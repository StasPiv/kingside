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
 * Режим главы. В MVP backend whitelist = `['analysis']` (см.
 * `STUDY_CHAPTER_MODES` в `apps/api/src/study/study-limits.ts`).
 * На случай будущих режимов (`practice` / `conceal` / `gamebook`,
 * ADR-059 §B.2 «отложено в фазу 2») тип объявлен как `string` —
 * фронт может сузить union по месту использования.
 */
export type StudyChapterMode = string;

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
  isPublic: boolean;
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
  isPublic?: boolean;
}

/**
 * `PATCH /api/studies/:slug` — все поля опциональные (партиальное
 * обновление). Включает toggle публичности — фронт может слать
 * `{isPublic: true|false}` напрямую без отдельного эндпоинта.
 */
export interface UpdateStudyRequest {
  name?: string;
  description?: string;
  isPublic?: boolean;
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
