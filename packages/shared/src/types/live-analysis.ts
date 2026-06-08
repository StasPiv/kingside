/**
 * KS-3731 / ADR-110: shared types для live-трансляции анализа партии.
 *
 * Контракт между `apps/api` (модуль `live-analysis`, namespace
 * `/live-analysis`) и `apps/web` (страница автора `AnalysisPage` +
 * страница зрителя `/live/:slug`). Импортируется обеими сторонами,
 * локально не дублировать.
 *
 * Источник истины — `docs/adr/110-live-analysis-broadcast.md`:
 *   §2.2 — транспорт и события WS.
 *   §2.3 — жизненный цикл (создание REST, sync, close).
 *   §2.6 — авторизация (анонимные зрители, owner-only действия).
 *
 * KS-3896 / ADR-117: `lectureDisabledTools` в Response/Snapshot и
 * событие `LECTURE_TOOLS` — фундамент для политики отключения
 * инструментов ученикам live-сессии лекции. Сам тип
 * `LectureDisabledTool` живёт в `api-contracts.ts` рядом с
 * `LectureSummary`.
 */
import type { LectureDisabledTool } from './api-contracts.js';

// ─── Domain primitives ──────────────────────────────────────────────

/**
 * Статус трансляции. Источник — enum `LiveAnalysisStatus` в Prisma
 * (`packages/db/prisma/schema.prisma`).
 *   - `active` — автор подключён или трансляция в окне неактивности
 *     до 30 минут (см. cleanup-job, ADR-110 §2.3 B).
 *   - `closed` — закрыта вручную автором (REST DELETE / WS `close`)
 *     или по таймауту cleanup-job'ом. Финальное состояние, обратно
 *     не оживает.
 */
export type LiveAnalysisStatus = 'active' | 'closed';

/** Ориентация доски, сохранённая автором на момент старта трансляции. */
export type LiveAnalysisOrientation = 'white' | 'black';

/**
 * Причина закрытия в `ClosedEvent`. `by_owner` — явное действие
 * автора (WS `close` или REST DELETE). `inactivity` — cleanup-job
 * по `lastActivityAt < NOW() - 30min`.
 */
export type LiveAnalysisCloseReason = 'by_owner' | 'inactivity';

// ─── REST DTO ────────────────────────────────────────────────────────

/**
 * `POST /live-analyses` — тело запроса.
 *
 * KS-3758 / ADR-112 §3, §4: `analysisId` обязателен — трансляция
 * привязана к конкретному `Analysis`. Сервер проверяет, что владелец
 * совпадает с автором анализа, и применяет partial-UNIQUE (один автор
 * × один анализ = одна active-трансляция, см. KS-3757). До ADR-112
 * поле отсутствовало; старые клиенты, не передающие его, получат
 * `400 Bad Request` после раскатки KS-3759/KS-3761.
 *
 * Остальные поля опциональны: без них стартовая позиция — initial
 * position. `startingFen` валидируется на сервере через chess.js;
 * невалидный FEN → 400.
 */
export type CreateLiveAnalysisDto = {
  /**
   * KS-3758 / ADR-112: UUID `Analysis.id`. Обязателен.
   * Сервер дополнительно проверяет, что `Analysis.userId === ownerId`.
   */
  analysisId: string;
  title?: string;
  startingFen?: string;
  orientation?: LiveAnalysisOrientation;
};

/**
 * `POST /live-analyses` 201 / `GET /live-analyses/:slug` 200.
 *
 * Полный snapshot трансляции для зрительской mount-фазы (фронт
 * подтягивает это до открытия WS, чтобы заранее рендерить доску).
 * Текущая позиция — `currentFen`, история ходов берётся отдельным
 * `SyncSnapshot` после WS-`subscribe`.
 */
export type LiveAnalysisResponse = {
  id: string;
  slug: string;
  /** Публичная ссылка вида `https://kingside.site/live/<slug>`. */
  url: string;
  ownerId: string;
  ownerUsername: string | null;
  title: string | null;
  startingFen: string | null;
  currentFen: string;
  currentPly: number;
  orientation: LiveAnalysisOrientation;
  status: LiveAnalysisStatus;
  /** Текущее число активных зрителей (snapshot на момент запроса). */
  viewerCount: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC. `null` если ещё active. */
  closedAt: string | null;
  /**
   * KS-3758 / ADR-112 §3, §4. UUID `Analysis.id`, к которому привязана
   * трансляция. `null` для исторических записей ADR-110, созданных до
   * введения binding (миграция KS-3757 их не очищает по analysisId,
   * только закрывает active без binding). У всех новых трансляций
   * после KS-3759 поле всегда заполнено.
   */
  analysisId: string | null;
  /**
   * KS-3743 / ADR-111: annotated PGN из последнего `state-patch`
   * автора. Поле опциональное: до первого state-patch отсутствует;
   * на трансляциях по контракту ADR-110 (без state-patch) не приходит
   * никогда. Фронт может прочитать дерево варинатов/комментариев из
   * него вместо своего REST-фолбэка на `/analyses/public/:id`.
   */
  currentPgn?: string;
  /**
   * KS-3743 / ADR-111: PGN-headers, продублированные мапой для
   * `GameMetaBar`. Опциональны; при расхождении с `currentPgn`
   * побеждает PGN.
   */
  headers?: Record<string, string>;
  /**
   * KS-3896 / ADR-117 §2. Снапшот отключённых инструментов лекции
   * на момент чтения трансляции. Поле опциональное: присутствует
   * только когда трансляция привязана к лекции (`lectureId !== null`).
   * Пустой массив = тренер ничего не отключил. Frontend ученика
   * сверяется с этим значением при mount-фазе, до подписки на WS
   * (последующие изменения приходят событием `LECTURE_TOOLS`).
   */
  lectureDisabledTools?: LectureDisabledTool[];
};

/**
 * Элемент списка `GET /live-analyses?ownerId=...` (для секции «Мои
 * трансляции» в профиле). Облегчённая форма без текущего FEN/ply —
 * детали подтягиваются отдельным запросом по slug.
 */
export type LiveAnalysisListItem = {
  id: string;
  slug: string;
  title: string | null;
  status: LiveAnalysisStatus;
  createdAt: string;
  closedAt: string | null;
  /** Пик числа одновременных зрителей за всю трансляцию (аналитика). */
  viewerPeak: number;
  /**
   * KS-3758 / ADR-112 §3. UUID `Analysis.id`, к которому привязана
   * трансляция. `null` для исторических записей ADR-110 (без binding).
   */
  analysisId: string | null;
};

// ─── WS payloads: client → server ───────────────────────────────────

/**
 * `subscribe` — присоединение к комнате трансляции. В ответ сервер
 * шлёт `sync` с полным состоянием.
 *
 * KS-3742 / ADR-111 §2.2. Опциональное поле `mode` зарезервировано
 * для разделения подписчиков на полную (`'full'`) и облегчённую
 * (`'board'`) ленту. На MVP сервер всегда отвечает `'full'`-snapshot'ом
 * вне зависимости от значения; поле сохраняется как контракт для
 * будущих ботов/виджетов вроде OBS-плагина стримера, которым PGN не
 * нужен. Отсутствие поля трактуется как `'full'`.
 */
export type LiveAnalysisSubscribePayload = {
  slug: string;
  mode?: 'board' | 'full';
};

/** `unsubscribe` — выйти из комнаты (опционально, можно и просто disconnect'нуться). */
export type LiveAnalysisUnsubscribePayload = {
  slug: string;
};

/**
 * `move` — автор делает ход. Сервер валидирует JWT, ownerId-матч и
 * легальность UCI в `currentFen` через chess.js. Невалидный ход →
 * `error { code: 'illegal-move' }` только автору, state не меняется.
 */
export type LiveAnalysisMoveClientPayload = {
  slug: string;
  /** UCI: `e2e4`, `e7e8q` (promotion). */
  uci: string;
};

/**
 * `reset` — автор полностью сбрасывает позицию (например, перешёл на
 * разбор другой партии). Опционально передаёт новый стартовый FEN
 * или PGN; без них — стандартная initial. Сервер очищает историю
 * ходов в Redis и пушит свежий `sync` всем подписанным.
 */
export type LiveAnalysisResetPayload = {
  slug: string;
  fen?: string;
  pgn?: string;
};

/** `close` — автор завершает трансляцию. Эквивалент `DELETE /live-analyses/:id`. */
export type LiveAnalysisClosePayload = {
  slug: string;
};

/**
 * `sync` — клиент явно запрашивает свежий snapshot (используется как
 * страховка при подозрении на рассинхронизацию, см. ADR-110 §2.2:
 * если применение UCI у зрителя дало другой FEN — re-subscribe).
 */
export type LiveAnalysisSyncRequestPayload = {
  slug: string;
};

/**
 * KS-3742 / ADR-111 §2.2, §3. `state-patch` — автор обновил содержимое
 * окна анализа: дерево вариантов, NAGs, комментарии, аннотации
 * (`[%csl]`/`[%cal]`/`[%cvc]`), ориентацию доски или PGN-headers.
 *
 * Передаётся целиком annotated PGN — это и есть каноничное дерево
 * анализа (см. ADR §2.1: «передаём PGN целиком, а не дельты»).
 * Сервер на приёме валидирует длину (hard cap 256 KB → `pgn-too-large`)
 * и грамматику через `chess.js.loadPgn`, дросселирует приём
 * (5 патчей/сек, burst 10 — anti-abuse), затем публикует sync.
 *
 * Опциональные поля:
 *   - `headers` — `Record<string,string>` со стандартными PGN-headers
 *     (`Event`, `Site`, `Date`, `Round`, `White`, `Black`, `Result`,
 *     `WhiteElo`, `BlackElo`, `WhiteTitle`, `BlackTitle`, `ECO`,
 *     `Opening`). Дублирует headers из самого `pgn`, чтобы фронту не
 *     парсить ради `GameMetaBar`. При расхождении побеждает `pgn`.
 *   - `currentPly` — где сейчас стоит автор. Автор мог листать дерево
 *     без совершения новых ходов — `move` тогда не эмитится, а зритель
 *     должен синхронизировать `ReviewMoveList`.
 *   - `orientation` — если автор перевернул доску.
 *
 * Owner-only. Аноним → `error { code: 'forbidden' }`.
 */
export type LiveAnalysisStatePatchPayload = {
  slug: string;
  /**
   * KS-3780. JSON-сериализованное дерево анализа автора с уже
   * проставленными `globalIndex` у каждого узла. Структура внутри
   * строки: `{ history: ChessMove[], headers?, initialFen?,
   * initialAnnotations? }`. Backend хранит строку как есть, не
   * парсит и не валидирует содержимое — за корректный JSON отвечает
   * фронт.
   *
   * Длина ≤ 256 KB (262 144 байт), иначе
   * `error { code: 'tree-too-large' }`.
   *
   * KS-3780 заменил формат: до этого передавался annotated PGN.
   * Замена нужна для того, чтобы у автора и зрителя совпадали
   * `globalIndex` каждого узла — при PGN зритель пересчитывал
   * индексы через `parseAnnotatedPgn` DFS-обходом, что давало
   * расхождение с reducer-счётчиком автора.
   */
  tree: string;
  /**
   * KS-3775. Сквозной индекс узла дерева, на котором автор стоит в
   * данный момент. После KS-3780 индекс берётся из самого `tree` и
   * совпадает у автора и зрителя (вычислять заново не нужно).
   */
  currentGlobalIndex?: number;
  orientation?: LiveAnalysisOrientation;
};

// ─── WS payloads: server → client ───────────────────────────────────

/**
 * `move` — broadcast хода автора всем подписанным зрителям. `fen`
 * шлётся как self-check (зритель сверяет результат применения uci
 * к своему current; рассинхрон → автоматический re-subscribe). `ply` —
 * порядковый номер для idempotent применения.
 */
export type LiveAnalysisMoveEvent = {
  slug: string;
  uci: string;
  /**
   * KS-3780: backend больше не вычисляет FEN на стороне сервера —
   * содержимое трансляции непрозрачно (см. контракт state-patch с
   * `tree`). Поле сохранено опциональным для совместимости и для
   * случая, когда автор сам прислал бы FEN; в текущем потоке
   * отсутствует.
   */
  fen?: string;
  ply: number;
};

/**
 * `sync` — полное состояние трансляции. Шлётся на `subscribe`, на
 * `reset` (всем) и явный `sync`-запрос от клиента.
 *
 * KS-3742 / ADR-111 §2.2, §2.3 расширил snapshot полями `currentPgn`
 * и `headers`. Поля опциональные, чтобы старые клиенты ADR-110
 * (которые ожидают только UCI-ленту) продолжали работать без правок.
 *
 * `currentPgn` — annotated PGN последнего state-patch автора. До
 * первого `state-patch` за время трансляции поле отсутствует (или
 * приходит пустой строкой) — фронт в этом случае строит дерево из
 * `startingFen` + `moves`. `headers` — стандартные PGN-headers в виде
 * мапы; при наличии расходятся с теми, что зашиты в `currentPgn`,
 * побеждает `currentPgn` (см. ADR-111 §2.8.2).
 */
export type LiveAnalysisSyncSnapshot = {
  slug: string;
  startingFen: string;
  orientation: LiveAnalysisOrientation;
  /**
   * KS-3780. JSON-сериализованное дерево анализа автора с уже
   * проставленными `globalIndex` у каждого узла. До первого
   * `state-patch` за время трансляции поле отсутствует. Заменило
   * прежнее поле `currentPgn` (annotated PGN) — переход на JSON
   * нужен, чтобы у автора и зрителя совпадали `globalIndex`.
   */
  tree?: string;
  /**
   * KS-3775. Сквозной индекс узла дерева, на котором стоит автор.
   * Зритель использует его для прямого позиционирования курсора в
   * `ReviewMoveList` через `searchInHistory(history, globalIndex)`.
   * После KS-3780 индекс уже зашит в самом `tree`, дополнительный
   * расчёт на стороне зрителя не требуется.
   */
  currentGlobalIndex?: number;
  /**
   * KS-3896 / ADR-117 §2. Снапшот отключённых инструментов лекции
   * (см. `LiveAnalysisResponse.lectureDisabledTools`). Дублируется в
   * sync, чтобы при `re-subscribe` ученик гарантированно получил
   * актуальное состояние без отдельного REST-запроса. Опциональное:
   * присутствует только для трансляций, привязанных к лекции.
   */
  lectureDisabledTools?: LectureDisabledTool[];
};

/**
 * `viewers` — изменение числа зрителей. Эмит дросселирован (~раз в
 * 2с при изменениях), не на каждый join/leave.
 */
export type LiveAnalysisViewersEvent = {
  slug: string;
  count: number;
};

/**
 * `closed` — трансляция завершена. После этого события WS-комнату
 * можно покидать, новых событий не будет. Зритель видит финальную
 * позицию в read-only режиме.
 */
export type LiveAnalysisClosedEvent = {
  slug: string;
  reason: LiveAnalysisCloseReason;
};

/**
 * `error` — ошибки гейтвея. Коды:
 *   - `slug-not-found` — слаг неизвестен или трансляция уже closed.
 *   - `forbidden` — попытка `move`/`reset`/`close`/`state-patch`
 *      не от owner'а.
 *   - `illegal-move` — UCI не парсится или нелегален в currentFen.
 *   - `rate-limit` — превышен лимит на эмит (защита от автора-бота,
 *      ADR-110 §2.9.15; ADR-111 §2.4: 5 state-patch/сек, burst 10).
 *   - `invalid-payload` — payload не прошёл DTO-валидацию.
 *   - KS-3742 / ADR-111 §2.3: `pgn-too-large` — длина annotated PGN
 *      в `state-patch` или `reset` превысила hard cap 256 KB
 *      (262 144 байт). Патч не применён, state не изменился.
 */
export type LiveAnalysisErrorEvent = {
  code:
    | 'slug-not-found'
    | 'forbidden'
    | 'illegal-move'
    | 'rate-limit'
    | 'invalid-payload'
    /**
     * KS-3742 / ADR-111. До KS-3780 — превышение длины annotated PGN
     * в `state-patch`. После KS-3780 для тех же 256 KB используется
     * `'tree-too-large'`. Старый код оставлен в union на случай
     * legacy-клиентов, новые трансляции его уже не получат.
     */
    | 'pgn-too-large'
    /** KS-3780. Длина JSON-сериализованного `tree` превысила 256 KB. */
    | 'tree-too-large';
  message: string;
};

// ─── Удобные алиасы для совместимости с формулировками ADR ──────────

/** Алиас `LiveAnalysisMoveEvent` под именем из ADR-110 §2 (payloads). */
export type MoveEvent = LiveAnalysisMoveEvent;
/** Алиас `LiveAnalysisSyncSnapshot` под именем из ADR-110 §2. */
export type SyncSnapshot = LiveAnalysisSyncSnapshot;
/** Алиас `LiveAnalysisViewersEvent` под именем из ADR-110 §2. */
export type ViewersEvent = LiveAnalysisViewersEvent;
/** Алиас `LiveAnalysisClosedEvent` под именем из ADR-110 §2. */
export type ClosedEvent = LiveAnalysisClosedEvent;

// ─── Имена событий WS namespace `/live-analysis` ────────────────────

/**
 * Имена событий socket.io namespace `/live-analysis`. Импортировать
 * на backend (`@SubscribeMessage`/`emit`) и frontend (`on`/`emit`),
 * чтобы исключить расхождения строк.
 */
export const LiveAnalysisEvents = {
  /** Namespace path, передаётся в `io(<base>, { path: '/socket.io' })` через `Server`/`Namespace` ctor. */
  NAMESPACE: '/live-analysis',

  // client → server
  SUBSCRIBE: 'live-analysis:subscribe',
  UNSUBSCRIBE: 'live-analysis:unsubscribe',
  MOVE: 'live-analysis:move',
  RESET: 'live-analysis:reset',
  CLOSE: 'live-analysis:close',
  SYNC_REQUEST: 'live-analysis:sync',
  /**
   * KS-3742 / ADR-111 §2.2. Автор обновил содержимое окна анализа
   * (дерево вариантов, NAGs, комментарии, аннотации, headers,
   * orientation). Payload — `LiveAnalysisStatePatchPayload`. Owner-only,
   * с дебаунсом 500 мс на стороне клиента и серверным дросселированием
   * приёма 5/сек burst 10.
   */
  STATE_PATCH: 'live-analysis:state-patch',

  // server → client
  // NB: `MOVE` и `SYNC_REQUEST` — одно имя для client→server и server→client
  // ходов / sync-запроса и sync-ответа соответственно. Socket.io это
  // допускает (разные направления — разные обработчики).
  SYNC: 'live-analysis:sync',
  VIEWERS: 'live-analysis:viewers',
  CLOSED: 'live-analysis:closed',
  ERROR: 'live-analysis:error',
  /**
   * KS-3896 / ADR-117 §3. Тренер изменил `Lecture.disabledTools` —
   * сервер шлёт `LectureToolsChangedEvent` всем подписчикам
   * live-сессии (учеников). Полный новый набор, не дельта. Для
   * трансляций без привязки к лекции событие не эмитится.
   */
  LECTURE_TOOLS: 'live-analysis:lecture-tools',
} as const;

export type LiveAnalysisEventName =
  (typeof LiveAnalysisEvents)[keyof typeof LiveAnalysisEvents];
