# ADR-013: Базы партий, дерево вариантов и интеграция в окно анализа

**Дата:** 2026-04-19
**Статус:** Предложено
**Задача:** KS-1577

---

## Контекст

В текущей платформе хранятся только партии, сыгранные на Kingside (`games`), пользовательские PGN-импорты (`pgn_imports` + `pgn_import_games`) и трансляции с Lichess (`broadcasts` + `broadcast_games`). Нет:

- единой "базы партий" уровня платформы (миллионы master-games), к которой имеет доступ любой пользователь;
- дерева вариантов (openings/moves tree) по позиции — статистики переходов из FEN, популярных продолжений, результатов;
- автоматической подгрузки свежих партий из внешних архивов (TWIC, lichess monthly dumps, chess.com PGN экспорты);
- интеграции этих данных в окно анализа (`apps/web/src/pages/AnalysisPage.tsx`).

Окно анализа уже умеет: chess.js + react-chessboard, MultiPV Stockfish (WASM/external), `useReviewState` для дерева вариантов в памяти, ECO-классификация (`classifyOpening`), сохранение PGN через `useSavedAnalyses`. Сейчас сбоку от доски расположены панели Engine и Moves (collapsible на desktop, табы на mobile). Места под ещё одну панель достаточно — можно добавить Tree, либо заменить Engine на Tabs (Engine / Tree / Moves).

Задача — спроектировать модель данных, контракты, подсистему импорта и UI-интеграцию. Код в этой задаче не пишется.

---

## Решение

### 1. Доменная модель и таблицы

Вводим новые таблицы в `packages/db/prisma/schema.prisma`. Все таблицы — отдельный домен `archive_*`, не путать с `games` (онлайн-партии Kingside).

#### 1.1 `archive_sources` — источники партий

Источник = откуда подтянуты партии. Хранит метаданные о расписании, последнем успешном пуле, статистике.

```prisma
model ArchiveSource {
  id              String   @id @default(uuid()) @db.Uuid
  code            String   @unique          // "twic", "lichess-broadcast", "chesscom-titled"
  name            String                    // "The Week In Chess"
  url             String?                   // базовый URL источника
  kind            String                    // "twic_zip", "lichess_api", "chesscom_api", "manual"
  enabled         Boolean  @default(true)
  schedule        String?                   // cron expression, NULL = manual
  lastRunAt       DateTime? @map("last_run_at")
  lastSuccessAt   DateTime? @map("last_success_at")
  lastError       String?   @map("last_error") @db.Text
  cursor          String?                   // last TWIC issue, last polled date — формат свой для каждого источника
  totalGames      Int      @default(0) @map("total_games")
  createdAt       DateTime @default(now()) @map("created_at")

  imports ArchiveImport[]
  games   ArchiveGame[]

  @@map("archive_sources")
}
```

#### 1.2 `archive_imports` — журнал импортов

Каждый запуск импорта (cron tick или ручной) — отдельная запись. Нужен для аудита, retry, отображения в админке.

```prisma
model ArchiveImport {
  id          String   @id @default(uuid()) @db.Uuid
  sourceId    String   @map("source_id") @db.Uuid
  status      String   @default("running") // running, ok, error, partial
  startedAt   DateTime @default(now()) @map("started_at")
  finishedAt  DateTime? @map("finished_at")
  fileName    String?  @map("file_name")   // напр. "twic1593.zip"
  cursorBefore String? @map("cursor_before")
  cursorAfter  String? @map("cursor_after")
  gamesParsed  Int    @default(0) @map("games_parsed")
  gamesAdded   Int    @default(0) @map("games_added")
  gamesSkipped Int    @default(0) @map("games_skipped") // дубликаты
  error        String? @db.Text

  source ArchiveSource @relation(fields: [sourceId], references: [id])
  games  ArchiveGame[]

  @@index([sourceId, startedAt])
  @@map("archive_imports")
}
```

#### 1.3 `archive_games` — партии

Хранит партии из внешних источников. Отделено от `games` (нет связки с User, нет clock state, нет рейтинговых дельт).

```prisma
model ArchiveGame {
  id            String   @id @default(uuid()) @db.Uuid
  sourceId      String   @map("source_id") @db.Uuid
  importId      String?  @map("import_id") @db.Uuid

  // Дедупликация: hash(white|black|date|round|movesUci) → bytea(20)
  contentHash   Bytes    @unique @map("content_hash")

  // Метаданные PGN
  event         String?
  site          String?
  round         String?
  date          String?  // как в PGN, неструктурированно ("2026.03.15", "????.??.??")
  playedAt      DateTime? @map("played_at") // распарсенный date+UTCTime, NULL если невозможно
  whiteName     String   @map("white_name")
  blackName     String   @map("black_name")
  whiteElo      Int?     @map("white_elo")
  blackElo      Int?     @map("black_elo")
  whiteTitle    String?  @map("white_title")  // "GM", "IM", ...
  blackTitle    String?  @map("black_title")
  result        String                       // "1-0", "0-1", "1/2-1/2", "*"
  eco           String?                      // ECO-код (B90 и т.п.)
  opening       String?                      // имя дебюта (если в PGN)
  plyCount      Int      @map("ply_count")
  pgn           String   @db.Text            // полный PGN (~2-5KB средний)
  finalFen      String?  @map("final_fen")

  source ArchiveSource @relation(fields: [sourceId], references: [id])
  import ArchiveImport? @relation(fields: [importId], references: [id])

  @@index([eco, playedAt(sort: Desc)])
  @@index([whiteName, blackName])
  @@index([playedAt(sort: Desc)])
  @@index([sourceId, playedAt(sort: Desc)])
  @@map("archive_games")
}
```

**Зачем `content_hash`:** один и тот же мастер-турнир может приехать через TWIC и chesscom-titled. Хэш = SHA-1 от нормализованной строки `white|black|date|round|round|<uci-стрингой>` гарантирует, что одна и та же партия не задвоится.

**Объём:** TWIC — ~3-5k партий/неделя × ~3KB pgn = ~15MB/неделя. За год ~750MB одного только PGN. С метаданными — ~1.2GB/год. Это укладывается в текущий PostgreSQL без партиционирования первые 2-3 года. После — `archive_games` партиционируется по `playedAt` (range, 1 год = 1 партиция).

#### 1.4 `position_stats` — агрегированное дерево вариантов

Это сердце фичи. Таблица не хранит позиции (это делал бы 50M строк просто для FEN), а хранит **статистику переходов** из позиции после конкретного хода.

```prisma
model PositionStats {
  // PK = (positionKey, nextMoveUci, bucket)
  positionKey   Bytes      @map("position_key")   // 16 bytes — Zobrist hash от FEN (без половинного счётчика)
  nextMoveUci   String     @map("next_move_uci")  // следующий ход в UCI ("e2e4")
  bucket        String     @default("master")     // "master" / "user" / "engine" — на будущее. MVP: только master
  whiteWins     Int        @default(0) @map("white_wins")
  draws         Int        @default(0)
  blackWins     Int        @default(0) @map("black_wins")
  total         Int        @default(0)
  avgElo        Int?       @map("avg_elo")        // средний рейтинг игроков сделавших ход
  lastSeenAt    DateTime?  @map("last_seen_at")   // playedAt самой свежей партии
  ply           Int                                // полу-ход в стартовой позиции (для фильтрации/индекса)

  @@id([positionKey, nextMoveUci, bucket])
  @@index([positionKey, bucket, total(sort: Desc)])
  @@index([ply])
  @@map("position_stats")
}
```

**Ключ позиции — Zobrist хэш FEN-а без половинного счётчика и счётчика ходов** (т.е. позиция = расположение фигур + сторона + рокировки + en passant). Считается на стороне backend (есть готовые либы или своя реализация на ~60 строк). 16 байт BYTEA в PK + индекс — ~80 байт на строку.

**Почему BYTEA, а не FEN-строка:** компактнее (16B vs ~60B), быстрее сравнение в PG, B-tree индекс плотнее. FEN всё равно нужен только для отображения, а его легко восстановить, выполнив ходы из стартовой позиции.

**Почему хранится `next_move_uci`, а не вершина дерева:** запрос "что играют из позиции X" → `WHERE position_key = $1 AND bucket = 'master' ORDER BY total DESC LIMIT 12` — один index range scan, ~1ms. Не нужно строить никакие графы.

**Глубина:** записываем только переходы для `ply <= 40` (20 полных ходов). Дальше дебютной фазы статистика бесполезна (1-2 партии на позицию), а данных в 10× больше.

**Объём:**
- средняя партия = 80 полу-ходов, но фиксируем только первые 40 → 40 переходов
- 5k партий/неделя × 40 = 200k обновлений `position_stats` в неделю
- В первые ходах позиции переиспользуются (1.e4 — миллионы партий → 1 строка), на 15-20 ходу почти каждая позиция уникальна
- Реалистичная оценка после года: ~5-10M строк, ~1-2GB. Влезает.

#### 1.5 `archive_game_positions` — связь партий и позиций (опционально, для запроса "какие партии прошли через эту позицию")

Опционально для MVP. Без этой таблицы можно получить **статистику** (`position_stats`), но нельзя получить **примеры партий** из позиции. Если нужны "посмотреть партии Магнуса из этой позиции" — нужна:

```prisma
model ArchiveGamePosition {
  gameId       String  @map("game_id") @db.Uuid
  positionKey  Bytes   @map("position_key")
  ply          Int

  @@id([gameId, ply])
  @@index([positionKey, ply])
  @@map("archive_game_positions")
}
```

Объём: 5k партий × 40 полу-ходов = 200k строк/неделя. ~10M/год. Решение для MVP: **не делаем**, добавим в фазу 2 если будет реальный запрос пользователей.

---

### 2. Стратегия индексации позиций

**Решение: предрасчёт `position_stats` при импорте партии.**

Альтернативы и почему они хуже:
- **on-demand агрегация** (запрос дерева сканирует `archive_games` и парсит PGN) — миллионы партий × парсинг = сотни секунд на запрос. Не работает.
- **частичный кэш Redis** (вычислять при первом запросе, кэшировать) — для популярной позиции работает, для редкой — те же сотни секунд. Не работает на холодном кэше.
- **Polyglot книги** (.bin) — стандартный формат для openings book, но он замораживает данные в файл и не даёт пер-результат статистики (только веса ходов). Хорошо для движка, плохо для UI.

**Алгоритм импорта (псевдокод, для backend):**
```
для каждой новой ArchiveGame:
  парсим PGN → массив (uci, fenAfter)
  для ply = 0..min(40, len-1):
    posKey = zobrist(fenBefore[ply])    // позиция ДО хода
    nextUci = uci[ply]
    upsert position_stats(posKey, nextUci, 'master')
      inc total, inc white_wins/draws/black_wins по результату партии,
      пересчёт avgElo через welford или просто sum/count в отдельной колонке
      lastSeenAt = max(lastSeenAt, playedAt)
```

Один UPSERT на каждую позицию. PostgreSQL `INSERT ... ON CONFLICT (...) DO UPDATE` справляется с ~10k/sec без проблем. Импорт TWIC (~5k партий × 40 = 200k upsert) укладывается в ~30 секунд.

**Откатываемость:** при удалении источника / партии нужно decrement-ить статистику. Это грязно. **Решение:** удаление партий запрещено, есть только soft-delete (`enabled=false` на источнике), пересчёт статистики делается фоновой джобой `recompute_position_stats(sourceId)` (TRUNCATE строк bucket='master' + перезаливка).

---

### 3. Схема построения дерева вариантов: on-demand vs предрасчёт

**Гибрид:**
- агрегаты (`position_stats`) — **полный предрасчёт** при импорте (см. §2);
- ответ API на `GET /api/archive/tree?fen=...` — **on-demand из БД** (один SELECT, см. §4);
- кэш в Redis на популярные позиции (TTL 1 час, ключ = `arch:tree:<hex(posKey)>:<bucket>`) — нивелирует пиковую нагрузку.

Дерево не строится в полную глубину сразу — только **один уровень** (12 топ-ходов из текущей позиции). При клике на ход в UI дерево фронт сам делает следующий запрос для новой позиции. Это эквивалентно тому, как работает [Lichess Explorer](https://lichess.org/analysis): не ёлка целиком, а лента непосредственных продолжений + статистика по выбранному.

---

### 4. REST/WebSocket контракты

Новый файл `packages/shared/src/types/archive.ts`, экспортируется через `api-contracts.ts`.

#### 4.1 Дерево вариантов (главный endpoint)

```ts
// GET /api/archive/tree?fen=<urlencoded>&bucket=master&minElo=2000&since=2024-01-01
export type ArchiveTreeRequest = {
  fen: string;                     // обязательно, FEN текущей позиции
  bucket?: 'master' | 'user';      // default master
  minElo?: number;                 // фильтр по среднему рейтингу
  since?: string;                  // ISO date, фильтр по последним играм
  limit?: number;                  // default 12
};

export type ArchiveTreeMove = {
  uci: string;                     // "e2e4"
  san: string;                     // "e4"  — рассчитывается на бэке через chess.js
  total: number;
  whiteWins: number;
  draws: number;
  blackWins: number;
  whitePct: number;                // 0..100, для UI
  drawPct: number;
  blackPct: number;
  avgElo: number | null;
  lastSeenAt: string | null;       // ISO
};

export type ArchiveTreeResponse = {
  fen: string;
  positionKey: string;             // hex (для отладки/кэша на фронте)
  totalGames: number;              // сумма total по всем ходам
  moves: ArchiveTreeMove[];        // отсортировано по total DESC, max 12
  opening: { eco: string; name: string } | null;  // ECO-классификация позиции
};
```

#### 4.2 Список партий через позицию (опционально, фаза 2)

```ts
// GET /api/archive/games?fen=<urlencoded>&move=e2e4&minElo=2400&limit=20&offset=0
export type ArchiveGamesRequest = {
  fen?: string;                    // если задано — только партии прошедшие через позицию
  move?: string;                   // uci, дополнительный фильтр (только если задан fen)
  white?: string;
  black?: string;
  player?: string;                 // either side
  eco?: string;
  minElo?: number;
  result?: '1-0' | '0-1' | '1/2-1/2';
  since?: string;
  limit?: number;
  offset?: number;
};

export type ArchiveGameSummary = {
  id: string;
  white: { name: string; elo: number | null; title: string | null };
  black: { name: string; elo: number | null; title: string | null };
  result: string;
  eco: string | null;
  opening: string | null;
  event: string | null;
  date: string | null;
  plyCount: number;
};

export type ArchiveGamesResponse = {
  total: number;
  items: ArchiveGameSummary[];
};

// GET /api/archive/games/:id
export type ArchiveGameDetail = ArchiveGameSummary & {
  pgn: string;
  site: string | null;
  round: string | null;
};
```

#### 4.3 Источники (для админки)

```ts
// GET /api/admin/archive/sources
export type ArchiveSourceDto = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  totalGames: number;
};

// POST /api/admin/archive/sources/:id/run  — ручной запуск импорта
// PATCH /api/admin/archive/sources/:id  — { enabled, schedule }
```

#### 4.4 WebSocket — НЕ нужен

Дерево вариантов — статические данные, обновляются раз в неделю (TWIC). Реал-тайм уведомления не дают пользователю ничего. REST + Redis-кэш достаточно.

---

### 5. Подсистема импорта и cron-расписание

**Решение: новый воркер `apps/archive-importer`.**

Почему отдельный воркер, а не `@nestjs/schedule` внутри `apps/api`:
- импорт TWIC — это download zip 5-20MB + распаковка + парсинг тысяч PGN + сотни тысяч UPSERT. Долгая операция (30-90 сек). В процессе API она забьёт event loop и пуш миграции matchmaker'а.
- уже есть прецедент изоляции — `apps/broadcast-worker` (для трансляций Lichess). Та же модель: отдельный процесс, общая БД через `@kingside/db`, Redis для координации.
- легче масштабировать/выключать без рестарта API.

**Структура:**
```
apps/archive-importer/
  src/
    index.ts              # bootstrap
    importer.ts           # главный цикл (interval по schedule из БД)
    sources/
      twic.ts             # download zip → splitPgn → parsePgnGames → upsert
      lichess-bulk.ts     # фаза 2
      chesscom-titled.ts  # фаза 2
    position-indexer.ts   # batch UPSERT в position_stats
    pgn-utils.ts          # zobrist, normalize для contentHash
```

**Cron-расписание (хранится в `archive_sources.schedule`):**
- `twic` — `0 8 * * 5` (пятница 08:00 UTC, TWIC выходит по четвергам) + retry через 6 часов если последний запуск ошибочный.
- `lichess-bulk` (фаза 2) — `0 4 1 * *` (первое число месяца, lichess monthly dump).
- `chesscom-titled` (фаза 2) — `0 6 * * *` (ежедневно).

Воркер реализует свой собственный лёгкий планировщик (как `arena-scheduler.service.ts` — `setInterval` каждые 60 сек, проверяет `next_run_at`). `@nestjs/schedule` не используем — не нужно тащить весь NestJS DI в воркер ради cron-tick'а.

**Lock'и:** в Redis, ключ `archive:import:lock:<sourceCode>`, TTL 30 минут. Стратегия как у broadcast-worker'а.

#### 5.1 TWIC: формат входных данных

[TWIC](https://theweekinchess.com/twic) — еженедельный архив. Формат:
- URL вида `https://theweekinchess.com/zips/twic1593g.zip` (g = games)
- `cursor` в `archive_sources` — последний обработанный номер ("1593"). На каждом тике пробуем `cursor+1`.
- Скачиваем zip, распаковываем единственный `.pgn` файл (UTF-8 / Latin-1, нужно sniff'ить и нормализовать).
- `splitPgn(content)` (уже есть в `apps/api/src/workshop/pgn.parser.ts`) → массив PGN-ов.
- `parsePgnGames` → метаданные.
- Для каждой партии: `parseMoves` через chess.js → массив `(uci, fenAfter)`.
- `contentHash = sha1(white|black|date|round|UCI-string)` → дедуп.
- BatchInsert `archive_games` (10k за раз через `prisma.createMany skipDuplicates: true`).
- `position-indexer` обновляет `position_stats` для добавленных игр.

#### 5.2 Обработка дубликатов

Три уровня защиты:
1. **`archive_games.contentHash` UNIQUE** — гарантия уровня БД.
2. **`createMany({ skipDuplicates: true })`** — не падает на конфликтах.
3. **`gamesSkipped`** в `archive_imports` для статистики.

Один и тот же TWIC issue может приехать дважды (ретрай) — будут пропущены все партии. Партии из перепечаток (TWIC + chesscom-titled того же турнира) — пропускаются по тому же `contentHash`, поэтому `bucket=master` обновится только из первого источника. Это приемлемо для MVP.

#### 5.3 Источники сверх TWIC (фаза 2)

- **Lichess monthly dump** — `https://database.lichess.org/`, гигантские .pgn.zst (~30GB unpacked / месяц). Качаем только partial по rating bucket (2200+) через `zstdcat | head -c N`. Только для `bucket=user` если решим включать любительские партии.
- **Chess.com titled players** — `https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}/pgn`. Отдельный воркер тянет известных GM/IM ежедневно.
- **Lichess broadcast PGN** — уже есть `broadcast_games.pgn`. Можно отдельной джобой импортировать в `archive_games` после завершения трансляции (нужен флаг "round.status = finished").

В MVP — **только TWIC**. Остальное — отдельные ADR.

---

### 6. Интеграция в окно анализа (UI/UX)

См. подробный документ `docs/architecture/KS-1577-game-archive-and-tree.md`. Здесь — резюме.

**Что меняется в `apps/web/src/pages/AnalysisPage.tsx`:**

1. В сайдбар добавляется панель **Tree** (Database / Database tree). На desktop — третья collapsible панель ниже Engine, выше Moves. На mobile — четвёртая вкладка табов (`moves | engine | tree | report`).
2. Панель Tree показывает:
   - заголовок с фильтрами (bucket: Masters | Lichess 2000+ | All; min Elo; since year);
   - таблицу top-12 ходов: SAN, total, win/draw/loss bar, avg Elo, последняя дата;
   - подсказку под таблицей "based on N games";
   - имя дебюта (если ECO-классификация дала результат).
3. Клик по ходу в таблице — делает `makeVariantMove(uci)` через `useReviewState`. Доска обновляется, дерево автоматически перезапрашивается для новой позиции.
4. Hover по ходу в таблице — рисует стрелку на доске (как у Lichess Explorer).
5. Если `total === 0` — панель показывает "No games found in this position".

**Stockfish работает параллельно**, не зависит от Tree. Engine оценивает позицию, Tree показывает практику. Это два независимых источника информации, как у Lichess.

**Новый хук `useArchiveTree(fen, filters)`:** дебаунс 300ms, ключ кэша = `fen+filters`, отменяет in-flight запрос при смене позиции (AbortController). Кэширует ответы в `Map<key, response>` пока компонент жив.

**Производительность:** один запрос `GET /api/archive/tree?fen=...` укладывается в <50ms (индекс range scan). С Redis-кэшем — <5ms.

---

### 7. Ownership и план миграций

**Прозрачно по существующим правилам (см. CLAUDE.md):**
- `packages/db/prisma/schema.prisma` + миграции — **backend** (новые модели, индексы);
- `apps/archive-importer` — **backend** (новый воркер, паттерн как `apps/broadcast-worker`);
- `packages/shared/src/types/archive.ts` — **backend** (контракты данных);
- `apps/api/src/archive/` (controller + service) — **backend**;
- `apps/web/src/pages/AnalysisPage.tsx` + новый компонент `ArchiveTreePanel.tsx` + хук `useArchiveTree.ts` — **frontend**;
- стили `apps/web/src/styles/analysis.css` (новый блок `.archive-tree-panel`) — **layout**;
- ECO-классификация (`classifyOpening`) уже есть на фронте; параллельно может потребоваться лёгкая версия на бэке для заголовка панели — **backend**.

---

### 8. Оценка объёмов и производительности

#### 8.1 Базовые допущения для расчётов

- Средняя партия мастеров: 80 полу-ходов, индексируем первые 40 (см. §1.4).
- Уникальность позиций: дебютные ходы переиспользуются массово (1.e4 — миллионы партий, одна строка), на 15-20 ply почти каждая позиция уникальна. Эмпирически из открытых источников (Lichess masters DB ~3.5M партий → ~30M уникальных переходов): **отношение partий к уникальным переходам ≈ 1:8** в дебютной фазе.
- Размер строки `position_stats` с tuple-header и alignment ≈ 125 B; индекс `(position_key, bucket, total DESC)` ≈ 40 B. Итого ~165 B на запись с одним основным индексом.
- Размер строки `archive_games` без PGN ≈ 250 B (включая два `whiteName/blackName`), PGN в TOAST со сжатием LZ4 ≈ 1.5 KB вместо сырых 3 KB.

#### 8.2 Сводная таблица для 5 уровней масштаба

| Сценарий | Партии | `position_stats` строк | Размер `archive_games` (вкл. TOAST) | Размер `position_stats` (вкл. индексы) | SELECT top-12 (cold) | UPSERT-нагрузка backfill | Дизайн |
| -------- | ------ | ---------------------- | ----------------------------------- | -------------------------------------- | -------------------- | ------------------------ | ------ |
| **MVP**           | 250k    | ~2M       | ~0.4 GB | ~0.4 GB | <2 ms  | 1-2 ч.    | текущий PG-monolithic |
| **Год 3 TWIC**    | 750k    | ~6M       | ~1.2 GB | ~1.2 GB | <3 ms  | 4-6 ч.    | текущий + ежеквартальный VACUUM FULL |
| **Phase B**       | 5M      | ~40M      | ~7 GB   | ~7 GB   | <5 ms  | 24-36 ч.  | партиционирование + staging table + COPY (см. §10.B) |
| **Phase C**       | 10M     | ~80M      | ~15 GB  | ~15 GB  | 5-10 ms (PG) / <1 ms (CH) | 36-72 ч. (PG) / 4-8 ч. (CH) | ClickHouse как secondary для `position_stats` |
| **Phase D**       | 50M     | ~400M     | ~75 GB  | ~75 GB  | >50 ms (PG) / 1-3 ms (CH) | недели (PG) / 1-2 суток (CH) | ClickHouse как primary для аналитики, PG только source-of-truth |

Цифры по UPSERT — для одного потока с `INSERT ... ON CONFLICT DO UPDATE` на SSD-узле с `shared_buffers ≥ 4GB`; реальные могут отличаться в 2-3× от настройки `wal_compression`, `checkpoint_timeout`, `maintenance_work_mem`. Запросы — после `VACUUM ANALYZE`, при условии что нужный индекс целиком умещается в кэше.

#### 8.3 Конкретно по запросам

**`GET /api/archive/tree` для популярной позиции** (например, после 1.e4 e5 — топ-100 ходов, total 1M+):
- индекс `(position_key, bucket, total DESC)` — index range scan, прыгает на нужный лист B-tree за `log(N)` (на 400M строк это ~6 уровней дерева ≈ ~50 µs cold).
- читается top-12 → 12 tuples → ~1 KB.
- даже на 50M партий cold-чтение ≤ 10 ms на NVMe, при условии что лист дерева и tuple-страницы есть в page cache.
- для редких позиций (далеко в дереве, total<10) — то же.
- **Узкое место не SELECT, а количество одновременных запросов и latency Redis-кэша**. При 100 RPS на горячих позициях кэш-hit > 99%.

**Сборка SAN из UCI на бэке** (chess.js): `new Chess(fen).move({from, to})` ≈ 0.1 ms × 12 ходов = 1.5 ms. Это часть response latency, можно кэшировать SAN в `position_stats` в фазе C если станет дорого (трейд-офф против размера таблицы).

#### 8.4 Хранилище

| Уровень | `archive_games` PGN | `position_stats` | Backup (gzip) | Replication lag |
| ------- | ------------------- | ---------------- | ------------- | --------------- |
| 250k    | 0.4 GB              | 0.4 GB           | ~0.3 GB       | n/a             |
| 5M      | 7 GB                | 7 GB             | ~5 GB         | без проблем     |
| 50M     | 75 GB               | 75 GB            | ~40 GB        | требуется streaming, pg_basebackup много часов |

На 50M+ partій pg_dump перестаёт быть приемлемым; backup стратегия должна меняться на streaming WAL + физические снэпшоты (см. §10.D).

---

### 9. План внедрения (для координатора)

1. **KS-1578 (backend):** миграция Prisma — добавить таблицы `archive_sources`, `archive_imports`, `archive_games`, `position_stats`. Сидинг записи `archive_sources(code='twic')`.
2. **KS-1579 (backend):** контракты в `packages/shared` (`archive.ts`).
3. **KS-1580 (backend):** новый воркер `apps/archive-importer` — TWIC importer + position indexer.
4. **KS-1581 (backend):** REST `apps/api/src/archive/` — controller `archive.controller.ts` + service. Endpoints: `/api/archive/tree`, `/api/archive/games`, `/api/archive/games/:id`. Redis-кэширование дерева.
5. **KS-1582 (frontend):** хук `useArchiveTree`, компонент `ArchiveTreePanel`, интеграция в `AnalysisPage` (третья панель / mobile-tab).
6. **KS-1583 (layout):** стили для панели и win/draw/loss bar.
7. **KS-1584 (devops):** добавить `archive-importer` в docker-compose / supervisord, cron-расписание из `archive_sources.schedule`.
8. **KS-1585 (qa):** проверка флоу: ручной импорт TWIC → дерево показывает реальные данные → клик по ходу обновляет доску.
9. **KS-1586 (admin, фаза 2):** UI админки для управления источниками.

---

## Альтернативы, которые рассмотрены

- **Использовать Lichess Explorer API напрямую с фронта** — нет контроля над расписанием, привязка к доступности, нельзя добавить свои фильтры. Может быть как fallback в будущем.
- **Хранить позиции отдельной таблицей `archive_positions`** (PK — Zobrist) и через many-to-many → `archive_games`. На 1M игр × 80 ходов это 80M связей и таблица позиций под 10M строк. Сложнее, медленнее, не даёт ничего сверх `position_stats`.
- **GraphQL для дерева** — не используется в проекте, REST + типы из shared дают тот же DX.

#### ClickHouse / DuckDB как primary-store с самого начала — отдельный анализ

Изначально я отверг это одной строкой, что было поверхностно. Расширенный разбор (см. также §10):

- **DuckDB**: embedded, single-writer. Не подходит как primary для конкурентной записи импортера + чтения API. Может быть полезен как локальный аналитический инструмент или для batch-агрегации в pipeline, но не как замена PG.
- **ClickHouse**: колоночный store, MergeTree-движок с кодеками Delta+ZSTD даёт сжатие 5-10× для статистики. На 50M partій (~400M строк `position_stats`) ожидаемый размер 8-15 GB вместо 75 GB в PG. SELECT top-12 — единицы ms даже без warm cache. UPSERT: ClickHouse не имеет UPDATE — нужен `ReplacingMergeTree` с фоновым merge'ом, либо staging-приём через `INSERT INTO new SELECT FROM (new UNION old)`.
- **Цена внедрения сразу**:
  - +1 production-сервис в docker-compose, +1 в supervisord, +1 в мониторинге;
  - дублирование `archive_games` (источник правды должен оставаться где-то транзакционным — иначе нельзя гарантировать дедуп);
  - изменение пути миграций: миграции CH несовместимы с Prisma, нужен отдельный инструмент (clickhouse-migrations / golang-migrate);
  - eventual consistency между CH и PG (после INSERT в PG агрегаты в CH появятся через секунды-минуты);
  - один разработчик — overhead на изучение/эксплуатацию ощутимый.
- **Вердикт**: ClickHouse оправдан с **~10M+ partій** (Phase C, см. §10). До этого PostgreSQL даёт меньше движущихся частей при сопоставимой производительности на запросах дерева. Но контракт API проектируется так, чтобы реализация ArchiveService могла быть переключена с PG на CH без изменения фронта (см. §10.C.4).

#### Lichess Polyglot books (.bin) как формат хранения

`.bin` — стандартный формат для openings book (zobrist + move + weight). Плюсы: компактно (~50 MB на масштабе мастеров), быстрое чтение через mmap. Минусы:
- weight без разбивки на win/draw/loss;
- нет avgElo, lastSeenAt, фильтров;
- иммутабельный, пересборка на каждый импорт = full rebuild.

Подходит как side-channel для подсветки книжных ходов в движке, но не заменяет `position_stats`.

---

## 10. Масштабирование и эволюция (ответ на вопросы координатора)

### 10.0 Что значит «наш масштаб» в исходной редакции ADR

В первой редакции под «нашим масштабом» подразумевалось 250k-750k partій (TWIC за 1-3 года). Это не закладка предельной ёмкости, а оценка ожидаемой нагрузки от единственного сконфигурированного источника MVP. Текущий дизайн **без архитектурных изменений** работает до **~5M partій** (≈ ~40M строк в `position_stats`); дальше нужно вмешательство — последовательно по фазам, описанным ниже. Это уточнение прямо вписано в §8.2 и в дальнейшие подразделы §10.

### 10.A Пределы текущего MVP-дизайна

Без партиционирования и без COPY-pipeline:
- **Чтение** (top-12 из позиции) — линейно по log(N), упирается не в SELECT, а в page cache. До 50M строк `position_stats` чтение горячей позиции остаётся <10 ms на NVMe; для холодной позиции с большим хвостом продолжений может вырасти до 50-100 ms (см. §8.3). Кэш Redis убирает это с user-perceived latency.
- **Запись** (UPSERT) — линейно по числу партий × 40 ply. На single-thread `INSERT ON CONFLICT` ≈ 5-15k op/s. **Это узкое место**, оно ломается раньше чтения.
- **Operational**: VACUUM FULL на таблице >50 GB занимает часы, требует exclusive lock; pg_dump >50 GB перестаёт быть приемлемым.

Триггеры перехода на следующую фазу:
- `position_stats` > 30M строк ИЛИ
- среднее время UPSERT-batch > 10 минут на TWIC issue ИЛИ
- появилась задача backfill > 1M partій.

### 10.B Phase B: 1-10M partій — оптимизация PostgreSQL

Что меняется (без новых сервисов):

1. **Партиционирование `archive_games` по `playedAt`** (RANGE, 1 год = 1 партиция). Включается через `pg_partman` или ручными миграциями. Старые годы можно вынести на дешёвое хранилище (`ALTER TABLE ... SET TABLESPACE archive_cold`).
2. **Партиционирование `position_stats` HASH по `position_key`** (16-64 партиции). Это работает: запросы всегда фильтруют по `position_key`, поэтому планировщик уйдёт в одну партицию (`partition pruning`). Каждая партиция вмещает 5-25M строк, индексы кэшируются по отдельности → меньше дисковых seek'ов.
3. **Импорт через staging table + COPY**, а не INSERT ON CONFLICT:
   - воркер парсит PGN → кладёт переходы в `position_stats_staging` через `COPY FROM STDIN` (binary). Скорость COPY: ~100-300k строк/сек, в 20-30× быстрее UPSERT;
   - после загрузки batch'а — один SQL: `INSERT INTO position_stats (...) SELECT key, uci, bucket, SUM(...), ... FROM position_stats_staging GROUP BY key, uci, bucket ON CONFLICT DO UPDATE SET total = position_stats.total + EXCLUDED.total, ...`;
   - даёт ~5-10× выигрыш на batch-нагрузке по сравнению с per-row UPSERT.
4. **`UNLOGGED` staging table** + ручной commit раз в N тысяч строк → меньше WAL.
5. **`fillfactor = 70` на `position_stats`** — UPDATE-heavy таблица; с 70% оставляем место для HOT-update'ов, реже срабатывает page-split, реже нужен VACUUM.

Эффект:
- Backfill 5M partій (200M переходов) уложится в 6-10 часов вместо 24-36.
- VACUUM/REINDEX можно делать пер-партиции, без exclusive lock на всю таблицу.
- Работает до ~10M partій с приемлемыми операционными окнами.

Триггер перехода на Phase C:
- `position_stats` > 100M строк ИЛИ
- запросы по широким фильтрам (avg Elo + since + bucket) деградируют до >50 ms ИЛИ
- начинаем импортировать Lichess monthly dumps (десятки миллионов партий/месяц).

### 10.C Phase C: 10M+ partій — ClickHouse как secondary

PostgreSQL **остаётся** source-of-truth для `archive_games`, `archive_sources`, `archive_imports`. Это нужно для:
- транзакционного `contentHash` UNIQUE дедупа;
- админских операций (soft-delete источника, ручной импорт);
- интеграции с Prisma в основном API.

ClickHouse получает **зеркало `position_stats` + (опционально) денормализованную проекцию `archive_games_flat` для аналитики**. Схема:

```sql
CREATE TABLE position_stats (
  position_key  FixedString(16),
  next_move_uci LowCardinality(String),
  bucket        LowCardinality(String),
  ply           UInt8,
  white_wins    UInt32,
  draws         UInt32,
  black_wins    UInt32,
  total         UInt32,
  avg_elo       Nullable(UInt16),
  last_seen_at  DateTime,
  PROJECTION p_pop (SELECT * ORDER BY position_key, bucket, total DESC)
) ENGINE = SummingMergeTree
  PARTITION BY bucket
  ORDER BY (position_key, bucket, next_move_uci);
```

Поток данных:
1. `archive-importer` пишет PGN в PG как и раньше, плюс пишет переходы в `position_stats_staging` (PG).
2. Отдельный шаг (после успешного COPY) — `INSERT INTO clickhouse.position_stats SELECT * FROM staging` через `clickhouse-client` или Kafka-bridge. Альтернатива — нативный `MaterializedPostgreSQL` engine в CH (CDC из PG WAL).
3. `SummingMergeTree` фоновым merge'ом аккумулирует `total/wins/draws` по совпадающему PK — это и есть «UPSERT» на стороне CH.
4. `archive-games` мигрируется в CH батч-джобой раз в день для аналитики (топ-игроки, динамика дебютов и т.п.); для UI-запросов из окна анализа этого не нужно.

ArchiveService (`apps/api/src/archive/`) получает интерфейс:
```ts
interface ArchiveStatsRepository {
  getTree(posKey: Buffer, opts: TreeOpts): Promise<ArchiveTreeResponse>;
}
```
и две реализации: `PostgresArchiveStatsRepository` (Phase A/B) и `ClickHouseArchiveStatsRepository` (Phase C+). Фактическая реализация выбирается через env-переменную. Фронт не знает разницы. **Это закладывается на этапе KS-1581 явно**, чтобы не переделывать сервис при миграции.

Эффект:
- Размер `position_stats` в CH в 5-8× меньше (8-15 GB вместо 75 GB на 50M partій).
- SELECT top-12 — единицы ms на любых масштабах.
- Backfill 10M partій — 4-8 часов на CH, против 36-72 часов на PG (см. §8.2).

### 10.D Phase D: 50M+ partій — ClickHouse как primary для аналитики

То же, что Phase C, плюс:
- `archive_games_flat` в CH становится primary для пользовательских поисков (фильтр по игроку, ELO, дате);
- PG хранит только канонический PGN и метаданные дедупа; запросы на список партий идут в CH;
- бэкап PG — pg_basebackup + WAL streaming на отдельный сервер;
- CH бэкап через `BACKUP TABLE ... TO Disk('s3', ...)` (нативный S3-backup).

Этого не делаем превентивно: миграция Phase C → Phase D — добавление новых таблиц в CH и переключение endpoint'а в `ArchiveService`, контракт API не меняется.

### 10.E План backfill TWIC (~4.5M партий)

Прямой UPSERT на single-thread = 24-48 часов даунтайма импортера и тонна WAL. Не делаем так. Стратегия в фазе B:

1. **Сегментирование** по TWIC issue: есть ~1500 issues, каждый ~3k партий. Импорт идёт chronologically, по 50-100 issues за окно (ночь). Это ~150k-300k партий за окно ≈ 1-2 часа COPY + GROUP BY.
2. **Pre-aggregation в файлах**: воркер парсит N issues в Parquet/CSV, считает агрегаты переходов локально, и одной командой COPY заливает в `position_stats_staging`. Затем GROUP-BY-UPSERT в основную таблицу.
3. **Идемпотентность**: каждый issue имеет уникальный `cursor` в `archive_sources`; повторная загрузка одного issue не двигает счётчики (защищает `contentHash UNIQUE` для `archive_games` + `position_stats_staging` пересоздаётся `TRUNCATE` перед каждой пачкой).
4. **Пользовательский трафик не страдает**: импорт пишет в staging table (не блокирует чтение из основной), финальный INSERT-MERGE короткий (минуты), запросы к API идут по полностью построенной части дерева.
5. **MVP-стратегия**: грузим только последние 100 issues (~300k partій, ~3 часа суммарно). Остальные 1400 — отдельной фоновой джобой с low-priority, растянутой на 2-3 недели по ночам. Эта джоба = той же `archive-importer`, но в режиме `BACKFILL_MODE=true` с малым `BATCH_SIZE` и cooldown 30 минут между issues.

Документируется отдельной задачей **KS-1587 (backend, Phase B):** «Backfill historical TWIC archive», запускается уже после стабилизации MVP.

### 10.F Контрольные точки и метрики, которые надо снимать с MVP

Чтобы решение о переходе на Phase B/C/D принималось на данных, а не на ощущениях, в `archive-importer` и `ArchiveService` сразу заложить метрики:
- `archive_import_duration_seconds{source}` (histogram);
- `archive_import_games_total{source, status}`;
- `position_stats_upsert_duration_seconds`;
- `archive_tree_query_duration_seconds` (histogram, label=cache_hit);
- `archive_tree_cache_hit_ratio`;
- `archive_games_table_size_bytes`, `position_stats_table_size_bytes` (раз в час, через `pg_total_relation_size`).

Триггеры алёртов = триггеры перехода на следующую фазу из §10.B/§10.C.

### 10.G Сводка путей эволюции

```
[MVP, ≤1M партий]
    PostgreSQL monolithic, INSERT ON CONFLICT, без партиций
                |
                | trigger: position_stats > 30M строк или backfill > 1M
                v
[Phase B, 1-10M партий]
    + партиционирование archive_games по году
    + партиционирование position_stats HASH(position_key)
    + COPY-staging-pipeline вместо UPSERT
    + per-partition VACUUM
                |
                | trigger: position_stats > 100M или Lichess-импорт
                v
[Phase C, 10-50M партий]
    + ClickHouse SummingMergeTree для position_stats
    + ArchiveStatsRepository — переключаемая реализация
    PostgreSQL остаётся source-of-truth для archive_games
                |
                | trigger: пользовательские запросы partій > 100 RPS или 50M
                v
[Phase D, 50M+ партий]
    + ClickHouse archive_games_flat для UI-поиска partій
    + S3-бэкап CH, streaming WAL для PG
    PostgreSQL — только канонический PGN + метаданные дедупа
```

Контракт API, миграции Prisma и внутренний интерфейс `ArchiveStatsRepository` остаются стабильными между фазами; меняется только реализация.

---

## Открытые вопросы (для phase 2)

1. Нужно ли пользователям видеть PGN/просмотр конкретной партии из архива? (Если да — нужен `ArchiveGamePage`.)
2. Нужна ли фильтрация по конкретному игроку? (Тогда нужны индексы по `whiteName/blackName` LOWER + дедуп имён, что нетривиально.)
3. Импорт собственных партий пользователя из chesscom/lichess в `archive_games` (bucket=user) — отдельная фича.
4. С какого реального трафика принимать решение о переходе Phase A → Phase B? Нужно собрать метрики §10.F хотя бы за месяц после запуска MVP.
