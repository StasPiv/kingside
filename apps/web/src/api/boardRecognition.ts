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
    if (!res.ok) {
      throw new Error(`board-recognition: HTTP ${res.status}`);
    }
    return (await res.json()) as BoardRecognitionResponse;
  } catch (err) {
    // KS-2363 не задеплоен → network-error / 404 / ECONNREFUSED. Не
    // ломаем UI, отдаём мок. После закрытия backend'а этот путь не
    // активен.
    if ((err as Error)?.name === 'AbortError') throw err;
    return buildMockResponse(
      `network: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
