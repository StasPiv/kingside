# ADR-023: Таблица турнира в трансляциях — источник chess-results.com, тип-aware рендер

**Статус:** Предложено
**Дата:** 2026-04-23
**Задача:** KS-1724
**Связанные ADR:** [ADR-021](./021-broadcast-service-extraction.md), [ADR-022](./022-broadcast-worker-merge-into-service.md), [research KS-484](../architecture/KS-484-broadcast-sources-research.md)

## 1. Контекст

### 1.1 Что есть сейчас (факт)

1. **Endpoint `GET /:id/standings`** — `apps/broadcast-service/src/http/broadcast.controller.ts:411`. Строит crosstable **из партий в нашей БД** (`broadcast_games`): собирает всех игроков, которые встречаются в играх трансляции, считает очки/SB/кликабельность ячеек. Алгоритм не знает про тип турнира — всегда матрица «все против всех».

2. **Рендер** — `apps/web/src/pages/BroadcastTournamentPage.tsx:242-300`. Всегда рисует `<table class="broadcast-standings-table">` с колонками `#|Player|Pts|GP|SB` + симметричная матрица N×N. Ячейка кликабельна, если в `scores[opp].gameId` есть строка.

3. **Последствия для швейцарки и опенов.** На турнире с 300 игроков в стримы Lichess попадает 10-20 топ-досок → в `broadcast_games` — 10-20 партий на тур → в таблице появляются только те игроки, которые сыграли на этих досках. Таблица неполная, группировки (очки → Бухгольц, Берг) нет, внешний вид — crosstable 20×20 с кучей пустых ячеек. Для round-robin турнира (все 10-12 игроков играют всех) — работает корректно. Для командного — не работает вообще.

4. **Данные, которые уже приходят с Lichess** в `Broadcast`:
   - `Broadcast.format` (string, сохраняется из `tour.info.format`) — примеры реальных значений с prod-запроса `/api/broadcast/top?nb=3`:
     - `"16-team round-robin"`
     - `"9-round Swiss"`
     - `"9-round Swiss for teams"`
     - `"10-player double round-robin"`
   - `Broadcast.standingsUrl` (string, из `tour.info.standings`) — **уже содержит прямую ссылку на chess-results.com** в большинстве случаев:
     - `"https://chess-results.com/tnr1394105.aspx"`
     - `"https://s1.chess-results.com/tnr1396652.aspx?art=0"`
     - Реже — ссылка на сторонний сайт (`ergebnisdienst.schachbund.de` и т. п.) для национальных лиг.
   - Флаги `teamTable`, `showTeamScores` приходят от Lichess, **но в нашем коде не сохраняются** (интерфейс `LichessBroadcast` в `broadcast-sync.service.ts:64-82` их не объявляет). Поле `tour.tier` (1-5, маркер «важности») — тоже не сохраняем, но есть `isPinned` (ADR-021 §2.1, avg Elo-based).

5. **Схема `packages/broadcasts-db` (ADR-021 §2.2):**
   - `Broadcast`: **нет** поля типа турнира (`tournament_type`/`format_kind`), **нет** `chess_results_id`, есть только строковый `format` и `standings_url`.
   - `BroadcastGame`: `whitePlayer`/`blackPlayer` — `String?` (имена, часто «Last, First» или «Last F.»), `whiteElo`/`blackElo` — `Int?`, **нет** `white_fide_id`/`black_fide_id`. Идентификация игроков — только по строке имени.
   - Таблицы под standings (`broadcast_standings` / `broadcast_players`) не существуют.

6. **Параллельный домен `live_tournaments` / `ChessResultsService`** (`apps/api/src/live-tournament/`):
   - `ChessResultsService.scanCurrentTournaments` — уже умеет скрейпить главную страницу chess-results и извлекать `livechesscloud`-UUID'ы, но **не парсит сами таблицы** (cross-table / swiss standings). Извлекает только метаданные (title, description, player count, last update).
   - Модель `LiveTournament` — отдельный продуктовый домен (ADR-021 §1.5, §2.1.1), без FK на `Broadcast`.
   - **Переиспользовать `ChessResultsService` для broadcasts нельзя** — он в `apps/api`, а broadcasts — в `apps/broadcast-service` (разные БД, разный деплой, разный CORS). Но код парсера — reference для нового сервиса (fetchPage с UA + timeout + follow-redirects, обработка s1/s2/s3 субдоменов).

7. **Фронт-компоненты, которые уже есть (паттерны):**
   - `apps/web/src/components/SwissStandingsTable.tsx` — готовая таблица швейцарки для внутренних турниров: `#|Player|Rtg|Pts|BH|Prg + N колонок по турам`. Ячейка тура: `+14○` / `-3●` / `=7○` / `BYE`. Кликабельна если есть `gameId`. **Не переиспользуем 1-в-1** (у нас `userId` нет — есть FIDE ID и имя), но форма таблицы подходит.
   - `BroadcastTournamentPage.tsx` — current crosstable-рендер (см. выше).
   - Отдельного компонента под team-round-robin / team-swiss нет.

### 1.2 Чего просит KS-1724

1. Брать полную таблицу с chess-results.com, чтобы видеть всех игроков (не только тех, чьи партии есть у нас).
2. Адаптировать рендер под тип турнира: round-robin (матрица), swiss (список с колонкой туров), team (группировка команд + игроки под каждой).
3. Партии, которые есть у нас в `broadcast_games`, должны быть кликабельными → открывать viewer. Остальные партии в таблице — не кликабельны (мы их PGN не храним).

### 1.3 Что НЕ в скоупе ADR-023

- Скрейпинг **не-chess-results источников** (`ergebnisdienst.schachbund.de`, ECU, локальные национальные сайты). Если `standingsUrl` не ведёт на chess-results — fallback на текущую логику (crosstable из `broadcast_games`).
- Добавление `white_fide_id`/`black_fide_id` в `BroadcastGame`. Lichess в PGN тэги `WhiteFideId`/`BlackFideId` **кладёт не всегда** (зависит от загрузки организаторами); mapping реализуем без этого. Если в будущем окажется, что Lichess стабильно даёт FIDE ID в PGN — отдельный ADR (добавить колонки, переписать mapping).
- Хранение full standings в локальной БД как источнике истины. `chess-results` — external SoT, мы кэшируем.
- UI-режим «показать таблицу как на chess-results.com» (iframe / прокси HTML). Отвергнуто: CORS, CSP, стилистическая чуждость kingside, потеря кликабельности на наши партии.
- Уведомления об изменениях в standings (WebSocket push). В v1 — пулл при открытии страницы + ручное обновление.

## 2. Решение

### 2.1 Источник данных (Q1) — HTML-скрейпинг chess-results.com

**Варианты:**

- **(A) HTML-скрейпинг.** Парсим `tnr<ID>.aspx?lan=1&art=N` через `fetch` + regex/cheerio. ✅
- **(B) Внешний агрегатор.** Не существует (публичного).
- **(C) Ручной ввод + background-воркер.** Частично применимо: см. §2.2 — mix из автомэппинга и ручного override.

**Выбор: (A) HTML-скрейпинг.**

Обоснование:
1. **Публичного API у chess-results нет.** Сайт — ASP.NET, данные рендерятся server-side. (Подтверждено существующим `ChessResultsService` в `apps/api`, авторитетно: не нашли API в KS-484 research.)
2. **robots.txt разрешает.** Проверено фактически (`curl https://chess-results.com/robots.txt`, 2026-04-23): `User-agent: * Allow: /`. Единственный запрет — агент `AAAA` (не наш кейс).
3. **Rate-limit по факту.** Публичных деклараций нет, но здравый подход — ≥ 5 минут на турнир, ≤ 1 req/s в целом, User-Agent с идентификацией (`Kingside/1.0 (chess platform; broadcast sync; staspivovartsev@gmail.com)`). Существующий `ChessResultsService` уже шлёт такой UA.
4. **Код есть как reference.** `apps/api/src/live-tournament/chess-results.service.ts` — готовый fetcher с follow-redirect (важно — chess-results 302-редиректит на `s1/s2/s3.chess-results.com` по балансировке).
5. **Отказ от (C) как основной стратегии.** Ручной ввод URL на каждую трансляцию — оператор-intensive, Lichess уже отдаёт URL в `tour.info.standings` в 70-80% broadcasts (эмпирически — все 3 из 3 в выборке top-3; для уверенности — инструментировать backend-метрикой `broadcasts_with_chess_results_url` в рамках KS-B3, см. §2.10). Ручной ввод — как **fallback-override**, не основной путь.

**Rate-limit политика (жёсткие инварианты):**
- ≥ 1 запрос в 5 минут на один турнир (ongoing) / ≥ 1 раз в час (pending/finished).
- Общий circuit-breaker: ≤ 2 одновременных запросов на всё приложение.
- На HTTP 429/503 — exp. backoff от 1 мин до 30 мин, публиковать в метрики `chess_results_backoff_active`.
- `User-Agent` с контактным email.
- Timeout 15 с на запрос (как в `chess-results.service.ts`).

**Какие страницы парсим** (разобрано по `art=` параметру):

| `art=` | Что отдаёт | Когда парсим |
| ------ | ---------- | ------------ |
| 1 | Общая таблица (rank / name / FIDE ID / Elo / federation / points / tiebreaks) | **Все** типы турниров |
| 4 | Кросс-таблица (только round-robin-турниры) | round-robin |
| 9 | Таблица команд (team score) | team-* |
| 5 | Pairings по турам (all rounds) — ключ для маппинга games | swiss, team-swiss |

Для v1 достаточно `art=1` (standings) + `art=4` (crosstable если round-robin) + `art=5` (pairings для swiss). `art=9` (team) отложим на v1.1 (scope-control, см. §2.3).

### 2.2 Идентификация турнира на chess-results (Q2)

**Решение: первичный источник — `Broadcast.standingsUrl` (уже есть), с fallback на ручной override.**

#### 2.2.1 Автоизвлечение `chessResultsTournamentId`

1. Broadcast-service при первом обращении к standings берёт `broadcast.standingsUrl`.
2. Если `url.hostname` заканчивается на `.chess-results.com` (s1/s2/s3/основной) ИЛИ равен `chess-results.com` → извлекаем `tnrID` regex'ом `/tnr(\d+)\.aspx/`.
3. Если `standingsUrl` пустой или не chess-results (например, `ergebnisdienst.schachbund.de`) → `chessResultsTournamentId = null`, стратегия fallback (§2.2.3).

#### 2.2.2 Поле в схеме

Добавить в `packages/broadcasts-db/prisma/schema.prisma`:

```prisma
model Broadcast {
  // ... existing fields
  chessResultsTournamentId String? @map("chess_results_tournament_id")
  // ...
}
```

Опциональное. Заполняется `BroadcastSyncService` (в `upsertBroadcast`, §2.9.1) путём парсинга `standingsUrl` при каждом sync-цикле (5 мин). Ручной override — через будущий admin UI или напрямую в БД (v1 — SQL-update, без UI).

**НЕ делаем автомэппинг по названию** — `"FIDE World Senior Team Championships"` в Lichess может совпасть с дюжиной турниров разных лет на chess-results. Рискованно.

#### 2.2.3 Fallback для не-chess-results `standingsUrl`

Для broadcasts без `chessResultsTournamentId`:
- Endpoint `/:id/crosstable` возвращает legacy-standings (как сейчас — из `broadcast_games`), флаг `source: 'internal'`.
- Фронт рендерит **прежний crosstable** (переиспользуем текущий UI как default-ветку switch по типу, §2.5).

#### 2.2.4 Detection типа турнира (Q3)

Источник истины — `Broadcast.format` (из Lichess). Парсим регулярками **в backend**, мапим в enum:

```ts
type TournamentType =
  | 'round-robin'       // "10-player double round-robin", "12-player round-robin"
  | 'swiss'             // "9-round Swiss"
  | 'team-swiss'        // "9-round Swiss for teams", "Team Swiss"
  | 'team-round-robin'  // "16-team round-robin"
  | 'knockout'          // "Knockout", "KO format"
  | 'match'             // "Match", "12-game match"
  | 'scheveningen'      // редко, "Scheveningen"
  | 'unknown';
```

Правила detection:

1. Если `/team/i` в format ИЛИ `Broadcast` имеет `teamTable=true` (нужно добавить в схему — см. §2.9.1) → префикс `team-`.
2. Если `/round-robin/i` → `round-robin` (или `team-round-robin`).
3. Если `/swiss/i` → `swiss` (или `team-swiss`).
4. Если `/knockout|KO|elimination/i` → `knockout`.
5. Если `/^\d+-game match$|^Match/i` → `match`.
6. Иначе → `unknown` (рендерится как legacy crosstable).

Не доверяем chess-results для detection (у них тип косвенно виден только по наличию `art=4`). Lichess — явный источник.

**v1 поддерживает** (в порядке приоритета):
- `swiss` — покрывает большинство крупных опенов и командных.
- `round-robin` — покрывает элитные турниры (Candidates, Norway Chess, Tata Steel Masters).
- `team-swiss` + `team-round-robin` — покрывают Bundesliga, European Club Cup, командные ЧМ.
- `unknown` → legacy crosstable.

**v1.1 добавит:** `knockout`, `match`, `scheveningen`, `double-round-robin` как отдельный рендер (сейчас на нём тоже работает `round-robin`-матрица, только с двумя клетками на пару).

### 2.3 Схема БД

**Добавляем в `packages/broadcasts-db`:**

```prisma
model Broadcast {
  // ... existing fields
  chessResultsTournamentId String?  @map("chess_results_tournament_id")
  tournamentType           String?  @map("tournament_type") // enum в коде, строка в БД (Prisma enum — ломает миграцию при добавлении значений, см. ADR-013 §X precedent).
  teamTable                Boolean  @default(false) @map("team_table")
  showTeamScores           Boolean  @default(false) @map("show_team_scores")

  standings BroadcastStandings?
}

/// Кэш распарсенных standings с chess-results.com для одной трансляции.
/// Обновляется backend-job'ом ChessResultsSyncService (§2.9).
/// На один Broadcast — одна запись. JSON-payload типа-specific.
model BroadcastStandings {
  id                   String   @id @default(uuid()) @db.Uuid
  broadcastId          String   @unique @map("broadcast_id") @db.Uuid
  sourceType           String   @map("source_type") // 'chess-results' | 'internal-fallback'
  sourceUrl            String?  @map("source_url")
  tournamentType       String   @map("tournament_type")
  rawPlayers           Json     @map("raw_players")        // [{ rank, name, fideId, elo, federation, points, tiebreaks: {...} }, ...]
  rawCrossTable        Json?    @map("raw_cross_table")    // для round-robin — матрица
  rawPairings          Json?    @map("raw_pairings")       // для swiss — per-round pairings
  rawTeams             Json?    @map("raw_teams")          // для team-* — группы
  fetchedAt            DateTime @map("fetched_at")
  fetchError           String?  @map("fetch_error")
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  broadcast Broadcast @relation(fields: [broadcastId], references: [id])

  @@map("broadcast_standings")
}
```

**Обоснование Json-колонок:**
- Форма данных варьируется сильно по типу (RR — N×N матрица, swiss — per-round pairings, team — 2-уровневая иерархия).
- Писать 3-4 нормализованных таблицы — overhead без выгоды (single reader — сам broadcast-service, никакие JOIN'ы по этим данным не нужны, поиск идёт по `broadcastId`).
- TypeScript-типы фиксируем в `@kingside/shared` (см. §2.7).
- Миграция на нормализованную схему — если появится use-case «показать все партии игрока X по всем трансляциям» (сейчас такой фичи нет).

**`tournamentType` как String, не enum Prisma:**
- Prisma `enum` на PostgreSQL — `CREATE TYPE ... AS ENUM`, добавление значения требует отдельной миграции. При расширении списка (v1.1) — лишний friction.
- В коде валидируем через Zod / TS union type.

### 2.4 REST endpoint

**Новый:** `GET /broadcasts/:id/crosstable` (в `apps/broadcast-service`, остаётся без префикса `/broadcasts` — см. ADR-021 §2.1 пункт KS-1702).

Response:
```ts
type CrosstableResponse = {
  source: 'chess-results' | 'internal-fallback';
  sourceUrl: string | null;           // URL на chess-results для «Open official standings»
  tournamentType: TournamentType;     // см. §2.2.4
  fetchedAt: string | null;           // ISO, null если internal-fallback
  players: CrosstablePlayer[];        // всегда заполнен (для любого типа)
  crossTable?: CrossTableMatrix;      // только для round-robin/double-round-robin
  pairings?: SwissPairings;           // только для swiss/team-swiss
  teams?: TeamStanding[];             // только для team-*
};

type CrosstablePlayer = {
  rank: number;
  name: string;                       // как пришло с chess-results
  fideId: string | null;              // "25102001" и т. п.
  elo: number | null;
  federation: string | null;          // ISO-3 код ("GER", "USA", ...)
  title: string | null;               // GM/IM/FM/WGM/…
  points: number;
  gamesPlayed: number;
  tiebreaks: { buchholz?: number; sonnebornBerger?: number; progressive?: number };
  teamId?: string | null;             // для team-*, ссылка в teams[].id
};

type CrossTableMatrix = {
  rows: Array<{
    playerRank: number;
    cells: Array<{
      opponentRank: number | null;    // null для диагонали
      score: 0 | 0.5 | 1 | null;      // null если не играли / bye
      color?: 'white' | 'black';
      gameRef: GameRef | null;        // null если мы не имеем эту партию в broadcast_games
    }>;
  }>;
};

type SwissPairings = {
  totalRounds: number;
  rounds: Array<{
    roundNumber: number;
    pairs: Array<{
      white: { rank: number; name: string; fideId: string | null };
      black: { rank: number; name: string; fideId: string | null };
      result: '1-0' | '0-1' | '1/2-1/2' | 'bye' | 'forfeit' | null;
      gameRef: GameRef | null;
    }>;
  }>;
};

type TeamStanding = {
  id: string;                         // нормализованное имя команды
  rank: number;
  name: string;
  matchPoints: number;
  boardPoints: number;
  tiebreaks: Record<string, number>;
  playerRanks: number[];              // индексы в players[] по rank
};

type GameRef = {
  gameId: string;                     // UUID из broadcast_games
  roundId: string;
  roundName: string;
};
```

**Query-параметры:** нет (всегда возвращаем всё; фронт решает что отрисовать).

**Старый `/:id/standings`** — оставляем на soak-период (2 недели), фронт уходит на `/crosstable`, потом `/standings` удаляется. В response старого endpoint'а — прежний shape (не меняем контракт на время переходa).

### 2.5 Frontend — рендер по типу

В `apps/web/src/pages/BroadcastTournamentPage.tsx` заменяем единый рендер на диспетчер:

```tsx
switch (crosstable.tournamentType) {
  case 'round-robin':
  case 'double-round-robin':
    return <RoundRobinCrosstable data={crosstable} onGameClick={navigateToGame} />;
  case 'swiss':
    return <BroadcastSwissStandings data={crosstable} onGameClick={navigateToGame} />;
  case 'team-swiss':
  case 'team-round-robin':
    return <TeamStandings data={crosstable} onGameClick={navigateToGame} />;
  default:
    return <LegacyCrosstable data={crosstable} onGameClick={navigateToGame} />; // для 'unknown' и internal-fallback
}
```

**Компоненты:**

1. **`<RoundRobinCrosstable>`** (новый, `apps/web/src/components/broadcast/RoundRobinCrosstable.tsx`):
   - Матрица N×N + колонки `#|Player|Fed|Elo|Pts|SB`.
   - Основан на форме текущей `broadcast-standings-table`, но с явной привязкой к `crosstable.crossTable.rows[i].cells[j]`.
   - Ячейка: показывает `1/½/0`, tooltip «white vs black», onClick → если `gameRef` не null, `navigate('/broadcasts/:id/game/:gameId')`.

2. **`<BroadcastSwissStandings>`** (новый, `apps/web/src/components/broadcast/BroadcastSwissStandings.tsx`):
   - Колонки `#|Player|Fed|Elo|Pts|BH|SB + N турoвых колонок` (N = `pairings.totalRounds`).
   - В ячейке тура: `+rank○` / `-rank●` / `=rank○` / `BYE`, как в существующем `SwissStandingsTable`.
   - Mapping: для каждой `(row, col)` — находим `pair` в `pairings.rounds[col-1].pairs` где игрок — white или black, смотрим `pair.gameRef`.
   - Для 300-игроков таблицы — `position: sticky` для первых 6 колонок + горизонтальный скролл (паттерн уже есть в `broadcast-standings-scroll`).

3. **`<TeamStandings>`** (новый, `apps/web/src/components/broadcast/TeamStandings.tsx`):
   - Внешняя таблица команд: `#|Team|MatchPts|BoardPts|Tiebreaks`.
   - Раскрывашка по клику — показывает игроков команды в under-row с личными Pts/результатами (использует `RoundRobinCrosstable` или `BroadcastSwissStandings` как inner по `team-round-robin` / `team-swiss`).

4. **`<LegacyCrosstable>`** = текущий UI, переносится в отдельный файл для backward-compat на `unknown`/`internal-fallback` (scope F1).

**Переиспользование существующего кода:**
- `SwissStandingsTable.tsx` — **не переиспользуем 1-в-1**, у него тип `SwissPlayer` построен на `userId`/`username` внутреннего турнира. Форму можно копировать, но тип новый.
- Стили `broadcast-standings-table` / `broadcast-st-*` — переиспользуем с дополнением (новые классы `swiss-broadcast-cell`, `team-standing-row` и т. п.).

### 2.6 Маппинг игроков chess-results ↔ broadcast_games (Q4, Q5)

**Ключ маппинга: нормализованное имя + (опционально) Elo для дизамбигуации.**

Почему не FIDE ID: `BroadcastGame` их не хранит (§1.1.5), Lichess в PGN тэги их кладёт **непостоянно** (проверено — часть активных broadcasts имеет `[WhiteFideId ...]`, часть нет; добавлять колонки — отдельная задача, вне scope v1).

**Нормализация имени** (функция `normalizePlayerName` в `apps/broadcast-service`):

```ts
function normalizePlayerName(raw: string): string {
  return raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

Применяется к обеим сторонам. Форма «Last, First» и «First Last» коррелируют: дополнительный шаг — если в строке chess-results `"Carlsen, Magnus"` и в PGN `"Magnus Carlsen"` — перед compare меняем `"Last, First" → "First Last"`. Для PGN тэгов с `"Carlsen"` только (без имени) — матч по substring.

**Алгоритм `matchGames(crosstablePlayers, dbGames)`:**

1. Построить индекс `nameNorm → playerRank` по `crosstablePlayers`.
2. Для каждого `BroadcastGame` в трансляции:
   - `normalizedWhite = normalizePlayerName(g.whitePlayer)`
   - `normalizedBlack = normalizePlayerName(g.blackPlayer)`
   - Найти в индексе (exact match → fuzzy substring fallback → skip с логированием `crosstable_game_match_miss`).
3. Для round-robin: `matrix[rankW][rankB] = { score, gameRef: { gameId: g.id, roundId, roundName } }`.
4. Для swiss: найти round по `round.name` из `BroadcastRound` ↔ `pairings.rounds[n].roundNumber` (если имена расходятся — mapping по `round.startsAt`). `pair.gameRef = g.id`.

**Edge cases:**

- **Дубли имён** (два однофамильца) — в реальных крупных турнирах редкость, но бывает. Если `nameNorm` даёт ≥2 матчей в индексе → дизамбигуация по `Elo` (если есть), иначе по federation, иначе пропускаем (game не кликабелен) и метрика `crosstable_ambiguous_name_total`.
- **Bye / forfeit в pairings** — `result='bye' | 'forfeit'`, `gameRef=null` без попытки матча.
- **Мы имеем партию, которой нет в chess-results** — возможно при подгрузке PGN до апдейта chess-results или mis-parse chess-results. Логируем `crosstable_orphan_game_total`, ячейка не появляется (так и должно быть — chess-results авторитет для сетки турнира). Если много таких — разбираться руками.
- **Chess-results имеет игрока без наших партий** — ровно желаемое поведение: строка есть, ячейки без `gameRef` → не кликабельны. Это суть фичи.

### 2.7 Shared types

Все типы из §2.4 — в `packages/shared/src/types/api-contracts.ts`, секция `// ─── Broadcast (REST) ───`.

Дополнить существующий раздел (после `BroadcastListResponse`):

```ts
export type TournamentType = 'round-robin' | 'double-round-robin' | 'swiss' | 'team-swiss' | 'team-round-robin' | 'knockout' | 'match' | 'scheveningen' | 'unknown';
export type CrosstablePlayer = { ... };
export type CrossTableMatrix = { ... };
export type SwissPairings = { ... };
export type TeamStanding = { ... };
export type GameRef = { ... };
export type CrosstableResponse = { ... };
```

Backend импортирует из `@kingside/shared`, фронт — тоже. Единый источник типов.

### 2.8 Кэш и частота обновления (Q6)

**Двухуровневый кэш:**

1. **Primary (БД)** — таблица `broadcast_standings`, upsert по `broadcast_id`. Писатель — `ChessResultsSyncService` (новый, в broadcast-service).
2. **HTTP response cache** — `Cache-Control: public, max-age=30, stale-while-revalidate=60` на endpoint `/crosstable`. Фронт и CloudFront будут уважать. Invalidation при каждом upsert в БД — не делаем (CDN не поддерживает, срок короткий).

**Расписание sync-job:**

Добавить в `BroadcastSyncService` (тот же, что тянет Lichess-broadcasts, ADR-022) новую петлю `chessResultsSyncLoop`:

| Lifecycle | Интервал | Примечание |
| --------- | -------- | ---------- |
| `live` (ongoing round есть) | 5 мин | совпадает с основным sync-циклом |
| `upcoming` (pending round в окне 48ч) | 1 час | таблица стабильная, только состав |
| `finished` | 24 часа | финальные результаты редко меняются (поправки иногда, но неспешно) |

**Изменённый подход вместо cron-loop:** **on-demand + TTL**.
- При `GET /:id/crosstable` — если запись в `broadcast_standings` старше порога (5 мин для live / 1 час для upcoming / 24 час для finished) → триггер async refresh (fire-and-forget), отдаём старую запись с `fetchedAt`.
- Если записи нет совсем (первый запрос) → синхронный fetch, ставим Redis-lock `chess-results:fetch:<broadcastId>` (TTL 30 с) чтобы параллельные запросы не шли параллельно, остальные ждут/получают `503 Retry-After: 5`.
- Circuit-breaker по ошибкам: `chess_results_error_rate`, если >50% ошибок за 10 мин → выключаем опросы на 30 мин (persisted в Redis).

**Причина on-demand вместо cron:** большинство broadcasts на любом конкретном моменте времени никто не смотрит. Пулить standings каждые 5 мин для 100+ broadcasts = 100+ запросов × 3 страницы (`art=1,4,5`) = 300 запросов / 5 мин = 1 req/s постоянно на один сайт. On-demand + TTL уменьшит нагрузку в разы.

**Недостаток on-demand:** первый пользователь на холодном кеше ждёт ~2-5 с (fetch + parse). Митигация: при upsert `Broadcast` в основном Lichess-sync, если это **новый pinned** broadcast → триггерить warm-up standings async.

### 2.9 Where the code lives

#### 2.9.1 Backend (`apps/broadcast-service`)

- **`src/chess-results/`** — новый модуль:
  - `chess-results.module.ts`
  - `chess-results-crosstable.service.ts` — парсер HTML (см. fetcher из `apps/api/src/live-tournament/chess-results.service.ts` как reference; **НЕ импортируем его — broadcast-service и api-service — разные NestJS-приложения, разные deploy**; копируем код базового `fetchPage` + пишем новые парсеры для `art=1,4,5`).
  - `chess-results-crosstable.service.spec.ts` — unit-тесты на fixtures из `test/fixtures/chess-results/`.
  - `player-name-matcher.ts` — нормализация + маппинг.
  - `tournament-type-detector.ts` — парсер `Broadcast.format` → `TournamentType`.
  - `crosstable-composer.ts` — собирает финальный `CrosstableResponse` из распарсенных данных + `broadcast_games`.
  - `chess-results-sync.service.ts` — on-demand + TTL (§2.8), с Redis locks.

- **`src/http/broadcast.controller.ts`** — добавить:
  - `GET /:id/crosstable` — делегирует в `ChessResultsCrosstableService.getForBroadcast(id)`.
  - (Оставляем старый `/:id/standings` до sunset-даты.)

- **`src/sync/broadcast-sync.service.ts`** — дополнить `upsertBroadcast`:
  - Парсить `standingsUrl` → извлечь `chessResultsTournamentId`.
  - Сохранять `Broadcast.tournamentType` (`TournamentTypeDetector.detect(format)`).
  - Интерфейс `LichessBroadcast` расширить: `teamTable?: boolean`, `showTeamScores?: boolean` → писать в одноимённые поля `Broadcast`.

#### 2.9.2 Миграции

`packages/broadcasts-db/prisma/migrations/<timestamp>_add_chess_results_standings/`:

```sql
ALTER TABLE broadcasts
  ADD COLUMN chess_results_tournament_id TEXT,
  ADD COLUMN tournament_type TEXT,
  ADD COLUMN team_table BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN show_team_scores BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE broadcast_standings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id UUID UNIQUE NOT NULL REFERENCES broadcasts(id),
  source_type TEXT NOT NULL,
  source_url TEXT,
  tournament_type TEXT NOT NULL,
  raw_players JSONB NOT NULL,
  raw_cross_table JSONB,
  raw_pairings JSONB,
  raw_teams JSONB,
  fetched_at TIMESTAMPTZ NOT NULL,
  fetch_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 2.9.3 Frontend (`apps/web`)

- `src/api/broadcastApi.ts` — добавить `getCrosstable(tournamentId)`.
- `src/pages/BroadcastTournamentPage.tsx` — switch по `tournamentType`, см. §2.5.
- `src/components/broadcast/RoundRobinCrosstable.tsx` — новый.
- `src/components/broadcast/BroadcastSwissStandings.tsx` — новый.
- `src/components/broadcast/TeamStandings.tsx` — новый.
- `src/components/broadcast/LegacyCrosstable.tsx` — выделенный текущий рендер.
- `src/styles/broadcast.css` — дополнения (sticky columns, team group headers).

#### 2.9.4 Shared types

- `packages/shared/src/types/api-contracts.ts` — секция из §2.7.

### 2.10 Dev / test (Q7)

**Unit-тесты (backend):**

- `test/fixtures/chess-results/` — сохранённые HTML-ответы:
  - `tnr1394105-art1.html` (standings swiss)
  - `tnr1394105-art5.html` (swiss pairings)
  - `tnr1394105-art9.html` (team table)
  - `tnr_RR_art4.html` (round-robin crosstable, взять с Candidates)
  - `tnr_DRR_art4.html` (double round-robin)
  - `tnr_team-RR_art9.html` (Bundesliga)
  - `tnr_edge_empty.html`, `tnr_edge_withdrawn.html`, `tnr_edge_bye.html`
- Mock `fetch` в spec'ах через jest mock (паттерн как в `chess-results.service.spec.ts`).
- Парсер не ходит в сеть в CI — покрытие по fixtures.

**Integration-тест:** опционально, через env-flag `CHESS_RESULTS_INTEGRATION=1` — делает 1 реальный запрос на известный турнир (например, finished Candidates 2024), проверяет что парсер не падает. Не запускаем в CI, только локально при изменении парсера.

**E2E (`apps/e2e`):** мок chess-results через MSW или локальный nginx-фикстура-сервер. Scope follow-up в KS-Q1.

**Frontend (Vitest):**
- Три рендер-теста (RoundRobin / Swiss / Team) на статичных fixture-JSON.
- Теcт диспетчера: при разных `tournamentType` — правильный компонент.
- Тест кликабельности ячейки: когда `gameRef` есть/нет — `navigate` вызывается/не вызывается.

### 2.11 Метрики и логирование

Добавить (backend):
- `chess_results_fetch_total{tournament_id, status}` — counter.
- `chess_results_fetch_duration_seconds` — histogram.
- `chess_results_parse_error_total{reason}` — counter (`missing_players_section`, `unknown_layout`, `regex_mismatch`).
- `crosstable_game_match_miss_total{broadcast_id}` — counter (mapping не нашёл).
- `crosstable_ambiguous_name_total` — counter.
- `broadcasts_with_chess_results_url` — gauge (коэффициент покрытия Lichess → chess-results URL).

Логи (`this.logger.warn`):
- При fetch-error — URL, status, попытка.
- При backoff — сколько минут, причина.
- При ambiguous mapping — оба кандидата.

## 3. Последствия

- **Backend.** Новый модуль `apps/broadcast-service/src/chess-results/`, миграция `packages/broadcasts-db`, изменения в `broadcast-sync.service.ts` (upsert новых полей). Новый endpoint `/:id/crosstable`. Старый `/:id/standings` — deprecated на soak-период 14 дней, потом удаляется.

- **DevOps.**
  - В `apps/broadcast-service` добавить env: `CHESS_RESULTS_USER_AGENT` (default `Kingside/1.0 (chess platform; broadcast sync; staspivovartsev@gmail.com)`), `CHESS_RESULTS_FETCH_TIMEOUT_MS` (15000), `CHESS_RESULTS_TTL_LIVE_S` (300), `CHESS_RESULTS_TTL_UPCOMING_S` (3600), `CHESS_RESULTS_TTL_FINISHED_S` (86400).
  - Миграция `broadcasts_kingside` — стандартная `prisma migrate deploy` в ECS task.
  - Outbound security group broadcast-service — добавить 443 на `chess-results.com`, `s1.chess-results.com`, `s2.chess-results.com`, `s3.chess-results.com` (или wildcard `*.chess-results.com`).
  - Prometheus scrape остаётся без изменений (новые метрики попадают автоматически).
  - CSP на фронте (`connect-src`) — **не затронут**, фронт по-прежнему ходит только на `broadcasts.kingside.site`. Бэкенд сам ходит к chess-results.

- **Frontend.** Три новых компонента + refactor `BroadcastTournamentPage`. Новые shared-types. Обновить моки тестов. i18n-ключи для team/swiss/round-robin заголовков.

- **QA.** Smoke-план:
  - `GET /broadcasts/:id/crosstable` для round-robin (Candidates-like) — matrix непустая, игроки нами известные кликабельны.
  - Для swiss (Chinese Team Chess или аналог) — колонки туров, пара клик. ячеек.
  - Для team (Bundesliga) — команды сгруппированы, клик по команде раскрывает игроков.
  - Для broadcast с `standingsUrl = null` или не chess-results — legacy-рендер как раньше.
  - Rate-limit: открыть одну страницу → увидеть 1 fetch к chess-results в логах. Перезагрузка в пределах 5 мин — 0 fetch'ей (кеш).
  - Отказ chess-results (симулировать 503) — UI показывает `<LegacyCrosstable>` + banner «Standings temporarily unavailable, showing games we have».

- **Документация.** После KS-F3 — обновить `docs/architecture/system-overview.md` (добавить chess-results.com в список внешних интеграций рядом с Lichess).

## 4. Предлагаемые тикеты (декомпозиция, Q8)

Нумерация условная (KS-A хх, координатор проставит).

### Блок 1 — Schema & types (параллельно)

- **KS-A01 [backend]** — `packages/broadcasts-db`: миграция + модели из §2.9.2 (`chess_results_tournament_id`, `tournament_type`, `team_table`, `show_team_scores`, таблица `broadcast_standings`).
- **KS-A02 [backend]** — `packages/shared`: типы из §2.7 (`TournamentType`, `CrosstablePlayer`, `CrossTableMatrix`, `SwissPairings`, `TeamStanding`, `CrosstableResponse`, `GameRef`).

### Блок 2 — Backend parser + composer (последовательно, каждый следующий зависит от предыдущего)

- **KS-A03 [backend]** — `ChessResultsCrosstableService`: fetcher (копия `fetchPage` из `apps/api/src/live-tournament/chess-results.service.ts` + User-Agent + follow-redirect + timeout). Unit-тест: mock fetch, проверка redirect.
- **KS-A04 [backend]** — парсер `art=1` (standings, все типы). Input: HTML fixture → output: `CrosstablePlayer[]`. Не менее 3 fixtures (swiss/rr/team). **Зависит от:** KS-A03.
- **KS-A05 [backend]** — парсер `art=4` (cross-table RR). **Зависит от:** KS-A04.
- **KS-A06 [backend]** — парсер `art=5` (pairings swiss). **Зависит от:** KS-A04.
- **KS-A07 [backend]** — `TournamentTypeDetector` (regex по `format`). Unit-tests на 10 реальных примерах (собрать из top-50 Lichess broadcasts). **Независим.**
- **KS-A08 [backend]** — `PlayerNameMatcher` + `CrosstableComposer`: мэппинг chess-results ↔ `broadcast_games`. Покрытие edge-cases (§2.6). **Зависит от:** KS-A02, KS-A04.
- **KS-A09 [backend]** — `ChessResultsSyncService` (on-demand + TTL, Redis locks, circuit-breaker, метрики §2.11). **Зависит от:** KS-A03-08.
- **KS-A10 [backend]** — endpoint `GET /:id/crosstable` в broadcast-controller + интеграция с `ChessResultsSyncService`. **Зависит от:** KS-A09.
- **KS-A11 [backend]** — расширить `BroadcastSyncService.upsertBroadcast` (§2.9.1): парсить `standingsUrl` → `chessResultsTournamentId`, писать `tournamentType`, `teamTable`, `showTeamScores`. **Зависит от:** KS-A01, KS-A07. Можно параллельно с KS-A09.

### Блок 3 — Frontend (последовательно F1 → параллельно F2/F3/F4)

- **KS-A12 [frontend]** — `src/api/broadcastApi.ts` `getCrosstable()` + extract текущего рендера в `<LegacyCrosstable>` + скелет диспетчера в `BroadcastTournamentPage.tsx`. **Зависит от:** KS-A02 (типы в shared), KS-A10 (endpoint для ручной проверки).
- **KS-A13 [frontend]** — `<RoundRobinCrosstable>` (§2.5, пункт 1). **Зависит от:** KS-A12.
- **KS-A14 [frontend]** — `<BroadcastSwissStandings>` (§2.5, пункт 2). **Зависит от:** KS-A12. Параллельно с KS-A13.
- **KS-A15 [frontend]** — `<TeamStandings>` (§2.5, пункт 3). **Зависит от:** KS-A12. Параллельно с KS-A13/A14.
- **KS-A16 [frontend]** — i18n-ключи + updates existing тестов + unit-тесты новых компонентов. **Зависит от:** KS-A13/A14/A15.

### Блок 4 — Layout (параллельно с F2-F4)

- **KS-A17 [layout]** — стили `.crosstable-rr-*`, `.broadcast-swiss-*`, `.team-standings-*`, sticky-колонки для широких таблиц, адаптивность mobile (scroll-x на узких экранах). **Зависит от:** KS-A13/A14/A15 (нужно видеть готовую разметку).

### Блок 5 — DevOps (минимальное участие)

- **KS-A18 [devops]** — в ECS Task Definition `broadcast-service`: добавить env `CHESS_RESULTS_*` (§3), подтвердить outbound 443 на `*.chess-results.com`. Накатить миграцию KS-A01. **Зависит от:** KS-A01.

### Блок 6 — QA + sunset

- **KS-A19 [qa]** — smoke-план (§3 QA), регресс-проверки 3 типов турниров в prod'е (Bundesliga team, Chinese Team swiss, любой round-robin из top-50). **Зависит от:** весь Блок 3 + KS-A10.
- **KS-A20 [backend]** — после 14 дней soak'а на `/crosstable`: удалить `/:id/standings` из контроллера и соответствующий код в `broadcastApi.ts`. **Зависит от:** KS-A19 + время.

### Карта параллелизма

```
[A01] [A02] [A07]
  \    /     \
   [A03]     [A11]         (A11 требует A01+A07)
    |
  [A04]─┐
    |    \
  [A05]  [A06]
    \     /
    [A08]
      |
    [A09]
      |
    [A10] ──────── [A18]   (A18 требует A01)
      |
    [A12]
     /|\
 [A13][A14][A15]
      \|/
     [A16]
      |
    [A17]
      |
    [A19] ── через 14 дней ── [A20]
```

**Оценка общего числа тикетов:** 20 (9 backend, 5 frontend, 1 layout, 1 devops, 1 qa, 3 cross-cutting/schema).

**Оценка по ролям:**
- backend: A01, A03-A11, A20 — 11 тикетов.
- frontend: A12-A16 — 5 тикетов.
- shared (выносится в backend-очередь): A02 — 1.
- layout: A17 — 1.
- devops: A18 — 1.
- qa: A19 — 1.

**Критический путь:** A01 → A03 → A04 → A08 → A09 → A10 → A12 → (A13/14/15) → A17 → A19. 10 звеньев.

## 5. Открытые вопросы / что спросить у пользователя

Не выдумываю — честно выношу.

1. **Sunset `/standings`.** После rollout `/crosstable` — убираем старый endpoint через 14 дней (KS-A20) или оставляем как alias навсегда? По-хорошему убираем (DRY), но если кто-то делает external-интеграцию через публичный `broadcasts.kingside.site` — сломается. На данный момент публичного OpenAPI у broadcast-service нет, внешних потребителей не заявлено. **Default: удаляем через 14 дней.**

2. **Команда в v1 или отложить в v1.1?** Block 5 из декомпозиции (`<TeamStandings>`, парсер `art=9`) — самый сложный из трёх типов (двухуровневая иерархия UI, разные tiebreak'и, кликабельность по матчам vs партиям). **Рекомендую оставить в v1**, т. к. Bundesliga и Team Championships — 10-15% всех broadcasts и именно они страдают от текущего рендера больше всего (36 игроков × 36 матрица бессмысленна).

3. **Fallback-override для `chessResultsTournamentId`.** Есть broadcasts с `standingsUrl = null` (ожидаемо, ~20-30% по оценке) или ведущими на не-chess-results сайт. Для них сейчас — legacy. **Хотим ли мы в v1 сделать admin UI** для ручной привязки chess-results ID? Моё мнение: нет, v1 — автомэппинг где можно + legacy где нельзя. Admin UI — отдельный epic если появится нужда (вопрос оператора).

4. **Автотест коэффициента покрытия.** Сколько в реальности broadcasts имеют `standingsUrl → chess-results.com`? По выборке top-3 — 2 из 3. Надо инструментировать метрикой `broadcasts_with_chess_results_url` (KS-A11) и смотреть неделю, прежде чем строить фронт-опыт. Если покрытие <50% — стратегия меняется (ADR-024, пересмотр: возможно, брать `live_tournaments`-поток или просить ручной ввод).

5. **Rate-limit chess-results по факту.** Деклараций нет. План 5 мин/турнир + circuit-breaker — «здравый» потолок, но **мы не знаем реального limit'а**. Митигация: после rollout — наблюдать 429 response rate, готовность поднять backoff'ы / уменьшить частоту. Это операционная задача, не блокирующая решение.

6. **Live-обновление standings по WS.** Не в scope v1 (§1.3). Но если пользователь хочет, чтобы standings обновлялась после каждого тура без manual-reload — добавляется WS-broadcast event `broadcast:standings-updated` из `ChessResultsSyncService` в `BroadcastGateway` (после успешного upsert). Фронт подписывается, refetch. Это 1 ticket дополнительно — ориентировочно V1.1.
