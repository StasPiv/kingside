export * from './types/game.js';
export * from './types/user.js';
export * from './types/puzzle.js';
export * from './types/puzzle-gen.js';
export * from './types/lessons.js';
export * from './types/user-courses.js';
export * from './types/video-url.js';
export * from './types/api-contracts.js';
export * from './types/feature-flags.js';
export * from './types/synthetic.js';
export * from './types/internal-auth.js';
export * from './types/tactic-drill.js';
// KS-4342 / ADR-135 §2.4: контракты API /tactic-puzzles/* (раздел
// «Точность» на Maia-difficulty).
export * from './types/tactic-puzzle.js';
// KS-4408 / ADR-137 rev2: контракты API /blog/*.
export * from './types/blog.js';
export * from './types/saved-filters.js';
// KS-3269 (ADR-077): Opening Trainer.
export * from './types/opening-trainer.js';
// KS-3731 (ADR-110): live-трансляция анализа партии (events + DTO).
export * from './types/live-analysis.js';
// KS-4008 (ADR-121 Phase 1): MVP чата лекции (контракты WS + лимиты).
export * from './types/lecture-chat.js';
// KS-4023 (ADR-122): аналитика позиционных метрик партии (DTO + версия).
export * from './types/positional-trace.js';
// KS-4071: единый источник истины для разбиения подкомпонент Stockfish
// на 7 групп `metrics` LLM-комментария (формула tapered, состав групп,
// знаковая конвенция white-signed / owner-signed).
export * from './review/metrics-comment.js';
// KS-4194 (ADR-128 §7.3 + §10 KS-9): контракт задачи prerender-воркера.
export * from './types/prerender-task.js';
// KS-4639 / ADR-143: shared-контракт индекса упоминаний хода в записи
// лекции (типы + serializeMoveKey/parseMoveKey) — формальная точка
// истины для builder'а индекса (`utils/lecture-replay/...`) и его
// потребителей (Moves panel, popover).
export * from './types/lecture-replay.js';
// KS-4639 / ADR-143 §5: чистая функция-builder индекса упоминаний.
// Используется `LectureReplayPage` один раз через useMemo по
// `recording.events` + `recording.durationMs`.
export * from './utils/lecture-replay/buildMoveTimestampIndex.js';
export * from './synthetic-chat-phrases.js';
export * from './constants.js';
export * from './constants/archive.js';
// KS-4689 / ADR-147 §4.2 + §4.2.1 + §9: контракты контекстных подсказок —
// enum anchor'ов, payload WS-события `hint:show` и REST lifecycle,
// список тихих страниц для `HintsEngine`.
export * from './types/hint-anchors.js';
export * from './types/hint-payload.js';
// KS-4825 / ADR-154: server-side подстановка `{{var}}` в payload
// контекстной подсказки + whitelist по trigger_event_type.
export * from './types/hint-templating.js';
export * from './constants/hint-quiet-pages.js';
// KS-4798 / ADR-152 §2.3: каталог UI-меты событий + SYSTEM_EVENT_TYPES
// (frontend — рендер `/me/actions`, backend — серверный фильтр в
// `GET /me/events`).
export * from './types/event-catalog.js';
export * from './utils/time-control.js';
export * from './utils/fen-key.js';
export * from './utils/archive-name-normalize.js';
export * from './utils/wdl.js';
export * from './utils/puzzle-gen-core.js';
export * from './utils/puzzle-gen-pipeline.js';
// KS-4338 / ADR-135: новый алгоритм генерации tactic-пазлов на
// Maia-difficulty. Живёт параллельно со старым puzzle-gen-pipeline.
export * from './utils/tactic-puzzle-gen.js';
export * from './utils/move-classification.js';
export * from './utils/precision-score.js';
// KS-3407 (ADR-086 S2): сравнение хода в guess-the-move.
export * from './utils/guess-move.js';
// KS-3439 (ADR-088 S2): move-generator blind-board (4 фигуры, без шахов/королей).
export * from './utils/blind-board/move-gen.js';
// KS-4981 / ADR-167: Vision-тренажёр зрения доски — типы, isDarkSquare,
// генераторы/валидаторы челленджей (на move-gen.ts, без нового движка).
export * from './types/vision.js';
export * from './utils/vision/is-dark-square.js';
export * from './utils/vision/challenge.js';
// KS-3359 (ADR-080): whitelist + группы для Precision Themes.
export * from './utils/precision-themes.js';
export * from './chess/index.js';
// KS-4855 / ADR-159 §7 п.1: разбор PGN broadcast-трансляций Lichess.
// Раньше жил в apps/broadcast-service — вынесен сюда, чтобы клиент мог
// использовать ту же реализацию (см. ADR-159 §2.2).
export * from './broadcast-pgn/index.js';
// KS-2962 / ADR-062: каталог фич для AI-ассистента.
export * from './features-catalog/index.js';
// NB: `./utils/position-key.js` намеренно НЕ реэкспортируется — он тянет `node:crypto`
// и ломает браузерный бандл. Backend (apps/api, apps/archive-service) импортирует
// функцию напрямую: `@kingside/shared/dist/utils/position-key`.
// NB: `./prerender-client.js` (KS-4203, ADR-128 §10 #10) — Node-only,
// тянет `@aws-sdk/client-sqs`. По той же причине НЕ реэкспортируется.
// Backend импортирует напрямую: `@kingside/shared/dist/prerender-client`.
