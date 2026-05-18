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
        payload = (await res.json()) as BoardRecognitionUnreliablePayload;
      } catch {
        payload = { error: 'recognition_unreliable' };
      }
      throw new BoardRecognitionUnreliableError(payload);
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
    // KS-3093: 422 — это нормальная доменная ошибка, не сетевая.
    // Не подменяем её моком, дропзона ловит и переходит в edit-mode.
    if (err instanceof BoardRecognitionUnreliableError) throw err;
    // KS-3094: 400 board_not_detected — то же самое, доменная ошибка,
    // дропзона ловит и показывает crop-оверлей.
    if (err instanceof BoardNotDetectedError) throw err;
    return buildMockResponse(
      `network: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
