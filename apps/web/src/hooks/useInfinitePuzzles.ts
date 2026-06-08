import { useCallback, useEffect, useRef, useState } from 'react';
import type { PuzzleObjective } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * KS-2561 / KS-2560 (backend): cursor pagination для `/puzzles/browse`.
 * Эндпоинт возвращает `{ data, nextCursor }`; cursor — base64({c, i}).
 * Сортировка фиксированная (`created_at DESC, id DESC`), параметры
 * `offset/sort/order` удалены.
 *
 * Хук — упрощённая версия `ArchiveGamesPage` infinite-логики:
 * `seq-guard` (монотонный счётчик) защищает от race'ов при смене
 * фильтров; `nextCursor === null` означает «достигли конца».
 */

export interface BrowsePuzzleDto {
  id: string;
  fen: string;
  moves: string[] | string;
  rating: number;
  themes: string[] | string;
  source: string;
  /** KS-2493+: API маркер solution-режима. Опционально на /browse. */
  solutionMode?: 'forced-line' | 'play-vs-engine';
  sourceId: string | null;
  sourceMoveNum: number | null;
  sourceMetadata: { white?: string; black?: string; event?: string } | null;
  /**
   * KS-2754 follow-up: метаданные исходной партии (расширенно). Когда
   * пазл сгенерирован из реальной партии — `event`/`white`/`black`/
   * `date`/`result`/`archiveGameId`/`pgnUrl`. Для legacy/lichess —
   * `null`/`undefined`.
   */
  sourceGame?: {
    white?: string;
    black?: string;
    /** KS-2754 backend 807e9bd2: ELO белых из PGN-tag `WhiteElo`. */
    whiteElo?: number;
    /** KS-2754 backend 807e9bd2: ELO чёрных из PGN-tag `BlackElo`. */
    blackElo?: number;
    event?: string;
    date?: string;
    result?: string;
    pgnUrl?: string;
    archiveGameId?: string;
  } | null;
  /**
   * KS-2754 follow-up: данные play-vs-engine — UCI зевка и FEN ДО
   * зевка. По ним фронт собирает SAN зевка через chess.js, чтобы
   * показать на карточке `/precision` «партия X-Y, ход N… Nxe4?».
   * Опционально (legacy/lichess пазлы → undefined).
   */
  playVsEngine?: {
    blunderMove?: string;
    fenBeforeBlunder?: string;
    wdlAfterBlunder?: number;
    /**
     * KS-3146 / ADR-069: жанр пазла. Backend (KS-3145) проставляет
     * `convertAdvantage` | `saveEquality` при генерации. Legacy-пазлы
     * (до KS-3144) поля не имеют — UI fallback: бейдж не показывается.
     */
    objective?: PuzzleObjective | null;
  } | null;
  /**
   * KS-2761: ELO ЗЕВНУВШЕГО игрока — конкретно той стороны, что
   * сыграла `blunderMove`. Backend подбирает между `whiteElo`/`blackElo`
   * по side-to-move в `fenBeforeBlunder`. `null` если у партии не
   * проставлены рейтинги в PGN-tags.
   */
  blundererElo?: number | null;
  isPublic?: boolean;
  /**
   * KS-2668: backend возвращает поле владельца под именем `createdBy`
   * (`User.id` или `null` для lichess-пазлов). До KS-2668 фронт читал
   * `userId`, которого в DTO нет — owner-кнопки на /precision никогда
   * не появлялись. Имя выровнено по DTO; для обратной совместимости
   * `userId` оставлен как deprecated alias (его всё равно не было в
   * ответе, но если где-то осталось чтение — TS укажет).
   */
  createdBy?: string | null;
  /** @deprecated KS-2668: используйте `createdBy`. */
  userId?: string;
  createdAt: string;
  solvedStatus?: 'solved' | 'failed' | null;
}

interface BrowseResponse {
  data: BrowsePuzzleDto[];
  nextCursor: string | null;
  /**
   * KS-3666 / KS-3672 (ADR-106). Точное число пазлов под текущие
   * фильтры (без учёта cursor-пагинации).
   *
   * После KS-3891 / KS-3893 backend возвращает поле так:
   *  - cache hit (Redis) на первой странице → число;
   *  - cache miss на первой странице → `null` (фоновый COUNT уходит
   *    в Redis, ответ не блокируется);
   *  - последующие страницы (cursor !== null) → `null` (COUNT не
   *    пересчитывается на каждом скроллинге);
   *  - старый backend / неожиданный ответ → `undefined` (используем
   *    fallback «загружено + N+»).
   *
   * Уточнение значения берётся из `/puzzles/browse/count`
   * (KS-3894): сначала `approx=true` за миллисекунды, затем точный.
   */
  total?: number | null;
}

/**
 * KS-3894. Ответ нового обработчика `/puzzles/browse/count`.
 * Параметры фильтра те же что у `/browse`, кроме `limit`/`cursor`.
 *  - `approximate=true` → planner-estimate через EXPLAIN, округление
 *    до сотен; миллисекунды.
 *  - `approximate=false` → точный COUNT через Redis-кеш с fallback
 *    на SQL-COUNT; до ~10 с при cold cache.
 */
interface CountResponse {
  total: number;
  approximate: boolean;
}

export interface InfinitePuzzleFilters {
  /** Опциональный нижний порог рейтинга. */
  ratingMin?: number;
  /** Опциональный верхний порог рейтинга. */
  ratingMax?: number;
  /** Темы (ANY-of). Пустой массив = без фильтра по теме. */
  themes?: string[];
  /**
   * KS-3361 (ADR-080 §4.1). Multi-select OR-фильтр по темам — задача
   * попадает в выдачу, если содержит хотя бы одну из перечисленных
   * тем. Comma-separated CSV в URL `themesOr=pin,fork`. Backend
   * валидирует против `PRECISION_RELEVANT_THEMES`.
   */
  themesOr?: string[];
  /**
   * KS-3361 (ADR-080 §4.1). Multi-select AND-фильтр — задача попадает
   * в выдачу, только если содержит ВСЕ перечисленные темы. Сочетается
   * с themesOr через AND. UI на этот сезон выставляет только OR;
   * AND зарезервирован для будущего «продвинутого» режима.
   */
  themesAnd?: string[];
  /** Только мои пазлы. */
  mine?: boolean;
  /**
   * KS-3353 (ADR-079 scope=server). «Не мои публичные» — NULL-aware
   * фильтр. Backend: `is_public=true AND (created_by IS NULL OR
   * created_by != me)`. Для guest backend проигнорирует userId-ветку
   * и отдаст public-only. Используется PrecisionPage при scope='server'
   * (см. `scopeToLegacyFilters`).
   */
  excludeMine?: boolean;
  /** Скрыть уже решённые. */
  hideSolved?: boolean;
  /**
   * Какой источник пазлов брать. Без значения — backend отдаёт все
   * (после KS-2557 hotfix).
   */
  source?: string;
  /**
   * KS-2582 / KS-2586: фильтр по `is_public`. `'draft'` = только
   * `is_public=false`; `'public'` = только `is_public=true`; `'all'`
   * (или undefined) = без фильтра. Backend whitelist'ит значения.
   */
  visibility?: 'draft' | 'public' | 'all';
  /**
   * KS-2758 / backend KS-2761: фильтр по рейтингу ЗЕВНУВШЕГО игрока
   * (того, кто сыграл `blunderMove`). Backend смотрит на сторону
   * side-to-move в `fenBeforeBlunder` и берёт соответствующий ELO
   * (`whiteElo` если ходили белые, иначе `blackElo`).
   */
  blundererEloMin?: number;
  blundererEloMax?: number;
  /**
   * KS-3657 / ADR-106 §2.6. Минимальное значение `maia_weak_choice_prob`
   * (порог сложности). При `> 0` backend применяет
   * `WHERE maia_weak_choice_prob >= $v AND maia_metric_version = 1` —
   * не размеченные / устаревшие пазлы из выдачи выпадают. При `null`/
   * `undefined`/`0` параметр не передаётся, выдача без фильтра.
   * Диапазон строго `(0, 1]`; backend возвращает 400 при выходе.
   */
  minMaiaWeakChoiceProb?: number;
  /**
   * KS-3665 / KS-3670 / ADR-106 §2.6. Верхняя граница диапазона
   * `maia_weak_choice_prob`. При `< 1` backend добавляет
   * `AND maia_weak_choice_prob <= $v`. `null` / `undefined` / `1` —
   * параметр не передаётся (без верхней границы).
   * Диапазон строго `[0, 1]`; backend возвращает 400 при выходе или
   * при `max < min`.
   */
  maxMaiaWeakChoiceProb?: number;
  /** Размер страницы. По умолчанию 30. */
  limit?: number;
}

export interface InfinitePuzzlesState {
  puzzles: BrowsePuzzleDto[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** `true` пока сервер прислал не `null` в `nextCursor`. */
  hasMore: boolean;
  /**
   * KS-3666 / KS-3672. Число пазлов под текущие фильтры
   * (`/puzzles/browse` `total` или `/puzzles/browse/count`).
   * `null` пока первая страница не загружена, либо если backend
   * поле не вернул (старый ответ).
   *
   * Под cursor-пагинацией значение стабильно между страницами —
   * берём из первой ответа и не обновляем (refetch вызывает сброс).
   *
   * KS-3894: значение проходит через две фазы:
   *  1. Approximate (planner-estimate) — приходит за миллисекунды.
   *  2. Exact (Redis-кеш / COUNT) — заменяет approximate.
   * Различать фазы через `totalApproximate`.
   */
  total: number | null;
  /**
   * KS-3894. `true` пока `total` — приблизительный planner-estimate;
   * `false` когда пришёл точный count (или `total` из cache-hit
   * `/browse`). При `null` total флаг трактуется как «нет данных»,
   * UI fallback'ится на «загружено + N+».
   */
  totalApproximate: boolean;
  /** Запросить следующую страницу. Игнорируется, если `hasMore=false`. */
  loadMore: () => void;
  /** Удаляет пазл из локального состояния (после backend `DELETE`). */
  removeLocally: (id: string) => void;
  /** Обновляет одно поле локально (например `isPublic` после PATCH). */
  patchLocally: (id: string, patch: Partial<BrowsePuzzleDto>) => void;
}

function appendFilterParams(
  params: URLSearchParams,
  filters: InfinitePuzzleFilters,
): void {
  if (filters.ratingMin != null)
    params.set('ratingMin', String(filters.ratingMin));
  if (filters.ratingMax != null)
    params.set('ratingMax', String(filters.ratingMax));
  if (filters.themes && filters.themes.length > 0)
    params.set('themes', filters.themes.join(','));
  // KS-3361: themesOr / themesAnd (ADR-080 §4.1).
  if (filters.themesOr && filters.themesOr.length > 0)
    params.set('themesOr', filters.themesOr.join(','));
  if (filters.themesAnd && filters.themesAnd.length > 0)
    params.set('themesAnd', filters.themesAnd.join(','));
  if (filters.mine) params.set('mine', 'true');
  // KS-3353: NULL-aware «не мои публичные» для scope=server.
  if (filters.excludeMine) params.set('excludeMine', 'true');
  if (filters.hideSolved) params.set('hideSolved', 'true');
  if (filters.source) params.set('source', filters.source);
  if (filters.visibility) params.set('visibility', filters.visibility);
  if (filters.blundererEloMin != null)
    params.set('blundererEloMin', String(filters.blundererEloMin));
  if (filters.blundererEloMax != null)
    params.set('blundererEloMax', String(filters.blundererEloMax));
  // KS-3657: 0 трактуется как «нет фильтра» (синоним null), параметр
  // не передаётся — backend в этом случае не накладывает WHERE-условие.
  if (filters.minMaiaWeakChoiceProb != null && filters.minMaiaWeakChoiceProb > 0)
    params.set('minMaiaWeakChoiceProb', String(filters.minMaiaWeakChoiceProb));
  // KS-3665 / KS-3670: 1 (или undefined) → без верхней границы. Параметр
  // в этом случае не передаётся; backend не накладывает WHERE-условие
  // на верхнюю границу.
  if (filters.maxMaiaWeakChoiceProb != null && filters.maxMaiaWeakChoiceProb < 1)
    params.set('maxMaiaWeakChoiceProb', String(filters.maxMaiaWeakChoiceProb));
}

function buildQuery(
  filters: InfinitePuzzleFilters,
  cursor: string | null,
): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit ?? 30));
  if (cursor) params.set('cursor', cursor);
  appendFilterParams(params, filters);
  return params.toString();
}

/**
 * KS-3894. Query для `/puzzles/browse/count` — те же фильтры что у
 * `/browse`, без `limit`/`cursor`. Когда `approx=true`, backend
 * считает через EXPLAIN (planner-estimate, миллисекунды).
 */
function buildCountQuery(
  filters: InfinitePuzzleFilters,
  approx: boolean,
): string {
  const params = new URLSearchParams();
  if (approx) params.set('approx', 'true');
  appendFilterParams(params, filters);
  return params.toString();
}

export function useInfinitePuzzles(
  filters: InfinitePuzzleFilters,
): InfinitePuzzlesState {
  const [puzzles, setPuzzles] = useState<BrowsePuzzleDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // KS-3666 / KS-3672. Число пазлов под фильтры. `null` —
  // пока не загружена первая страница или backend не вернул поле.
  const [total, setTotal] = useState<number | null>(null);
  // KS-3894. `true` пока total — planner-estimate из
  // `/browse/count?approx=true`. Когда придёт точный count или
  // `/browse` отдаст готовое число (cache hit) — `false`.
  const [totalApproximate, setTotalApproximate] = useState<boolean>(false);

  // KS-2149-pattern: seq-guard. Каждое новое требование (init / loadMore)
  // увеличивает счётчик; ответы со старыми seq игнорируются.
  const seqRef = useRef(0);
  // Последний actual cursor — нужен для loadMore без замыкания state.
  const cursorRef = useRef<string | null>(null);
  /**
   * KS-2565: cursor, с которым мы УЖЕ делали запрос. Защищает от
   * бесконечного цикла retry, когда retry-effect в `PuzzleBrowserPage`
   * после `loadingMore: true → false` снова видит sentinel в viewport
   * и дёргает `loadMore`. Если backend в гонке вернул тот же cursor
   * (что произошло в проде, 16+ запросов подряд) — мы будем фечить
   * бесконечно. Идемпотентность: повторный fetch с тем же cursor —
   * no-op, hasMore переключается в false.
   */
  const lastUsedCursorRef = useRef<string | null>(null);
  /**
   * KS-3894. `true` если уже пришёл точный `/browse/count` (или
   * cache-hit `total` из `/browse`) для текущего поколения фильтров.
   * Защита от прыжка «N → ~N» если approx-ответ задержался и
   * подоспел уже после exact. Сбрасывается в начале каждого
   * filtersKey-эффекта.
   */
  const exactTotalArrivedRef = useRef<boolean>(false);

  // Стабильная сериализация фильтров — изменения значимых полей
  // вызывают перезагрузку. JSON-сериализация массива тем сохраняет
  // порядок, что норм (порядок выбора пользователя).
  const filtersKey = JSON.stringify({
    ratingMin: filters.ratingMin,
    ratingMax: filters.ratingMax,
    themes: filters.themes,
    // KS-3361: re-fetch при смене выбранных тем.
    themesOr: filters.themesOr,
    themesAnd: filters.themesAnd,
    mine: filters.mine,
    // KS-3353: переключение scope server↔drafts должно re-fetch'ить.
    excludeMine: filters.excludeMine,
    hideSolved: filters.hideSolved,
    source: filters.source,
    visibility: filters.visibility,
    blundererEloMin: filters.blundererEloMin,
    blundererEloMax: filters.blundererEloMax,
    // KS-3657: re-fetch при смене порога maia weak-choice.
    minMaiaWeakChoiceProb: filters.minMaiaWeakChoiceProb,
    // KS-3665: re-fetch при смене верхней границы диапазона.
    maxMaiaWeakChoiceProb: filters.maxMaiaWeakChoiceProb,
    limit: filters.limit,
  });

  // Initial / reset on filters change.
  useEffect(() => {
    const mySeq = ++seqRef.current;
    cursorRef.current = null;
    // KS-2565: при смене фильтра — разрешаем заново все cursor'ы.
    lastUsedCursorRef.current = null;
    setLoading(true);
    // KS-3122: ОБЯЗАТЕЛЬНО сбросить loadingMore при смене filtersKey.
    // Если пользователь поменял фильтр (themes/rating/etc.) пока
    // предыдущий loadMore был inflight — его `.finally` сравнивает
    // `mySeq !== seqRef.current` и НЕ вызывает `setLoadingMore(false)`
    // (это race-guard). Результат: loadingMore залип в true, индикатор
    // «Загрузка...» висит навсегда, новый loadMore блокируется
    // условием `if (loadingMore) return`. Reset снимает блок.
    setLoadingMore(false);
    setError(null);
    setPuzzles([]);
    setNextCursor(null);
    // KS-3672: сбрасываем total — для новых фильтров будет переписан
    // первой страницей. До этого UI показывает fallback «N+».
    setTotal(null);
    // KS-3894: при сбросе total флаг approximate тоже снимаем —
    // следующее значение установит его сам (true для approx-count,
    // false для cache-hit /browse или для exact-count).
    setTotalApproximate(false);
    // KS-3894: сброс «exact-уже-пришёл» — иначе после смены фильтра
    // первый approx-ответ нового поколения будет проигнорирован.
    exactTotalArrivedRef.current = false;

    // KS-3894. AbortController отменяет три inflight'a при смене
    // фильтра. seqRef-guard ниже всё равно отбросит устаревшие
    // ответы, но реальная отмена экономит сеть и снимает нагрузку
    // с backend'а (точный COUNT — до 10с).
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    const isAborted = (e: unknown): boolean =>
      (e instanceof ApiError && e.errorCode === 'REQUEST_TIMEOUT' &&
        signal.aborted) ||
      (e instanceof DOMException && e.name === 'AbortError');

    // KS-3894. Параллельные запросы — список, приблизительный счёт
    // и точный счёт. Старт одновременно; UI обновляется по мере
    // прихода ответов.

    // 1. Основной список + (на cache hit) total.
    api
      .get<BrowseResponse>(
        `/puzzles/browse?${buildQuery(filters, null)}`,
        { signal },
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setPuzzles(res.data ?? []);
        setNextCursor(res.nextCursor ?? null);
        cursorRef.current = res.nextCursor ?? null;
        // KS-3672: backend (KS-3666) кладёт total в первый ответ.
        // KS-3892 / KS-3891: с этой ревизии backend возвращает
        // `total` ТОЛЬКО на первой странице, чтобы не делать тяжёлый
        // COUNT(*) на каждом скроллинге. На последующих страницах
        // приходит null — но `loadMore` ниже total не трогает, так
        // что прежнее значение сохраняется. Здесь обновляем total
        // ТОЛЬКО если backend вернул число; null/отсутствие поля
        // означает «не пересчитывал» — оставляем последнее известное
        // значение (на свежий фильтр reset выше уже выставил `null`,
        // и UI показывает fallback «N+»).
        // KS-3894: cache hit на `/browse` — точное число; снимаем
        // флаг approximate, чтобы UI не показывал «~N» лишних 10 с
        // до прихода exact-count.
        if (typeof res.total === 'number') {
          exactTotalArrivedRef.current = true;
          setTotal(res.total);
          setTotalApproximate(false);
        }
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        if (isAborted(e)) return;
        setError(e instanceof Error ? e.message : 'Failed to load puzzles');
        setPuzzles([]);
        setNextCursor(null);
        cursorRef.current = null;
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoading(false);
      });

    // 2. Приблизительный count (planner-estimate). Миллисекунды.
    //    Применяем ТОЛЬКО если точное число ещё не пришло
    //    (`exactTotalArrivedRef` снимает запись approx когда уже
    //    есть exact — иначе UI на мгновение прыгнет с N на ~N).
    api
      .get<CountResponse>(
        `/puzzles/browse/count?${buildCountQuery(filters, true)}`,
        { signal },
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        if (exactTotalArrivedRef.current) return;
        setTotal(res.total);
        setTotalApproximate(true);
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        if (isAborted(e)) return;
        // Approx-count — best effort. Ошибку проглатываем: UI
        // получит точное число от exact-count или fallback «N+».
      });

    // 3. Точный count. Может занять до 10 с при cold cache.
    api
      .get<CountResponse>(
        `/puzzles/browse/count?${buildCountQuery(filters, false)}`,
        { signal },
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        // Точный count всегда перетирает: и null, и approx.
        exactTotalArrivedRef.current = true;
        setTotal(res.total);
        setTotalApproximate(false);
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        if (isAborted(e)) return;
        // Exact-count упал (5xx, network, timeout) — best effort.
        // UI остаётся на approx (если успел прийти) или fallback.
      });

    return () => {
      abortCtrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadMore = useCallback(() => {
    const cursorAtCall = cursorRef.current;
    if (!cursorAtCall) return;
    if (loadingMore) return;
    // KS-2565: если уже фечили с этим cursor (например, retry-effect
    // вызвал нас дважды подряд, или backend вернул тот же cursor что
    // мы посылали) — больше не пытаемся, переключаем hasMore=false.
    if (cursorAtCall === lastUsedCursorRef.current) {
      cursorRef.current = null;
      setNextCursor(null);
      return;
    }
    lastUsedCursorRef.current = cursorAtCall;
    const mySeq = ++seqRef.current;
    setLoadingMore(true);
    api
      .get<BrowseResponse>(
        `/puzzles/browse?${buildQuery(filters, cursorAtCall)}`,
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setPuzzles((prev) => [...prev, ...(res.data ?? [])]);
        // KS-2565: если backend вернул тот же cursor что мы послали —
        // прогресса нет, считаем, что список закончился.
        const nextC =
          res.nextCursor && res.nextCursor !== cursorAtCall
            ? res.nextCursor
            : null;
        setNextCursor(nextC);
        cursorRef.current = nextC;
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load puzzles');
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoadingMore(false);
      });
  }, [filters, loadingMore]);

  const removeLocally = useCallback((id: string) => {
    setPuzzles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const patchLocally = useCallback(
    (id: string, patch: Partial<BrowsePuzzleDto>) => {
      setPuzzles((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      );
    },
    [],
  );

  return {
    puzzles,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    total,
    totalApproximate,
    loadMore,
    removeLocally,
    patchLocally,
  };
}
