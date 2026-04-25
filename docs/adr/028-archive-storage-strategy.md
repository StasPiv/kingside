# ADR-028: Стратегия хранилища архива партий — пересмотр после KS-1893

**Дата:** 2026-04-25
**Статус:** Предложено (требуется решение пользователя)
**Задача:** KS-1901
**Связанные:**
- [ADR-013 Game archive and tree](./013-game-archive-and-tree.md) — фазы A/B/C/D, ClickHouse-secondary
- [ADR-014 Archive games by position](./014-archive-games-by-position.md) — `archive_game_positions`, индексы
- [ADR-018 Archive service extraction](./018-archive-service-extraction.md) — выделение HTTP-сервиса
- [ADR-027 Archive RDS sizing](./027-archive-rds-sizing.md) — sizing PG (Phase B), может быть пересмотрен
- KS-1893 — производственный инцидент, мотивация пересмотра
- KS-1900 — секционирование `archive_game_positions` (зависит от выбора в этом ADR)

---

## 1. Контекст

### 1.1 Что произошло (KS-1893)

ADR-013 §10.A закладывал переход на Phase B (партиционирование, COPY-pipeline)
при объёме > 30M строк `position_stats` и переход на ClickHouse (Phase C) при
> 100M строк или подключении Lichess. Триггер «10M партий» был задуман как
архитектурный, не операционный.

В KS-1893 эта картина **сломалась эмпирически**: на 4.14M строк
`archive_game_positions` (1.4 GB с индексами) импорт TWIC замедлился в **30×**,
запросы `/tree` стали падать на ping timeout. PK-индекс размером 303 MB
оказался в **3.3× больше** `shared_buffers = 91 MB` на db.t3.micro, и
любые UPSERT'ы шли с диска.

ADR-027 (KS-1899) дал ответ «scale-up до t3.large» (8 GB RAM, ~2 GB
shared_buffers) — это разблокирует инцидент за 5–10 минут даунтайма и
закладывает запас на 12–18 мес TWIC-only. **Но координатор справедливо
ставит вопрос:** если порог «10M партий → Phase C» оказался завышенным
в 2.5× по факту, может быть пора пересмотреть саму стратегию хранилища?

### 1.2 Что мы знаем о профиле данных

**Источники:** `packages/archive-db/prisma/schema.prisma`, ADR-013 §8.

#### Таблицы и их роль

| Таблица | Строк сейчас | Размер | Шейп ключа | Роль |
|---|---|---|---|---|
| `archive_sources` | 1 (TWIC) | < 1 KB | `id UUID` | Каталог источников импорта |
| `archive_imports` | ~150 | < 1 MB | `id UUID` | Журнал прогонов импортера |
| `archive_games` | ~150k | ~400 MB (с TOAST PGN) | `id UUID`, индексы по `eco/playedAt`, `whiteName/blackName`, `playedAt`, `sourceId/playedAt`, UNIQUE `contentHash` | Метаданные партий + PGN. Чтение ad-hoc, дедуп через `contentHash` |
| `position_stats` | 3.56M | ~600 MB | composite PK `(positionKey:16, nextMoveUci, bucket)`, индекс `(positionKey, bucket, total DESC)` | Агрегат «позиция → статистика по следующим ходам». **Точка входа дерева.** UPSERT при импорте |
| `archive_game_positions` | 4.14M | 1.4 GB (с индексами) | composite PK `(positionKey:16, bucket, gameId)`, два индекса по `(positionKey, bucket, playedAt DESC)` и `(positionKey, bucket, avgElo DESC)` | Денормализованный индекс «позиция → list of games». INSERT-only (см. §1.3) |

#### Профиль запросов

1. **`GET /api/archive/tree`** — `WHERE position_key=? AND bucket=?
   ORDER BY total DESC LIMIT 12`. Hot path, кэшируется в Redis. На 100% запросов это
   **point lookup + index range scan top-12**.
2. **`GET /api/archive/games?fen=…`** — keyset-pagination по
   `archive_game_positions` с двумя сортировками (recent / topElo).
   `WHERE position_key=? AND bucket=? AND <cursor> ORDER BY played_at DESC, game_id DESC LIMIT 50`.
   На 100% — **префиксный scan + ранний LIMIT**.
3. **`GET /api/archive/games/:id`** — простой PK lookup в `archive_games`.
4. **Импорт TWIC** — для каждой партии: 40 INSERT в `archive_game_positions`
   (insert-only) + 40 UPSERT в `position_stats` (агрегат `total += 1`,
   `wins += δ`, …).

#### Природа доступа

- **Immutable после импорта** для `archive_game_positions` (per ADR-014:
  «без foreign key, не удаляем партии в рантайме»). Таблица растёт только
  append'ом.
- **Mutable агрегат** для `position_stats` (UPSERT при каждом импорте).
  Перестраивается полностью раз в неделю в фоновом задании
  `rebuild-position-stats.ts`.
- **Read-heavy** после импорта: TWIC выходит раз в неделю; между
  выпусками 99.9% времени БД отдаёт чтение из `position_stats` /
  `archive_game_positions`.
- **Концентрация чтений** на горячих позициях (стартовая, типовые
  миттельшпили). Long tail — позиции глубоко в дереве с total < 5 —
  читается редко.

### 1.3 Что осталось от исходного плана ADR-013

| Положение | Подтверждено реальностью | Опровергнуто |
|---|---|---|
| Phase A до ~5M партий на PG | ✓ — сейчас 4.14M, на адекватном RAM (≥4 GB shared_buffers) работает | — |
| Триггер Phase B = `position_stats > 30M` | — пока не проверено | — |
| Триггер Phase C = `position_stats > 100M` или Lichess | — пока не проверено | — |
| `shared_buffers ≥ 4 GB` для Phase A | — | **Не подтверждено**: реальный RDS имел 91 MB |
| ClickHouse-secondary спроектирован переключаемым | ✓ — `ArchiveStatsRepository` имеет интерфейс, не реализацию | — |
| DuckDB не подходит как primary | ✓ — single-writer всё так же | — |
| ClickHouse-primary: дороже в эксплуатации, без транзакционного дедупа | ✓ — выводы ADR-013 §«Альтернативы» в силе | — |

**Главный вывод:** инцидент KS-1893 — это **сбой сайзинга**, а не сбой
архитектуры. ADR-013 §10.A явно требовал `shared_buffers ≥ 4 GB`,
фактически было выделено в **45× меньше**. Архитектурные пороги
(10M / 100M / 50M партий) не достигнуты, проверить их валидность
сейчас невозможно — сравнение «PG не справился на 4M» некорректно,
PG **никогда не получил** ресурсов, на которые был спроектирован.

### 1.4 Ограничения проекта, влияющие на выбор

- **Один разработчик.** Любая стратегия с двумя системами хранения и
  eventual consistency удваивает операционную нагрузку (мониторинг,
  бэкапы, миграции, инциденты).
- **Бюджет на инфраструктуру.** Команда не озвучивала жёсткий cap, но
  переход с $13/мес (db.t3.micro) на $400/мес (db.r5.xlarge) и тем более
  на $1500/мес (CockroachDB Dedicated) — это решение, требующее
  обоснования, а не «попробуем и посмотрим».
- **Готовность принять operational risk.** Кастомное хранилище / шардинг
  / distributed SQL — это новый класс инцидентов. Сейчас инциденты — на
  уровне «не выделили RAM». После миграции — «compaction застрял»,
  «replica leader не выбрался», «WAL apply отстал».
- **Только TWIC сейчас.** Подключение Lichess/ChessCom — гипотетическое,
  без срока. Сайзить под этот сценарий сегодня — premature.

---

## 2. Стратегии — анализ

Каждая стратегия оценивается по 5 осям:
- **Что меняется** (архитектурно).
- **Стоимость/мес** на текущем объёме (4M строк) и на прогнозном
  (12 мес TWIC-only ≈ 8M строк).
- **Сложность миграции** (часы / дни / недели + риски).
- **Operational risk** (кто и как поддерживает в проде).
- **Когда снова станет узким местом** (триггер следующего пересмотра).

### S1. Phase B продолжить (scale-up PG до t3.large)

**Что меняется:** ничего, кроме класса экземпляра RDS. Архитектура
остаётся PG-monolithic. Партиционирование (KS-1900) — следующий шаг
в этой же стратегии при достижении 30M строк.

**Стоимость:**
- Сейчас: **$128/мес** (db.t3.large + 100 GB gp3 в eu-central-1).
- Через 12 мес TWIC-only: тот же $128 (объём ~3 GB укладывается в 100 GB
  storage и 8 GB RAM с запасом).
- Через 12 мес + Lichess (фильтр rating ≥ 2000): не хватит, нужен апгрейд
  до r5.xlarge (~$400/мес) или переход на S2.

**Сложность миграции:** 5–10 минут даунтайма (RDS modify-instance).
Никаких изменений кода, схемы, миграций. **Это самое дешёвое решение по
человеко-часам.**

**Operational risk:** zero delta — мы уже эксплуатируем PG, инструменты
и опыт есть.

**Когда снова станет узким местом:**
- Через 6–9 мес при достижении 30M строк `position_stats` (Phase B
  trigger по ADR-013 §10.A) — нужно партиционирование (KS-1900) и/или
  апгрейд RAM до 16 GB (r5.large).
- При подключении Lichess/ChessCom — точно потребуется S2 или S3.

**Вердикт:** реалистично, дёшево, известная зона. Минус — откладывает
архитектурное решение, не отменяет его.

---

### S2. Phase C ускорить — миграция на ClickHouse сейчас

**Вариант 2a: ClickHouse-secondary** (как в ADR-013 §10.C). PG остаётся
source-of-truth для `archive_games` (метаданные + PGN, дедуп через
`contentHash UNIQUE`). ClickHouse получает зеркало `position_stats` и
`archive_game_positions`. `ArchiveStatsRepository` переключается через
env-флаг.

**Вариант 2b: ClickHouse-primary** (как в ADR-013 §«Альтернативы») —
`archive_games` тоже в CH, дедуп через `ReplacingMergeTree`. Отвергнут
в ADR-013 как primary, **аргументы остаются в силе** — `contentHash
UNIQUE` транзакционно невозможен в CH, дедуп через background merge
оставляет окно «дублирующиеся партии 1–2 минуты», что плохо при
backfill.

Дальше анализирую только **2a (CH-secondary)** как живой вариант.

**Что меняется:**
- Поднимаем ClickHouse: вариант ClickHouse Cloud (managed) или
  self-hosted на ECS.
- Importer пишет в CH через batch INSERT после успешного COPY в PG
  staging.
- Новая реализация `ClickHouseArchiveStatsRepository` (TS-клиент
  `@clickhouse/client`).
- Миграции CH несовместимы с Prisma — отдельный инструмент
  (`clickhouse-migrations` или ручные DDL-скрипты).
- Eventual consistency PG↔CH (секунды-минуты).

**Стоимость:**
- ClickHouse Cloud Production: minimum **$300–400/мес** (2 vCPU × 8 GB
  тier, eu-central-1) + traffic.
- Self-hosted на ECS Fargate: m5.large $70/мес (CPU/RAM) + EBS $10/мес +
  backup S3 $5/мес ≈ **$90/мес**, плюс ops time.
- На 12 мес объём вырастет в 2× (с компрессией 5–10× CH будет занимать
  100–300 MB) — никакого апгрейда не нужно.
- Плюс **исходная** PG-RDS остаётся под `archive_games` — её можно
  оставить на t3.medium ($69/мес) или даже t3.small ($35/мес), потому
  что без `archive_game_positions`/`position_stats` нагрузки на индексы
  почти нет.
- **Итого**: PG t3.medium + ClickHouse Cloud = $69 + $350 = **~$420/мес**,
  или PG + self-hosted CH = ~$160/мес + ops overhead.

**Сложность миграции:** **4–6 недель разработки** (не «часы»):
- BE-1 (M, 1 нед): схема CH + миграции `clickhouse-migrations`.
- BE-2 (L, 2 нед): `ClickHouseArchiveStatsRepository` — все методы из
  существующего `PostgresArchiveStatsRepository`. Особенность:
  `position_stats` в CH через `SummingMergeTree` (фоновая агрегация)
  вместо PG UPSERT — нужно адаптировать importer.
- BE-3 (M, 1 нед): backfill из PG → CH (батч `INSERT INTO clickhouse
  SELECT FROM postgres_fdw` или dump через CSV).
- BE-4 (S, 0.5 нед): metrics + alerts (CH replication lag, merge queue
  size).
- DEV-1 (M, 1 нед): docker-compose, ECS task definition, IAM, secrets.
- QA-1 (M, 1 нед): regression e2e на /tree, /games — данные совпадают.

**Риски:**
- Один разработчик. 4–6 недель — это календарных, при 100% фокусе. С
  параллельными задачами реалистично 8–12 недель.
- ClickHouse compaction (background merge) — поведение надо изучать,
  есть инциденты «merge queue растёт без причины», требующие ручного
  вмешательства.
- `ReplacingMergeTree`/`SummingMergeTree` — окно eventual consistency
  на свежие записи. UI может видеть ещё-не-смерженные дубли.
- Backup strategy — в CH иначе чем в PG (clickhouse-backup tool, не
  pg_dump). Restore тестируется отдельно.

**Operational risk:** **+1 production-сервис**, +1 в мониторинге, +1 в
бэкапах, +1 в incident playbook. Один разработчик — этот overhead будет
заметен.

**Когда снова станет узким местом:** при ~500M+ строк или multi-region.
Запас 5–10 лет TWIC-only, или 2–3 года с Lichess.

**Вердикт:** архитектурно правильное решение для **момента**, когда
триггер ADR-013 §10.B/C фактически наступит. Сейчас триггер не наступил
(PG на t3.large справится). Делать сейчас = тратить 4–6 недель работы +
$200–400/мес лишних расходов **без явного выигрыша по производительности
на текущем объёме**. После Lichess — да; до — рано.

---

### S3. Гибрид — t3.large сейчас + параллельно начать миграцию за 1–2 мес

**Что меняется:**
- Шаг 1 (сейчас): scale-up до t3.large — разблокирует KS-1893.
- Шаг 2 (1–2 мес): начинаем S2 (ClickHouse-secondary), не под давлением
  инцидента.

**Стоимость:**
- Месяц 1: $128 (t3.large) + 0 (нет CH). Плюс работа разработчика
  ~80–120 часов спайка/прототипа.
- Месяцы 2–3: $128 (t3.large) + $90–350 (CH self-hosted/cloud) + работа
  разработчика 80–120 часов.
- После релиза — переход на конфигурацию S2: PG downgraded до t3.medium
  ($69) + CH ($90–350) = $160–420/мес.

**Сложность миграции:** та же что S2 (4–6 недель календарных), но без
давления инцидента. Можно вкладывать частями.

**Operational risk:** временно повышен (две системы в production
параллельно). После переключения — как в S2.

**Когда снова станет узким местом:** как S2 — при 500M+ строк.

**Вердикт:** разумно **только если есть твёрдые планы на Lichess** в
горизонте 6–12 мес. Иначе — это работа «впрок», которая может быть
обесценена изменением приоритетов. Рекомендую отложить S2 до
конкретного решения о Lichess.

---

### S4. Aurora PostgreSQL / Aurora Serverless v2

**Что меняется:** managed PostgreSQL на storage-compute-разделённой
архитектуре Aurora. Совместимость с PG — bytewise (Prisma работает без
изменений). Главные отличия:
- Storage decoupled от compute, auto-scaling до 128 TB.
- Read replicas через storage layer (не WAL replication) — фактически
  бесплатные read replicas.
- Aurora Serverless v2 — auto-scale CPU/RAM в диапазоне 0.5–128 ACU,
  тарификация поминутная.

**Стоимость:**
- **Aurora Standard, db.t4g.medium** (4 GB RAM): $93/мес compute +
  $0.10/GB/мес storage = $103/мес для текущего объёма. ≈ цена t3.medium
  + 30% за Aurora premium.
- **Aurora Standard, db.t4g.large** (8 GB): $186/мес + storage = $196/мес.
  ≈ +50% над t3.large RDS.
- **Aurora Serverless v2**: 0.5–32 ACU. Минимум 0.5 ACU × $0.12/hr × 730ч
  = $44/мес idle. Burst до 32 ACU при импорте — $0.12 × 32 × ~4ч/неделю
  ≈ $60/мес peaks. Реалистично **$100–250/мес**, зависит от профиля.
- **Aurora I/O-Optimized**: storage $0.225/GB (вместо $0.10), но IOPS
  включены. Выгодно при > 25% IO от compute cost — у нас не тот случай
  (write-heavy импорт, но не IOPS-bound).

**Сложность миграции:** AWS DMS или pg_dump/pg_restore — **1 день
работы + 1–2 часа даунтайма**. Никаких изменений в коде/схеме.

**Риски:**
- **Aurora Serverless v2 idle minimum 0.5 ACU**: даже при нулевой
  нагрузке платим $44/мес. Не такой уж «serverless».
- **ACU-капасити при импорте**: scaling реактивный, не предиктивный.
  Первые минуты импорта могут идти на низком ACU, пока CloudWatch не
  поймёт что нагрузка пришла. Эффект «холодного старта».
- **Cross-AZ replication** — Aurora копирует данные в 6 копий по 3 AZ.
  При случайных багах AWS (бывает 1–2 раза в год) можно столкнуться с
  деградацией latency без понятной причины.

**Operational risk:** **меньше, чем у self-hosted CH**, но **больше,
чем у RDS PG**. Aurora — другой движок, ноды лечатся иначе, есть свои
limitations (например, прямые WAL-инструменты не работают).

**Когда снова станет узким местом:** Aurora имеет тот же архитектурный
limit что и PG — single-writer instance. Read replicas масштабируются
горизонтально, write — нет. На 50M+ партий тот же rapid-rebuild проблем
с writer как и в S1, но storage-decoupled даёт **больше плавности
upgrades** (fast minor-version updates, instant resize).

**Вердикт:** хорошая опция как **апгрейд S1 в будущем**, но **не как
текущее решение**. Aurora даёт +30–50% к стоимости за свойства, которые
сейчас не критичны (read replicas, storage auto-scale). На текущем
объёме vanilla RDS PG функционально эквивалентен.

Aurora Serverless v2 был бы интересен **если бы у нас был
**bursty** профиль** (например, 10 минут пиковой нагрузки в день и
20 часов idle), но импорт TWIC занимает 30–60 минут раз в неделю —
это не Serverless-идеальный профиль.

---

### S5. TimescaleDB

**Что меняется:** PG + расширение TimescaleDB. Hypertables (auto-partitioning
по времени), columnar compression на старых партициях.

**Применимость к нашему профилю:** **низкая.**
- Hypertable выгоден на time-series запросах
  (`WHERE time BETWEEN x AND y` + aggregate). Наши запросы — point
  lookup по `position_key`, `playedAt` — только в сортировке.
- Partition by `created_at` — планировщик не уйдёт в одну партицию,
  потому что фильтр идёт по `position_key`, а не по времени. Включится
  scan по всем партициям.
- Columnar compression Timescale работает на сжатых chunks (старых
  партициях). Наши запросы читают «вперемешку старые и новые партии для
  одной позиции» — компрессия снизит latency, не повысит.

**Стоимость:**
- **RDS не поддерживает Timescale** (нельзя устанавливать custom
  extensions). Self-hosted на EC2/ECS: m5.large $70/мес + EBS + ops.
- **Timescale Cloud**: $50/мес минимум, реалистично ~$200/мес для
  нашего объёма.

**Сложность миграции:** 2–3 недели — переписать схему как hypertable,
backfill данных, перевести запросы (часть индексов меняется).

**Operational risk:** Timescale + self-hosted — это уход с RDS, новый
playbook бэкапов/мониторинга/upgrade.

**Когда снова станет узким местом:** примерно так же как S1 — single-
writer limit. Compression выигрывает место, не throughput.

**Вердикт:** **не подходит.** Time-series суть Timescale нерелевантна
нашему access pattern. Compression — единственное возможное преимущество,
но за ценой ухода с RDS, что для одного разработчика overhead. ClickHouse
даёт ту же compression при правильном профиле.

---

### S6. CockroachDB / YugabyteDB

**Что меняется:** distributed SQL, PG-wire-compatible (Prisma работает
без изменений). Автоматический шардинг по range, leader replication,
multi-region capable.

**Стоимость:**
- **CockroachDB Dedicated**: minimum 2 vCPU × $0.50/hr × 730ч = $730/мес
  на ноду, минимум 3 ноды для HA = **$2190/мес**. Plus storage.
- **CockroachDB Serverless**: free до 50M request units/мес, далее
  $0.50/M RUs. Наш трафик ~1k req/сек × 86400 × 30 = 2.6M req/мес —
  free tier? Нет, RU ≠ req: каждый SQL запрос = десятки RU. Реалистично
  $50–200/мес для нашего трафика, но **бесплатный tier лимитирует
  storage до 10 GB**, что по нашему прогнозу 12-мес уже впритык.
- **YugabyteDB Managed**: $0.04/CRU-hr × 4 CRU minimum × 730ч = $117/мес.
  Self-hosted: 3 ноды × $70 = $210/мес + ops.
- Self-hosted CockroachDB: 3 × m5.large = $210/мес + EBS + ops.

**Сложность миграции:** 2–3 недели для базового переезда (schema
compatible на 95%, отличия — system catalogs, некоторые index hints).
**Backfill data** — те же объёмы что в S2.

**Риски:**
- **Distributed system overhead**: каждая транзакция требует консенсуса
  (Raft) между leader и follower'ами. Latency point lookup растёт с
  ~1–2 ms (PG single-node) до 5–15 ms (Cockroach 3-node).
- **Operational complexity**: 3 ноды, leader transfer, range rebalance,
  TLS между нодами, восстановление после node-down. Один разработчик
  будет тратить заметную долю времени на ops.
- **CDC/backup tools** — отдельные, не PG-tools.
- **Когда оправдано**: multi-region active-active, > 100 GB working set,
  > 10k writes/sec sustained. **У нас всё это в зелёной зоне на одном
  PG node.**

**Operational risk:** **высокий.** Distributed databases — отдельная
дисциплина. Один разработчик на нашем масштабе — это не зона комфорта.

**Когда снова станет узким местом:** теоретически — никогда (горизонтально
масштабируется). Практически — упирается в стоимость нод и затраты на
ops.

**Вердикт:** **оверкилл для нашего масштаба.** 4M строк — это smartphone
SD-карта по объёму. Использовать Cockroach/Yugabyte здесь — то же что
ставить распределённую файловую систему ради хранения 1.4 GB данных.

---

### S7. Самописное хранилище под FEN-ключ

Профиль (по запросу пользователя):
- Архивные данные **immutable** после импорта — `archive_game_positions`
  никогда не UPDATE'ится, только INSERT. `position_stats` — UPSERT,
  но это изолированный агрегат.
- Lookup по 16-байт ключу + range scan по сортировке (`played_at DESC`,
  `avg_elo DESC`).
- Read-heavy после импорта.
- Агрегаты пересчитываются батчами.

#### S7a. RocksDB (LSM-tree)

**Что меняется:** `archive_game_positions` и `position_stats` в RocksDB
вместо PG-таблиц. Композитные ключи:
- `archive_game_positions`: `position_key:16 || bucket:1 || gameId:16` →
  value `playedAt:8 || avgElo:2 || result:1 || ply:1 || moveUci:6 ||
  sideToMove:1` ≈ 25 байт.
- Вторичные сортировки через **дополнительные** column families:
  - `recent_idx`: `position_key:16 || bucket:1 || (-playedAt):8 ||
    gameId:16` → empty value.
  - `top_elo_idx`: `position_key:16 || bucket:1 || (-avgElo):2 ||
    gameId:16` → empty value.
  Это отдельные LSM-trees, обновляются вместе с основной CF атомарно.
- `position_stats`: ключ `position_key:16 || nextMoveUci:6 || bucket:1`,
  value — упакованный struct {whiteWins, draws, blackWins, total,
  avgElo, lastSeenAt, ply}. UPSERT через `merge` operator
  (`SummingMergeOperator` custom).

**Стоимость:**
- Embedded в archive-importer / archive-service процессах. Storage:
  4M × 25 байт + 2 × индексные CF × ~33 байт = ~280 MB raw. С Snappy
  compression ~120–150 MB.
- Не требует отдельного экземпляра — один EC2/ECS на котором уже работает
  archive-service: t3.small достаточно ($15/мес), потому что RocksDB
  страница cache использует RAM эффективно.
- На 12 мес: ~250–300 MB.
- **Итого**: $15–30/мес vs $128 (S1 t3.large). **Самое дешёвое решение
  по cloud-spend.**

**Сложность миграции:** **8–12 недель**:
- RocksDB native binding для Node: `rocksdb` npm-пакет — давно не
  обновлялся, последний release 5.2.1 (2020-01). Альтернативы:
  - `level-rocksdb` через level-up — устарел.
  - Делать RocksDB-серверный процесс на Go/Rust + RPC — это уже не
    embedded.
  - **Прямой биндинг через `node-gyp`** — сборка на каждом deploy,
    несовместимости с Node-версиями.
- Custom merge operator для `SummingMergeTree`-эквивалента — C++ код
  + перебиндинг.
- Свой layer для бэкапов (RocksDB checkpoint в S3) — недели работы.
- Свой layer для миграций schema (изменение shape ключа = full
  re-write).
- Свой `ArchiveStatsRepository` impl. Свои интеграционные тесты.
- Восстановление после crash importer'а на середине batch (RocksDB
  WAL recovery — нативно, но нужен testing).

**Риски:**
- **Один разработчик. 8–12 недель календарных = реалистично 12–20 недель
  с прерываниями.**
- **Bugs в LSM compaction = потеря данных без бэкапа.** Это
  не теоретическая угроза — RocksDB в проде требует постоянного
  мониторинга compaction queue, write stall, level imbalance.
- **Биндинги Node ↔ RocksDB заброшены.** Поддерживать самим = ещё
  отдельная подсистема.
- **Поведение под памятью** — block cache, table cache, memtable —
  всё нужно тюнить руками. На PG/Aurora тюнинг абстрагирован.

**Operational risk:** **очень высокий.** RocksDB в production требует
SRE-уровень внимания. Команда из 1 разработчика — не та зона.

**Когда снова станет узким местом:** теоретически на масштабе 100M+
позиций. Практически — упрётся в operational bandwidth ещё раньше.

**Вердикт:** **стоимость разработки + риск молчаливой потери данных
без сильного выигрыша.** На текущем объёме PG+t3.large даёт sub-ms
latency, нам не нужно 20× быстрее. Сэкономить $100/мес на инфре — но
потерять 12+ недель разработчика.

#### S7b. LMDB (B+tree, mmap, embedded)

**Что меняется:** аналогично S7a, но storage engine — LMDB.
- B+tree, не LSM. Read-optimized. Single-writer, multi-reader (MVCC
  snapshots).
- Mmap-based: pages в OS page cache shared между процессами.
- Без compression (хранит как есть).
- Биндинги Node: `lmdb` npm-пакет (kriszyp/lmdb-js) — **активно
  поддерживается**, миллионы скачиваний, использован в Mozilla, Salesforce.

**Стоимость:**
- Storage: 4M × 100 байт = ~500 MB на диске + ~500 MB mmap (но shared
  page cache OS, не дублируется в RAM процесса). На 12 мес ~1 GB.
- Embedded в один процесс. **t3.small ($15/мес) достаточно.**
- **Итого**: $15–30/мес.

**Сложность миграции:** **4–6 недель** (меньше чем RocksDB, потому что
biding жив):
- BE-1 (M, 1 нед): схема ключей + декодеры/энкодеры.
- BE-2 (L, 2 нед): `LmdbArchiveStatsRepository` + всё чтение.
- BE-3 (M, 1 нед): importer пишет в LMDB вместо PG (или дублирует на
  переходный период).
- BE-4 (S, 0.5 нед): backup (rsync directory + WAL).
- BE-5 (S, 0.5 нед): тесты.

**Риски:**
- **Single-writer на всю БД.** archive-importer — один писатель, ОК. Но
  если позже захотим параллельные импортеры (Lichess + ChessCom + TWIC)
  — нужен очередь-сериализатор. Архитектурно ограничивает scaleout.
- **Backup non-atomic с running writer** — нужно либо stop writer на
  время snapshot, либо использовать LMDB `mdb_env_copy` (атомарно, но
  блокирует write).
- **Schema evolution руками.** Изменение shape ключа = full re-write.
  В PG — `ALTER TABLE ADD COLUMN` за миллисекунды.
- **Replication нет.** Нужен disaster recovery — копировать каталог в
  S3 раз в час. Если worker уронили — restore = последний snapshot
  плюс воспроизвести импорты с момента snapshot'а.
- **Multi-process write невозможен**, только multi-process **read**.
  Если архитектура когда-нибудь станет distributed — придётся
  переписать.

**Operational risk:** **средний.** LMDB в проде стабилен, но кастомное
хранилище = кастомный playbook. Один разработчик справится, если выделить
2–3 недели на ops-инструменты вокруг.

**Когда снова станет узким местом:** single-writer ~50–100k writes/sec
— далеко от наших нужд. Single-process — рано или поздно blocker, но не
на нашем масштабе.

**Вердикт:** **технически наиболее интересная альтернатива.** Дешевле,
быстрее, проще RocksDB. Но **выигрыш по latency** (PG: ~1–2 ms; LMDB:
~10–50 µs) **не виден пользователю** через layered Redis-cache. Главное
преимущество — **снижение cloud spend** ($128 → $15) при cost разработки
4–6 недель. На горизонте года экономия $1.3k vs стоимость 80–120 часов
работы — break-even где-то на 15–20 месяцах без учёта риска.

#### S7c. Кастомный mmap-формат (Zobrist hash table + append log)

**Что меняется:** ещё более специализировано — собственный binary file
format с perfect hash / Robin Hood hash table на mmap, отдельные
секции для индексов recent/topElo (sorted arrays).

**Стоимость:**
- Минимальная storage (~280 MB raw, без compression).
- t3.micro достаточно — single core. ~$13/мес.

**Сложность миграции:** **16–24 недели**:
- Это **писать базу данных с нуля**: hash collision strategy, growth/
  rehashing, durability (WAL? sync()? fsync barrier?), schema versioning,
  recovery, backup.
- Бенчмарки + тесты на потерю данных при kill -9 — недели.
- Custom binary format = custom debugger, custom dumper, custom
  миграционный tool.

**Риски:** **критические.** Молчаливая потеря данных. Невоспроизводимые
баги. Один разработчик = bus factor 1 на этой подсистеме.

**Operational risk:** **запредельный** для команды 1 человека.

**Когда оправдано:** на специальных задачах, где известный готовый
storage даёт 100× проигрыш. У нас **не та задача** — PG/LMDB/RocksDB
все справятся.

**Вердикт:** **категорически не сейчас.** Это пишут команды из 5+
инженеров для Etsy/Stripe/Cloudflare-уровня. Lichess Polyglot книга
(`.bin`-формат) — пример такого специализированного формата. ADR-013
уже отверг его как primary из-за отсутствия win/draw/loss. Заводить
свой полный формат — это **год работы** одного человека.

#### S7d. Embedded DuckDB как secondary

**Что меняется:** DuckDB — embedded аналитический OLAP store. **Не
primary** (single-writer = ADR-013 outcome). Может быть **secondary** для
тяжёлых аналитических запросов (топ-игроки за период, динамика дебютов).

**Стоимость:** copy-of-data. PG → Parquet export раз в день → DuckDB
читает Parquet через `read_parquet()`. **$0 дополнительно** (DuckDB
embedded в существующем процессе).

**Сложность:** 2–3 недели для standalone analytical workflow. Не решает
RAM-проблему PG на горячих запросах. Это **дополнение для аналитики**,
не альтернатива основному стеку.

**Вердикт:** **полезно отдельно** в будущем (для admin-аналитики). Не
ответ на вопрос «куда переехать с PG». Из текущего ADR — выносим в
backlog (отдельной задачей при появлении продуктового запроса на
аналитику).

#### S7e. Гибрид PG (метаданные) + RocksDB/LMDB (positions)

**Что меняется:**
- `archive_sources`, `archive_imports`, `archive_games` (с PGN) → PG
  (как сейчас). Это ~400 MB, t3.micro/t3.small справится.
- `position_stats`, `archive_game_positions` → RocksDB или LMDB,
  embedded в archive-service.

**Стоимость:** PG t3.small ($35/мес) + LMDB embedded (free) =
**$35–50/мес**. Cheap.

**Сложность миграции:** S7a/S7b cost + sync logic. **8–12 недель**.

**Риски:**
- **Транзакционная консистентность теряется**: импорт партии — это INSERT
  в `archive_games` (PG) + 40 INSERT в `archive_game_positions` (LMDB) +
  40 UPSERT в `position_stats` (LMDB). Если падает на середине — частичный
  импорт. Нужен 2-phase commit или idempotency-key recovery.
- **Бэкапы**: PG (managed RDS) + LMDB (директория rsync). Два процесса,
  нужно координировать timing для consistency.
- **Один разработчик** — две системы хранения = +50% ops time.

**Operational risk:** **высокий.** Гибриды — самые сложные в проде.

**Вердикт:** **избыточно.** Если идти к KV-storage, проще целиком,
не гибрид. Если оставаться на PG — целиком на PG.

---

## 3. Финальная таблица сравнения

| # | Стратегия | Cost/мес сейчас | Cost/мес 12 мес TWIC | Сложность миграции | Operational risk | Когда узкое место снова |
|---|---|---|---|---|---|---|
| **S1** | **Phase B (scale-up t3.large)** | **$128** | **$128** | **5–10 мин даунтайма** | **0 delta** | 30M строк (6–9 мес) → партиционирование (KS-1900); + Lichess → S2 |
| S2 | Phase C (CH-secondary) | $160–420 | $160–420 | 4–6 нед разработки | +1 production system | 500M+ строк или multi-region |
| S3 | Гибрид S1 → S2 за 1–2 мес | $128 → $160–420 | $160–420 | 4–6 нед без давления | временно повышен | как S2 |
| S4 | Aurora PG (t4g.large) | $196 | $196 | 1 день + 1–2ч даунтайм | small +; иной runbook | как S1 (single-writer) |
| S4-serverless | Aurora Serverless v2 | $100–250 | $150–350 | 1 день | small + | как S4 |
| S5 | TimescaleDB | $200 (cloud) или ops self-hosted | то же | 2–3 нед | средний | как S1, нерелевантно |
| S6 | CockroachDB Dedicated | $730+ (минимум HA) | $730+ | 2–3 нед | высокий (distributed) | никогда (но overcost) |
| S6-srv | CockroachDB Serverless | $50–200, storage cap | upgrade на dedicated при росте | 2–3 нед | средний | через ~12 мес — паре |
| **S7a** | RocksDB (custom KV) | $15–30 | $15–30 | **8–12 нед** | **очень высокий** | 100M+ позиций |
| **S7b** | **LMDB (custom KV)** | **$15–30** | **$15–30** | **4–6 нед** | **средний** | single-writer ~50k/sec |
| S7c | Custom mmap format | $13 | $13 | 16–24 нед | критический | — |
| S7d | DuckDB secondary | $0 | $0 | 2–3 нед | low | не альтернатива primary |
| S7e | Гибрид PG + LMDB | $35–50 | $35–50 | 8–12 нед | высокий | 100M+ |

---

## 4. Анализ: что говорит инцидент KS-1893

Координатор справедливо ставит вопрос: «10M-порог из ADR-013 был
оптимистичен — может, надо менять стратегию?»

**Ответ: 10M-порог касался выбора между Phase A и Phase B/C на одной и
той же платформе (PostgreSQL → PostgreSQL+ClickHouse). Этот порог не
был протестирован, потому что PG никогда не получил ресурсов, на которые
ADR-013 был спроектирован (`shared_buffers ≥ 4 GB`).**

Эмпирически на 4M строк сорвалось не «архитектурное» поведение PG, а
самое примитивное — недостаток RAM для PK-индекса. Это та же проблема,
что в любой БД с теми же 91 MB для PK 303 MB:
- ClickHouse — деградирует merge на нехватке RAM.
- LMDB/RocksDB — теряют block cache hit ratio.
- Aurora — упирается в storage IOPS вместо in-memory chains.
- CockroachDB — теряет range cache.

KS-1893 — **не архитектурный сигнал**, а сигнал operational discipline.
Архитектурные триггеры (30M строк, 100M, Lichess) — **по-прежнему в
будущем**. Менять архитектуру под operational fix — это лечить
насморк ампутацией.

---

## 5. Рекомендация

### 5.1 Принятая стратегия: **S1 (Phase B continue)**

Конкретно:
1. **Сейчас** — выполнить ADR-027 (scale-up до db.t3.large). Это
   разблокирует KS-1893 за 5–10 минут даунтайма и стоит $128/мес vs
   текущих $13.
2. **Через 6–9 мес** (или при достижении 30M строк `position_stats`) —
   реализовать KS-1900 (партиционирование `archive_game_positions` HASH
   по `position_hash` на 32 партиции). Это снижает индекс-pressure ещё
   на 6–12 мес.
3. **Параллельно с шагом 2 или после** — апгрейд RAM на db.r5.large
   (16 GB) если объёмы того потребуют.
4. **Перед Lichess/ChessCom** — отдельное решение (через новый ADR), с
   замером реального объёма после фильтрации. Кандидаты: ClickHouse
   (S2), r5.xlarge+ (продление S1), distributed-SQL (S6) — выбор
   определят цифры на момент решения.

### 5.2 Почему именно S1

**Аргументы за:**

1. **KS-1893 — не архитектурный сигнал.** ADR-013 закладывал
   `shared_buffers ≥ 4 GB`; фактически было 91 MB. Это операционная
   ошибка сайзинга, не предел PG. После scale-up архитектура работает
   ровно как заложено.
2. **Один разработчик.** Любая стратегия с +1 системой хранения
   (S2, S5, S7) добавляет постоянную operational нагрузку: бэкапы,
   мониторинг, миграции, инциденты. У S1 эта нагрузка = 0 (мы уже
   эксплуатируем PG).
3. **Стоимость разработки vs cloud spend.** S1: $128/мес × 12 = $1.5k
   за год + 0 часов разработки. S7b (LMDB): $30/мес × 12 = $360 + 4–6
   недель × 40ч = ~$15k (по рыночной ставке senior PHP/TS). Экономия
   $1.1k/год не оправдывает $15k разовых затрат + ongoing operational
   complexity.
4. **Архитектура переключаемая.** ADR-013 §10.C.4 заложил
   `ArchiveStatsRepository` интерфейс. Когда триггер Phase C наступит
   (Lichess или 100M строк), миграция на ClickHouse — добавление второй
   реализации репозитория, не переписывание API. Заранее ничего не
   ломается.
5. **Реальность объёмов.** 4M строк / 1.4 GB — это **меньше USB-флешки**.
   Использовать distributed DB (S6) или custom storage (S7) на этом
   объёме — гипертрофированное решение. Простое железо решает.
6. **Reversibility.** S1 (apgрейд RDS) откатывается за 5–10 минут. S2
   (CH-migration) откатывается через rollback всех миграций + потеря
   полученной во время миграции data — недели работы.

**Аргументы против S1 (и почему мы их не принимаем):**

- *«Мы упёрлись на 4M, упрёмся на 30M через 6 мес — лучше переезжать
  один раз»* — false dilemma. Между «scale-up RDS» и «миграция на
  ClickHouse» есть промежуточный шаг **«партиционирование PG»**
  (KS-1900), который снимает давление на индексы ещё на год вперёд за
  ~1 неделю работы. То есть последовательность scale-up → partitioning
  → ClickHouse — это **3 шага**, каждый ~10× capacity, каждый дешевле
  следующего.
- *«ClickHouse сжимает в 5–10×, экономит RAM»* — true, но компрессия
  выигрывает место/IO, не throughput. На наших запросах (point lookup +
  top-12) PG + достаточный RAM даёт sub-ms latency, который пользователь
  видит через Redis cache. CH имеет смысл при scan-heavy аналитике, не
  на нашем профиле.

### 5.3 Что мы НЕ принимаем (с обоснованием)

- **S2 (ClickHouse сейчас)**: 4–6 недель работы при отсутствии
  архитектурного триггера. Делается **до** Lichess по конкретному
  плану, не превентивно.
- **S3 (гибрид)**: то же что S2 + лишний апгрейд PG в дороге. Имеет
  смысл только при **твёрдых планах на Lichess в горизонте 6 мес**,
  чего сейчас нет.
- **S4 (Aurora)**: +30–50% к стоимости PG за свойства, которые сейчас
  не критичны. Возможный апгрейд **после** S1 при появлении нужды в
  read-replicas или multi-AZ HA.
- **S5 (TimescaleDB)**: time-series не наш профиль. Compression Timescale
  не даст того выигрыша, что даёт ClickHouse при правильном паттерне.
- **S6 (Cockroach/Yugabyte)**: distributed SQL для 1.4 GB данных —
  гипертрофия. Один разработчик не должен поддерживать 3-node consensus
  cluster без явной нужды.
- **S7a (RocksDB)**: 8–12 недель работы, биндинги Node заброшены, риск
  молчаливой потери данных. Cloud spend не оправдывает.
- **S7b (LMDB)**: технически разумно, но 4–6 недель vs $1.1k/год экономии
  — break-even на 15+ мес без учёта риска. Откладываем.
- **S7c (custom format)**: писать БД с нуля — 4–6 месяцев + bus factor 1.
  Категорически нет.
- **S7d (DuckDB secondary)**: не альтернатива primary, отдельная задача
  для аналитики (не в скоупе KS-1901).
- **S7e (PG + LMDB hybrid)**: две системы вместо одной. Если идти от PG
  — то целиком, не половинкой.

### 5.4 Триггеры пересмотра ADR-028

ADR пересматривается, если:

1. **30M строк `position_stats`** (~6–9 мес TWIC). Триггер →
   реализовать KS-1900 (партиционирование). Это в рамках S1, ADR не
   меняется.
2. **100M строк `position_stats`** ИЛИ принято решение подключать
   Lichess/ChessCom. Триггер → S2 (ClickHouse-secondary), обновить
   ADR-028 на «принято: S2», запустить отдельный ADR на детали миграции.
3. **Single-writer impact ≥ 50% времени импорта** (профиль изменится:
   несколько параллельных источников). Триггер → переоценить S2 vs S6.
4. **Multi-region requirement**. Триггер → S6 (CockroachDB) или
   PG-replication поверх S1 — отдельный ADR.
5. **Bound by RDS pricing для крупного объёма** (>$1k/мес в RDS) —
   триггер для S2 / S7b как cost-optimization. Пока не рядом.

---

## 6. Влияние на смежные ADR/задачи

| Документ | Статус | Действие |
|---|---|---|
| ADR-013 (план Phase A/B/C/D) | актуален | без изменений; пороги по-прежнему в силе |
| ADR-014 (`archive_game_positions`) | актуален | без изменений |
| ADR-018 (вынос архив-сервиса) | актуален | без изменений; PG переезд в отдельную БД уже сделан |
| ADR-027 (RDS sizing) | **актуален** | рекомендация t3.large сохраняется; доводим статус до «принято» после выбора пользователя |
| KS-1900 (партиционирование) | актуален | реализовывать при достижении 30M строк, не сейчас |

**Вывод по KS-1899/ADR-027:** **актуален, не пересматривается.**

---

## 7. Риски выбранной стратегии и митигация

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| PG t3.large упрётся раньше 12 мес | M | M | Алерты по hit ratio < 95% (см. ADR-027 §5). Апгрейд на r5.large $200/мес — те же 5 мин даунтайма |
| Lichess подключим раньше плана | L | H | Запустить ADR на CH-secondary заранее (не реализацию, ADR) |
| Партиционирование (KS-1900) сорвётся | L | M | План rollback в KS-1900 ADR. Pg_partman + dry-run на staging |
| Один разработчик не успеет KS-1900 при росте быстрее прогноза | M | M | Триггер раннего предупреждения — 20M строк, не 30M. Декомпозировать KS-1900 по партициям (миграция инкрементальная) |
| Stockfish/Polyglot книга станет нужна на стороне сервера | L | L | Side-channel из Lichess `.bin` уже описан в ADR-013 §«Альтернативы» — не блокер |
| Решение пересмотреть на CH через 6 мес | M | L | Архитектура уже переключаемая (`ArchiveStatsRepository`). 4–6 нед работы запланировано как Phase C, не как pivot |

---

## 8. Что точно НЕ делаем по этой стратегии

- **Не делаем preventive миграцию** на ClickHouse / LMDB / Aurora «на
  будущее». Каждая миграция = недели работы + risk; делаем под
  конкретный триггер.
- **Не пишем custom storage** (S7a/c). Один разработчик не должен
  поддерживать собственную БД ради экономии $100/мес.
- **Не разносим** archive_games + archive_game_positions в разные
  storages (S7e). Если оставаться на PG — целиком на PG.
- **Не переходим на distributed SQL** (S6) до multi-region requirement
  или 100+ GB активного working set.

---

## Приложение A. Что у нас уже спроектировано переключаемым

ADR-013 §10.C.4 заложил:

```ts
interface ArchiveStatsRepository {
  getTopMoves(positionKey, bucket, limit): Promise<...>;
  getGamesByPosition(positionKey, bucket, cursor, sort): Promise<...>;
  upsertPositionStats(rows): Promise<...>;
  // ...
}
```

Сейчас в коде есть `PostgresArchiveStatsRepository` (фактическая
реализация). При срабатывании триггера Phase C добавляем
`ClickHouseArchiveStatsRepository` рядом, выбор через env-флаг
`ARCHIVE_STATS_BACKEND=postgres|clickhouse`. **API для `archive-service`
не меняется**, фронт не знает разницы.

То же для S7b: можно добавить `LmdbArchiveStatsRepository` без ломки
контракта.

Это **главный архитектурный страховой полис**: выбор «где хранить
позиции» отделён от «как пользоваться позициями». Любая будущая миграция
— замена реализации, не переписывание сервиса.

---

## Приложение B. Чеклист принятия решения пользователем

Пользователь выбирает между:

- [ ] **S1 (рекомендуется): scale-up до db.t3.large $128/мес.**
  KS-1893 разблокирован за 10 мин. Запас 12–18 мес.
- [ ] S1-cheap: scale-up до db.t3.medium $69/мес. Тот же effect, запас
  6–9 мес. Раньше потребуется второй апгрейд.
- [ ] S2/S3: начать миграцию на ClickHouse сейчас. 4–6 нед работы +
  $200–400/мес. Имеет смысл при твёрдых планах на Lichess в ≤6 мес.
- [ ] S4: переезд на Aurora PG. Цена t3.large + 30%. Польза только при
  будущей нужде в read-replicas / multi-AZ HA.
- [ ] S7b (LMDB): кастомное embedded хранилище. 4–6 нед работы,
  $15–30/мес. Имеет смысл, если cloud spend — главный driver.

**Архитектор рекомендует S1.** Решение за пользователем.
