/**
 * KS-3269 (ADR-077). Shared types для Opening Trainer — тренировка
 * дебютов из пользовательского PGN.
 *
 * Контракт между:
 *   - backend (`apps/api/src/opening-trainer/*` — controller, service, DTO)
 *   - frontend (`apps/web/src/pages/opening-trainer/*`, hooks)
 *
 * Источник истины — ADR-077 §3 (RepertoireTree), §6 (12 endpoints).
 * Семантические правила (бот-picker, скоринг, мастеринг) описаны в
 * §2.3 / §2.7 / §2.5 ADR'а и здесь только как константы.
 */

// ─── Enum-style unions ─────────────────────────────────────────────────

/** Цвет фигур пользователя в сессии (бот играет другим цветом). */
export type TrainerColor = 'white' | 'black';

/**
 * Режим тренировки:
 *   - `learn`     — учим новые линии (без SM-2, до 3 подряд правильных = mastered)
 *   - `review`    — SRS по линиям с `sm2DueAt <= now` (M2)
 *   - `mistakes`  — только линии, где `wrongCount > 0`
 *   - `free`      — свободная прогонка по всему репертуару, без обновления статистики
 */
export type OpeningTrainerMode = 'learn' | 'review' | 'mistakes' | 'free';

/**
 * Что делать когда в позиции пройдены все edges:
 *   - `cycle`    — обнуляем `playedLines[fen]` и продолжаем
 *   - `complete` — финиш сессии (default для M1)
 */
export type OpeningTrainerRepeatMode = 'cycle' | 'complete';

/** Статус сессии для UX. */
export type OpeningTrainerSessionStatus = 'active' | 'finished' | 'expired';

/**
 * Результат проверки хода пользователя.
 *
 * KS-3277 расширение для «учить дерево до полного освоения»:
 *   - `line-restart`  — линия закончилась, сессия не финиширует,
 *     бек откатывает доску к ближайшей развилке с непройденными
 *     вариантами и продолжает.
 *   - `tree-complete` — всё дерево пройдено без ошибок, сессия
 *     автоматически финишируется.
 *
 * `line-complete` оставлен для обратной совместимости и редких краевых
 * случаев; в основном flow KS-3277 фронт получает `line-restart` или
 * `tree-complete`.
 */
export type OpeningTrainerMoveResult =
  | 'correct'
  | 'wrong'
  | 'line-complete'
  | 'line-restart'
  | 'tree-complete';

// ─── Tree (ADR-077 §2.2) ──────────────────────────────────────────────

/**
 * Хард-лимиты репертуара (превышение → 400 при POST/PATCH).
 * Должны совпадать с серверной валидацией.
 */
export const OPENING_REPERTOIRE_LIMITS = {
  /** Максимум уникальных позиций (FEN'ов после транспозиций). */
  maxNodes: 2000,
  /** Максимум edges (вариантов; одна позиция может иметь несколько). */
  maxEdges: 5000,
  /** Максимум глубина в полуходах = 40 ходов. */
  maxDepthHalfMoves: 80,
  /** Максимум размер исходного PGN в байтах. */
  maxPgnBytes: 500 * 1024,
  /** Максимум репертуаров на пользователя (MVP). */
  maxRepertoiresPerUser: 50,
  /** Максимум активных (незакрытых) сессий на пользователя. */
  maxActiveSessionsPerUser: 10,
  /**
   * KS-3324 / ADR-078. Максимум источников (PGN-блоков) в одном
   * репертуаре. Превышение → 400/409 при `POST /repertoires` или
   * `POST /repertoires/:id/sources`.
   */
  maxSourcesPerRepertoire: 20,
} as const;

/**
 * Скоринг (ADR-077 §2.7). Серверная функция (KS-3272) считает по этим
 * правилам, фронт повторяет логику только для предиктивного UI —
 * source of truth всегда `scoreDelta` в response.
 */
export const OPENING_TRAINER_SCORING = {
  /** Правильный ход без подсказки. */
  correctNoHint: 10,
  /** Правильный ход после `hint`. */
  correctWithHint: 5,
  /** Бонус за быстрый правильный ход (< 5 секунд от показа позиции). */
  fastBonusMs: 5000,
  fastBonusPoints: 1,
  /** Неправильный ход (минимум баланс 0 — не уходим в минус). */
  wrong: -5,
  /** Streak triggers at this count of consecutive correct moves. */
  streakThreshold: 5,
  /** Multiplier для streak-бонуса, применяется до первой ошибки. */
  streakMultiplier: 1.2,
} as const;

/**
 * Сколько подряд правильных проходов линии нужно чтобы она считалась
 * «mastered» и попала в SRS-очередь (M2). M1 хранит counter, но
 * SRS-инициализация — в M2.
 */
export const OPENING_LINE_MASTERY_THRESHOLD = 3;

/**
 * Edge — переход из родительской позиции в дочернюю по одному ходу.
 * NAG'и и комментарии сохраняются на edge'ах, потому что одна и та же
 * позиция может быть достигнута разными ходами (но это редкость).
 */
export interface RepertoireEdge {
  /** UCI хода: 'e2e4', 'e7e8q' (promotion). */
  moveUci: string;
  /** SAN хода для отображения: 'e4', 'Nf3', 'O-O'. */
  moveSan: string;
  /** FEN позиции ПОСЛЕ этого хода (ключ соответствующего child-node). */
  childFen: string;
  /**
   * Numeric Annotation Glyphs из PGN-источника (опц.).
   * `[1] = "!"`, `[2] = "?"`, `[3] = "!!"`, `[4] = "??"`, `[5] = "!?"`,
   * `[6] = "?!"`. Multi-NAG возможен (`[1,14]` = "! ±").
   */
  nag?: number[];
  /** Авторский комментарий из PGN (`{ ... }`). */
  comment?: string;
  /**
   * KS-3324 / ADR-078. UUID источников (`OpeningRepertoireSourceDto.id`),
   * которые «закодировали» этот edge. При транспозиции (один и тот же
   * UCI из одного FEN'а пришёл из нескольких источников) — массив
   * содержит все эти ID. После удаления источника edges, оставшиеся с
   * пустым `sourceIds`, удаляются из дерева; orphan-pruning срабатывает
   * на линиях которые больше нечем поддерживать.
   *
   * Опц. (`?`) для backward-compat: старые JSONB-tree, созданные до
   * миграции multi-source, не содержат поля. После миграции legacy-
   * репертуары получают `sourceIds = [<legacy-source-id>]`.
   */
  sourceIds?: string[];
}

/**
 * Node = уникальная позиция (по FEN). Edges — все ходы из этой позиции,
 * закодированные в репертуаре. У одной позиции может быть несколько
 * edges, если автор записал несколько вариантов.
 */
export interface RepertoireNode {
  /** FEN — дубликат ключа в `RepertoireTree.nodes`, удобство для итерации. */
  fen: string;
  /** Ходы из этой позиции. Пустой массив = «конец линии» (line-complete). */
  edges: RepertoireEdge[];
}

/**
 * Дерево репертуара — структурированный PGN с транспозициями
 * (одинаковая позиция, достигнутая разными путями, схлопывается в один
 * node). Парсится на бэке при создании/обновлении репертуара.
 */
export interface RepertoireTree {
  /** FEN корневой позиции (обычно стандартная стартовая). */
  rootFen: string;
  /** Все узлы дерева, ключ — FEN позиции. */
  nodes: Record<string, RepertoireNode>;
  /** Метаданные для лимитов и UI (счётчики). */
  meta: {
    nodeCount: number;
    edgeCount: number;
    /** Максимум полуходов от корня до листа. */
    maxDepth: number;
  };
}

// ─── Domain DTOs ──────────────────────────────────────────────────────

/**
 * Карточка репертуара в списке. БЕЗ дерева — оно тяжёлое; для tree
 * запрашивается `GET /opening-trainer/repertoires/:id`.
 */
export interface OpeningRepertoireDto {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  /**
   * KS-3302. Сторона за которую пользователь тренирует репертуар
   * (white/black). Фиксируется при создании, не выбирается при
   * старте сессии. Один репертуар = одна сторона.
   */
  side: TrainerColor;
  /** Из `tree.meta`, дубликат для лобби-списка. */
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Агрегаты прогресса для tree-view покраски и лобби-стат-блока (M2,
 * в M1 заполняются нулями).
 */
export interface OpeningRepertoireStats {
  /** Линий со статусом mastered (`OPENING_LINE_MASTERY_THRESHOLD`+ подряд). */
  masteredLines: number;
  /** Линий хотя бы раз пройденных, но не masered. */
  learningLines: number;
  /** Линий с хотя бы одной ошибкой. */
  wrongLines: number;
  /** Всего уникальных листовых линий в дереве. */
  totalLines: number;
}

/** Карточка + агрегаты (опц. через `?include=stats`). */
export interface OpeningRepertoireWithStatsDto extends OpeningRepertoireDto {
  stats: OpeningRepertoireStats;
}

/**
 * KS-3324 / ADR-078 §2.1. Источник репертуара (один PGN-блок).
 * Один репертуар может содержать 1..`maxSourcesPerRepertoire` источников.
 *
 *   - `pgn-upload`         — загружен пользователем через форму.
 *   - `workshop-analysis`  — конверсия из мастерской (KS-3293
 *                            `POST /repertoires/from-analysis`).
 *   - `legacy-import`      — миграция из старого `OpeningRepertoire.pgn`
 *                            (один-source-fallback для существующих
 *                            до multi-source репертуаров).
 */
export type OpeningRepertoireSourceKind =
  | 'pgn-upload'
  | 'workshop-analysis'
  | 'legacy-import';

export interface OpeningRepertoireSourceDto {
  id: string;
  repertoireId: string;
  /**
   * UI-имя источника. Опц. — если null, фронт показывает fallback
   * (`[Event]` из PGN-header'а или `PGN N` по порядковому номеру).
   */
  name: string | null;
  /** Исходный PGN этого блока. */
  pgn: string;
  sourceKind: OpeningRepertoireSourceKind;
  /**
   * Если `sourceKind === 'workshop-analysis'` — UUID анализа из
   * мастерской. Опц. для прочих kinds.
   */
  sourceAnalysisId: string | null;
  /**
   * Стабильный sort-order (0..N). Не пересчитывается при удалении
   * соседних источников; фронт сортирует по этому полю.
   */
  order: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Полный вид: карточка + дерево + список источников.
 *
 * Поле `pgn` оставлено для backward-compat — это денормализованный
 * concat всех `sources[].pgn` (стабильный порядок по `order`). Старые
 * клиенты, которые читают `pgn` напрямую, продолжают работать.
 */
export interface OpeningRepertoireDetailDto extends OpeningRepertoireDto {
  /**
   * Денормализованный concat всех `sources[].pgn` (для backward-compat
   * и экспорта). После KS-3324/ADR-078 — derived поле, не источник истины.
   */
  pgn: string;
  tree: RepertoireTree;
  /**
   * KS-3324 / ADR-078. Источники, из которых собрано дерево. Минимум
   * один (репертуар не может быть пустым после миграции legacy-import).
   */
  sources: OpeningRepertoireSourceDto[];
}

/**
 * Сессия тренировки. Per-session состояние — `playedLines` (`Json` в БД),
 * не возвращается во фронт; для UX фронту достаточно `currentFen` +
 * counters.
 */
export interface OpeningTrainerSessionDto {
  id: string;
  repertoireId: string;
  side: TrainerColor;
  mode: OpeningTrainerMode;
  repeatMode: OpeningTrainerRepeatMode;
  status: OpeningTrainerSessionStatus;
  /** Текущая FEN позиция. Для resume через 7 дней. */
  currentFen: string;
  /** UCI-путь от корня до `currentFen` — для рисования стрелок последнего хода. */
  currentPath: string[];
  score: number;
  /**
   * Количество примененных к доске ходов (только correct — wrong-попытки
   * отвергаются и доску не двигают). НЕ ИСПОЛЬЗОВАТЬ для accuracy:
   * `movesPlayed === correctMoves` всегда. Для процента точности —
   * `accuracyPercent` (см. ниже).
   */
  movesPlayed: number;
  correctMoves: number;
  wrongMoves: number;
  hintsUsed: number;
  /**
   * KS-3307. Точность как процент: `correctMoves / (correctMoves +
   * wrongMoves) * 100`, округлено до целого. 0 если попыток не было.
   * Backend вычисляет — фронт берёт готовое (старая локальная формула
   * `correctMoves / movesPlayed` давала 100% при наличии ошибок).
   */
  accuracyPercent: number;
  startedAt: string;
  lastActivityAt: string;
  finishedAt: string | null;
}

/**
 * Одна попытка — для аудита и tree-view ошибок (M2). В M1 сохраняется,
 * наружу через API экспортируется только в `finish`-summary.
 */
export interface OpeningTrainerAttemptDto {
  id: string;
  sessionId: string;
  positionFen: string;
  /** Что ожидалось в этой позиции (массив UCI). */
  expectedMoves: string[];
  /** Что прислал пользователь (UCI). */
  userMove: string;
  correct: boolean;
  hintUsed: boolean;
  scoreDelta: number;
  /** Время от показа позиции до отправки хода (для streak/fast-bonus). */
  responseTimeMs: number;
  createdAt: string;
}

/**
 * KS-3286 (M2). Статус линии для tree-view покраски и лобби-счётчиков.
 *
 *   - `not-played` — нет записи в OpeningLineProgress (computed на фронте
 *     сопоставлением tree.nodes с массивом lines). Серый цвет.
 *   - `learning`   — есть попытки, но не mastered. Жёлтый.
 *   - `wrong`      — `wrongCount > correctCount` (преобладают ошибки). Красный.
 *   - `mastered`   — `masteredAt != null && (!sm2DueAt || sm2DueAt > now)`.
 *     Зелёный.
 *   - `due`        — mastered + `sm2DueAt <= now` (пора повторить). Синий.
 *
 * Backend вычисляет в `GET /opening-trainer/repertoires/:id/progress`
 * (KS-3292 / B6).
 */
export type OpeningLineStatus =
  | 'not-played'
  | 'learning'
  | 'wrong'
  | 'mastered'
  | 'due';

/**
 * Прогресс по конкретной линии (от root до точки замера). Per-path, не
 * per-edge — мастеринг оценивается по полной цепочке. M2.
 *
 * KS-3286: добавлено `status` (derived backend'ом) и `orphaned` —
 * флаг что линия из старого PGN больше не существует в репертуаре
 * после редактирования (M2 §2.5). Orphan не учитывается в SRS-выборках
 * и не рендерится в tree-view (KS-3294 / B8 orphan-pruning).
 */
export interface OpeningLineProgressDto {
  id: string;
  repertoireId: string;
  /** SHA-1 от `join('|', pathUci)` — короткий ключ для уникальности. */
  pathHash: string;
  pathUci: string[];
  /** Длина пути в полуходах. */
  pathLength: number;
  correctCount: number;
  wrongCount: number;
  consecutiveCorrect: number;
  lastPlayedAt: string;
  masteredAt: string | null;
  /** SM-2 SRS-поля (M2, до мастеринга — null). */
  sm2DueAt: string | null;
  sm2Interval: number | null;
  sm2Easiness: number | null;
  sm2Reps: number | null;
  /**
   * KS-3286 (M2 §2.5). `true` если линия из старого PGN больше не
   * существует в дереве (после `PATCH /repertoires/:id` с новым PGN).
   * Backend проставляет в KS-3294 (B8) при пересборке tree. Orphan'ы
   * не учитываются в SRS-выборках и не рендерятся в tree-view.
   * Default `false` — поле опц. для backward-compat (старые записи
   * без поля считаются не-orphan).
   */
  orphaned?: boolean;
  /**
   * KS-3286. Derived статус для UI — вычисляется backend'ом в
   * `GET /repertoires/:id/progress` (KS-3292). Опц. потому что
   * raw-row из БД не имеет этого поля; присутствует только в DTO.
   */
  status?: OpeningLineStatus;
}

// ─── Request bodies ───────────────────────────────────────────────────

/**
 * KS-3324 / ADR-078 §4. Один блок-источник внутри
 * `CreateOpeningRepertoireRequest.sources` или
 * `CreateRepertoireSourceRequest`. Лимит размера PGN —
 * `OPENING_REPERTOIRE_LIMITS.maxPgnBytes` (применяется per-source).
 */
export interface OpeningRepertoireSourceInput {
  pgn: string;
  /**
   * UI-подпись источника. Опц. — backend проставляет fallback (`[Event]`
   * из PGN-header'а или `PGN N`).
   */
  name?: string;
}

/**
 * `POST /opening-trainer/repertoires`.
 *
 * KS-3324 / ADR-078. Поддерживает оба формата body:
 *   - **Новый (рекомендуется):** `{ title, sources: [{ pgn, name? }, ...] }`
 *     — minimum 1 source, maximum `maxSourcesPerRepertoire`.
 *   - **Legacy (deprecated):** `{ title, pgn }` — backend конвертирует
 *     в `sources: [{ pgn, name: null }]` с `sourceKind='pgn-upload'`.
 *
 * Указывать одновременно `pgn` и `sources` — 400 BadRequest.
 */
export interface CreateOpeningRepertoireRequest {
  title: string;
  description?: string;
  /**
   * @deprecated KS-3324. Используй `sources`. Поле сохранено для
   * backward-compat со старыми клиентами; backend конвертирует в
   * single-source. Указывать одновременно с `sources` нельзя.
   */
  pgn?: string;
  /**
   * KS-3324 / ADR-078. Массив источников (1..`maxSourcesPerRepertoire`).
   * Каждый source создаёт запись в `opening_repertoire_sources` с
   * `sourceKind='pgn-upload'`.
   */
  sources?: OpeningRepertoireSourceInput[];
  /**
   * KS-3302. Сторона тренировки (white/black). Опц. — default 'white'
   * (backward-compat: старые клиенты, которые не знают про это поле,
   * получат white-репертуар).
   */
  side?: TrainerColor;
}

/**
 * KS-3324 / ADR-078 §4. `POST /opening-trainer/repertoires/:id/sources`.
 * Добавить ещё один источник в существующий репертуар. Триггерит
 * пересборку tree (через builder с union-edges по sourceIds) и
 * orphan-pruning прогресса.
 *
 * 409 Conflict если уже достигнут `maxSourcesPerRepertoire`.
 */
export interface CreateRepertoireSourceRequest {
  pgn: string;
  name?: string;
  /**
   * Опц. — backend по умолчанию проставит `'pgn-upload'`. Передаётся
   * `'workshop-analysis'` при использовании конверсии из мастерской
   * через KS-3293 расширение (см. `CreateOpeningRepertoireFromAnalysisRequest.repertoireId`).
   */
  sourceKind?: OpeningRepertoireSourceKind;
  /** Для `sourceKind='workshop-analysis'` — UUID анализа. */
  sourceAnalysisId?: string;
}

/**
 * KS-3324 / ADR-078 §4. `PATCH /opening-trainer/repertoires/:id/sources/:sourceId`.
 * Все поля опциональны; нужно прислать хотя бы одно. Если меняется
 * `pgn` — backend пересобирает tree и делает orphan-pruning. Изменение
 * только `name` — без пересборки.
 */
export interface UpdateRepertoireSourceRequest {
  pgn?: string;
  /** `null` чтобы очистить и вернуться к fallback. */
  name?: string | null;
}

/** `PATCH /opening-trainer/repertoires/:id`. Все поля опциональны. */
export interface UpdateOpeningRepertoireRequest {
  title?: string;
  /** `null` чтобы очистить. */
  description?: string | null;
  /** Если задан — пересборка дерева; прогресс НЕ сбрасывается. */
  pgn?: string;
  /**
   * KS-3302. Смена стороны репертуара. Допустимо, но обычно делается
   * один раз при создании. UI не показывает поле в edit-форме.
   */
  side?: TrainerColor;
}

/**
 * KS-3286 (M2 §5 / KS-3293 B7). `POST /opening-trainer/repertoires/
 * from-analysis` — конверсия из мастерской («использовать как
 * репертуар» в карточке анализа).
 *
 * Backend берёт `Analysis.pgn` из текущего юзера (owner-check), парсит
 * через тот же repertoire-builder. `title` по умолчанию = `Analysis.title`
 * или его `headline`. Чужой analysisId → 404, пустой PGN → 400.
 */
export interface CreateOpeningRepertoireFromAnalysisRequest {
  analysisId: string;
  title?: string;
  description?: string;
  /** KS-3302. Сторона тренировки. Default 'white'. */
  side?: TrainerColor;
  /**
   * KS-3324 / ADR-078. Если задан — добавляет PGN анализа КАК ИСТОЧНИК
   * в существующий репертуар (вместо создания нового). Backend проверяет
   * ownership репертуара (404 для чужого), лимит `maxSourcesPerRepertoire`
   * (409 при превышении). Возвращает обновлённый `OpeningRepertoireDetailDto`
   * существующего репертуара (а не свежесозданный).
   *
   * Опц. для backward-compat: без него — старое поведение (новый
   * репертуар, KS-3293).
   */
  repertoireId?: string;
}

/**
 * `POST /opening-trainer/repertoires/:id/sessions`.
 *
 * KS-3302: `side` помечен опц. и backend'ом ИГНОРИРУЕТСЯ — фактический
 * side берётся из `repertoire.side` (фиксируется при создании). Старые
 * клиенты, отправляющие `side`, не сломаются.
 */
export interface StartOpeningTrainerSessionRequest {
  /** @deprecated KS-3302: игнорируется backend'ом, берётся из repertoire. */
  side?: TrainerColor;
  mode: OpeningTrainerMode;
  /** Default `complete`. */
  repeatMode?: OpeningTrainerRepeatMode;
}

/** `POST /opening-trainer/sessions/:sid/move`. */
export interface OpeningTrainerMoveRequest {
  /** UCI хода: 'e2e4', 'g1f3', 'e7e8q'. */
  moveUci: string;
  /** Миллисекунды от показа позиции до отправки. Для fast-bonus / SRS. */
  responseTimeMs: number;
}

/** `POST /opening-trainer/sessions/:sid/undo`. Тело пустое. */
export type OpeningTrainerUndoRequest = Record<string, never>;

/** `POST /opening-trainer/sessions/:sid/hint`. Тело пустое. */
export type OpeningTrainerHintRequest = Record<string, never>;

/** `POST /opening-trainer/sessions/:sid/giveup`. Тело пустое. */
export type OpeningTrainerGiveupRequest = Record<string, never>;

/** `POST /opening-trainer/sessions/:sid/finish`. Тело пустое. */
export type OpeningTrainerFinishRequest = Record<string, never>;

// ─── Response bodies ──────────────────────────────────────────────────

/**
 * `GET /opening-trainer/repertoires`.
 * Поле `stats` присутствует только при `?include=stats`.
 */
export interface ListOpeningRepertoiresResponse {
  repertoires: Array<OpeningRepertoireDto | OpeningRepertoireWithStatsDto>;
}

/** `POST /opening-trainer/repertoires` — возвращает полный repertoire с tree. */
export type CreateOpeningRepertoireResponse = OpeningRepertoireDetailDto;

/** `GET /opening-trainer/repertoires/:id` — карточка + дерево. */
export type GetOpeningRepertoireResponse = OpeningRepertoireDetailDto;

/** `PATCH /opening-trainer/repertoires/:id` — обновлённая карточка + дерево. */
export type UpdateOpeningRepertoireResponse = OpeningRepertoireDetailDto;

/** `DELETE /opening-trainer/repertoires/:id` — soft-delete confirmation. */
export interface DeleteOpeningRepertoireResponse {
  id: string;
  deletedAt: string;
}

/**
 * KS-3324 / ADR-078. Response для всех source-endpoints
 * (`POST/PATCH/DELETE /repertoires/:id/sources[/:sourceId]`) — возвращаем
 * полный обновлённый `OpeningRepertoireDetailDto` (с пересобранным tree
 * и актуальным списком `sources`). Это позволяет фронту обновить state
 * атомарно без дополнительного GET.
 */
export type CreateRepertoireSourceResponse = OpeningRepertoireDetailDto;
export type UpdateRepertoireSourceResponse = OpeningRepertoireDetailDto;
export type DeleteRepertoireSourceResponse = OpeningRepertoireDetailDto;

/**
 * `POST /opening-trainer/repertoires/:id/sessions`.
 *
 * Если играем чёрными — первый бот-ход уже сделан, `initialBotMove`
 * заполнен; если белыми — `initialBotMove = null` и ожидаем ход
 * пользователя.
 */
export interface StartOpeningTrainerSessionResponse {
  session: OpeningTrainerSessionDto;
  /** Первый ход бота (когда играем чёрными). */
  initialBotMove: { moveUci: string; moveSan: string; newFen: string } | null;
}

/** `GET /opening-trainer/sessions/:sid`. */
export interface GetOpeningTrainerSessionResponse {
  session: OpeningTrainerSessionDto;
}

// ─── Discriminated union для /move response (ADR-077 §2.4) ────────────
//
// Сужение по дискриминатору `result` гарантирует, что фронт получает
// нужные поля для каждого исхода. Тест на narrowing — в .test.ts рядом.

interface OpeningTrainerMoveBaseResponse {
  result: OpeningTrainerMoveResult;
  session: OpeningTrainerSessionDto;
}

/** Правильный ход: применён, бот-ход (если ещё не end-of-line). */
export interface OpeningTrainerMoveCorrectResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'correct';
  applied: true;
  scoreDelta: number;
  newFen: string;
  /** Бот ответил. `null` если после нашего хода — конец линии. */
  botMove: {
    moveUci: string;
    moveSan: string;
    newFen: string;
  } | null;
}

/** Неправильный ход: не применён, есть подсказка по правильным вариантам. */
export interface OpeningTrainerMoveWrongResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'wrong';
  applied: false;
  /** `-5` обычно (см. OPENING_TRAINER_SCORING.wrong). */
  scoreDelta: number;
  /** Что было правильно — для popup'а «попробовать снова». */
  expectedMoves: Array<{ moveUci: string; moveSan: string }>;
}

/**
 * Линия закончилась — нет edges из новой позиции (`newFen`). Фронт
 * показывает «линия пройдена», предлагает выбор: вернуться на развилку
 * выше / начать с начала / закончить сессию.
 */
export interface OpeningTrainerMoveLineCompleteResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'line-complete';
  applied: true;
  scoreDelta: number;
  newFen: string;
}

/**
 * KS-3277. Линия закончилась (или бот не нашёл непройденный вариант
 * в текущей позиции), бекенд автоматически откатил доску к ближайшей
 * развилке с непройденными edges. Сессия НЕ финиширует — пользователь
 * продолжает играть из нового стартового FEN'а.
 */
export interface OpeningTrainerMoveLineRestartResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'line-restart';
  applied: true;
  scoreDelta: number;
  /** FEN, в который перенесли доску (новая branch-стартовая позиция). */
  newFen: string;
  /** UCI-путь от root до `newFen` — фронт ре-рендерит доску по этому пути. */
  newPath: string[];
  /**
   * Опц. бот-ход из новой позиции (если сейчас очередь бота). Когда
   * `null` — ожидаем ход пользователя из `newFen`.
   */
  botMove: {
    moveUci: string;
    moveSan: string;
    newFen: string;
  } | null;
}

/**
 * KS-3277. Всё дерево репертуара пройдено без ошибок — финал-экран
 * «дерево выучено». Сессия автоматически финиширована (`status='finished'`).
 */
export interface OpeningTrainerMoveTreeCompleteResponse
  extends OpeningTrainerMoveBaseResponse {
  result: 'tree-complete';
  applied: true;
  scoreDelta: number;
  /** Финальная FEN — позиция, в которой завершилось дерево. */
  newFen: string;
}

export type OpeningTrainerMoveResponse =
  | OpeningTrainerMoveCorrectResponse
  | OpeningTrainerMoveWrongResponse
  | OpeningTrainerMoveLineCompleteResponse
  | OpeningTrainerMoveLineRestartResponse
  | OpeningTrainerMoveTreeCompleteResponse;

/** `POST /opening-trainer/sessions/:sid/hint`. */
export interface OpeningTrainerHintResponse {
  /** Один правильный ход (если их несколько — рандомный). */
  hint: { moveUci: string; moveSan: string };
  session: OpeningTrainerSessionDto;
}

/**
 * `POST /opening-trainer/sessions/:sid/giveup`.
 * Возвращает все правильные + переходит на бот-ход (если after-our-move
 * не end-of-line). Помечает попытку как wrong.
 */
export interface OpeningTrainerGiveupResponse {
  expectedMoves: Array<{ moveUci: string; moveSan: string }>;
  botMove: {
    moveUci: string;
    moveSan: string;
    newFen: string;
  } | null;
  newFen: string;
  session: OpeningTrainerSessionDto;
}

/**
 * `POST /opening-trainer/sessions/:sid/undo`.
 * Откатывает последний полуход (наш или бот'а — фронт сам решит, что
 * показать). Возвращается отрицательный `scoreDelta` (компенсация).
 */
export interface OpeningTrainerUndoResponse {
  newFen: string;
  /** Отрицательное значение (компенсация прошлого +N). */
  scoreDelta: number;
  session: OpeningTrainerSessionDto;
}

/**
 * `POST /opening-trainer/sessions/:sid/finish`.
 * Закрывает сессию, агрегирует попытки в `OpeningLineProgress`
 * (M2 — в M1 progress не пишется, summary считается прямо из attempts).
 */
export interface OpeningTrainerFinishResponse {
  session: OpeningTrainerSessionDto;
  summary: {
    score: number;
    movesPlayed: number;
    correctMoves: number;
    wrongMoves: number;
    hintsUsed: number;
    /**
     * KS-3307. `correctMoves / (correctMoves + wrongMoves) * 100`,
     * округлено до целого. 0 если попыток не было. Дубликат
     * `session.accuracyPercent` для удобства Result-страницы.
     */
    accuracyPercent: number;
    /** Количество линий, дошедших до line-complete за сессию. */
    linesCompleted: number;
  };
}

/** `GET /opening-trainer/repertoires/:id/progress` (M2). */
export interface GetOpeningRepertoireProgressResponse {
  repertoireId: string;
  lines: OpeningLineProgressDto[];
}

/**
 * KS-3286 (M2 §5 / KS-3294 B8). `GET /opening-trainer/repertoires/:id/
 * active-session` — последняя неоконченная сессия пользователя по этому
 * репертуару с `finishedAt IS NULL AND lastActivityAt > now - 7d`,
 * иначе `null`. Используется для sticky-карточки «продолжить
 * тренировку» на странице репертуара.
 */
export interface GetOpeningRepertoireActiveSessionResponse {
  session: OpeningTrainerSessionDto | null;
}

/**
 * KS-3283. Топ-N позиций по числу wrong-attempts. Используется в
 * `GET /repertoires/:id/stats` для UI «где ты чаще всего ошибаешься».
 *
 *   - `positionFen` — позиция, где совершались ошибки.
 *   - `expectedMoves` — UCI-варианты, которые считаются правильными
 *     (для этой позиции в репертуаре).
 *   - `mostFrequentWrongMove` — UCI хода, который пользователь чаще
 *     всего играл неправильно (для подсказки «вот этот ход опять не
 *     тот»). `null` если все wrong-moves разные (нет moda).
 *   - `wrongCount` — число wrong-attempts.
 *   - `totalCount` — общее число attempts (correct + wrong).
 *   - `errorRate` — `wrongCount / totalCount` ∈ [0..1].
 */
export interface OpeningRepertoireErrorPosition {
  positionFen: string;
  expectedMoves: string[];
  mostFrequentWrongMove: string | null;
  wrongCount: number;
  totalCount: number;
  errorRate: number;
}

/**
 * KS-3283. Запись последней сессии для lastSessions[] в stats.
 */
export interface OpeningRepertoireRecentSession {
  id: string;
  finishedAt: string | null;
  score: number;
  /**
   * KS-3307. `correctMoves / (correctMoves + wrongMoves)` ∈ [0..1].
   * Раньше считалось `correctMoves / movesPlayed`, что давало 1.0 при
   * любом числе ошибок (wrong не входит в movesPlayed).
   */
  accuracy: number;
}

/**
 * KS-3283. `GET /opening-trainer/repertoires/:id/stats` — агрегатная
 * статистика прохождения для текущего пользователя по этому репертуару.
 */
export interface GetOpeningRepertoireStatsResponse {
  repertoireId: string;
  totalSessions: number;
  completedSessions: number;
  totalAttempts: number;
  correctAttempts: number;
  wrongAttempts: number;
  hintsUsed: number;
  /** `correctAttempts / totalAttempts * 100`, 0 если attempts нет. */
  accuracyPercent: number;
  /** Топ-10 проблемных позиций по wrongCount, desc. */
  topErrorPositions: OpeningRepertoireErrorPosition[];
  /** Последние 10 сессий по finishedAt DESC (включая active с null). */
  lastSessions: OpeningRepertoireRecentSession[];
}

/** `GET /opening-trainer/reviews/due` (M2 — SRS-очередь). */
export interface GetOpeningReviewsDueResponse {
  lines: Array<
    OpeningLineProgressDto & {
      /** Денормализация — фронту не нужно ходить отдельно за repertoire. */
      repertoireTitle: string;
    }
  >;
}

// ─── Type guards для discriminated union ──────────────────────────────

export function isCorrectMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveCorrectResponse {
  return r.result === 'correct';
}

export function isWrongMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveWrongResponse {
  return r.result === 'wrong';
}

export function isLineCompleteMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveLineCompleteResponse {
  return r.result === 'line-complete';
}

/** KS-3277. Type guard для `line-restart`. */
export function isLineRestartMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveLineRestartResponse {
  return r.result === 'line-restart';
}

/** KS-3277. Type guard для `tree-complete`. */
export function isTreeCompleteMove(
  r: OpeningTrainerMoveResponse,
): r is OpeningTrainerMoveTreeCompleteResponse {
  return r.result === 'tree-complete';
}
