# ADR-033: Интерфейс работы с архивной (мастерской) базой партий

**Дата:** 2026-04-28
**Статус:** Предложено
**Задача:** KS-2061
**Связанные:**
- [ADR-013](./013-game-archive-and-tree.md) — базовый архив, схема `archive_games`, `position_stats`
- [ADR-014](./014-archive-games-by-position.md) — список партий по позиции (FEN-индекс), keyset, страница `/archive/games?fen=...`
- [ADR-016](./016-archive-tree-list-ply-sync.md) — fail-closed `totalApprox: null`
- [ADR-018](./018-archive-service-extraction.md) — выделение `archive-service` как отдельного приложения

---

## Контекст

Backend архива уже работает: `archive_games`, `archive_game_positions`, `position_stats`, REST `/api/archive/tree`, `/api/archive/games`, `/api/archive/games/:id`, `/api/archive/games/by-position`. Импортёр TWIC заливает партии, индекс позиций отстроен.

Чего нет: **прямого пользовательского входа в эту базу**. Единственный путь сейчас — через `ArchiveTreePanel` в окне анализа (ADR-014). Пользователь не может:
- открыть «Архив» из главного меню и листать партии без позиции;
- найти все партии конкретного игрока;
- отфильтровать по дебюту/году/турниру не привязываясь к FEN;
- открыть страницу одной партии по shareable URL (сейчас открывается только через `state` в `/analysis`).

Этот ADR описывает MVP полноценного UI поверх **существующих** API/таблиц + минимально необходимые добавки. Дублировать индекс позиций или контракт `by-position` мы не будем — он уже есть и работает.

---

## 1. Сценарии использования

| # | Сценарий | Entry point | Действия | Результат |
| - | -------- | ----------- | -------- | --------- |
| S1 | «Как Карлсен играл против Каруаны» | Главное меню → «Архив» → поиск | Ввод имён в фильтре `player` (можно два); сортировка по дате | Список партий двух игроков, клик → страница партии |
| S2 | «Как мастера играли эту позицию» | Окно анализа → `ArchiveTreePanel` → «View N games →» | (уже работает по ADR-014) | Страница `/archive/games?fen=...` с keyset-списком |
| S3 | «Просто полистать топ-партии турнира» | Главное меню → «Архив» → фильтр по турниру (event) | Сортировка по средней Elo | Список партий одного `event` |
| S4 | «Найти партии в дебюте B90 Najdorf после 2020 года» | Главное меню → «Архив» → фильтр eco + since | Сортировка по дате/Elo | Список с фильтрами |
| S5 | «Профиль игрока: все его партии в архиве» | Клик по имени в строке списка | Перехода на `/archive/players/:slug` | Список партий игрока + краткая статистика |
| S6 | «Открыть конкретную партию по ссылке» | Внешняя ссылка `/archive/games/:id` | — | Страница партии: доска + ходы + метаданные + «другие партии с этой позицией» |
| S7 | «Из партии — обратно в позиционный поиск» | На странице партии — кнопка «Find similar» на текущем ходе | Переход на `/archive/games?fen=<currentFen>` | Возврат в by-position список |

S2 целиком закрыт ADR-014. Остальные — предмет этого ADR.

---

## 2. Точка входа в UI

**Решение: и то, и другое.**

- **Главное меню → «Архив».** Отдельный раздел верхнего уровня. Маршрут `/archive` (lobby с поиском по метаданным) и `/archive/games?...` (результат поиска / список партий).
- **Deep-link из анализа** — остаётся как есть, через `ArchiveTreePanel` (ADR-014). Ссылка на `/archive/games?fen=...&...` shareable, в т.ч. отправляется из меню партии в архиве (S7).

**Обоснование:**
- Архив — крупный самостоятельный продукт (миллионы партий, мастерские базы), он должен иметь top-level entry, иначе пользователи о нём не узнают.
- Поиск по метаданным (S1, S3, S4) семантически не должен требовать открытой позиции — это отдельная точка входа в платформу.
- Deep-link из анализа покрывает S2 без дублирования: тот же `/archive/games` принимает `fen` и переключает поведение на by-position (см. §6).

В навигации (header) появляется пункт «Архив» рядом с существующими разделами. Подменю не нужно: `/archive` сам по себе lobby с поиском.

---

## 3. Что доступно пользователю

**MVP — read-only для всех ролей.** Любой авторизованный/неавторизованный пользователь может искать, фильтровать, открывать партии. Без редактирования, без модерации, без добавления.

**Обоснование:**
- Источник данных — внешний (TWIC через `archive-importer`), редактировать его в UI бессмысленно: следующий импорт перетрёт правки.
- Модерация (скрытие партий, пометка дубликатов) на текущем объёме не нужна — спама нет, источники доверенные.
- Добавление партий пользователем = `bucket=user` — отдельный продукт со своими правилами (ELO-санация, антифрод, ограничения по объёму). Откладываем как follow-up.

**Что отложено (post-MVP):**
- Загрузка пользовательских партий в `bucket=user`.
- Модераторская роль и удаление/скрытие отдельных партий.
- Закладки/коллекции (сохранять понравившиеся партии в личный список).
- Комментарии/аннотации к партиям.

---

## 4. Поисковые операции и фильтры

### 4.1 Два режима списка

Маршрут один — `/archive/games?...`, поведение определяется наличием `fen`:

| Режим | Триггер | Endpoint | Пагинация | Total |
| ----- | ------- | -------- | --------- | ----- |
| **By-position** | `?fen=...` есть | `GET /api/archive/games/by-position` | keyset (`cursor`) | `totalApprox` |
| **Metadata** | `?fen=...` пусто | `GET /api/archive/games` | offset (`limit/offset`) | `total` (точный) |

В обоих режимах — общий компонент `ArchiveGamesList` (универсальная строка партии), но фильтры/header/пагинация рендерятся под режим.

**Почему два режима, а не один:** объяснено в ADR-014 §4.2 — разная семантика total и пагинации, разные индексы. Не объединяем.

### 4.2 Фильтры (metadata-режим)

Все уже поддерживаются `GET /api/archive/games` (см. `archive-games-query.dto.ts`):

| Фильтр | Поле API | UI | Комбинируется с |
| ------ | -------- | -- | --------------- |
| Имя игрока (любой цвет) | `player` | text input + autocomplete | всем |
| Имя белых | `white` | text input | всем |
| Имя чёрных | `black` | text input | всем |
| Минимальный Elo (обоих) | `minElo` | preset (0/2000/2200/2400/2600) | всем |
| Результат | `result` | toggle (1-0 / 0-1 / ½ / *) | всем |
| ECO-код | `eco` | text input + datalist (A00-E99) | всем |
| Дата от | `since` | year picker | всем |
| Дата до (новый) | `until` | year picker | всем |
| Турнир | `event` (новый) | text input | всем |
| Длина партии (новый) | `minPly` / `maxPly` | range | всем |

**Новые поля API** (`until`, `event`, `minPly`, `maxPly`) — добавляются в `ArchiveGamesRequest` и DTO. Все опциональные, обратной совместимости не ломают.

**Комбинации:** все фильтры — AND. Без OR/группировок (overengineering для MVP).

**Сортировки** (новое поле `sort` в metadata-режиме):
- `recent` (default) — `played_at DESC, id DESC`;
- `topElo` — `GREATEST(white_elo, black_elo) DESC NULLS LAST, id DESC`;
- `oldest` — `played_at ASC, id ASC`.

Существующий индекс `(played_at DESC)` покрывает `recent`. Для `topElo` — отдельный индекс `(GREATEST(white_elo, black_elo) DESC NULLS LAST, id DESC)` (выражение-индекс, новая миграция).

### 4.3 Пагинация и лимиты

- Metadata-режим: `limit` 1-200 (default 50), `offset` ≥ 0. Total — точный (`SELECT COUNT(*)`). На корпусе TWIC ~250k partition COUNT ≤ 200ms; на 5M+ — деградирует, тогда переходим на keyset (отдельный ADR в Phase B).
- By-position: уже keyset, описано в ADR-014.

**Жёсткий потолок offset = 5000** — глубже листать бессмысленно, пусть фильтрует.

### 4.4 Полнотекстовый поиск игроков и турниров — единый подход

Решение пользователя (KS-2061): для имён игроков и названий турниров — **умный полнотекстовый поиск с ранжированием по частоте встречаемости (`gamesCount DESC`)**. Тёзки разрешаются автоматически: первый в autocomplete = самый частый. Это закрывает три открытых вопроса (slug-стабильность, тёзки, точное совпадение vs substring) одним подходом.

#### 4.4.1 Нормализованные таблицы

Заводим две новые таблицы в `archive-db` (миграция в B2):

```prisma
model ArchivePlayer {
  id             String    @id @default(uuid()) @db.Uuid
  /** канонический slug, стабильный: "carlsen-magnus". URL-safe, lowercase. */
  slug           String    @unique
  /** канонически отображаемое имя: "Carlsen, Magnus". */
  nameCanonical  String    @map("name_canonical")
  /** нормализованная форма для матчинга: "carlsen magnus" (lower, без пунктуации, без диакритики). */
  nameNormalized String    @map("name_normalized")
  /** все варианты как строка для GIN trgm. ", "-separated. */
  nameAliases    String    @map("name_aliases") @db.Text
  gamesCount     Int       @default(0) @map("games_count")
  peakElo        Int?      @map("peak_elo")
  firstSeenAt    DateTime? @map("first_seen_at")
  lastSeenAt     DateTime? @map("last_seen_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@index([nameNormalized])
  @@index([gamesCount(sort: Desc)])
  @@map("archive_players")
}

model ArchiveEvent {
  id             String    @id @default(uuid()) @db.Uuid
  slug           String    @unique
  nameCanonical  String    @map("name_canonical")
  nameNormalized String    @map("name_normalized")
  gamesCount     Int       @default(0) @map("games_count")
  firstDate      String?   @map("first_date")
  lastDate       String?   @map("last_date")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@index([gamesCount(sort: Desc)])
  @@map("archive_events")
}
```

GIN-индексы (через `Unsupported` или прямой raw SQL в миграции):
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX archive_players_aliases_trgm
  ON archive_players USING GIN (name_aliases gin_trgm_ops);
CREATE INDEX archive_events_name_trgm
  ON archive_events USING GIN (name_normalized gin_trgm_ops);
```

#### 4.4.2 Почему pg_trgm, а не tsvector

- **Имена и названия турниров — короткие токены без морфологии.** `tsvector` со словарями (`english`, `russian`) ничего не даёт — стемминг для «Carlsen» работает как лексема как есть.
- **Подстрочный поиск критичен** для autocomplete: пользователь набирает «carls» — должно матчить «Carlsen». Триграммы это умеют нативно (`carl`, `arls`, `rlse`...). У `tsvector` для этого нужны префиксные `:*` или дополнительный n-gram preprocessing.
- **`similarity()` из `pg_trgm`** даёт численный score 0..1, удобен для вторичного ранжирования при равных `gamesCount`.

#### 4.4.3 Нормализация имён

Применяется одинаково на write (backfill, инкрементальный апдейт) и read (входящий `q`):
1. lowercase;
2. NFKD + удаление диакритики (`Müller` → `muller`);
3. замена пунктуации (`,`, `.`, `-`, `_`) на пробел;
4. collapse whitespace.

Slug = `nameNormalized.replace(/\s+/g, '-')`.

`nameAliases` — конкатенация всех встретившихся вариантов через `, `, чтобы триграммы матчили любую форму («Carlsen,M.» → `carlsen m, carlsen,m, carlsen, m`).

#### 4.4.4 Ранжирование

```sql
SELECT slug, name_canonical, games_count, peak_elo
FROM archive_players
WHERE name_aliases % $1                          -- pg_trgm operator
   OR name_normalized ILIKE $1 || '%'            -- prefix-fast path
ORDER BY
  games_count DESC,
  similarity(name_normalized, $1) DESC,
  name_normalized ASC
LIMIT $2;
```

`%` — оператор pg_trgm с порогом `pg_trgm.similarity_threshold = 0.3` (default), быстро отсекает не-кандидатов через GIN.

Аналогично для событий: `archive_events`, индекс `name_normalized_trgm`.

#### 4.4.5 Backfill и инкрементальный апдейт

- **One-shot backfill** (часть B2): `INSERT INTO archive_players ... FROM (SELECT name FROM archive_games UNION white/black)`. Группировка по `nameNormalized`. `nameAliases` собирается через `string_agg(DISTINCT raw_name, ', ')`.
- **Инкрементально:** после каждого успешного `archive-importer` run — UPSERT в `archive_players`/`archive_events` для новых имён/турниров (отдельный шаг в пайплайне, не блокирует импорт партий). Реализация — в B3 (вместе с endpoint'ами; шаг идёт в `archive-importer`, но логику кодит тот же исполнитель чтобы держать в голове целостность).
- **Метрики:** `archive_players_total`, `archive_events_total` для мониторинга.

#### 4.4.6 Профиль игрока — материализованный view

`archive_player_stats` — MV поверх `archive_players` × `archive_games`:
```sql
CREATE MATERIALIZED VIEW archive_player_stats AS
SELECT
  p.slug,
  COUNT(*) AS games_count,
  COUNT(*) FILTER (WHERE g.white_name = p.name_canonical) AS games_white,
  COUNT(*) FILTER (WHERE g.black_name = p.name_canonical) AS games_black,
  COUNT(*) FILTER (WHERE result_for_player(g, p) = 'win') AS wins,
  COUNT(*) FILTER (WHERE result_for_player(g, p) = 'draw') AS draws,
  COUNT(*) FILTER (WHERE result_for_player(g, p) = 'loss') AS losses,
  MAX(GREATEST(COALESCE(g.white_elo, 0), COALESCE(g.black_elo, 0))) AS peak_elo,
  MIN(g.played_at) AS first_seen_at,
  MAX(g.played_at) AS last_seen_at
FROM archive_players p
JOIN archive_games g ON (g.white_name = p.name_canonical OR g.black_name = p.name_canonical)
GROUP BY p.slug;

CREATE UNIQUE INDEX ON archive_player_stats (slug);
```

`REFRESH MATERIALIZED VIEW CONCURRENTLY archive_player_stats` — после каждого успешного импорта (нагрузка ~10-30s на корпусе 250k, асинхронно). На 5M+ — оценим, возможно перейдём на инкрементальные триггеры; в Phase B пересмотр.

#### 4.4.7 Кэш

- `arch:players:search:<q>` — Redis 5 мин.
- `arch:players:profile:<slug>` — Redis 1 ч (MV сама — кэш, дополнительный слой нужен только под нагрузкой).
- `arch:events:search:<q>` — Redis 5 мин.
- Инвалидация — через существующий `ARCHIVE_IMPORTED_CHANNEL` (расширение `invalidateTreeCache` → `invalidateArchiveCaches`).

---

## 5. Просмотр партии

### 5.1 Маршрут

**`/archive/games/:id`** — отдельная страница, не часть `/analysis`.

Почему отдельная:
- Shareable URL (S6) — `/analysis` сейчас работает через `state` в `navigate`, ссылка не воспроизводит партию.
- Нужен archive-specific UI: блок «другие партии с этой позицией» (S7), ссылки на профили игроков, метаданные турнира.
- `/analysis` остаётся «верстаком» — открыть партию там можно отдельной кнопкой «Open in analysis».

### 5.2 Что на странице

```
┌──────────────────────────────────────────────────────┐
│ < Архив / Партии / Carlsen vs Caruana, 2018          │  breadcrumbs
├────────────┬─────────────────────────────────────────┤
│            │ Carlsen, M. (2835)  vs  Caruana, F. (2832)
│            │ Round 12 · World Championship · 2018-11-26
│            │ Result: ½-½                             │
│   Доска    │ ECO: C42 (Petrov Defence)               │
│            │                                         │
│ (chess-    ├─────────────────────────────────────────┤
│  board)    │ [Список ходов — ходовые кнопки]         │
│            │                                         │
│            ├─────────────────────────────────────────┤
│            │ ▸ Other games with this position (12)   │  при клике на ход
│            │   [список через ArchiveGamesList]       │
│            ├─────────────────────────────────────────┤
│            │ [Open in analysis] [Find similar]       │
│            │ [Copy PGN]                              │
└────────────┴─────────────────────────────────────────┘
```

- **Доска + ходы.** Переиспользуем `chess.js` + `react-chessboard` + существующий `MoveList` из `/analysis` (без stockfish, lite-режим).
- **Метаданные.** Из `ArchiveGameDetail` (есть в API).
- **«Other games with this position»** (S7). Новый правый/нижний блок: на текущем ply берём FEN, грузим первую страницу `GET /api/archive/games/by-position?fen=...&limit=5`, кликом «See all →» уходим в `/archive/games?fen=...`. Ленивая загрузка по клику на toggle (не сразу).
- **Ссылки на профили.** Имена игроков — `<Link to="/archive/players/:slug">`.
- **Кнопки действий.** «Open in analysis» — `navigate('/analysis', { state: { pgn, ... }})` как в `WorkshopPgnList`. «Copy PGN» — clipboard.

### 5.3 Откуда данные

Полностью покрывается **существующим** `GET /api/archive/games/:id` (отдаёт `pgn`, `white`, `black`, `result`, `event`, `date`, `eco`, `opening`, `site`, `round`).

Никаких новых backend-API для просмотра партии **не нужно**, кроме блока «другие партии с этой позицией» — он использует `by-position` (уже есть).

---

## 6. API-контракты (high-level)

### 6.1 Существующее (без изменений контракта)

| Endpoint | Назначение | Используется в |
| -------- | ---------- | -------------- |
| `GET /api/archive/tree?fen=...` | Дерево вариантов из позиции | `ArchiveTreePanel`, ADR-013 |
| `GET /api/archive/games/by-position?fen=...&cursor=...` | Партии через позицию (keyset) | `/archive/games?fen=...`, ADR-014 |
| `GET /api/archive/games/:id` | Одна партия (PGN + метаданные) | `/archive/games/:id`, S6 |

### 6.2 Эволюция существующего

**`GET /api/archive/games`** (metadata-режим, уже есть):
- Новые опциональные поля query: `until`, `event`, `minPly`, `maxPly`, `sort` (`recent` | `topElo` | `oldest`).
- Тип `ArchiveGamesRequest` в `packages/shared/types/archive.ts` расширяется (опционально, обратно совместимо).
- Ответ `ArchiveGamesResponse` без изменений (`{ total, items }`).

### 6.3 Новые endpoint'ы

| Endpoint | Назначение | Источник | Форма ответа |
| -------- | ---------- | -------- | ------------ |
| `GET /api/archive/players/search?q=&limit=` | Autocomplete игроков (FTS, ранжирование по `gamesCount DESC`) | `archive_players` + GIN trgm | `{ items: [{ name, slug, gamesCount, peakElo }] }` |
| `GET /api/archive/players/:slug` | Профиль игрока: статистика | MV `archive_player_stats` | `{ name, slug, gamesCount, peakElo, byColor: { white, black }, byResult: { wins, draws, losses }, firstSeenAt, lastSeenAt }` |
| `GET /api/archive/players/:slug/games?...` | Партии игрока (фильтры/пагинация) | `archive_players` + JOIN `archive_games` | как `ArchiveGamesResponse`, плюс `playerColor` per item |
| `GET /api/archive/events/search?q=&limit=` | Autocomplete турниров (FTS) | `archive_events` + GIN trgm | `{ items: [{ name, slug, gamesCount, firstDate, lastDate }] }` |

DTO детализирует backend в реализации. Архитектор фиксирует только список и зоны ответственности.

### 6.4 Зоны ответственности

- Все endpoint'ы — в `apps/archive-service` (не в `apps/api`), согласно ADR-018.
- Контракты — `packages/shared/src/types/archive.ts`.
- Frontend ходит через `apps/web/src/api/archive.ts` (хелпер уже есть).

---

## 7. Декомпозиция на задачи

### 7.1 Зависимости

```
[B0] shared types: ArchiveGamesRequest+sort/until/event/minPly/maxPly,
                   ArchivePlayer*, ArchiveEvent* типы
        │
        ├──> [B1] archive-service: расширение GET /api/archive/games
        │         (until/event/minPly/maxPly/sort + индекс topElo)
        │
        ├──> [B2] db migrations: archive_players, archive_events,
        │         archive_player_stats MV, GIN trgm индексы,
        │         backfill из archive_games + инкрементальный апдейт
        │         после импорта
        │         │
        │         └──> [B3] archive-service: endpoint'ы
        │                   GET /api/archive/players/search
        │                   GET /api/archive/players/:slug
        │                   GET /api/archive/players/:slug/games
        │                   GET /api/archive/events/search
        │                   + Redis-кэш + инвалидация
        │
        └──> [F0] frontend: роутинг /archive, /archive/games,
                  /archive/players/:slug, /archive/games/:id;
                  api-хелперы; пункт «Архив» в главном меню;
                  i18n ключи (ru+en)
                  │
                  ├──> [F1] страница /archive (лобби: поиск + Recent games
                  │         + Search by position) — зависит от B1, B3
                  │
                  ├──> [F2] страница /archive/games (universal list,
                  │         два режима: by-position и metadata) — зависит от B1
                  │
                  ├──> [F3] страница /archive/players/:slug — зависит от B3
                  │
                  └──> [F4] страница /archive/games/:id (просмотр партии
                            + lazy-блок «other games with this position»
                            на текущем ply) — зависит только от существующих API

[L1] layout: стили страниц архива, mobile-карточки     (после F1-F4)
[Q1] qa: e2e сценарии S1, S3-S7                         (после L1)
```

### 7.2 Параллелизация

**Сначала:**
1. **B0** — shared types. Разблокирует всё.

**Потом параллельно:**
2. **B1** (расширение games endpoint) и **B2** (миграции + backfill players/events/MV) — независимы.
3. **F0** и **F4** — F0 готовит инфру, F4 использует только существующие API.

**Когда B2 готов:**
4. **B3** — endpoint'ы players/events.

**Когда B1, B3 готовы:**
5. **F1**, **F2**, **F3** — параллельно.

**В конце:**
6. **L1** (стили) → **Q1** (e2e).

### 7.3 Точки синхронизации

- **`packages/shared/src/types/archive.ts`** — расширение типов делает backend в B0 первым коммитом, frontend импортирует те же типы.
- **`apps/web/src/api/archive.ts`** — добавление новых клиентских функций (`searchPlayers`, `getPlayerProfile`, `getPlayerGames`) делает фронт в F0 одним коммитом, дальнейшие F1/F3 опираются на готовые функции.
- **Routing** — `apps/web/src/App.tsx` (или router-файл) — F0 первым добавляет все 4 маршрута сразу с заглушками, дальнейшие задачи наполняют страницы.

---

## 8. Импорт/экспорт PGN

**В MVP — только экспорт одной партии**, копированием PGN в clipboard на странице `/archive/games/:id` (кнопка «Copy PGN»). Реализуется тривиально: `navigator.clipboard.writeText(pgn)`.

**Импорт PGN пользователем — отложено в follow-up.** Обоснование:
- Импорт = `bucket=user`, требует отдельной инфраструктуры: лимиты на пользователя, антифрод (фейковые партии с фейковым Elo «обмазываются» в master-tree), модерация.
- Текущий `archive-importer` спроектирован под TWIC pull-схему — переиспользовать его для пользовательского upload нельзя без переделки.
- Это самостоятельный продукт со своими сценариями, отдельный ADR.

**Массовый экспорт результатов поиска (PGN-файл со списком партий) — отложено.** Сценарий нишевый, реализация требует streaming response и аккуратной авторизации (rate limit, защита от выкачивания всей базы). Если будет спрос — отдельная задача.

---

## 9. Закрытые решения (после согласования с пользователем 2026-04-28)

1. **Slug игрока / тёзки / event substring (вопросы 1, 3, 5).** Закрыты единым подходом: полнотекстовый поиск с GIN+pg_trgm поверх нормализованных таблиц `archive_players` и `archive_events`, ранжирование по `gamesCount DESC`. Тёзки разрешаются автоматически — первый в autocomplete = самый частый. Slug стабилизируется через `nameNormalized`. Детали в §4.4.
2. **Профиль игрока (вопрос 2).** Материализованный view `archive_player_stats`, REFRESH CONCURRENTLY после каждого импорта. См. §4.4.6.
3. **Лобби `/archive` (вопрос 4).** Минимум: поисковая форма + блок «Recent games» (10 последних) + кнопка «Search by position».
4. **«Other games with this position» (вопрос 6).** На текущем ply просмотра, ленивая загрузка по клику на toggle.
5. **i18n (вопрос 7).** Локализация ru+en сразу, все строки через `i18next`. Включается в каждую frontend-задачу (F0-F4).

Новых открытых вопросов нет. Переходим к декомпозиции и реализации.

---

## TL;DR

Архив партий получает полноценный пользовательский интерфейс: пункт «Архив» в главном меню (`/archive` лобби + `/archive/games` универсальный список с двумя режимами — by-position из ADR-014 и metadata-поиск с фильтрами player/eco/event/year/result/length), профиль игрока (`/archive/players/:slug`) и страница партии (`/archive/games/:id`) с lazy-блоком «другие партии с этой позицией». MVP read-only, импорт PGN пользователем отложен. Поиск имён и турниров — единый: GIN+pg_trgm поверх нормализованных таблиц `archive_players`/`archive_events`, ранжирование по частоте (тёзки разрешаются автоматически). Профиль — материализованный view с REFRESH CONCURRENTLY после импорта. Лобби минимум: поиск + Recent games + Search by position. i18n ru+en сразу. План: B0 shared types → параллельно (B1+B2→B3 backend) и (F0+F4 frontend) → параллельно (F1, F2, F3) → L1 стили → Q1 e2e.
