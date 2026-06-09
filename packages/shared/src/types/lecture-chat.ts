/**
 * KS-4008 / ADR-121 §6, §7, §8: контракты MVP чата лекции (Phase 1).
 *
 * Чат живёт в том же WS namespace `/live-analysis` (см.
 * `live-analysis.ts`), что и трансляция доски — отдельного namespace не
 * заводим (ADR-121 §1.3, §10 Phase 1). Зрители-анонимы получают
 * `chat:snapshot` в read-only режиме, попытка `chat:send` — `forbidden`.
 *
 * Имена WS-событий — `LectureChatEvents`. Импортировать на обе стороны,
 * строковые литералы локально не дублировать.
 */
/**
 * Тип сообщения. `user` — обычное от участника лекции; `system` —
 * служебное (закрепления, mute-олл и т.п., Phase 2 ADR-121).
 * Зеркало Prisma-enum `LectureChatMessageKind`.
 */
export type LectureChatMessageKind = 'user' | 'system';

// ─── Доменные типы ────────────────────────────────────────────────────

/**
 * Сообщение чата лекции, в форме, в которой gateway раздаёт его в
 * комнату и сохраняет в `chat:snapshot`. Удалённое модератором —
 * `text === '[удалено]'`, `deletedAt` выставлен; остальные поля
 * сохраняются для аудита и сохранения порядка ленты.
 */
export type LectureChatMessage = {
  id: string;
  lectureId: string;
  /** `null` для анонимов или после `User.delete` (FK SET NULL). */
  authorId: string | null;
  authorUsername: string | null;
  text: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** true если author — owner лекции (поле `LectureChatMessage.isTrainerMessage`). */
  isTrainerMessage: boolean;
  /** true для текущего pinned-сообщения. */
  pinned: boolean;
  /** ISO-8601 UTC; null если не удалено. */
  deletedAt: string | null;
  /** `user` — обычное; `system` — системное (закрепления, mute) (Phase 2). */
  kind: LectureChatMessageKind;
};

// ─── WS payloads: client → server ─────────────────────────────────────

/**
 * `chat:send` — клиент отправляет сообщение. Сервер обрабатывает в
 * порядке: mute-check → rate-limit (sliding window) → duplicate guard
 * → trim/length/control-char → persist + broadcast. См. ADR-121 §6.1.
 */
export type LectureChatSendPayload = {
  lectureId: string;
  text: string;
};

/**
 * `chat:delete` — тренер удаляет сообщение. Soft-delete (`deletedAt`,
 * текст заменяется на `[удалено]`). Не-тренеру — `forbidden`.
 */
export type LectureChatDeletePayload = {
  lectureId: string;
  messageId: string;
};

/**
 * `chat:mute` — тренер мьютит ученика в рамках текущей лекции.
 * Upsert `LectureChatMute(lectureId, userId)`. Targets'у на новый
 * `chat:send` будет приходить `chat:error { code: 'muted' }`.
 */
export type LectureChatMutePayload = {
  lectureId: string;
  userId: string;
};

// ─── WS payloads: server → client ─────────────────────────────────────

/**
 * `chat:message` — broadcast новой записи в комнату лекции. Эмитится
 * после успешного `chat:send`. Тренер тоже получает (включая своё
 * собственное сообщение — для подтверждения и ack-by-room).
 */
export type LectureChatMessageEvent = LectureChatMessage;

/**
 * `chat:snapshot` — отправляется одному клиенту при `subscribe` к
 * комнате лекции. Содержит последние N=100 сообщений и индивидуальный
 * `mutedSelf` (для текущего viewer'а). Для анонимов `mutedSelf=false`,
 * UI рендерит read-only состояние независимо от поля.
 */
export type LectureChatSnapshotEvent = {
  lectureId: string;
  messages: LectureChatMessage[];
  pinnedId: string | null;
  mutedSelf: boolean;
};

/**
 * `chat:delete` (server-side broadcast). Эмитится всем в комнате
 * после soft-delete. Клиент заменяет содержимое локально по `messageId`.
 */
export type LectureChatDeleteEvent = {
  lectureId: string;
  messageId: string;
};

/**
 * `chat:muted` — точечное уведомление muted-юзеру (через адресный
 * emit по его socket'у). Сообщает, кто его выключил (для UI overlay).
 */
export type LectureChatMutedEvent = {
  lectureId: string;
  byUserId: string;
};

/**
 * `chat:error` — ошибка обработки `chat:send`/`chat:delete`/`chat:mute`.
 *   - `rate_limited` — превышено окно 3 сообщения / 10 сек.
 *   - `too_long` — длина текста после trim > 500 unicode-codepoints.
 *   - `too_short` — после trim 0 символов.
 *   - `duplicate` — то же сообщение, что предыдущее от того же автора
 *     (TTL 30 сек).
 *   - `muted` — пользователь в `LectureChatMute` для текущей лекции.
 *   - `forbidden` — не-тренер пытается delete/mute, либо аноним шлёт
 *     chat:send, либо лекция/доступ ограничены.
 *   - `closed` — лекция уже `closed` (вкл. force-end) — приём остановлен.
 *   - `invalid_payload` — невалидный DTO (например, нет lectureId).
 *   - `not_found` — для delete/mute: лекция или target не найдены.
 *   - `control_char` — текст содержит запрещённые контрольные символы.
 */
export type LectureChatErrorCode =
  | 'rate_limited'
  | 'too_long'
  | 'too_short'
  | 'duplicate'
  | 'muted'
  | 'forbidden'
  | 'closed'
  | 'invalid_payload'
  | 'not_found'
  | 'control_char';

export type LectureChatErrorEvent = {
  code: LectureChatErrorCode;
  message: string;
};

// ─── Имена WS-событий ─────────────────────────────────────────────────

/**
 * KS-4008 / ADR-121 §6. Имена событий чата в namespace `/live-analysis`.
 * Префикс `chat:` — не пересекается с `live-analysis:*` (события доски)
 * и `webrtc:*` (P2P аудио, ADR-116).
 */
export const LectureChatEvents = {
  // client → server
  SEND: 'chat:send',
  DELETE: 'chat:delete',
  MUTE: 'chat:mute',
  // server → client
  MESSAGE: 'chat:message',
  SNAPSHOT: 'chat:snapshot',
  DELETED: 'chat:delete',
  MUTED: 'chat:muted',
  ERROR: 'chat:error',
} as const;

export type LectureChatEventName =
  (typeof LectureChatEvents)[keyof typeof LectureChatEvents];

// ─── Константы лимитов ───────────────────────────────────────────────

/**
 * ADR-121 §6.1. Сервер-side лимиты, дублируются на клиенте для UX.
 */
export const LECTURE_CHAT_LIMITS = {
  /** Максимум unicode-codepoints в одном сообщении после trim. */
  MAX_TEXT_LENGTH: 500,
  /** Sliding window: сколько сообщений за окно. */
  RATE_LIMIT_WINDOW_COUNT: 3,
  /** Sliding window: длина окна, мс. */
  RATE_LIMIT_WINDOW_MS: 10_000,
  /** Duplicate guard: TTL хеша последнего сообщения автора, сек. */
  DUPLICATE_TTL_SEC: 30,
  /** Сколько последних сообщений отдаём в `chat:snapshot`. */
  SNAPSHOT_LIMIT: 100,
} as const;
