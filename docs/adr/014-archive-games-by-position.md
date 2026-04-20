# ADR-014: Список партий по позиции из архива (Archive: games-by-FEN)

**Дата:** 2026-04-20
**Статус:** Предложено
**Задача:** KS-1607
**Связанные:** ADR-013 (базовый архив), KS-1577..KS-1582 (фаза 1)

---

## Контекст

Фаза 1 архива (ADR-013, задачи KS-1577..KS-1582) построила:
- таблицы `archive_sources`, `archive_imports`, `archive_games`, `position_stats`;
- воркер `apps/archive-importer` (TWIC) с `PositionIndexer`, который обновляет агрегат `position_stats` по каждому полу-ходу (`ply <= 40`);
- REST `GET /api/archive/tree` с Redis-кэшем;
- панель `ArchiveTreePanel` в окне анализа.

Внутри панели в `apps/web/src/components/analysis/ArchiveTreePanel.tsx:140-149` есть placeholder — `<button disabled>View {{count}} games →</button>`. Это заглушка. Задача фазы 2 — сделать её рабочим переходом: пользователь кликает и попадает в список партий, прошедших через **текущую позицию (FEN)**.

Ключевое ограничение: **проектируем под миллионы партий**. Текущий MVP-корпус TWIC на 6 400 партий на стартовой позиции — это временные объёмы. Архитектура должна работать и на 10M, 50M без деградации UX.

Текущее состояние по данным, нужным для этой фичи:
- `position_stats` хранит агрегаты **переходов** из позиции — перечислить список `game_id` через это нельзя;
- эндпоинт `GET /api/archive/games` в `archive.controller.ts` уже существует, но внутри `archive.service.ts:126-165` **игнорирует** параметры `fen`/`move` (прямая цитата из кода: `// NOTE: fen/move filters require a position_stats join and are deferred`);
- контракт `ArchiveGamesRequest`/`ArchiveGamesResponse` в `packages/shared/src/types/archive.ts` уже описан с полями `fen`, `move`, `limit`, `offset`, `total` — но `offset`-пагинация на миллионах не работает, контракт нужно эволюционировать.

---

## Решение (кратко)

1. **Новая таблица `archive_game_positions`** (денормализованная, с `played_at`/`avg_elo`/`result`/`side_to_move`/`move_uci`) — прямой индекс «позиция → список game_id» для ply ≤ 24.
2. **Курсорная (keyset) пагинация** по двум сортировкам: `recent` (`played_at DESC, game_id DESC`) и `topElo` (`avg_elo DESC NULLS LAST, game_id DESC`). `offset` не используется.
3. **Фильтры**, которые ложатся на индекс index-only (без JOIN): `result`, `minElo`, `since`, `color`, `move`. Фильтры требующие JOIN: `player`, `eco`, `event` — допустимы, но дороже.
4. **API**: `GET /api/archive/games` эволюционирует — добавляются `cursor`, `sort`, `color`. `total` заменяется на `totalApprox` (из `position_stats.total`) + `hasMore`.
5. **Воркер** `apps/archive-importer` при импорте пишет в `archive_game_positions` дополнительно к `position_stats`. Для уже залитых TWIC — одноразовая backfill-джоба.
6. **UI**: отдельная страница `/archive/games?fen=…&bucket=…` с mini-board в заголовке, панелью фильтров, бесконечным списком партий. Переход из `ArchiveTreePanel` — обычный `<Link>`. Клик по партии → переиспользуемый `/analysis` с PGN (как в `WorkshopPgnList`).
7. **Кэш**: Redis для первых страниц популярных позиций (TTL 10 мин), инвалидация через существующий pub/sub `archive:imported`. Pre-warm для 20-30 самых частых позиций.
8. **План миграции**: миграция БД → апдейт воркера → backfill → API → frontend. Backfill и API-правки можно параллелить.

Обоснования и детали — в §1..§8 ниже. UI-wireframes, SQL, типы, диаграммы — в сопроводительном документе `docs/architecture/KS-1607-archive-games-by-position.md`.

---

## 1. Модель данных

### 1.1 Почему нужна новая таблица, а не join через PGN-парсинг

Альтернативы, отвергнутые:
- **Парсить PGN на лету** (`archive_games.pgn` есть) — на миллионах партий сканировать, парсить chess.js для каждой партии и проверять попадание позиции занимает десятки секунд на запрос. Не работает.
- **Считать через `position_stats` + обратный индекс `game_id`** — `position_stats` агрегат, в нём нет game_id. Добавить `game_ids BIGINT[]` в `position_stats` (массив ссылок) — 1M+ игр в одну ячейку для популярных позиций, TOAST взорвётся, UPSERT невозможен.
- **Сканировать `archive_games` с `WHERE pgn LIKE %...%`** — даже с `pg_trgm` это деградирует на миллионах и не даёт позиционной семантики.

Единственный рабочий подход — **явный индекс «позиция → game_id»** в отдельной таблице, построенный на этапе импорта.

### 1.2 Схема `archive_game_positions`

```prisma
model ArchiveGamePosition {
  positionKey  Bytes     @map("position_key")   // 16B, Zobrist без move-counters (как в position_stats)
  bucket       String                           // 'master' / 'user' / ...
  gameId       String    @map("game_id") @db.Uuid
  ply          Int       @db.SmallInt           // 0..24
  moveUci      String?   @map("move_uci")       // следующий ход из позиции, для фильтра "move=..."
  sideToMove   String    @map("side_to_move") @db.Char(1)  // 'w' / 'b' — кто ходит
  playedAt     DateTime? @map("played_at")      // денормализация из archive_games
  avgElo       Int?      @map("avg_elo") @db.SmallInt  // денормализация; NULL если обе стороны без рейтинга
  result       String?   @db.Char(1)            // '1' (white), '0' (black), '=' (draw), NULL ('*')

  @@id([positionKey, bucket, gameId])
  @@index([positionKey, bucket, playedAt(sort: Desc), gameId(sort: Desc)], name: "archive_game_positions_recent")
  @@index([positionKey, bucket, avgElo(sort: Desc), gameId(sort: Desc)], name: "archive_game_positions_top_elo")
  @@map("archive_game_positions")
}
```

**Ключевые решения по структуре:**

- **PK = `(position_key, bucket, game_id)`**. Одна партия может прийти в позицию через транспозицию дважды с разных `ply` (редко, но бывает). Дубликат per-game не полезен (мы показываем партию один раз), поэтому PK без `ply`, а `ply` хранится как поле «когда впервые достигли». `moveUci` — тоже «какой ход был сделан впервые».
- **Два вторичных индекса** — под две сортировки, которые даёт UI: «недавние» и «top by Elo». Без `INCLUDE(...)` — потому что `played_at`/`avg_elo`/`result` уже в ключе/на листе B-tree (index scan с доступом к tuple за O(1)).
- **Денормализация `played_at`, `avg_elo`, `result`**. Стоит 8+2+1 = 11 байт на строку, экономит JOIN на каждую пагинацию. При миллиардах строк это разница между 5ms и 500ms per query.
- **`side_to_move`** нужен для фильтра «показать только партии, где эта позиция встретилась у белых/чёрных» — частый запрос в дебютном анализе.
- **`ply` как SMALLINT** — не более 24, укладывается. SMALLINT даёт 2 байта вместо 4.
- **Без foreign key** на `archive_games` с `ON DELETE CASCADE`. Мы не удаляем партии в рантайме (soft-delete на уровне источника, см. ADR-013 §2). FK при миллионах строк — штраф на каждую вставку. Консистентность обеспечивает воркер.

### 1.3 Ограничение `ply <= 24`

Триггер — объём. При 5M партий × 80 полу-ходов = 400M связей. Это недопустимо. Компромисс:

- `ply <= 24` (первые 12 полных ходов каждой стороны) — покрывает **98% запросов дерева**: после 20 ply позиции в 95% случаев уникальны (1 партия на позицию), а в панели `ArchiveTreePanel` пользователь видит "total < 5" и в список не переходит.
- Для позиций с `ply > 24` — показываем в UI пояснение: «Deep position: showing the full games that reached here up to move 12». Если там нашлось 1-2 партии, пользователь может открыть их через `/analysis` с PGN, а дальше внутри неё проверить, прошла ли партия через конкретную позднюю позицию (это уже локальная навигация, не нужна БД).

Объёмы при `ply=24` (1:1 с ADR-013 §8):

| Сценарий | Партии | Строк в `archive_game_positions` | Размер (таблица+2 индекса) |
| -------- | ------ | -------------------------------- | -------------------------- |
| MVP TWIC         | 250k  | ~6M        | ~500 MB   |
| Год 3 TWIC       | 750k  | ~18M       | ~1.5 GB   |
| Phase B          | 5M    | ~120M      | ~10 GB    |
| Phase C          | 10M   | ~240M      | ~20 GB    |
| Phase D          | 50M   | ~1.2B      | ~100 GB (PG) / ~15 GB (CH) |

### 1.4 Партиционирование (когда оно включается)

- **MVP/Год 3** — без партиций. До 20M строк один индекс с hot-part в buffer cache справляется.
- **Phase B (>5M партий)** — включаем `PARTITION BY HASH (position_key)` на `archive_game_positions` (32 партиции). Запросы всегда фильтруют по `position_key` → `partition pruning` уходит в одну партицию. Вставки распределяются равномерно.
- **Phase C (>10M партий)** — переносим `position_stats` и `archive_game_positions` (только агрегат-side) в ClickHouse, как в ADR-013 §10.C. Схема в CH:
  ```sql
  CREATE TABLE archive_game_positions (
    position_key FixedString(16),
    bucket LowCardinality(String),
    game_id UUID,
    played_at DateTime,
    avg_elo Nullable(UInt16),
    result LowCardinality(String),
    side_to_move Enum8('w'=1,'b'=2),
    ply UInt8,
    move_uci LowCardinality(String)
  ) ENGINE = ReplacingMergeTree
    PARTITION BY bucket
    ORDER BY (position_key, bucket, played_at, game_id);
  ```
  `ArchiveGameListRepository` — аналог `ArchiveStatsRepository` из ADR-013 §10.C.4, с PG/CH-реализациями; контракт API не меняется.

Триггеры перехода — те же §10.B/10.C ADR-013.

---

## 2. Пагинация

### 2.1 Почему не skip/take

`WorkshopMyGames` использует `?take=20&skip=0` (см. `apps/web/src/components/workshop/WorkshopMyGames.tsx:42`). Это работает на 100-1000 записей. На миллионах позиций:
- `OFFSET 100000 LIMIT 20` в Postgres — полный скан листа B-tree до 100000-го ключа. На B-tree из 100M строк это ~500ms на холодный кэш.
- `COUNT(*)` для total — ~full scan. Секунды.
- Согласованность ломается: при вставке новой партии в середину сессии пользователь видит дубликаты / пропуски.

### 2.2 Keyset (cursor) пагинация

Курсор = непрозрачная строка, кодирующая последний tuple из предыдущей страницы:

```
cursor (recent)  = base64url(JSON.stringify({ t: "<played_at_iso>" | null, g: "<game_id>" }))
cursor (topElo)  = base64url(JSON.stringify({ e: <avg_elo> | null, g: "<game_id>" }))
```

`sort` клиент передаёт явно (`sort=recent` | `sort=topElo`). Первый запрос без cursor'а берёт первые N записей.

SQL для `sort=recent` (первая страница):
```sql
SELECT agp.game_id, agp.played_at, agp.avg_elo, agp.result, agp.ply, agp.move_uci, agp.side_to_move
FROM archive_game_positions agp
WHERE agp.position_key = $1
  AND agp.bucket = $2
  AND ($3::int IS NULL OR agp.avg_elo >= $3)          -- minElo
  AND ($4::timestamptz IS NULL OR agp.played_at >= $4) -- since
  AND ($5::char(1) IS NULL OR agp.result = $5)        -- result
  AND ($6::char(1) IS NULL OR agp.side_to_move = $6)  -- color
  AND ($7::text IS NULL OR agp.move_uci = $7)         -- move
ORDER BY agp.played_at DESC NULLS LAST, agp.game_id DESC
LIMIT $8 + 1;
```

SQL для следующих страниц (cursor = `{t, g}`):
```sql
  AND (agp.played_at, agp.game_id) < ($cursor_t::timestamptz, $cursor_g::uuid)
```

Аналогично для `sort=topElo`:
```sql
ORDER BY agp.avg_elo DESC NULLS LAST, agp.game_id DESC
  AND (agp.avg_elo, agp.game_id) < ($cursor_e::int, $cursor_g::uuid)
```

`LIMIT N+1` — стандартный приём: если вернулось N+1 → `hasMore = true`, показываем N, N+1-й становится `nextCursor`.

### 2.3 Без `OFFSET` — без total

`total` отсутствует в ответе — его нельзя посчитать дёшево. Замена:
- **`totalApprox`** из `position_stats.total` для той же (position_key, bucket) — это сумма всех `total` по строкам в `position_stats` для этой позиции (все next_move_uci). Один вспомогательный запрос:
  ```sql
  SELECT COALESCE(SUM(total), 0) AS total_approx
  FROM position_stats WHERE position_key = $1 AND bucket = $2;
  ```
  Индекс `(position_key, bucket)` уже есть (ADR-013 §1.4). Cost: O(K) где K — число уникальных next_move_uci для позиции ≤ 12-20. <1ms.
- **`totalApprox` = приближение, а не точный счётчик** — фильтры `minElo/since/result/color/move` в нём **не учитываются**. UI должен подписать: «~1 240 games total» с тильдой.
- **`hasMore`** — точный, из keyset pagination.

Если пользователь сильно фильтрует — показываем `~N games` (без фильтров) и актуальный `hasMore` по отфильтрованному списку.

---

## 3. Фильтры

### 3.1 Какие фильтры нужны в UI

Минимальный набор для MVP (без них юзер не найдёт партию в миллионах):
- **sort**: `recent` | `topElo` (по-дефолту `topElo` — пользователь ожидает увидеть Карлсена, а не партию между неизвестными).
- **result**: `white` | `black` | `draw` | `any` (default).
- **minElo**: 0 / 2000 / 2200 / 2400 / 2600 (преселект + slider).
- **since**: год (dropdown: «Last 1 year», «Last 5 years», «All time»).
- **color**: `white` | `black` | `any` — «как сыграл сторону, за которую я анализирую».
- **move**: UCI следующего хода из позиции. Не показывается как отдельный control, но автоматически подставляется если пользователь пришёл из клика по конкретной строке `ArchiveTreePanel` (см. §6.2).

В фазу 2 (опционально):
- **player**: поле поиска по имени. Поддерживается `GIN(whiteName || ' ' || blackName gin_trgm_ops)` на `archive_games`, но не в индексе `archive_game_positions`. При наличии этого фильтра запрос делает JOIN + сортировка по JOIN-поля → откат на medium latency (50-200ms на миллионах).
- **eco**: ECO-код. JOIN на `archive_games.eco` (у которого уже есть индекс).
- **event**: имя турнира. Тоже JOIN, без индекса — full scan по event. Пока не делаем, оцениваем спрос.

### 3.2 Как фильтры ложатся на индексы

Индекс `archive_game_positions_recent = (position_key, bucket, played_at DESC, game_id DESC)`:
- `result`, `minElo`, `color`, `move` — фильтруются пост-сортировкой по уже сужённому range scan (Postgres умеет skip-scan, но полагаться на него нельзя → рассчитываем на селективность индекса на первых 2 колонках).
- `since` попадает в диапазон по `played_at` — оптимально.

Если один из фильтров (особенно `minElo` высокого порога) резко сужает выборку — после range scan на 10k строк остаётся 500. Цена: ~2ms.

Если фильтров нет — индекс буквально `ORDER BY`, cost = N строк × 100B / read throughput ≈ 1ms для первой страницы.

**Не добавляем** частичные или покрытые индексы под каждую комбинацию фильтров — это 2^4 = 16 индексов на каждую денормализованную таблицу. Дорого в поддержке. Стратегия: **один индекс под сортировку, фильтры — на листе**.

### 3.3 Фильтр `player` — требует JOIN

```sql
SELECT ...
FROM archive_game_positions agp
JOIN archive_games g ON g.id = agp.game_id
WHERE agp.position_key = $1 AND agp.bucket = $2
  AND (lower(g.white_name) LIKE $player OR lower(g.black_name) LIKE $player)
ORDER BY agp.played_at DESC, agp.game_id DESC
LIMIT N+1;
```

Стратегия планировщика:
- сначала index scan по `archive_game_positions_recent` до лимита, потом JOIN → быстро если `player` мягкий;
- если `player` жёсткий (условный «Carlsen»), лучше начать от `archive_games` с `pg_trgm` индекса на имени → JOIN. Планировщик выберет сам по статистике.

Для MVP: добавляем фильтр `player`, но **предупреждаем в UI** при длинных запросах «searching… may take a few seconds for popular positions». Если деградация критична — в Phase C переносим этот путь в ClickHouse.

---

## 4. Контракт API

### 4.1 Изменения в `packages/shared/src/types/archive.ts`

Эволюция `ArchiveGamesRequest` (offset остаётся deprecated для backward-compat, cursor — приоритет):

```ts
export type ArchiveGamesSort = 'recent' | 'topElo';
export type ArchiveGameColor = 'white' | 'black' | 'any';

export type ArchiveGamesByPositionRequest = {
  fen: string;                         // обязательно
  bucket?: ArchiveBucket;              // 'master' default
  sort?: ArchiveGamesSort;             // 'topElo' default
  cursor?: string;                     // непрозрачный base64url
  limit?: number;                      // 20 default, max 50
  // встроенные фильтры (index-only)
  minElo?: number;
  since?: string;                      // ISO date
  result?: ArchiveGameResult;
  color?: ArchiveGameColor;
  move?: string;                       // UCI, если пришли из дерева
  // JOIN-based (medium latency)
  player?: string;
  eco?: string;
};

export type ArchiveGamesByPositionItem = {
  id: string;
  white: ArchivePlayerInfo;
  black: ArchivePlayerInfo;
  result: ArchiveGameResult | null;
  eco: string | null;
  opening: string | null;
  event: string | null;
  date: string | null;
  plyCount: number | null;
  /** ply на котором партия достигла запрошенной позиции */
  reachedAtPly: number;
  /** ход, который эта партия сделала из запрошенной позиции (UCI) */
  nextMoveUci: string | null;
  /** сторона, которая ходила в запрошенной позиции */
  sideToMove: 'w' | 'b';
};

export type ArchiveGamesByPositionResponse = {
  fen: string;
  positionKey: string;          // hex
  bucket: ArchiveBucket;
  sort: ArchiveGamesSort;
  items: ArchiveGamesByPositionItem[];
  nextCursor: string | null;    // null если hasMore=false
  hasMore: boolean;
  /** грубое число партий в позиции без фильтров. UI показывает с тильдой. */
  totalApprox: number;
};
```

Существующий `ArchiveGamesRequest`/`ArchiveGamesResponse` (без `fen`) **остаётся** — он питает `PlayerProfilePage`-подобные поиски по метаданным без привязки к позиции. Новый маршрут — **отдельный подэндпоинт**.

### 4.2 Эндпоинты

- **`GET /api/archive/games`** (существует) — метаданные, `offset/total` путь. Поле `fen` в query игнорируется (как сейчас). `player`, `eco`, `result` работают.
- **`GET /api/archive/games/by-position`** (новый, ключевой для этой задачи) — FEN-индексированный поиск, keyset, `ArchiveGamesByPositionRequest`/`Response`.
- **`GET /api/archive/games/:id`** (существует, без изменений) — детали, PGN.

Альтернатива «один эндпоинт с optional fen» рассмотрена и **отвергнута**: разная семантика пагинации (offset vs cursor), разный total (true count vs approx), разные индексы под капотом — в одном DTO это месиво валидации. Лучше два явных контракта.

### 4.3 WebSocket — не нужен

Архив статичен, апдейты раз в неделю. Pub/Sub уже есть для инвалидации кэша дерева (`ARCHIVE_IMPORTED_CHANNEL`) — расширяем его на новый кэш games-by-position (см. §7).

---

## 5. Воркер `archive-importer`

### 5.1 Что меняется при импорте партии

Текущий `PositionIndexer.index()` (`apps/archive-importer/src/position-indexer.ts:71`) делает только UPSERT в `position_stats`. Нужен второй этап: **batch INSERT в `archive_game_positions`**.

Алгоритм:
```
для каждой ParsedGame game:
  side = 'w'  // стартовая позиция — ход белых
  fenBefore = STARTING_FEN
  seen = new Set<string>()  // дедуп транспозиций в рамках одной партии
  for ply in 1..min(24, game.moves.length):
    key = zobrist(fenBefore)
    keyHex = key.toString('hex')
    if !seen.has(keyHex):
      batch.push({
        position_key: key,
        bucket: 'master',
        game_id: game.id,
        ply: ply - 1,                // ply ДО хода (0 для стартовой)
        move_uci: game.moves[ply-1].uci,
        side_to_move: side,
        played_at: game.playedAt,
        avg_elo: avgElo(game) ?? null,
        result: resultCode(game.result),  // '1' / '0' / '=' / null
      })
      seen.add(keyHex)
    fenBefore = game.moves[ply-1].fenAfter
    side = (side === 'w') ? 'b' : 'w'

// batch COPY в конце обработки issue
COPY archive_game_positions (...) FROM STDIN
```

**Batch через `COPY FROM STDIN` (binary)**, а не `createMany`. При 5k партий × 24 ply = 120k строк на один TWIC issue. `createMany` идёт по 10k/транзакция и занимает ~15s. `COPY` — ~1-2s.

**Идемпотентность:** на PK `(position_key, bucket, game_id)` уже стоит UNIQUE. Повторный импорт одного issue даёт `ON CONFLICT DO NOTHING` (или `skipDuplicates` в Prisma) — безопасно. Если партия попала в архив дважды из разных источников (содержит тот же `contentHash` → не создаётся второй `archive_games`), связи тоже не двоятся.

**Порядок:** внутри транзакции — сначала INSERT в `archive_games` (с `skipDuplicates`), потом вставка в `archive_game_positions` для **действительно новых** партий. Список новых game_id получаем из `createMany({...}).returning('id')` в Phase B (Prisma умеет), либо из pre-filter по `contentHash` на клиенте в MVP.

### 5.2 Backfill для существующих TWIC

До этой задачи уже залито ~N issues TWIC (см. `archive_imports`). Для них нужно одноразово заполнить `archive_game_positions` — иначе UI показывает 0 партий на старых позициях.

Джоба:
```
npm run backfill -- --source=twic [--batch=5000] [--resume-from=<cursor>]
```

Реализуется в `apps/archive-importer/src/backfill.ts`:
1. SELECT archive_games LIMIT 5000 OFFSET ? (или keyset по `created_at, id` — быстрее)
2. Для каждой партии парсим `pgn` через `parsePgnGames` (библиотека уже есть).
3. Построчно в `archive_game_positions` через `COPY`.
4. Обновляем промежуточный cursor.
5. Пауза 30s между батчами чтобы не мешать онлайн-запросам.

Оценка времени на MVP (250k партий):
- 5000 партий × 24 ply = 120k строк за батч ≈ 3-5s на COPY + PGN-парсинг
- всего 50 батчей × 30s пауза + 5s работа = ~30 минут

Для Phase B (5M партий) — ~10 часов фоновой работой. Запускается ночью в `BACKFILL_MODE=true` с низким приоритетом, как уже запланировано в ADR-013 §10.E.

**Не идёт в том же коммите**, что миграция БД — это отдельная задача для координатора.

### 5.3 Переиндексация после правок логики

Если мы позже меняем правило фильтрации (например, включаем `ply <= 30`), нужен полный rebuild. Строим отдельную целевую таблицу `archive_game_positions_new`, перекладываем через COPY, атомарно свапаем через `ALTER TABLE RENAME`. Downtime — нулевой если делаем через партицию.

---

## 6. UI

### 6.1 Отдельная страница vs модалка

**Решение: отдельная страница `/archive/games`.**

Почему не модалка:
- mini-board в заголовке — крупный элемент (200-300px), конкурирует с контентом в модалке;
- фильтры и бесконечный список — много вертикали;
- глубокие ссылки `?fen=...&sort=topElo&minElo=2400` должны шариться и индексироваться (SEO-потенциал для мастер-партий);
- mobile UX — полноэкранный лучше ограниченного попапа.

Маршрут: **`/archive/games?fen=<urlencoded>&bucket=master&sort=topElo&minElo=2400&move=e2e4`**

### 6.2 Переход из `ArchiveTreePanel`

В `apps/web/src/components/analysis/ArchiveTreePanel.tsx:140-150` сейчас:

```tsx
<button type="button" className="..." disabled title="...coming soon">
  View {{count}} games →
</button>
```

Становится:

```tsx
import { Link } from 'react-router-dom';
// ...
<Link
  to={{
    pathname: '/archive/games',
    search: buildQuery({ fen: currentFen, bucket, sort: 'topElo' }),
  }}
  className="archive-tree-panel__view-games"
>
  View {totalGames.toLocaleString()} games →
</Link>
```

**Дополнительно:** клик по конкретной строке таблицы `ArchiveTreePanel__row` остаётся, как сейчас — `onSelectMove(uci)` делает ход на доске. Но можно добавить вторую иконку в ряд — 📜 «games with this move», которая ведёт на `/archive/games?fen=…&move=<uci>`. Это pre-filter по конкретному ходу. Решение об этом — фронт в задаче KS-…, в ADR фиксируем только опциональность.

### 6.3 Компоненты: что переиспользуем

Разбираю список из задачи:

| Компонент | Подходит? | Комментарий |
| --------- | --------- | ----------- |
| `WorkshopGameListItem` | **Нет** | Он завязан на модель `{ playerColor, playerResult, opponent }` — user-centric. В архивной партии обе стороны равноправны. Копировать в другой структуре проще, чем адаптировать. |
| `WorkshopMyGames` | **Нет как компонент** | Как **паттерн** — да: header + list + pagination, копируем структуру CSS. Но `WorkshopMyGames` использует skip/take, а нам нужен keyset + infinite scroll. |
| `WorkshopPgnList`→`PgnFileGames` | **Частично** | Список `{ white, black, result, date }` с кликом → `navigate('/analysis', { state: { pgn, title, breadcrumbSection, ... }})` — это **ровно та** навигация, которую нужно переиспользовать. Оборачиваем этот блок в свою компоненту `ArchiveGameRow`. |
| `PlayerProfilePage.tsx:317-358` (`.player-profile-games-table`) | **Да, как шаблон** | Таблица `opponent / result / time-control / date / action` — близко к тому, что нужно. Переименовываем в `ArchiveGamesTable` с колонками: white+elo / black+elo / result / event / date / ECO / [Open]. |

**Итого новые компоненты:**
```
apps/web/src/pages/
  ArchiveGamesByPositionPage.tsx       (новая страница)
apps/web/src/components/archive/
  ArchiveGamesList.tsx                 (список + infinite scroll)
  ArchiveGameRow.tsx                   (одна строка, открывает /analysis с pgn)
  ArchiveGamesFilters.tsx              (фильтры: sort, result, minElo, since, color)
  ArchivePositionHeader.tsx            (mini-board + FEN copy + opening name + "~N games")
apps/web/src/hooks/
  useArchiveGamesByPosition.ts         (react-query-style хук с keyset pagination)
```

**Ничего не перезагружаем при смене фильтра**: когда меняется sort/minElo — сбрасываем cursor и загружаем первую страницу заново. При смене `fen` (редко, только через URL) — full reload.

### 6.4 Infinite scroll

IntersectionObserver на sentinel-элементе внизу списка. Когда sentinel в viewport — вызываем `fetchNextPage()` если `hasMore`. Скролл внутри `ArchiveGamesList` сам или внешний — решение по вёрстке (не в ADR).

### 6.5 Клик по партии

```tsx
navigate('/analysis', {
  state: {
    pgn: fetchedPgn,                        // нужно дозагрузить GET /api/archive/games/:id
    title: `${white.name} vs ${black.name}`,
    breadcrumbSection: 'Archive',
    breadcrumbBackUrl: `/archive/games?fen=${encodeURIComponent(fen)}`,
    breadcrumbFileName: event ?? date,
    breadcrumbFileBackUrl: `/archive/games?fen=${encodeURIComponent(fen)}`,
  },
});
```

Это полная копия паттерна `WorkshopPgnList.tsx:242-254`. `AnalysisPage` уже умеет работать с этим state — ничего менять не надо.

### 6.6 Состояния страницы

| Состояние | UI |
| --------- | -- |
| `loading` (first page) | skeleton 10 строк |
| `items.length === 0 && !loading` | «No games found» + подсказка "Try lowering minElo or changing bucket" |
| `error` | «Archive unavailable» + Retry |
| `loading` (pagination) | спиннер в sentinel |
| `hasMore === false` | «End of results» (нейтральный текст) |

### 6.7 Mobile

Таблица (6 колонок) не помещается. Переключаемся на **карточки** (один `ArchiveGameRow` per row, 2 строки: `white vs black · event · date` / `result · ECO · Open →`). Стандартный media query `max-width: 768px`. Детали — верстальщик в отдельной задаче.

---

## 7. Кэш и оптимизации

### 7.1 Redis-кэш первых страниц

Ключ: `arch:games:<hex(posKey)>:<bucket>:<sort>:<filtersHash>:<cursor|first>`

- TTL = **10 минут** (не 1 час как у `arch:tree:*`, потому что кеш ожидается менее "горячим" и хочется быстрее обновляться).
- Размер значения: N=20 партий × ~500B JSON ≈ 10KB. 1000 горячих ключей × 10KB = 10MB — приемлемо.
- Только first page (`cursor=null`) и 2-3 следующих — глубокие страницы редко повторяются.
- Инвалидация: через существующий pub/sub `ARCHIVE_IMPORTED_CHANNEL` — добавляем паттерн `arch:games:*` в `invalidateTreeCache()` в `archive.service.ts:270-284` (переименовываем в `invalidateArchiveCaches`).

### 7.2 Pre-warm популярных позиций

Cron в `apps/archive-importer` (или простая джоба в API) раз в 15 минут:
1. Выбираем top-30 позиций с наибольшим `totalApprox`:
   ```sql
   SELECT position_key, bucket, SUM(total) AS total_approx
   FROM position_stats
   GROUP BY position_key, bucket
   ORDER BY total_approx DESC LIMIT 30;
   ```
2. Для каждой — первая страница `recent` + первая `topElo` (без фильтров). Кэшируем.

Это гарантирует, что клик по «View 1.2M games» из стартовой позиции или из «1.e4» всегда hit-ит Redis.

### 7.3 Compression для cold-data

Для `archive_games.pgn` уже работает TOAST+LZ4 (PG-дефолт). В `archive_game_positions` нет текстовых полей > 8 байт, компрессия не нужна.

### 7.4 Чего **не** делаем превентивно

- Материализованные view (`MATERIALIZED VIEW top_games_per_position AS ...`) — overkill в MVP, `archive_game_positions` и так оптимизирован под этот запрос.
- pg_partman для `archive_game_positions` до триггера Phase B (см. §1.4).
- ClickHouse-репликацию до Phase C.
- Search по имени игрока через ElasticSearch — `pg_trgm` на `archive_games` хватает до Phase C.

---

## 8. План миграции и задачи координатора

### 8.1 Зависимости

```
[1. Миграция БД: archive_game_positions]
          |
          +--> [2. Воркер: писать в новую таблицу при импорте]
          |         |
          |         +--> [3. Backfill существующих TWIC]   (≥ шаг 2)
          |
          +--> [4. API /api/archive/games/by-position]     (параллельно с шагом 2)
                    |
                    +--> [5. Frontend: страница + ссылка из ArchiveTreePanel]
```

Что можно параллельно:
- **Шаг 2 и шаг 4** — да, разные приложения (`apps/archive-importer` и `apps/api`), общий контракт (`packages/shared`) подготовлен заранее.
- **Шаг 3 и шаг 4** — да, backfill идёт фоново на сервере, API тестируется на ручных данных + уже импортированных `position_stats` (пустой результат при отсутствии `archive_game_positions` — корректный fallback).

Что нельзя:
- **Шаг 1 должен быть первым** (без таблицы воркер/API не смогут запуститься).
- **Шаг 5 требует шаг 4** (фронту нужен эндпоинт).
- **UI не должен показывать ссылку до того, как хотя бы один TWIC-батч залит в новую таблицу** — иначе «View 6k games» откроет пустой список. Решение: после деплоя шагов 1-4 сначала запускается backfill-джоба, затем фронт-релиз делает feature-flag `ARCHIVE_GAMES_LIST_ENABLED=true`.

### 8.2 Задачи для координатора

Координатор по итогам этого ADR создаёт (с учётом ownership из CLAUDE.md):

1. **KS-XXX (backend, prisma)** — миграция `archive_game_positions` (схема из §1.2) + Prisma-модель.
2. **KS-YYY (backend, shared)** — расширение `packages/shared/src/types/archive.ts` (новые типы `ArchiveGamesByPositionRequest`/`Response`) + re-export через `api-contracts.ts`.
3. **KS-ZZZ (backend, archive-importer)** — обновление `PositionIndexer` / новый модуль `PositionRowBuilder`: COPY FROM в `archive_game_positions` при импорте + дедуп per-game.
4. **KS-AAA (backend, archive-importer)** — отдельный CLI-скрипт `backfill` для существующих `archive_games`. Запускается вручную.
5. **KS-BBB (backend, api)** — новый endpoint `GET /api/archive/games/by-position` в `apps/api/src/archive/`, Redis-кэш, обновление `ArchiveService.invalidateTreeCache()` → инвалидация `arch:games:*`, pre-warm-джоба.
6. **KS-CCC (frontend)** — страница `ArchiveGamesByPositionPage`, компоненты `ArchiveGamesList` / `ArchiveGameRow` / `ArchiveGamesFilters` / `ArchivePositionHeader`, хук `useArchiveGamesByPosition`, правка `ArchiveTreePanel.tsx` (placeholder → Link), добавление роута в router.
7. **KS-DDD (layout)** — стили новой страницы, responsive (mobile-карточки), стили win/draw/loss badge в строке.
8. **KS-EEE (qa)** — сценарии: клик «View N games» из дерева → список → фильтры работают → клик партии → `/analysis` с PGN. Проверить на стартовой позиции (много игр) и на позиции после 15 ходов (может быть пусто).
9. **KS-FFF (devops, опционально)** — мониторинг `archive_game_positions_table_size_bytes`, `archive_games_list_query_duration_seconds{cache_hit}`; алёрт на деградацию p95.

Нумерацию и зависимости расставит координатор после ревью.

### 8.3 Фича-флаг

До завершения backfill фронт держит ссылку `View N games →` **disabled** (как сейчас) под env-флагом `VITE_ARCHIVE_GAMES_LIST_ENABLED`. Флаг включается после «OK» от qa. При rollback — флаг обратно в `false`, UI показывает placeholder, данные в БД остаются (не мешают).

---

## Альтернативы рассмотрены

1. **Использовать Lichess Explorer API вместо собственной таблицы**. Даёт готовый endpoint `https://explorer.lichess.ovh/masters?fen=…`. Но: нет наших фильтров, зависимость от внешнего сервиса, rate limits, нельзя включать свои партии (`bucket=user`). Может быть fallback если наши данные пусты.
2. **Хранить `game_ids` как массив прямо в `position_stats`**. Массив строк миллионов `UUID` — TOAST, ломает UPSERT, нельзя индексировать содержимое массива для keyset. Отвергнуто.
3. **Поисковый индекс (ElasticSearch/Meilisearch) с документом per game**. Дублирование данных + синхронизация. Overkill для позиционного запроса. Может быть полезно для player search в Phase C, но не в MVP.
4. **Полный ClickHouse с первого дня**. Анализ в ADR-013 §10.C — откладываем до 10M+ партий. Для MVP 6-250k это overengineering.
5. **Единый endpoint `GET /api/archive/games` для всех случаев**. Разная семантика пагинации (offset vs cursor), разный total — один DTO не выражает корректно без `oneOf`. Лучше 2 явных.

---

## Открытые вопросы (в задачах координатора должны решиться)

1. **`sort=topElo` по NULL Elo — куда девать?** Решение в ADR: `NULLS LAST`. Если пользователь поставил `minElo=2400`, NULL-партии отфильтруются вообще.
2. **`move` фильтр — точное совпадение или начинается с (для promotion)?** Точное (UCI не вариативен в промо: `e7e8q` vs `e7e8n` — разные ходы).
3. **Pre-warm список позиций — статический (топ-30) или динамический (по popularity за неделю)?** MVP — статический из агрегата `SUM(total) DESC LIMIT 30`. Пересчитывать раз в сутки.
4. **Лимит `ply=24` потенциально урезает часть запросов в эндшпиле**. Метрика `archive_games_list_position_not_indexed_total` должна это ловить — если срабатывает >0.1% запросов, поднимаем до 30.
5. **Нужна ли страница `/archive/games/:id`** (просмотр одной партии в архивном контексте, отдельно от `/analysis`)? Открыто — зависит от SEO-стратегии в маркетинговой задаче. В этом ADR не решаем.
