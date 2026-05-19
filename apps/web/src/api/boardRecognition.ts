/**
 * KS-2365 / ADR-040 §5.1. Клиент для board-recognition API
 * (`POST {VITE_API_URL}/board-recognition`, multipart с полем `image`).
 *
 * Контракт response зафиксирован в ADR-040 §5.1 и в описании KS-2365:
 *   { fen, fenBoard, orientation, orientationConfidence, bbox, modelVersion,
 *     lowConfidenceCells[], warnings[] }
 *
 * Backend (KS-2363) ещё не задеплоен на момент закрытия KS-2365 — поэтому
 * клиент:
 *   1. Делает реальный POST.
 *   2. Если ответ 404/501/network — возвращает стабильный мок (стартовая
 *      позиция + warning «mock»). Юзер видит работающий UI, и как только
 *      backend поднимется — фолбек перестанет срабатывать без правок
 *      фронта.
 * Флаг `VITE_BOARD_RECOG_FORCE_MOCK=1` в `.env.local` гарантирует мок
 * даже при работающем endpoint'е — нужен для Playwright/детерминированных
 * тестов.
 */

export interface BoardRecognitionBbox {
  /** Координаты bounding box доски в исходном изображении, пиксели. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardRecognitionCell {
  /** Координаты клетки 0..7 (file/rank), 0,0 = a8 в FEN-нотации. */
  file: number;
  rank: number;
  /** Распознанная фигура (одна буква FEN: 'P','K',...,'.' для пустой). */
  piece: string;
  /** Уверенность 0..1, ниже порога ⇒ попадает в `lowConfidenceCells`. */
  confidence: number;
}

export interface BoardRecognitionResponse {
  /** Полный FEN ровно как нужно для chess.js (с side-to-move, castling и т.д.). */
  fen: string;
  /** Только board-часть FEN'а, для подсветки/edit без потери метаданных. */
  fenBoard: string;
  /** Распознанная ориентация: 'white' = a1 слева внизу. */
  orientation: 'white' | 'black';
  /** Уверенность ориентации, 0..1. */
  orientationConfidence: number;
  /** bbox доски в исходном изображении. */
  bbox: BoardRecognitionBbox;
  /** Версия модели (для воспроизводимости/телеметрии). */
  modelVersion: string;
  /** Клетки с низкой уверенностью — UI подсвечивает для ручной правки. */
  lowConfidenceCells: BoardRecognitionCell[];
  /** Дополнительные предупреждения (ambiguous orientation, blurry image и т.п.). */
  warnings: string[];
  /**
   * KS-3117 / backend `2521b320`+`779f4251`: multi-board режим. Если на
   * скриншоте найдено больше одной доски (страница пазлов, учебник с
   * несколькими диаграммами) — `boards` содержит ВСЕ распознанные
   * позиции, каждая со своим fen/orientation/bbox/lowConfidenceCells.
   * Корневые поля дублируют первую доску для back-compat.
   *
   * Для single-board (`boards` отсутствует или `length === 1`) — UI
   * ведёт себя как раньше; для multi (`length > 1`) — показывает grid
   * превью с выбором.
   */
  boards?: BoardRecognitionResponse[];
}

/**
 * KS-3093 / ADR-040-v2 §5.1. Тело 422 `recognition_unreliable`: backend
 * успел распознать позицию, но client-sanity её отверг (например, пешки
 * на 1/8 ранге). `fenAttempt` — что модель «увидела»; `issues` — почему
 * sanity сработал; `lowConfidenceCells` — клетки, в которых модель не
 * уверена. Фронт обязан показать fenAttempt на доске и дать
 * исправить вручную, а не оборвать flow «Invalid FEN: точка».
 */
export interface BoardRecognitionUnreliablePayload {
  error: 'recognition_unreliable' | string;
  message?: string;
  fenAttempt?: string;
  issues?: string[];
  lowConfidenceCells?: BoardRecognitionCell[];
  orientation?: 'white' | 'black';
  modelVersion?: string;
}

/**
 * KS-3093. Доменная ошибка для 422-ответа: компонент-дропзона ловит её
 * и переходит в «soft-warning»-режим вместо общего error-ветки. Хранит
 * payload as-is, чтобы UI мог решить, есть ли `fenAttempt` (тогда —
 * редактируем) или нет (legacy edge-case — старое сообщение «не удалось
 * распознать»).
 */
export class BoardRecognitionUnreliableError extends Error {
  readonly payload: BoardRecognitionUnreliablePayload;
  constructor(payload: BoardRecognitionUnreliablePayload) {
    super(payload.message ?? payload.error ?? 'recognition_unreliable');
    this.name = 'BoardRecognitionUnreliableError';
    this.payload = payload;
  }
}

/**
 * KS-3094 / ADR-040-v2 §5.1. Тело 400 `board_not_detected`: stage 1
 * `board_detect` не нашёл квадрат доски на картинке (мобильный
 * скриншот с обвязкой, фото под углом, большой бэкграунд). UI должен
 * показать crop-инструмент, дать пользователю руками выделить доску
 * и переотправить кроп на тот же endpoint.
 */
export interface BoardNotDetectedPayload {
  error: 'board_not_detected' | string;
  message?: string;
}

/**
 * KS-3094. Доменная ошибка 400 — отличается от unreliable тем, что
 * stage 1 (детект квадрата доски) вообще ничего не вернул. fenAttempt
 * тут принципиально невозможен. Дропзона на эту ошибку открывает
 * crop-оверлей над исходной картинкой и повторно вызывает recognizer
 * с обрезанным blob.
 */
export class BoardNotDetectedError extends Error {
  readonly payload: BoardNotDetectedPayload;
  constructor(payload: BoardNotDetectedPayload) {
    super(payload.message ?? payload.error ?? 'board_not_detected');
    this.name = 'BoardNotDetectedError';
    this.payload = payload;
  }
}

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const STARTING_FEN_BOARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

/**
 * KS-3087/KS-2365 hotfix: api-сервис висит на отдельном origin
 * (`api.kingside.site`), контроллер `BoardRecognitionController`
 * зарегистрирован без `/api`-префикса (`/board-recognition`, как
 * `/auth/login`). CloudFront не маршрутизирует `kingside.site/api/*`
 * на backend, поэтому относительный путь `/api/board-recognition`
 * улетал в никуда и фолбек-мок маскировал 404.
 *
 * Берём базовый URL из `VITE_API_URL` так же, как `api.ts` /
 * `api-puzzle.ts`.
 */
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/**
 * Стабильный мок ответа для случая, когда backend (KS-2363) ещё не
 * отвечает. Возвращает стартовую позицию — этого достаточно чтобы
 * увидеть полный UI-флоу: «загрузил → отрисовалась доска → можно
 * править FEN». В реальной интеграции (после деплоя KS-2363) этот
 * путь не используется.
 */
function buildMockResponse(reason: string): BoardRecognitionResponse {
  return {
    fen: STARTING_FEN,
    fenBoard: STARTING_FEN_BOARD,
    orientation: 'white',
    orientationConfidence: 0.5,
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    modelVersion: 'mock-ks2363-pending',
    lowConfidenceCells: [],
    warnings: [`mock: ${reason}`],
  };
}

function isForceMock(): boolean {
  // Vite инлайнит import.meta.env при build; в тестах vitest даёт fallback {}.
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  return env.VITE_BOARD_RECOG_FORCE_MOCK === '1';
}

/**
 * KS-3106: «толерантный» парсер ячеек low-confidence. Backend (prod
 * с загруженной моделью) может вернуть массив в одной из форм:
 *
 *   1. `[{ file, rank, piece, confidence }]` — формат, который ждёт
 *      фронт (camelCase, file=0..7 / rank=0..7 где 0=top).
 *   2. `[{ square: "a1", piece, confidence }]` — алгебраическая нотация
 *      одной строкой.
 *   3. `["a1", "h6", ...]` — просто массив строк (минимальный вариант,
 *      без piece/confidence).
 *   4. `[{ file: "a", rank: 1, ... }]` — file как буква, rank как
 *      1-based число (FEN-side, rank 8 — top).
 *
 * Нормализуем всё в `BoardRecognitionCell { file, rank, piece, confidence }`
 * нашего контракта. Невалидные элементы пропускаем (не падаем — UI
 * должен продолжить работать с тем что распарсилось).
 *
 * Этот же парсер используется и для `lowConfidenceCells` в 422-ответе
 * `recognition_unreliable`.
 */
export function normalizeLowConfidenceCells(input: unknown): BoardRecognitionCell[] {
  if (!Array.isArray(input)) return [];
  const out: BoardRecognitionCell[] = [];
  for (const raw of input) {
    if (typeof raw === 'string') {
      const cell = parseAlgebraicSquare(raw);
      if (cell) out.push({ ...cell, piece: '.', confidence: 0 });
      continue;
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      // KS-3106: piece может быть в `piece` (legacy/мок) или в
      // `predicted` (реальный backend, `{square, predicted, ...}`).
      const piece =
        typeof obj.piece === 'string'
          ? obj.piece
          : typeof obj.predicted === 'string'
            ? obj.predicted
            : '.';
      const confidence =
        typeof obj.confidence === 'number'
          ? obj.confidence
          : typeof (obj as { conf?: unknown }).conf === 'number'
            ? ((obj as { conf: number }).conf)
            : 0;
      // Сначала пробуем `square: "a1"`.
      if (typeof obj.square === 'string') {
        const cell = parseAlgebraicSquare(obj.square);
        if (cell) {
          out.push({ ...cell, piece, confidence });
          continue;
        }
      }
      // Дальше — `file`/`rank` в разных вариантах.
      const f = obj.file;
      const r = obj.rank;
      let fileIdx: number | null = null;
      let rankIdx: number | null = null;
      if (typeof f === 'number') {
        // 0..7 — наш контракт. Всё что вне диапазона — мусор.
        if (f >= 0 && f <= 7) fileIdx = f;
      } else if (typeof f === 'string' && f.length === 1) {
        const code = f.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 104) fileIdx = code - 97;
      }
      if (typeof r === 'number') {
        // Может быть 0-based (0=8-й ранг) или 1-based (1=1-й ранг,
        // 8=8-й ранг — FEN-side). Считываем как 0-based по умолчанию
        // (наш контракт), а если в диапазоне 1..8 — пробуем
        // интерпретировать как FEN-rank и конвертируем в наш 0..7
        // (rank 8 = 0, rank 1 = 7). НО только если строго в [1..8]
        // и file тоже валидный — иначе мусор.
        if (r >= 0 && r <= 7) {
          rankIdx = r;
        } else if (r >= 1 && r <= 8 && Number.isInteger(r)) {
          rankIdx = 8 - r;
        }
      }
      if (fileIdx !== null && rankIdx !== null) {
        out.push({ file: fileIdx, rank: rankIdx, piece, confidence });
      }
    }
  }
  return out;
}

/**
 * KS-3117: нормализатор массива `boards` от backend. Принимает unknown[]
 * (может быть undefined/null/массив объектов с разными формами полей),
 * возвращает `BoardRecognitionResponse[]` либо undefined если поле
 * отсутствует/пустое.
 *
 * Для каждой доски проверяем критичные поля `fen` и `fenBoard` (KS-3115
 * guard — без них рендерить editor нельзя). Нормализуем вложенный
 * `lowConfidenceCells` через `normalizeLowConfidenceCells`. Невалидные
 * элементы (без fen/fenBoard) пропускаем — defensive против частичных
 * payload'ов.
 */
export function normalizeBoards(
  input: unknown,
): BoardRecognitionResponse[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const out: BoardRecognitionResponse[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.fen !== 'string' || typeof obj.fenBoard !== 'string') {
      continue;
    }
    const normalized: BoardRecognitionResponse = {
      ...(obj as unknown as BoardRecognitionResponse),
      lowConfidenceCells: normalizeLowConfidenceCells(obj.lowConfidenceCells),
    };
    out.push(normalized);
  }
  return out.length > 0 ? out : undefined;
}

function parseAlgebraicSquare(
  sq: string,
): { file: number; rank: number } | null {
  if (sq.length !== 2) return null;
  const fileCh = sq[0].toLowerCase().charCodeAt(0);
  const rankCh = sq[1];
  if (fileCh < 97 || fileCh > 104) return null;
  if (rankCh < '1' || rankCh > '8') return null;
  // file: 'a'..'h' → 0..7. rank: '1'..'8' → 7..0 (FEN-top=0).
  return { file: fileCh - 97, rank: 8 - Number(rankCh) };
}

/**
 * KS-3108: толерантный парсер `orientation` поля от backend.
 * Strictly — это `'white' | 'black'` (см. apps/api), но историческая
 * совместимость + защита от рассинхрона на проде: принимаем также
 * `'w'`/`'b'`, boolean `flipped`/`flip`, числа 0/1. Всё остальное →
 * null (fallback на autodetect или дефолт `'white'`).
 */
export function normalizeOrientation(
  input: unknown,
): 'white' | 'black' | null {
  if (input === 'white' || input === 'black') return input;
  if (input === 'w') return 'white';
  if (input === 'b') return 'black';
  if (input === true) return 'black'; // `flipped: true` чаще = чёрные снизу
  if (input === false) return 'white';
  if (typeof input === 'number') {
    if (input === 0) return 'white';
    if (input === 1) return 'black';
  }
  return null;
}

/**
 * KS-3108: автодетект ориентации по позиции королей в FEN-board части.
 * Эвристика:
 *   - белый король на ранге 1-3 → доска повёрнута белыми вниз ('white');
 *   - белый король на ранге 6-8 → доска повёрнута чёрными вниз ('black');
 *   - неоднозначно (rank 4-5) — возвращаем null, оставляем backend.
 * Тот же подход, что backend-агент сам рекомендует в комментарии KS-3108.
 */
export function autodetectOrientationFromFen(
  fenBoard: string,
): 'white' | 'black' | null {
  const rows = fenBoard.split('/');
  if (rows.length !== 8) return null;
  // rowIdx=0 → ранг 8 (top FEN), rowIdx=7 → ранг 1 (bottom FEN).
  let whiteKingRank: number | null = null;
  let blackKingRank: number | null = null;
  rows.forEach((row, rowIdx) => {
    const fenRank = 8 - rowIdx;
    for (const ch of row) {
      if (ch === 'K') whiteKingRank = fenRank;
      else if (ch === 'k') blackKingRank = fenRank;
    }
  });
  // Если ни одного короля нет — не можем сказать.
  if (whiteKingRank === null && blackKingRank === null) return null;
  // Приоритет: белый король. Если есть оба, можно проверить
  // консистентность (чёрный должен быть на противоположной половине).
  const ranks: number[] = [];
  if (whiteKingRank !== null) ranks.push(whiteKingRank);
  if (blackKingRank !== null) ranks.push(8 - (blackKingRank as number) + 1); // зеркало
  // Если хоть один король указывает что white-side внизу (ранги 1-3 для
  // wK, 6-8 для bK) — это 'white' (стандартная ориентация).
  // Аналогично 'black'.
  if (whiteKingRank !== null) {
    if (whiteKingRank <= 3) return 'white';
    if (whiteKingRank >= 6) return 'black';
  }
  if (blackKingRank !== null) {
    if (blackKingRank >= 6) return 'white';
    if (blackKingRank <= 3) return 'black';
  }
  // Короли в центре (rank 4-5) — неоднозначно.
  return null;
}

/**
 * KS-3108: вычислить окончательную ориентацию редактора из
 * (backend-orientation, orientationConfidence, fenBoard).
 *   1. Если backend confidence >= 0.7 и orientation parsed — берём его.
 *   2. Иначе пробуем autodetect по королям; если он дал результат и
 *      РАСХОДИТСЯ с backend (или backend не parsed) — берём autodetect.
 *   3. Fallback — то, что вернул backend (parsed), или 'white'.
 * Backend сам в комментарии KS-3108 рекомендует именно этот алгоритм.
 */
export function resolveOrientation(
  backendOrientation: unknown,
  backendConfidence: unknown,
  fenBoard: string,
): 'white' | 'black' {
  const parsed = normalizeOrientation(backendOrientation);
  const conf =
    typeof backendConfidence === 'number' ? backendConfidence : 1;
  const auto = autodetectOrientationFromFen(fenBoard);
  if (parsed !== null && conf >= 0.7) {
    return parsed;
  }
  if (auto !== null) {
    // Используем эвристику если backend < 0.7 или не парсится / не задан.
    return auto;
  }
  return parsed ?? 'white';
}

/**
 * Отправляет изображение на распознавание. При недоступности backend'а —
 * возвращает мок (поведение KS-2365: «начинай с моком, пока KS-2363 не
 * закрыт»).
 *
 * Параметр `fetchImpl` нужен только для unit-тестов — production-код
 * вызывает без него и идёт через глобальный `fetch`.
 */
export async function recognizeBoard(
  file: File | Blob,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<BoardRecognitionResponse> {
  if (isForceMock()) {
    return buildMockResponse('VITE_BOARD_RECOG_FORCE_MOCK=1');
  }
  const form = new FormData();
  form.append('image', file, 'board.png');
  const headers: Record<string, string> = {};
  try {
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    /* ignore — приватный режим / SSR */
  }
  const fetchFn = options.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`${API_URL}/board-recognition`, {
      method: 'POST',
      body: form,
      headers,
      signal: options.signal,
    });
    if (res.status === 404 || res.status === 501) {
      return buildMockResponse(`backend ${res.status} (KS-2363 pending)`);
    }
    // KS-3094 / ADR-040-v2 §5.1. 400 `board_not_detected` — stage 1
    // не нашёл квадрат доски на загруженной картинке. Пробрасываем
    // доменной ошибкой, дропзона откроет crop-оверлей.
    if (res.status === 400) {
      let payload: BoardNotDetectedPayload;
      try {
        payload = (await res.json()) as BoardNotDetectedPayload;
      } catch {
        payload = { error: 'board_not_detected' };
      }
      throw new BoardNotDetectedError(payload);
    }
    // KS-3093 / ADR-040-v2 §5.1. 422 — backend распознал картинку, но
    // sanity отверг результат. Тело несёт `fenAttempt` (что модель
    // увидела) + `issues` (почему отвергло) + `lowConfidenceCells`. UI
    // должен показать fenAttempt и дать поправить, поэтому НЕ маскируем
    // мок-ответом — пробрасываем доменной ошибкой.
    if (res.status === 422) {
      let payload: BoardRecognitionUnreliablePayload;
      try {
        const raw = (await res.json()) as Record<string, unknown>;
        payload = {
          ...(raw as unknown as BoardRecognitionUnreliablePayload),
          // KS-3106: тот же normalize для 422-ветки, формат элементов
          // у бэка одинаковый что в 200, что в 422.
          lowConfidenceCells: normalizeLowConfidenceCells(raw.lowConfidenceCells),
        };
      } catch {
        payload = { error: 'recognition_unreliable' };
      }
      throw new BoardRecognitionUnreliableError(payload);
    }
    if (!res.ok) {
      // KS-3120: при любом не-2xx (5xx / 502 / 503) — пользователь
      // видел техническую строку `mock: network: board-recognition:
      // HTTP 500` поверх фейковой стартовой позиции. Раньше она
      // приходила из общего catch-блока, который маскировал ошибку
      // мок-ответом. Теперь любой не-2xx (кроме явно обработанных
      // 400/422 выше) → `BoardNotDetectedError`: дропзона переключается
      // в crop-overlay из KS-3094 с понятным сообщением «доска не
      // найдена, обрежьте кадр». Backend параллельно (KS-3119) поправит
      // 500 → 400, но фронт остаётся defensive в любом случае.
      throw new BoardNotDetectedError({
        error: 'board_not_detected',
        message: `Recognizer error (HTTP ${res.status}).`,
      });
    }
    // KS-3106: backend отдаёт элементы как
    // `{ square: "a8", predicted: "wK", confidence, top3 }`, а наш
    // внутренний тип — `{ file, rank, piece, confidence }`. Без
    // нормализации `cellToSquare()` в дропзоне получал `undefined`
    // и подсветка молча пропадала. `normalizeLowConfidenceCells`
    // принимает любую известную форму payload'а и приводит к
    // нашему контракту.
    const raw = (await res.json()) as Record<string, unknown>;
    // KS-3115: degenerate-случай — backend в новой v2 модели на
    // непригодной картинке возвращает 200 с `bbox: [0,0,0,0]` и БЕЗ
    // полей `fen`/`fenBoard`. Старая логика делала `fen.split(...)`
    // на undefined → uncaught TypeError в продакшен-бандле.
    // Конвертируем в нашу доменную ошибку `BoardNotDetectedError` —
    // дропзона уже умеет её показывать как crop-overlay («доска не
    // найдена, обрежьте кадр»). Backend не трогаем — фронт должен
    // переживать любой формат.
    if (typeof raw.fen !== 'string' || typeof raw.fenBoard !== 'string') {
      throw new BoardNotDetectedError({
        error: 'board_not_detected',
        message: 'Recognizer returned no FEN — board not found in image.',
      });
    }
    // KS-3117: если backend прислал `boards` — нормализуем массив.
    // Каждая доска получает свой набор lowConfidenceCells (нормализованных).
    // Spread кладёт raw.boards в normalized, даже если массив пустой —
    // явно убираем поле когда `normalizeBoards` вернул undefined, чтобы
    // потребитель `res.boards === undefined` корректно различал single
    // и multi-board сценарии.
    const boards = normalizeBoards(raw.boards);
    const normalized: BoardRecognitionResponse = {
      ...(raw as unknown as BoardRecognitionResponse),
      lowConfidenceCells: normalizeLowConfidenceCells(raw.lowConfidenceCells),
    };
    if (boards) {
      normalized.boards = boards;
    } else {
      delete normalized.boards;
    }
    return normalized;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    // KS-3093: 422 — это нормальная доменная ошибка, не сетевая.
    // Не подменяем её моком, дропзона ловит и переходит в edit-mode.
    if (err instanceof BoardRecognitionUnreliableError) throw err;
    // KS-3094: 400 board_not_detected — то же самое, доменная ошибка,
    // дропзона ловит и показывает crop-оверлей.
    if (err instanceof BoardNotDetectedError) throw err;
    // KS-3120: network-error (ECONNREFUSED, fetch failed и т.п.) —
    // раньше возвращался мок со стартовой позицией и тех. строкой в
    // warnings, что вводило пользователя в заблуждение «как будто
    // распозналась стартовая». Теперь — `BoardNotDetectedError` с
    // понятным message, дропзона показывает crop-overlay. Тех. detail
    // остаётся в console.warn для дебага. Mock-fallback для случая
    // «backend KS-2363 ещё не задеплоен» оставлен ТОЛЬКО на статусы
    // 404/501 (см. выше — там explicit для dev-сценария) и под
    // `VITE_BOARD_RECOG_FORCE_MOCK=1`.
    console.warn(
      '[recognizeBoard] network/unexpected error:',
      err instanceof Error ? err.message : String(err),
    );
    throw new BoardNotDetectedError({
      error: 'board_not_detected',
      message: 'Recognizer unavailable.',
    });
  }
}
