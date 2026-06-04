/**
 * KS-3680 (ADR-108 §3, §5, §6). Хук для кнопки «Оценка позиции от AI»
 * в окне анализа. Поверх ранее реализованных кусков:
 *   - сбор позиционных факторов: `evalTrace(fen)` →
 *     `apps/web/src/lib/review/stockfishTrace.ts`;
 *   - HTTP: `POST /analyses/position/comment` с телом
 *     `{ fen, factors, eval?, language? }`, ответ `{ comment: string }`.
 *
 * 8 состояний возвращаемого `state.kind`:
 *   - `idle` — позиция готова, ничего не делали;
 *   - `loading` — идёт запрос (фабрика WASM + сеть);
 *   - `success` — есть текст; `source` показывает откуда (`live` / `cache` /
 *     `full-review`);
 *   - `empty` — backend ответил пустой строкой (`comment === ''`);
 *   - `error` — сетевая/серверная ошибка, текст в `message`;
 *   - `rate-limited` — backend вернул 429; в `retryAfterSec` секунды
 *     обратного отсчёта;
 *   - `unauthenticated` — `user === null` (гость), кнопка disabled;
 *   - `unsupported` — `evalTrace` отказался (нет WASM/SAB/таймаут) — без
 *     факторов запрос не имеет смысла.
 *
 * In-memory LRU-кэш на 50 записей по нормализованному FEN (поля 1–4 —
 * расстановка, сторона хода, рокировки, en-passant; halfmove/fullmove
 * не учитываются: они меняются по позициям, оценка позиции от них не
 * зависит). Кэш — модульный singleton: переход между ходами не теряет
 * результат, переход между маршрутами — теряет (что и нужно).
 *
 * При смене входного `fen`:
 *   - активный запрос отменяется через `AbortController`;
 *   - если в кэше есть запись по новому FEN — сразу `success(source=cache)`;
 *   - иначе — `idle` (либо `unauthenticated` для гостя).
 *
 * Если в `fullReviewComment` приходит непустой текст (=
 * `history[currentGlobalIndex]?.comment` из полного разбора партии) —
 * показываем его как `success(source='full-review')` до первого ручного
 * запроса. Кнопка `regenerate()` форсирует новый запрос: результат пишем
 * в RAM-кэш (не в PGN), карточка переключается на `source='live'`.
 *
 * Soft-counter: считаем запросы, отправленные текущим клиентом за окно
 * `SOFT_WINDOW_MS` (20 минут). Это локальная UX-индикация, никак не
 * заменяет серверный rate-limit (20/мин, 200/сут, 2000/сут общий).
 *
 * Параметр `language` отправляется ТОЛЬКО если backend готов его принять.
 * Пока нет server-side B1 — параметр опциональный; если caller передаёт
 * `undefined`, поле не уходит в тело, backend использует свой default.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AiArrow, AiHighlight } from '@kingside/shared';

import { evalTrace } from '../lib/review/stockfishTrace';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Soft-counter: окно и софт-лимит для UI-индикатора. */
const SOFT_WINDOW_MS = 20 * 60 * 1000;
export const SOFT_LIMIT = 20;
export const SOFT_WINDOW_MIN = 20;

/** Размер LRU-кэша по нормализованному FEN. */
const CACHE_LIMIT = 50;

/**
 * Нормализация FEN: оставляем только первые 4 поля. Halfmove/fullmove
 * не меняют оценку и не должны рвать кэш-хит при возврате на ту же
 * позицию через другой маршрут (например, после смены ветки).
 */
export function normalizeFen(fen: string): string {
  const parts = fen.split(/\s+/);
  return parts.slice(0, 4).join(' ');
}

/**
 * KS-3691 / ADR-108b §5. В кэше теперь храним не только текст комментария,
 * но и overlay (подсветки + стрелки) от модели. Пустые overlay (`comment===''`)
 * тоже кэшируются — обозначаются `comment===''` и пустыми массивами.
 */
interface CacheEntry {
  comment: string;
  highlights: AiHighlight[];
  arrows: AiArrow[];
}

// Модульный LRU. Map в JS сохраняет порядок вставки — этого хватает
// для классического LRU: при чтении `get` мы переустанавливаем ключ
// (delete + set), при превышении лимита удаляем «голову» (первый ключ).
const cache: Map<string, CacheEntry> = new Map();

function cacheGet(key: string): CacheEntry | undefined {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key)!;
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key: string, value: CacheEntry): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

/** Тест-хук: очистить кэш между тестами. */
export function _resetAiPositionCommentCacheForTests(): void {
  cache.clear();
}

export type AiCommentSource = 'live' | 'cache' | 'full-review';

export type AiCommentState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'success';
      comment: string;
      source: AiCommentSource;
      /** KS-3691 / ADR-108b §3. Подсветки клеток от модели. */
      highlights: AiHighlight[];
      /** KS-3691 / ADR-108b §3. Стрелки от модели. */
      arrows: AiArrow[];
    }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'rate-limited'; retryAfterSec: number }
  | { kind: 'unauthenticated' }
  | { kind: 'unsupported' };

/** KS-3691: безопасный фасад overlay для AnalysisPage. */
export interface AiOverlay {
  highlights: AiHighlight[];
  arrows: AiArrow[];
}

export interface UseAiPositionCommentOptions {
  fen: string;
  /** `null` → состояние `unauthenticated`, кнопка disabled. */
  user: { id: string } | null;
  /**
   * `history[currentGlobalIndex]?.comment ?? null` от AnalysisPage.
   * Непустая строка → показываем её как `success(source='full-review')`
   * до первого ручного запроса. Кнопка «Перегенерировать» заменит её
   * результатом из API (только в RAM-кэше).
   */
  fullReviewComment?: string | null;
  /** Опционально: язык ответа. Если backend ещё без B1, не передавать. */
  language?: 'ru' | 'en';
  /**
   * Опционально: оценка позиции в сантипешках с точки зрения белых.
   * Если undefined — поле в теле запроса не отправляется.
   */
  engineEvalCp?: number | null;
  /**
   * KS-3685: лучшая (multipv=1) линия от работающего экземпляра
   * Stockfish 18 в окне анализа на момент клика по кнопке. Если есть —
   * добавляем в `factors` два дополнительных элемента:
   *   { id: 'sf18_eval', score, depth, multipv: 1, sideToMove }
   *   { id: 'sf18_pv',   pv: string[uci], depth, multipv: 1 }
   * Если null/undefined (движок ещё не успел думать) — запрос уходит
   * без них, пользователя не блокируем.
   */
  engineBestLine?: EngineBestLineInput | null;
  /**
   * KS-3687: опциональная функция автозапуска движка перед отправкой
   * запроса. Если задана — хук вызывает её на каждом `request()`/
   * `regenerate()` и ждёт результат с потолком {@link ENGINE_PROBE_TIMEOUT_MS}.
   * Возвращаемое значение приоритетнее `engineBestLine` из ref.
   *
   * Логика обязанности caller'а (AnalysisPage):
   *  - если движок уже думает над текущей позицией и есть свежая
   *    линия — вернуть её мгновенно;
   *  - иначе — на короткое время включить движок, дождаться первой
   *    линии (~1 с), вернуть её и выключить движок, если включали;
   *  - если по таймауту 2 с линии нет — вернуть `null`.
   *
   * Если promise бросил/таймаут — запрос всё равно уходит, просто без
   * `sf18_eval` / `sf18_pv` (поведение KS-3685).
   */
  engineProbe?: () => Promise<EngineBestLineInput | null>;
}

export interface EngineBestLineInput {
  depth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  /** UCI-строка, пробелы между ходами. */
  pv: string;
}

/** Потолок ожидания engineProbe перед отправкой запроса. */
export const ENGINE_PROBE_TIMEOUT_MS = 2000;

export interface UseAiPositionCommentResult {
  state: AiCommentState;
  /** Запросить комментарий (если ещё нет в кэше). */
  request: () => void;
  /** Перегенерировать: игнорирует кэш и `fullReviewComment`. */
  regenerate: () => void;
  /** Текущее значение софт-счётчика для UI-индикатора. */
  softCounter: { used: number; limit: number; windowMin: number };
  /**
   * KS-3691 / ADR-108b §5. overlay в `success(live|cache)` либо `null`
   * для всех прочих состояний (включая `full-review` — в PGN нет структуры,
   * только текст). AnalysisPage подмешивает его в `mergedSquareStyles`
   * и `mergedArrows` между системным слоем и пользовательскими аннотациями.
   */
  overlay: AiOverlay | null;
  /** Скрыт ли overlay пользовательским кликом. Сбрасывается на смену FEN,
   *  новый `request()`/`regenerate()` и новый success. */
  overlayHidden: boolean;
  /** Переключатель скрытия overlay. Никаких side-effects, кроме setState. */
  toggleOverlay: () => void;
}

interface PositionCommentPayload {
  fen: string;
  factors: unknown[];
  eval?: number;
  language?: 'ru' | 'en';
}

interface FetchOk {
  ok: true;
  comment: string;
  highlights: AiHighlight[];
  arrows: AiArrow[];
}
interface FetchRateLimited {
  ok: false;
  kind: 'rate-limited';
  retryAfterSec: number;
}
interface FetchError {
  ok: false;
  kind: 'error';
  message: string;
}
type FetchOutcome = FetchOk | FetchRateLimited | FetchError;

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  try {
    const token =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('token')
        : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* SSR/test без localStorage */
  }
  return headers;
}

/**
 * Парсит 429 в `retryAfterSec`. Backend (см. KS-3679) возвращает тело
 * `{ error: 'rate_limit', retryAfter: <seconds>, limits: {...} }`. Если
 * тело пустое или формат другой — fallback на заголовок `Retry-After`,
 * затем на 60 секунд по умолчанию (минимальное «подожди минуту» окно).
 */
async function parseRateLimited(res: Response): Promise<number> {
  let bodyRetry: number | undefined;
  try {
    const body = (await res.json()) as { retryAfter?: unknown };
    if (typeof body?.retryAfter === 'number' && Number.isFinite(body.retryAfter)) {
      bodyRetry = Math.max(1, Math.round(body.retryAfter));
    }
  } catch {
    /* пустое или не-JSON тело — fallback */
  }
  if (bodyRetry !== undefined) return bodyRetry;
  const header = res.headers.get('Retry-After');
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 60;
}

async function postPositionComment(
  payload: PositionCommentPayload,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/analyses/position/comment`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    return { ok: false, kind: 'error', message: 'network' };
  }

  if (res.status === 429) {
    const retryAfterSec = await parseRateLimited(res);
    return { ok: false, kind: 'rate-limited', retryAfterSec };
  }

  if (!res.ok) {
    return { ok: false, kind: 'error', message: `http_${res.status}` };
  }

  try {
    const data = (await res.json()) as {
      comment?: unknown;
      highlights?: unknown;
      arrows?: unknown;
    };
    const comment = typeof data?.comment === 'string' ? data.comment : '';
    const highlights = sanitizeHighlights(data?.highlights);
    const arrows = sanitizeArrows(data?.arrows);
    return { ok: true, comment, highlights, arrows };
  } catch {
    return { ok: false, kind: 'error', message: 'parse' };
  }
}

const ALLOWED_OVERLAY_COLORS = new Set(['red', 'green', 'yellow', 'blue']);
const SQUARE_RE = /^[a-h][1-8]$/;

function sanitizeHighlights(input: unknown): AiHighlight[] {
  if (!Array.isArray(input)) return [];
  const out: AiHighlight[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { square?: unknown; color?: unknown };
    if (typeof obj.square !== 'string' || !SQUARE_RE.test(obj.square)) continue;
    if (typeof obj.color !== 'string' || !ALLOWED_OVERLAY_COLORS.has(obj.color)) {
      continue;
    }
    out.push({ square: obj.square, color: obj.color as AiHighlight['color'] });
  }
  return out;
}

function sanitizeArrows(input: unknown): AiArrow[] {
  if (!Array.isArray(input)) return [];
  const out: AiArrow[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { from?: unknown; to?: unknown; color?: unknown };
    if (typeof obj.from !== 'string' || !SQUARE_RE.test(obj.from)) continue;
    if (typeof obj.to !== 'string' || !SQUARE_RE.test(obj.to)) continue;
    if (obj.from === obj.to) continue;
    if (typeof obj.color !== 'string' || !ALLOWED_OVERLAY_COLORS.has(obj.color)) {
      continue;
    }
    out.push({
      from: obj.from,
      to: obj.to,
      color: obj.color as AiArrow['color'],
    });
  }
  return out;
}

export function useAiPositionComment(
  options: UseAiPositionCommentOptions,
): UseAiPositionCommentResult {
  const {
    fen,
    user,
    fullReviewComment,
    language,
    engineEvalCp,
    engineBestLine,
    engineProbe,
  } = options;
  const normalizedFen = normalizeFen(fen);
  // KS-3680: важно сравнивать пользователя по `id`, а не по ссылке.
  // В AnalysisPage объект `user` (или production wrapper `{ id: user.id }`)
  // может пересоздаваться на каждом рендере — если положить его в зависимости
  // `useEffect` напрямую, эффект будет выстреливать на каждом ре-рендере
  // и устроит бесконечный цикл setState → render → effect → setState.
  const userId = user?.id ?? null;

  // Soft-counter — timestamps в ref'е (не нужны в render). Чистим окно
  // при каждом обновлении.
  const requestTimestampsRef = useRef<number[]>([]);
  // useState только чтобы поднимать ре-рендер UI-индикатора счётчика.
  const [softCounterTick, setSoftCounterTick] = useState(0);

  const usedInWindow = (() => {
    const now = Date.now();
    const cutoff = now - SOFT_WINDOW_MS;
    requestTimestampsRef.current = requestTimestampsRef.current.filter(
      (t) => t >= cutoff,
    );
    return requestTimestampsRef.current.length;
  })();

  const initialState = (): AiCommentState => {
    if (!user) return { kind: 'unauthenticated' };
    const cached = cacheGet(normalizedFen);
    if (cached !== undefined) {
      return cached.comment === ''
        ? { kind: 'empty' }
        : {
            kind: 'success',
            comment: cached.comment,
            source: 'cache',
            highlights: cached.highlights,
            arrows: cached.arrows,
          };
    }
    if (fullReviewComment && fullReviewComment.trim() !== '') {
      // KS-3691 / ADR-108b §5: full-review-комментарий из PGN не несёт
      // overlay — массивы всегда пустые. AnalysisPage не покажет AI-слой
      // (overlay=null в результате), и кнопка-переключатель в панели не
      // появится.
      return {
        kind: 'success',
        comment: fullReviewComment,
        source: 'full-review',
        highlights: [],
        arrows: [],
      };
    }
    return { kind: 'idle' };
  };

  const [state, setState] = useState<AiCommentState>(initialState);
  // KS-3691: пользовательский «скрыть подсветку». Сбрасывается в false
  // при смене FEN и любом новом запросе.
  const [overlayHidden, setOverlayHidden] = useState(false);
  const toggleOverlay = useCallback(() => {
    setOverlayHidden((v) => !v);
  }, []);

  // Активный AbortController + признак «свежий ли запрос» (по нормализованному
  // FEN: при смене FEN отменяем in-flight и сбрасываем).
  const abortRef = useRef<AbortController | null>(null);
  const inFlightFenRef = useRef<string | null>(null);

  // KS-3685: engineBestLine читаем через ref, чтобы каждое обновление
  // EvalLine (новая глубина SF каждые ~80 мс) не пересоздавало
  // `doRequest` и не сбрасывало useEffect-зависимости.
  const engineBestLineRef = useRef(engineBestLine);
  engineBestLineRef.current = engineBestLine;
  // KS-3687: engineProbe тоже через ref — caller обычно пересоздаёт
  // callback на каждом рендере (зависит от `toggleAnalysis`/refs).
  const engineProbeRef = useRef(engineProbe);
  engineProbeRef.current = engineProbe;

  // Перезагрузка состояния при смене FEN / user / fullReviewComment.
  useEffect(() => {
    // Отменяем in-flight запрос для предыдущей позиции.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      inFlightFenRef.current = null;
    }
    // KS-3691: сброс «скрыто» по смене FEN — новая позиция, новый overlay.
    setOverlayHidden(false);
    if (!userId) {
      setState({ kind: 'unauthenticated' });
      return;
    }
    const cached = cacheGet(normalizedFen);
    if (cached !== undefined) {
      setState(
        cached.comment === ''
          ? { kind: 'empty' }
          : {
              kind: 'success',
              comment: cached.comment,
              source: 'cache',
              highlights: cached.highlights,
              arrows: cached.arrows,
            },
      );
      return;
    }
    if (fullReviewComment && fullReviewComment.trim() !== '') {
      setState({
        kind: 'success',
        comment: fullReviewComment,
        source: 'full-review',
        highlights: [],
        arrows: [],
      });
      return;
    }
    setState({ kind: 'idle' });
  }, [normalizedFen, userId, fullReviewComment]);

  const doRequest = useCallback(
    async (opts: { ignoreCache: boolean }) => {
      if (!userId) {
        setState({ kind: 'unauthenticated' });
        return;
      }
      // KS-3691: новый запрос/перегенерация всегда показывают overlay
      // (если придёт). Сбрасываем пользовательское скрытие.
      setOverlayHidden(false);
      if (!opts.ignoreCache) {
        const cached = cacheGet(normalizedFen);
        if (cached !== undefined) {
          setState(
            cached.comment === ''
              ? { kind: 'empty' }
              : {
                  kind: 'success',
                  comment: cached.comment,
                  source: 'cache',
                  highlights: cached.highlights,
                  arrows: cached.arrows,
                },
          );
          return;
        }
      }

      // Отменяем предыдущий in-flight (если был), стартуем свежий.
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      inFlightFenRef.current = normalizedFen;
      setState({ kind: 'loading' });

      // 1) Собираем факторы через evalTrace. На любой ошибке движка —
      //    состояние `unsupported`: без факторов запрос не имеет смысла.
      let factors: unknown[];
      try {
        factors = await evalTrace(fen);
      } catch (e) {
        if (isAbortError(e)) return;
        if (inFlightFenRef.current !== normalizedFen) return;
        setState({ kind: 'unsupported' });
        abortRef.current = null;
        inFlightFenRef.current = null;
        return;
      }
      if (ctrl.signal.aborted) return;

      // 2) Тело запроса. `language` и `eval` — опциональные.
      //
      // KS-3685: если в окне анализа уже работает Stockfish 18 и успел
      // вернуть хотя бы одну линию — дописываем в `factors` две дополнительные
      // записи (`sf18_eval` + `sf18_pv`), чтобы языковая модель могла
      // опираться на реальную оценку движка и его рекомендованную линию.
      // Если движок ещё не успел думать (engineBestLine = null/undefined) —
      // запрос уходит без них, пользователя не блокируем.
      //
      // KS-3687: если caller передал `engineProbe` — даём ему шанс
      // запустить движок (или забрать готовую линию), ждём с потолком
      // ENGINE_PROBE_TIMEOUT_MS. Результат приоритетнее ref-значения.
      let bestLine: EngineBestLineInput | null | undefined =
        engineBestLineRef.current;
      const probe = engineProbeRef.current;
      if (probe) {
        try {
          const probed = await Promise.race<
            EngineBestLineInput | null
          >([
            probe(),
            new Promise<EngineBestLineInput | null>((resolve) =>
              setTimeout(() => resolve(null), ENGINE_PROBE_TIMEOUT_MS),
            ),
          ]);
          if (ctrl.signal.aborted) return;
          if (inFlightFenRef.current !== normalizedFen) return;
          if (probed) bestLine = probed;
        } catch {
          // engineProbe бросил — игнорируем, отправим без sf18-факторов.
        }
      }
      const factorsWithEngine: unknown[] = [...factors];
      if (bestLine && Number.isFinite(bestLine.score?.value)) {
        const sideToMove: 'w' | 'b' = fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
        factorsWithEngine.push({
          id: 'sf18_eval',
          engine: 'stockfish-18',
          depth: bestLine.depth,
          multipv: bestLine.multipv,
          score: bestLine.score,
          side_to_move: sideToMove,
        });
        const pvList = (bestLine.pv ?? '').trim().split(/\s+/).filter(Boolean);
        if (pvList.length > 0) {
          factorsWithEngine.push({
            id: 'sf18_pv',
            engine: 'stockfish-18',
            depth: bestLine.depth,
            multipv: bestLine.multipv,
            pv: pvList,
          });
        }
      }

      const payload: PositionCommentPayload = {
        fen,
        factors: factorsWithEngine,
      };
      if (language) payload.language = language;
      if (engineEvalCp != null && Number.isFinite(engineEvalCp)) {
        payload.eval = engineEvalCp;
      }

      // 3) Считаем запрос для soft-counter ДО fetch'а — даже если он
      //    провалится, для пользователя это уже была отправка.
      requestTimestampsRef.current.push(Date.now());
      setSoftCounterTick((v) => v + 1);

      let outcome: FetchOutcome;
      try {
        outcome = await postPositionComment(payload, ctrl.signal);
      } catch (e) {
        if (isAbortError(e)) return;
        outcome = { ok: false, kind: 'error', message: 'network' };
      }
      // Защита от гонки: пока запрос летел, FEN мог смениться. Тогда
      // результат относится к старой позиции — игнорируем.
      if (inFlightFenRef.current !== normalizedFen) return;
      abortRef.current = null;
      inFlightFenRef.current = null;

      if (outcome.ok) {
        cacheSet(normalizedFen, {
          comment: outcome.comment,
          highlights: outcome.highlights,
          arrows: outcome.arrows,
        });
        // KS-3691: новый success всегда раскрывает overlay (пользователь
        // мог скрыть предыдущий, но это уже неактуальное состояние).
        setOverlayHidden(false);
        if (outcome.comment === '') {
          setState({ kind: 'empty' });
        } else {
          setState({
            kind: 'success',
            comment: outcome.comment,
            source: 'live',
            highlights: outcome.highlights,
            arrows: outcome.arrows,
          });
        }
        return;
      }
      if (outcome.kind === 'rate-limited') {
        setState({ kind: 'rate-limited', retryAfterSec: outcome.retryAfterSec });
        return;
      }
      setState({ kind: 'error', message: outcome.message });
    },
    [fen, normalizedFen, userId, language, engineEvalCp],
  );

  const request = useCallback(() => {
    void doRequest({ ignoreCache: false });
  }, [doRequest]);

  const regenerate = useCallback(() => {
    void doRequest({ ignoreCache: true });
  }, [doRequest]);

  // Cleanup: при размонтировании отменяем активный запрос.
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        inFlightFenRef.current = null;
      }
    };
  }, []);

  // softCounterTick включён в зависимости неявно — UI обновляется
  // каждый раз, когда мы пушим timestamp.
  void softCounterTick;

  // KS-3691: overlay есть только в `success(live|cache)` — в `full-review`
  // массивы пустые, кнопка-переключатель в панели для него не показывается.
  const overlay: AiOverlay | null =
    state.kind === 'success' &&
    state.source !== 'full-review' &&
    (state.highlights.length > 0 || state.arrows.length > 0)
      ? { highlights: state.highlights, arrows: state.arrows }
      : null;

  return {
    state,
    request,
    regenerate,
    softCounter: {
      used: usedInWindow,
      limit: SOFT_LIMIT,
      windowMin: SOFT_WINDOW_MIN,
    },
    overlay,
    overlayHidden,
    toggleOverlay,
  };
}
