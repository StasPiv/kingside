/**
 * KS-2815 / ADR-059 / KS-2824 (T9). Контракт REST API для Studies.
 *
 * Источник истины — DTO `apps/api/src/study/`:
 *  - `StudyDto`, `StudyChapterDto` — те же поля, что отдаёт backend в
 *    JSON-ответах (даты — ISO-8601 string, не Date).
 *  - Request-типы повторяют class-validator DTO. Поля помечены
 *    `optional?` ровно там, где это разрешено `@IsOptional` в DTO.
 *
 * Frontend импортирует отсюда. Backend свои DTO держит локально
 * (class-validator декораторы), но возвращаемые JSON-объекты
 * структурно совпадают с типами ниже.
 *
 * Не путать с `lessons` / `user-courses` контрактом — Studies это
 * самостоятельная фича, никаких пересечений с Course/Lesson нет.
 */

/**
 * Разрешённые ориентации доски в главе. Whitelist валидируется
 * backend'ом, фронт может опираться на union literal.
 */
export type StudyChapterOrientation = 'white' | 'black';

/**
 * Режим главы. KS-2856 / ADR-060 §2.2 — Phase 2 включает все четыре
 * значения. Backend whitelist в `STUDY_CHAPTER_MODES` /
 * `apps/api/src/study/study-limits.ts`.
 */
export type StudyChapterMode =
  | 'analysis'
  | 'practice'
  | 'conceal'
  | 'gamebook';

/**
 * KS-2856 / ADR-060 §3.2. Тройная видимость студии:
 *   'private'  — только members;
 *   'unlisted' — по прямой ссылке (в каталог не попадает);
 *   'public'   — индексируется в каталоге, доступна всем.
 */
export type StudyVisibility = 'private' | 'unlisted' | 'public';

/**
 * KS-2856 / ADR-060 §3.2. Роли в `study_members`. `spectator`
 * (читатель публичной студии) implicit, в таблице не хранится.
 */
export type StudyMemberRole = 'owner' | 'contributor';

/**
 * KS-2856 / ADR-060 §3.3 R4. Узел gamebook payload'а.
 * Опубликован в API через `StudyChapterDto.gamebook.byUci[uci]`.
 */
export interface GamebookNode {
  hint?: string;
  success?: string;
  failure?: string;
}

/**
 * KS-2856 / ADR-060 §3.3 R4. Корневой gamebook payload автора главы.
 * Лимиты на стороне backend: 200 узлов, intro ≤ 2000 симв., каждое
 * текстовое поле ≤ 500 симв.
 */
export interface GamebookPayload {
  intro?: string;
  byUci?: Record<string, GamebookNode>;
}

/**
 * Короткая сводка студии без глав. Используется в каталоге
 * (`GET /api/studies`, `GET /api/studies/public`) и как обёртка
 * `study` в `StudyWithChaptersResponse`.
 */
export interface StudyDto {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  description: string | null;
  /**
   * DEPRECATED KS-2856 / ADR-060. Оставлено на время раскатки Phase 2;
   * источник истины — `visibility`. `isPublic === (visibility !== 'private')`.
   */
  isPublic: boolean;
  /** KS-2856 / ADR-060 §3.2. */
  visibility: StudyVisibility;
  /** KS-2856 / ADR-060 §3.4. Темы студии (lower-case, max 5). */
  topics: string[];
  /** KS-2856 / ADR-060 §3.4. Денормализованный счётчик лайков. */
  likes: number;
  /**
   * KS-2856 / ADR-060. Источник создания студии:
   *   'scratch' (default) | 'analysis:<id>' | 'broadcast:<roundId>'.
   */
  fromKind: string;
  /** UUID соответствующей сущности (analysisId / roundId), либо null. */
  fromRefId: string | null;
  /** Денормализованный счётчик глав (для каталога без COUNT JOIN'а). */
  chaptersCount: number;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp; обновляется при PATCH study / chapters. */
  updatedAt: string;
}

/**
 * Краткая сводка главы (без `pgn`) — используется в
 * `StudyWithChaptersResponse` для каталога глав, чтобы не тащить
 * мегабайты PGN в первый рендер страницы студии.
 */
export interface StudyChapterSummaryDto {
  id: string;
  name: string;
  orderIdx: number;
  startFen: string | null;
  orientation: StudyChapterOrientation;
  mode: StudyChapterMode;
  /** KS-2856 / ADR-060 §3.3 R3. Для mode='conceal'. */
  concealPly?: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Полная глава с `pgn` — используется в редакторе главы и в
 * publicChapter-эндпоинте. Сериализованный размер pgn ограничен
 * 256 КБ (см. `STUDY_LIMITS.chapterPgnMaxBytes` на backend).
 */
export interface StudyChapterDto {
  id: string;
  studyId: string;
  name: string;
  orderIdx: number;
  pgn: string;
  startFen: string | null;
  orientation: StudyChapterOrientation;
  mode: StudyChapterMode;
  /** KS-2856 / ADR-060 §3.3 R3. NULL для не-conceal режимов. */
  concealPly: number | null;
  /** KS-2856 / ADR-060 §3.3 R4. NULL для не-gamebook режимов. */
  gamebook: GamebookPayload | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Listing ─────────────────────────────────────────────────────────

/**
 * Ответ `GET /api/studies` (mine|public) и `GET /api/studies/public`.
 * Пагинации в MVP нет — лимит выборки 50 на запрос (clamp 1..50 на
 * backend).
 */
export interface StudyListResponse {
  data: StudyDto[];
}

// ─── Detail ──────────────────────────────────────────────────────────

/**
 * Ответ `GET /api/studies/:slug`. Главы отдаются без `pgn` для
 * экономии payload каталога; полный PGN запрашивается отдельно через
 * `GET /api/studies/:slug/chapters/:chapterId`.
 */
export interface StudyWithChaptersResponse {
  study: StudyDto;
  chapters: StudyChapterSummaryDto[];
}

/**
 * Ответ `GET /api/studies/public/c/:chapterId` (KS-2821 T6).
 * Помимо самой главы отдаёт минимальные метаданные родительской студии,
 * чтобы фронт мог показать «Из студии: <name>» без второго запроса.
 */
export interface PublicChapterResponse {
  chapter: StudyChapterDto;
  study: {
    id: string;
    slug: string;
    name: string;
    ownerId: string;
  };
}

// ─── Request bodies ──────────────────────────────────────────────────

/**
 * `POST /api/studies` — создать пустую студию. `name` обязателен,
 * `description` опциональный, `isPublic` опциональный (default false).
 */
export interface CreateStudyRequest {
  name: string;
  description?: string;
  /** DEPRECATED: см. StudyDto.isPublic. */
  isPublic?: boolean;
  /** KS-2856 / ADR-060 §3.2. */
  visibility?: StudyVisibility;
  /** KS-2856 / ADR-060 §3.4. Lower-case, max 5 элементов, ≤30 симв. */
  topics?: string[];
}

/**
 * `PATCH /api/studies/:slug` — все поля опциональные (партиальное
 * обновление). Включает toggle публичности — фронт может слать
 * `{isPublic: true|false}` напрямую без отдельного эндпоинта.
 */
export interface UpdateStudyRequest {
  name?: string;
  description?: string;
  /** DEPRECATED: см. CreateStudyRequest.isPublic. */
  isPublic?: boolean;
  visibility?: StudyVisibility;
  topics?: string[];
}

/**
 * Удобная обёртка для UI-«share toggle». В REST-роуты не отдельный
 * эндпоинт — это всё ещё PATCH `/api/studies/:slug` с одним полем,
 * см. UpdateStudyRequest. Тип объявлен для семантической ясности
 * на фронте (хук `useShareStudy()`).
 */
export interface ShareStudyRequest {
  isPublic: boolean;
}

/**
 * `POST /api/studies/:slug/chapters` — создать главу. `name` обязателен,
 * остальные поля опциональные. `pgn` может быть пустой строкой
 * (свежесозданная глава без ходов).
 */
export interface CreateChapterRequest {
  name: string;
  pgn?: string;
  startFen?: string;
  orientation?: StudyChapterOrientation;
  mode?: StudyChapterMode;
  /** KS-2856 / ADR-060 §3.3 R3. Для mode='conceal'. */
  concealPly?: number;
  /** KS-2856 / ADR-060 §3.3 R4. Для mode='gamebook'. */
  gamebook?: GamebookPayload;
}

/**
 * `PATCH /api/studies/:slug/chapters/:chapterId` — партиальное
 * обновление главы. `startFen: null` разрешён (явный сброс).
 */
export interface UpdateChapterRequest {
  name?: string;
  pgn?: string;
  startFen?: string | null;
  orientation?: StudyChapterOrientation;
  mode?: StudyChapterMode;
  concealPly?: number | null;
  gamebook?: GamebookPayload | null;
}

/**
 * KS-2856 / ADR-060 §3.3 R4 (KS-2861 B5). Специализированный
 * `PATCH /api/studies/:slug/chapters/:chapterId/gamebook` — отдельный
 * endpoint для frontend gamebook-editor'а (FM4). Тело — payload
 * целиком.
 */
export interface UpdateGamebookRequest {
  gamebook: GamebookPayload;
}

// ─── Members / likes / invites (B5) ──────────────────────────────────

/** KS-2856 / ADR-060 §3.2. Запись в `study_members`. */
export interface StudyMemberDto {
  studyId: string;
  userId: string;
  username: string | null;
  role: StudyMemberRole;
  addedAt: string;
}

export interface StudyMembersResponse {
  members: StudyMemberDto[];
}

/** KS-2856 / ADR-060 §3.2. `POST /api/studies/:slug/members`. */
export interface InviteMemberRequest {
  /** UUID или username (lookup в users.username case-insensitive). */
  userIdOrUsername: string;
}

/**
 * KS-2856 / ADR-060 §3.2. `POST /api/studies/:slug/invite-link`.
 * Backend генерирует одноразовый токен (TTL 7 дней) — фронт
 * показывает ссылку `/studies/invites/:token`.
 */
export interface InviteLinkResponse {
  token: string;
  expiresAt: string;
  url: string;
}

/** Ответ `POST /api/studies/invites/:token/accept`. */
export interface AcceptInviteResponse {
  study: StudyDto;
  role: StudyMemberRole;
}

/** Ответ `POST /api/studies/:slug/like` — toggle like. */
export interface ToggleLikeResponse {
  liked: boolean;
  likes: number;
}

/**
 * `PATCH /api/studies/:slug/chapters/:chapterId/order` —
 * переупорядочивание. `after = null` означает «в начало списка»;
 * `after = chapterId` — поставить после указанной главы. Backend
 * сам вычисляет новый `orderIdx` (среднее между соседями либо
 * rebalance шагами 1000).
 */
export interface ReorderChapterRequest {
  after: string | null;
}

/**
 * `POST /api/studies/:slug/import-pgn` — multi-PGN импорт. `pgn`
 * передаётся как одна большая строка; backend режет её `splitPgn`,
 * создаёт по главе на партию. Возвращает массив созданных глав
 * (см. `ImportPgnResponse`).
 */
export interface ImportPgnRequest {
  pgn: string;
}

export interface ImportPgnResponse {
  created: StudyChapterDto[];
}

/**
 * Ответ `GET /api/studies/:slug/export.pgn` и
 * `GET /api/studies/:slug/chapters/:chapterId/export.pgn`. Поле
 * `pgn` — text/x-chess-pgn содержимое; фронт может выставить
 * `Content-Type` сам при скачивании файла.
 */
export interface StudyExportPgnResponse {
  pgn: string;
}
