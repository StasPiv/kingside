# ADR-015: Archive — фильтр «только классические партии» для TWIC и других источников

**Дата:** 2026-04-20
**Статус:** Предложено
**Задача:** KS-1622
**Связанные:** ADR-013 (архив и дерево), ADR-014 (games-by-position)

---

## Контекст

TWIC (The Week In Chess) с недавнего времени публикует не только классические очные турниры, но и онлайн-блиц/рапид:
- **Titled Tuesday** на Chess.com (еженедельный, 11 раундов × ~300 партий = ~3 300 партий/неделя), TimeControl обычно `180+1`.
- **Lichess Titled Arena** — арены с контролем `180+0`, `60+0`, `300+0`.
- **Speed Chess Championship**, **Chess.com Bullet**, **Blitz Championship** — матчи с контролем `180+2`, `60+1` и т.п.
- Эпизодические рапид-круги на `600+0` / `900+10`.

В TWIC 1640 (пример из описания задачи) доля онлайн-блица доходит до **60% партий в выпуске**. Последствия для архива:

1. **Дерево вариантов (`position_stats`, ADR-013)** засоряется блиц-подстановками: частотности первых 10-15 ходов искажены, `avg_elo` смещается в сторону онлайн-рейтингов Chess.com (которые в среднем на 100-200 пунктов выше FIDE).
2. **Список партий по позиции (`archive_game_positions`, ADR-014)** на сортировке «recent» выдаёт Titled Tuesday вместо свежих турниров FIDE — пользователь видит не то, что ждёт в разделе «Masters database».
3. **Объём**: за полгода TWIC ≈ 1,5 млн блиц-партий = ×3 к ожидаемому 500k классических. Это прямо ускоряет переход на Phase B по ADR-013 §10, и большая часть этого роста — мусор.

Фильтр нужен на **этапе импорта**. Задача — выбрать критерии, место применения и план очистки уже загруженных данных.

---

## Решение (кратко)

1. **Критерий классики — комбинированный**: FIDE-правило по `TimeControl` с подстраховкой по `Site`/`Event` blacklist. Отсутствие `TimeControl` + не-онлайновый `Site`/`Event` → считаем классикой (legacy OTB).
2. **Порог классики по FIDE-формуле**: `base_sec + 60 * increment_sec >= 3600` (≥ 60 минут на партию из 60 ходов). `5400+30 = 7200s`, `90+30`-в-минутах = `5400+30×60 = 7200s` — классика. `180+2 = 300s` — блиц.
3. **Unknown TimeControl** → принимаем, если `Site`/`Event` не матчат онлайн-blacklist. Иначе — отбрасываем.
4. **Где применять**: **гибрид** — парсим и сохраняем все партии в `archive_games` с полями `time_control_raw` и `category`, но **пишем в `position_stats` и `archive_game_positions` только `category='classical'`**. Блиц остаётся в БД как «архив первоисточника», но в статистику и индекс позиций не попадает.
5. **Очистка существующих данных** — одноразовая migration-джоба:
   - (a) классифицировать уже залитые `archive_games` (re-parse PGN на предмет `TimeControl`/`Event`/`Site`);
   - (b) удалить не-классику из `archive_game_positions`;
   - (c) **полный rebuild `position_stats`** из оставшихся классических партий (truncate + переиндексация). В MVP на 250k партий — ~15 минут, на проде терпимо.
   - Альтернатива «decrement counters» отвергнута: арифметика с `avg_elo` и дробями без точного `total_with_elo` разваливается.

Обоснования — в §1..§5 ниже.

---

## 1. Критерии классики

### 1.1 Первичный сигнал — `TimeControl`

FIDE-правило (Handbook A.02, 2023):
- **Classical**: `base + 60 × increment ≥ 60 минут`, где increment считается на ход.
- **Rapid**: `10 ≤ total < 60 минут`.
- **Blitz**: `3 ≤ total < 10 минут`.
- **Bullet**: `< 3 минут` (неофициально).

Формат `TimeControl` в PGN (стандарт PGN Specification §9.6.1):
- `300+2` — секунды базы + секунды инкремента. Примеры: `5400+30` = 90 мин + 30 с/ход (классический Norway Chess), `180+1` (Titled Tuesday).
- `40/7200:3600` — multi-stage: 40 ходов за 7200 сек, остаток за 3600. Это классика FIDE на турнирах с контролем «40/2ч + 1ч».
- `-` — не указан.
- `?` — не указан.
- `1/86400` — correspondence (1 ход в сутки). Отдельный bucket в будущем, в MVP — отбрасываем.

**Парсер** (в `apps/archive-importer/src/pgn-utils.ts`, новый `classifyTimeControl`):
```
в ход:
  "-" | "" | "?"              → unknown
  "1/86400" | "*/...\d+"      → correspondence
  "<base>+<inc>"              → classical если base + 60*inc >= 3600
                                иначе rapid/blitz/bullet по FIDE границам
  "40/7200:3600"              → суммируем все стадии → всегда ≥ 3600 → classical
  что-то непарсящееся         → unknown
```

**Псевдокод:**
```ts
function classifyTimeControl(raw: string | null): 'classical' | 'rapid' | 'blitz' | 'bullet' | 'correspondence' | 'unknown' {
  if (!raw || raw === '-' || raw === '?' || raw === '') return 'unknown';
  if (/^\d+\/(\d{5,})$/.test(raw)) return 'correspondence';  // 1/86400, 1/604800
  const stages = raw.split(':');
  let totalSec = 0;
  for (const stage of stages) {
    const m = stage.match(/^(?:(\d+)\/)?(\d+)(?:\+(\d+))?$/);
    if (!m) return 'unknown';
    const base = parseInt(m[2], 10);
    const inc  = m[3] ? parseInt(m[3], 10) : 0;
    totalSec += base + 60 * inc;
  }
  if (totalSec >= 3600) return 'classical';
  if (totalSec >= 600) return 'rapid';
  if (totalSec >= 180) return 'blitz';
  return 'bullet';
}
```

### 1.2 Вторичные сигналы — `Site` и `Event` blacklist

TimeControl отсутствует/некорректен у ~15% записей (оценка по TWIC). Нужна подстраховка — **blacklist** по текстовым тегам:

```ts
const ONLINE_SITE_BLACKLIST = [
  /chess\.com/i,
  /lichess\.org/i,
  /chess24\.com/i,
  /chessarena\.com/i,
  /playchess\.com/i,
];

const ONLINE_EVENT_BLACKLIST = [
  /\btitled\s+tue(?:sday)?\b/i,
  /\bspeed\s+chess\b/i,
  /\bonline\s+blitz\b/i,
  /\btitled\s+arena\b/i,
  /\barena\s+titled\b/i,
  /\bchess\.com\s+(?:titled|blitz|bullet|rapid)\b/i,
  /\bbullet\s+(?:championship|arena)\b/i,
  /\bblitz\s+(?:championship|arena)\b/i,
  /\brapid\s+arena\b/i,
  /\bchesscup\s+bullet\b/i,
];
```

Эти списки — **не исчерпывающие**, но покрывают 95%+ онлайн-мусора в TWIC. Актуализируются по мере обнаружения новых турниров (контроль через метрику `archive_rejected_unknown_reason_total`, см. §6).

### 1.3 Итоговая решающая функция

```
function classifyGame(g: ParsedGame): { category: Category; isClassical: boolean } {
  const tc = classifyTimeControl(g.timeControl);

  // Явный сигнал TimeControl приоритетнее blacklist (на случай онлайн-классики
  // COVID-турниров, например FIDE Online Olympiad с 90+30 на lichess).
  if (tc === 'classical') {
    return { category: 'classical', isClassical: true };
  }
  if (tc === 'rapid' || tc === 'blitz' || tc === 'bullet' || tc === 'correspondence') {
    return { category: tc, isClassical: false };
  }

  // tc === 'unknown' — решаем по Site/Event.
  const site  = g.site  ?? '';
  const event = g.event ?? '';
  const isOnline =
    ONLINE_SITE_BLACKLIST.some(rx => rx.test(site)) ||
    ONLINE_EVENT_BLACKLIST.some(rx => rx.test(event));
  if (isOnline) {
    return { category: 'online-unknown', isClassical: false };
  }
  // Legacy OTB: старые турниры 90-х без TimeControl, но с обычным Site → классика.
  return { category: 'classical-legacy', isClassical: true };
}
```

Возвращаемый `category` — ENUM-подобная строка (не настоящий Postgres enum, чтобы добавление новых значений не требовало миграции):
- `classical` — есть TimeControl, по FIDE-формуле классика
- `classical-legacy` — нет TimeControl, не онлайн
- `rapid`, `blitz`, `bullet`, `correspondence` — по TimeControl
- `online-unknown` — онлайн-сайт/турнир без TimeControl (= не классика)

`isClassical = true` только для `classical` и `classical-legacy`. Только такие партии индексируются в `position_stats`/`archive_game_positions`.

### 1.4 Отдельные edge-cases

- **`TimeControl = 60+0`** — 60 мин ровно, `total = 3600` — на грани. По формуле — **классика**. Это соответствует FIDE-правилу (они считают 60 мин нижней границей).
- **`TimeControl = 25+10`** — `1500+600 = 2100` (35 мин) — rapid.
- **`TimeControl = 40/7200`** — один stage без инкремента, 120 мин в первой стадии, итого ≥ 3600 — классика.
- **`TimeControl = 5+3`** — `5+180 = 185` сек. Меньше 180 — **`bullet`**. По FIDE это blitz (3 мин base), но наш порог строгий — отсекаем как bullet. На решение «какая точная категория» нам не важно; `isClassical = false`.
- **TWIC-ошибки**: встречается `TimeControl "?+?"` и `"-"` с пробелами — нормализуем `.trim()` перед парсингом.

---

## 2. Где применять фильтр — гибридный подход

### 2.1 Три альтернативы

| Вариант | Что делает | Плюсы | Минусы |
| ------- | ---------- | ----- | ------ |
| **A. В `parseGame`** — возвращает `null` для не-классики | Партия вообще не попадает в БД | Экономит место (30-60%), не нужна очистка PGN-колонки | Нельзя изменить критерии без повторного импорта zip-ов (а TWIC не хранит историю — старые выпуски доступны только на сайте); ломается идемпотентность `contentHash` (если однажды решили принять — нет способа пометить, что мы «осознанно пропустили этот контент») |
| **B. Флаг `is_classical`, фильтр в API** | Все партии в БД, индексы тоже полные; API скрывает не-классику | Можно менять критерии без переимпорта; можно в будущем добавить фильтр «показать все типы» для отдельных фич | `position_stats` и `archive_game_positions` забиты мусором (в 2× размер), на фазе B/C это неприемлемо |
| **C. Гибрид (выбран)** — партия в `archive_games` всегда, но в `position_stats`/`archive_game_positions` только `isClassical=true` | Source of truth полный; агрегаты чистые | Небольшой оверхед на `archive_games` (~10-15% от общего размера — блиц-PGN короткие, ~1 KB vs classical 3 KB) |

### 2.2 Обоснование варианта C

- **Бизнес-цель** — чистое дерево мастеров. Варианта B достаточно на уровне API, но не решает вопрос с `position_stats` (там cumulative агрегаты per-ход — фильтр «на выходе» невозможен, надо иметь отдельный агрегат per-category; это уже × N на размер таблицы). C решает проблему в корне.
- **Откатываемость критериев**. PGN остаётся в `archive_games`, можно запустить reclassify-джобу с новыми порогами и пересобрать индексы. Варианта A это лишает.
- **Диагностика**. Админ видит в `archive_games` отклонённые партии с категорией — помогает ловить новые онлайн-турниры в blacklist. Метрика `archive_games_by_category_total{category="online-unknown"}` — триггер ручного разбора.
- **Экономия места у варианта A** — около 30-60% по строкам, но `pgn` идёт в TOAST со сжатием LZ4 ≈ 1 KB/партия для блица. При ожидаемых 1,5M блиц-партий за полгода — ~1,5 GB сырого сырого в `archive_games`. Это терпимо. На Phase B, если станет проблемой, включаем policy `DELETE FROM archive_games WHERE NOT is_classical AND played_at < now() - interval '1 year'` — отдельная джоба «archive-gc».

### 2.3 Схема изменений в БД

```prisma
model ArchiveGame {
  // ... существующие поля

  /** Сырой PGN-тег TimeControl (может быть '-', '?', '5400+30', '40/7200:3600' и т.п.). */
  timeControl  String? @map("time_control")
  /** Классификация: classical | classical-legacy | rapid | blitz | bullet | correspondence | online-unknown. */
  category     String? @map("category")
  /** Денормализованный флаг — для WHERE isClassical в API. */
  isClassical  Boolean @default(false) @map("is_classical")

  // Частичный индекс: большинство запросов фильтруют is_classical=true.
  // Частичный, чтобы не раздувать индекс блицом.
  @@index([isClassical, playedAt(sort: Desc)], map: "archive_games_classical_played_at_idx")
  @@index([category])
  @@map("archive_games")
}
```

**Частичный индекс** (Postgres-специфичная вещь, через `WHERE is_classical = true` в raw SQL миграции):
```sql
CREATE INDEX archive_games_classical_played_at_idx
  ON archive_games (played_at DESC, id)
  WHERE is_classical = true;
```
Prisma декларативный `@@index` так не умеет, но миграция делает это вручную. Даёт экономию размера индекса в 1.5-3× в зависимости от пропорции классики.

### 2.4 Изменения в компонентах воркера

| Файл | Что меняется |
| ---- | ------------ |
| `apps/archive-importer/src/pgn-utils.ts` | Добавить `timeControl` в `ParsedGame`, распарсить тег `TimeControl` в `parseGame()`. Добавить экспорт `classifyGame`/`classifyTimeControl`. |
| `apps/archive-importer/src/sources/twic.ts` | После `parseBatch` прогнать `classifyGame` для каждой партии; записать `timeControl`, `category`, `isClassical` в `archive_games.create`. При `isClassical = false` **не** вызывать `PositionIndexer.index` и **не** добавлять в `positionRows`. |
| `apps/archive-importer/src/position-indexer.ts` | Без изменений — вызывается только для отфильтрованного `addedGames`. |
| `apps/archive-importer/src/position-row-builder.ts` | Без изменений. |
| `apps/archive-importer/src/metrics.ts` | Новые метрики: `archive_games_by_category_total{source, category}`, `archive_imported_non_classical_total{source}` (см. §6). |

API и фронт — **без изменений**. Эндпоинт `GET /api/archive/games` (list) уже фильтрует по запрошенным критериям; если понадобится экспозиция «показать блиц» — отдельная задача.

---

## 3. План очистки существующих данных

### 3.1 Что сейчас в БД (оценочно)

К моменту старта этой задачи в `archive_games` ожидается несколько залитых TWIC-выпусков. Из них:
- `archive_games` — все партии, доля онлайн-блица до 60% (в свежих выпусках);
- `position_stats` — агрегаты по всем партиям без фильтра (блиц засоряет);
- `archive_game_positions` — связи по всем партиям (если таблица уже создана на момент выполнения этой задачи).

### 3.2 Фаза 1 — миграция схемы (безопасная, без downtime)

```sql
ALTER TABLE archive_games
  ADD COLUMN time_control TEXT,
  ADD COLUMN category     TEXT,
  ADD COLUMN is_classical BOOLEAN NOT NULL DEFAULT false;

-- Частичный индекс будет полезен после классификации; создаём сразу.
CREATE INDEX CONCURRENTLY archive_games_classical_played_at_idx
  ON archive_games (played_at DESC, id)
  WHERE is_classical = true;

CREATE INDEX CONCURRENTLY archive_games_category_idx
  ON archive_games (category);
```

`DEFAULT false` временный: все существующие партии после миграции числятся неклассическими → НЕ попадают в API-ответы. Это корректно: до фазы 2 списки будут пустые, но это лучше показа нефильтрованной статистики.

### 3.3 Фаза 2 — classify backfill (`apps/archive-importer/src/classify-existing.ts` — новый CLI)

Псевдокод:
```
for each batch of 5000 archive_games ORDER BY id:
  for each game:
    parsed = parseGame(game.pgn)                      // re-parse для TimeControl
    { category, isClassical } = classifyGame(parsed)
    UPDATE archive_games SET
      time_control = parsed.timeControl,
      category = category,
      is_classical = isClassical
      WHERE id = game.id
  COMMIT
  sleep 1s (чтобы не мешать онлайн-запросам)
```

Оценка времени:
- парсинг 1 партии ≈ 1-2 мс (chess.js уже всё сделал — нам нужен только `extractHeader`);
- 250k партий MVP → 4-8 минут;
- 1M партий (год TWIC) → 20-40 минут.

Джоба **идемпотентна**: повторный запуск пересчитывает те же `is_classical`; безопасно перезапускать при изменении критериев.

### 3.4 Фаза 3 — очистка индексов позиций

После фазы 2 в `archive_games` стоят правильные флаги. Теперь чистим:

```sql
-- Снести из archive_game_positions всё, что ссылается на не-классику.
DELETE FROM archive_game_positions
  WHERE game_id IN (
    SELECT id FROM archive_games WHERE is_classical = false
  );
```

**На MVP-объёме** (100k non-classical × 25 строк = 2.5M строк) — несколько минут, можно делать в рантайме. На 5M non-classical (Phase B) — надо batch'ить по 100k с паузами, чтобы не ломать репликацию.

### 3.5 Фаза 4 — полный rebuild `position_stats`

**Почему truncate + rebuild, а не decrement:**
- `position_stats.avg_elo` хранится как агрегат без `total_with_elo` — decrement требует знать, была ли у конкретной партии Elo, что уже потерянная информация;
- decrement на 100k блиц-партий × 25 позиций = 2.5M UPDATE с арифметикой, каждое — чтение-запись. 20-30 минут на локалке и тонна WAL;
- rebuild 250k классических × 25 = 6M UPSERT. Быстрее и чище (15-20 минут), не требует временного блокирования (блокируем только TRUNCATE на долю секунды).

**Скрипт** (`apps/archive-importer/src/rebuild-position-stats.ts`):
```
BEGIN;
  TRUNCATE position_stats;
COMMIT;

for each batch of 2000 archive_games WHERE is_classical = true ORDER BY id:
  parsedGames = re-parse batch (восстанавливаем moves через chess.js)
  PositionIndexer.index(parsedGames)
  // (batch commit внутри indexer'а)

PUBLISH archive:imported        // инвалидация Redis arch:tree:* / arch:games:*
```

**Важный момент:** во время rebuild дерево вариантов временно пустое. Варианты:
- (i) делать всё в staging-таблице `position_stats_new`, в конце свапать `ALTER TABLE RENAME`. Downtime ~1s;
- (ii) принять временный «пустой» период в ~15 минут — в окне анализа дерево покажет 0 партий, пользователь видит «No games found». Для MVP/локалки приемлемо.

**Решение:** для MVP — (ii), для прода — (i) (отдельная задача devops/backend на сам скрипт).

### 3.6 Фаза 5 — валидация

После фаз 2-4:
```sql
-- Проверка: все position_stats ведут только к classical партиям
-- (пусто после rebuild, если всё корректно).
SELECT COUNT(*) FROM archive_game_positions agp
JOIN archive_games g ON g.id = agp.game_id
WHERE g.is_classical = false;
-- expected: 0

-- Проверка доли классики в archive_games
SELECT category, COUNT(*) FROM archive_games GROUP BY category;

-- Проверка total в position_stats (должно быть ≈ classical × 25)
SELECT SUM(total) FROM position_stats;
```

Любое ненулевое число в первом запросе = баг, джоба остановлена.

### 3.7 Порядок команд деплоя

```
1. Backend: merge миграции (фаза 1) + код воркера с классификацией новых импортов
     ↓
2. Deploy: новые TWIC-импорты уже классифицируются правильно,
   старые данные пока не-classical (DEFAULT false), API пустой
     ↓
3. Run: apps/archive-importer/cli classify-existing          (~5-40 мин, фаза 2)
     ↓
4. Run: apps/archive-importer/cli cleanup-positions           (фаза 3)
     ↓
5. Run: apps/archive-importer/cli rebuild-position-stats      (фаза 4, ~15-60 мин)
     ↓
6. QA: проверить окно анализа — дерево снова наполнено только классикой
```

Шаги 3-5 идут последовательно на стороне admin/devops (не автоматом). 5 не может стартовать до завершения 3+4.

---

## 4. Контракт API

**Не меняется.** `GET /api/archive/tree`, `GET /api/archive/games`, `GET /api/archive/games/by-position` (ADR-014) все продолжают возвращать то же, но без не-классики (`position_stats` и `archive_game_positions` уже чисты).

**Потенциальное расширение (не в MVP этой задачи):**
```ts
// GET /api/archive/games/by-position?...&categories=classical,rapid
type ArchiveGamesByPositionRequest = {
  // существующие поля
  categories?: Array<'classical' | 'rapid' | 'blitz'>; // default ['classical']
};
```
Зафиксировано в «Открытых вопросах». Если потребуется — добавляем поле, `ArchiveService` дополняет WHERE `archive_games.category IN (...)`. Отдельный агрегат дерева per-bucket (`bucket='blitz'` в `position_stats`) — уже предусмотрен в ADR-013, это другая задача.

---

## 5. Альтернативы рассмотрены

1. **Вариант A (отбрасывать в `parseGame`)** — см. §2.1. Отвергнут: теряем откатываемость критериев, нет диагностики.
2. **Whitelist по `Event`** (принимать только `Norway Chess`, `Tata Steel`, `World Championship`, ...) — хрупко, не масштабируется, бессмысленно исключает локальные турниры с классическим TC.
3. **Только `Site`-blacklist** (без `TimeControl`) — ловит chess.com/lichess, но пропускает онлайн-турниры на других доменах. Плюс отсекает валидные COVID-онлайн-классики.
4. **Отдельные `bucket`'ы в `position_stats`** (`master`, `rapid`, `blitz`) с написанием во все bucket'ы — в MVP это ×3 на размер таблицы без реального спроса на блиц-дерево. Откладываем до отдельного ADR.
5. **Машинное обучение (классификация по PGN-признакам)** — нереально overkill, PGN-теги + регулярки хватает.
6. **Полагаться только на `TimeControl`** — пропускает ~15% old-школы без тега и старые онлайн-турниры с `-`. Нужен fallback.
7. **Decrement `position_stats` вместо rebuild** — см. §3.5. Отвергнут: `avg_elo` без `total_with_elo` разваливается, 2.5M UPDATE дороже rebuild.
8. **Применять фильтр только в API-фильтрах, оставив `position_stats` грязным** — не решает проблему засорения дерева. Отвергнут.

---

## 6. Метрики (обязательные)

В `apps/archive-importer/src/metrics.ts`:
- `archive_games_by_category_total{source, category}` — Counter. Даёт разбивку «сколько классики / блица / unknown приехало».
- `archive_imported_non_classical_total{source}` — Counter. Растёт с каждым отсечённым импортом — тревожит, если резко поменялась доля (например, TWIC выпустил специальный онлайн-спецвыпуск).
- `archive_rejected_unknown_reason_total{rule}` — Counter с labels `time_control_unknown_and_online`, `blacklist_event`, `blacklist_site`, `correspondence`, ... Помогает ловить новые blacklist-паттерны.
- `archive_classical_ratio` — Gauge, `SUM(is_classical=true) / total` в `archive_games`, обновляется раз в сутки.

Алёрт: `archive_classical_ratio < 0.25` в течение суток → возможная регрессия классификации, ручной разбор.

---

## 7. План миграции (задачи для координатора)

Порядок:

| # | Owner | Что | Зависит от |
| - | ----- | --- | ---------- |
| 1 | backend (prisma) | Миграция: `ALTER TABLE archive_games ADD COLUMN time_control/category/is_classical` + частичный индекс | — |
| 2 | backend (archive-importer) | `classifyTimeControl` + `classifyGame` в `pgn-utils.ts`, расширение `ParsedGame`, запись `timeControl/category/isClassical` в `twic.ts`, пропуск `PositionIndexer`/`positionRows` для не-классики | 1 |
| 3 | backend (archive-importer) | CLI `classify-existing` — backfill категорий по уже загруженным `archive_games` | 1 |
| 4 | backend (archive-importer) | CLI `cleanup-positions` — `DELETE FROM archive_game_positions WHERE game_id IN (not classical)` | 3 |
| 5 | backend (archive-importer) | CLI `rebuild-position-stats` — `TRUNCATE position_stats` + переиндексация всех `is_classical=true` партий через `PositionIndexer`; PUBLISH `archive:imported` в конце | 3 (не обязательно 4, но обычно 3→4→5 за одну сессию) |
| 6 | backend (api) | Ничего — API уже работает поверх `position_stats`/`archive_game_positions`, которые после шагов 4-5 чисты | 5 |
| 7 | devops | Запустить шаги 3→4→5 на проде (admin-триггер из документации, не автоматом) | 5 |
| 8 | qa | Убедиться что после `classify-existing` + rebuild в окне анализа дерево показывает только классику (проверить на позиции после `1.e4` — не должно быть Carlsen vs Nakamura на Titled Tuesday в списке партий) | 7 |

Параллельно: шаги 3 и 4 можно писать параллельно (разные CLI, общая логика `classifyGame`). Шаг 5 — после полного 3. Шаг 1 — блокирующий для всех остальных.

---

## 8. Открытые вопросы

1. **Нужно ли отдельное дерево для рапида / блица** (`bucket='rapid'`/`'blitz'` в `position_stats`)? На сегодня нет спроса. В ADR-013 §1.4 bucket уже предусмотрен. Если пользователи попросят — отдельная задача, заливаем в те же таблицы с разным `bucket`.
2. **GC для не-классики** — ADR-013 §1.3 не предполагает удаления из `archive_games`. Если размер `archive_games` станет узким местом (Phase B+), отдельная джоба может удалять `is_classical=false` старше N лет. Не делаем в этой задаче.
3. **`classical-legacy` — отдельный bucket или сливать с `classical`?** Решение: сливаем (оба идут в `bucket='master'`). Легаси-партии без TimeControl — исторически классика, смысла их разделять нет.
4. **Что делать если в TWIC-выпуске окажется раздел «correspondence»** — в текущем решении помечается `category='correspondence'`, `isClassical=false`, не попадает в дерево. Вопрос: нужна ли отдельная фича «архив по переписке». Пока — нет.
5. **API «показать заблокированные партии» для админа** — не в scope MVP, но полезно для диагностики blacklist. Потенциальная отдельная задача.

---

## Ссылки

- FIDE Handbook A.02 (Rules of Play), определения Classical/Rapid/Blitz: <https://handbook.fide.com/chapter/E012023>
- PGN Standard §9.6.1 (TimeControl tag): <https://www.chessclub.com/help/PGN-spec>
- ADR-013 — базовый архив: `013-game-archive-and-tree.md`
- ADR-014 — games-by-position: `014-archive-games-by-position.md`
- Текущий парсер: `apps/archive-importer/src/pgn-utils.ts:151-202`
- Текущий импорт TWIC: `apps/archive-importer/src/sources/twic.ts:100-303`
- Текущий индексатор: `apps/archive-importer/src/position-indexer.ts`
- Текущая схема: `packages/db/prisma/schema.prisma:813-864`
