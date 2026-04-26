# KS-2004 — Миграция БД `archive_kingside` на отдельный RDS-инстанс

**Статус:** Предложено
**Дата:** 2026-04-26
**Связанные ADR:** [ADR-018 archive-service-extraction](../adr/018-archive-service-extraction.md), [ADR-019 archive-importer-merge-into-service](../adr/019-archive-importer-merge-into-service.md), [ADR-013 game-archive-and-tree](../adr/013-game-archive-and-tree.md), [ADR-027 archive-rds-sizing](../adr/027-archive-rds-sizing.md)

---

## 1. Контекст

### 1.1 Что есть сейчас (факт)

- БД `archive_kingside` живёт **отдельной database** на общем RDS-инстансе `kingside-db` (вариант B из ADR-018 §2.2). Соседние database в том же инстансе: основная `kingside` (apps/api) и `broadcasts_kingside`.
- Класс инстанса: **db.t3.micro** — 1 GiB RAM, 2 vCPU (burstable).
- Storage: **gp3 20 GB**, baseline 3000 IOPS / 125 MB/s.
- Прод-потребители архивной БД (по ADR-019, importer мерджнут в service):
  - `apps/archive-service` — единственный процесс, который читает (HTTP API) и пишет (TWIC tick + cron `rebuild-position-stats`) в архивные таблицы. Один Prisma-клиент `@kingside/archive-db` на оба пути; для горячего write-path в `archive_game_positions` отдельный `pg.Pool` + `COPY FROM STDIN`.
  - `ARCHIVE_DATABASE_URL` уже выделена отдельно от `DATABASE_URL` основного API (по ADR-018 §2.3), хранится в AWS Secrets Manager.
- Размер архивных таблиц (по схеме `packages/archive-db/prisma/schema.prisma`):
  - `archive_sources`, `archive_imports` — KB.
  - `archive_games` — text-поле `pgn`, миллионы строк по мере роста.
  - `position_stats` — агрегат, размер на порядок меньше `archive_game_positions`.
  - **`archive_game_positions`** — самая большая, два составных B-tree индекса (`_recent`, `_top_elo`) поверх `(positionKey, bucket, ...)`.

### 1.2 Симптомы (из задачи)

TWIC-импорт 1595:
- `DiskQueueDepth` 0 → 10 (RDS-метрика — очередь IO операций).
- `WriteLatency` 1ms → 10ms.
- Throughput по импорту 18 → 5.6 игр/с.

Корень: индексы `archive_game_positions` уже **не помещаются в shared_buffers** t3.micro (1 GiB RAM делится между tcp/wal/work_mem/shared_buffers; на shared_buffers по правилу 25% — это ~256 MiB). Каждый INSERT в горячий B-tree требует чтения random-pages с диска gp3 — отсюда рост queue/latency. Дополнительно конкурируют workload основного API и broadcasts.

### 1.3 Что задача просит

Поднять отдельный RDS-инстанс под archive_kingside и мигрировать данные туда. Это переход «вариант B → вариант A» из ADR-018 §2.2: `pg_dump/restore + смена ARCHIVE_DATABASE_URL`. Архитектура приложений не меняется.

### 1.4 Что НЕ в скоупе

- ClickHouse / column-store для `position_stats` (открытый follow-up из ADR-013 §10.C.4).
- Read replica архивного инстанса (имеет смысл когда HTTP API упрётся в read-IOPS, сейчас не упёрся).
- Аналогичный вынос `broadcasts_kingside` на отдельный инстанс (отдельная задача, если потребуется).
- Партиционирование `archive_game_positions` по `bucket` или `playedAt` — это решается на уровне схемы, отдельно от инфра-миграции.

---

## 2. Решение по новому инстансу

### 2.1 Класс инстанса

Цель: shared_buffers ≥ горячие B-tree индексы + headroom. На сегодня горячая часть — это `archive_game_positions_recent` и `archive_game_positions_top_elo` плюс PK `(positionKey, bucket, gameId)`. Точные размеры известны только devops (`SELECT pg_size_pretty(pg_relation_size('...'))`); ниже — рекомендации по диапазонам.

| Класс | RAM | vCPU | Цена on-demand* | Когда подходит |
|---|---|---|---|---|
| db.t4g.small | 2 GiB | 2 (Graviton) | низкая | Минимальный шаг — даст ×2 RAM и ARM-скидку, но всё ещё burstable (CPU credits) |
| **db.t4g.medium** | **4 GiB** | **2 (Graviton)** | **средняя** | **Рекомендация для cutover.** ×4 RAM, shared_buffers ~1 GiB (25%), хватает для текущих индексов + запас на ~6–12 месяцев импортов |
| db.m6g.large | 8 GiB | 2 (Graviton) | выше | Когда `archive_games` переедет 5+ GiB и индексы `archive_game_positions` перевалят за 2 GiB |
| db.r6g.large | 16 GiB | 2 (Graviton, memory-optimized) | заметно выше | Если поняли, что вся БД должна жить в RAM (lookup-heavy, sub-ms latency) |

\* Бюджет точно знает devops; здесь ранг важнее абсолютных цифр.

**Принимаем: db.t4g.medium на старте.** Burstable t-класс приемлем, потому что write-нагрузка точечная (раз в неделю TWIC tick + ручные backfill), а read-нагрузка GET API — десятки RPS (см. ADR-018 §2.6 «низкий трафик»). Если CPUCreditBalance начнёт стабильно падать в импортном окне — переходим на m6g.large без миграции (RDS modify-instance с минимальным downtime ~2–5 мин).

> **Открытый вопрос (см. §6.1):** утверждаем t4g.medium как стартовый или сразу m6g.large для запаса на 2+ года.

### 2.2 Storage и IOPS

| Параметр | Значение | Обоснование |
|---|---|---|
| Type | **gp3** | дешевле io2; baseline IOPS/throughput настраиваются независимо |
| Size | **50 GiB** | старт; gp3 поддерживает online resize, увеличиваем по мере роста |
| Provisioned IOPS | **3000** (gp3 baseline) | хватит для текущей нагрузки; повышаем до 6000–12000 если WriteLatency > 5 ms сохранится после миграции |
| Provisioned throughput | **125 MB/s** (gp3 baseline) | для weekly TWIC бачки достаточно; увеличиваем при backfill больших архивов |
| Storage Autoscaling | **enabled, max 200 GiB** | защита от аларма по диску в выходные, без ручного reaction |

50 GiB — оценочный заряд исходя из ~2k партий/неделю и роста за 2–3 года + место под dump/restore при необходимости. Точный текущий размер `pg_database_size('archive_kingside')` девопс должен подтвердить перед запуском (см. §6.2).

### 2.3 Multi-AZ, бэкапы, версия

| Параметр | Значение | Обоснование |
|---|---|---|
| Engine | **PostgreSQL 16** | та же мажорная версия, что текущий инстанс (предположение, проверить у devops) — нужно для бесшовного pg_dump/restore без upgrade-сюрпризов |
| Multi-AZ | **enabled** | стандарт прода; small-medium классы в Multi-AZ выходят разумно |
| Automated backups | **7 дней** | стандарт; для архива дольше не нужно — данные пересобираются из TWIC при необходимости |
| Snapshot retention | по дефолту RDS | + ручной snapshot перед cutover (см. §3.4) |
| Maintenance window | **`Mon 03:00–04:00 UTC`** | вне TWIC-окон (TWIC обычно выходит вторник вечером по UTC); согласовать с devops |
| Performance Insights | **enabled** (free tier) | для мониторинга после миграции; без него непонятно решена ли проблема |
| Enhanced Monitoring | **60s** | базовая видимость по cgroups |

### 2.4 Network и security

| Параметр | Значение | Обоснование |
|---|---|---|
| VPC | **та же**, что общий RDS | archive-service сидит в той же VPC, peering не нужен |
| Subnet group | **private subnet group** (DB Subnet) | как у общего RDS; никаких public endpoints |
| Publicly accessible | **`false`** | очевидно |
| Security group | **новая** `kingside-archive-rds-sg` | — |
| SG inbound | TCP 5432 от **`archive-service-sg`** (ECS task SG) | единственный потребитель — archive-service. Importer внутри него же (ADR-019). |
| SG outbound | default deny | RDS ничего не инициирует |
| Encryption at rest | **enabled, AWS-managed KMS** | стандарт для prod |
| TLS | `rds.force_ssl=1` (через parameter group) | importer/service уже подключаются с `sslmode=require` (предположение, см. §6.3) |
| Parameter group | новая `kingside-archive-pg16` | копия дефолтной + кастом параметры (§2.5) |

Старый общий RDS остаётся доступным для архив-таблиц до завершения soak-периода (см. §4) — на случай отката.

### 2.5 Тюнинг параметров под workload

Главный bottleneck — индексы не в кэше. Tuning ориентирован на write-throughput TWIC + read-throughput GET API.

| Параметр | Значение | Зачем |
|---|---|---|
| `shared_buffers` | дефолт RDS (25% RAM ≈ 1 GiB на t4g.medium) | базовый параметр |
| `effective_cache_size` | дефолт RDS (75% RAM ≈ 3 GiB) | для планировщика |
| `work_mem` | 8 MB (вместо 4 MB) | большие index scans на `archive_game_positions` для read API |
| `maintenance_work_mem` | 256 MB | для ANALYZE / VACUUM / REINDEX после миграции |
| `wal_compression` | `on` | для cheaper Multi-AZ replication, gp3 throughput не пострадает |
| `pg_stat_statements` | enabled через `shared_preload_libraries` | критично для дальнейшей оптимизации запросов |
| `autovacuum_vacuum_scale_factor` (на `archive_game_positions`) | 0.05 (вместо 0.2) | таблица растёт большими батчами после TWIC; чаще vacuum даёт более свежую статистику |
| `autovacuum_analyze_scale_factor` (на `archive_game_positions`) | 0.02 | после batch-INSERT'а статистика устаревает |
| `max_connections` | 50 | archive-service держит ~10 коннектов (Prisma + pg.Pool); 50 даёт запас 5×, не раздувает per-conn память |

> Per-table параметры (`autovacuum_*_scale_factor`) применяются через `ALTER TABLE archive_game_positions SET (...)`, не через parameter group — это часть post-migration runbook (§3.5).

### 2.6 Что НЕ меняем в коде приложения

`apps/archive-service` (включая archive-importer-часть из ADR-019) **не меняется**. Подключение к новой БД — через смену значения секрета `ARCHIVE_DATABASE_URL` в Secrets Manager и перезапуск task'а. Никаких изменений в Prisma schema, Dockerfile, package.json — миграция чисто инфраструктурная.

---

## 3. Стратегия миграции данных

### 3.1 Сравнение вариантов

| Вариант | Downtime | Сложность | Подходит? |
|---|---|---|---|
| **A. pg_dump/pg_restore** | 30 мин – 2 часа в окне (write только, read остаётся на старой БД до cutover) | низкая | **да, рекомендуется** |
| B. Native PG logical replication (`pglogical`/built-in) | секунды (только switchover) | средняя — нужны publisher/subscriber, проверка лагов, обработка sequence'ов | overkill для weekly-write workload; даёт незаметный switchover, но цена сложности высока |
| C. AWS DMS | минуты | средняя — отдельный сервис | дополнительный billing + setup; имеет смысл когда исходная и целевая БД разных версий или вендоров |
| D. RDS snapshot → restore as new instance | ~30 мин копии, **но новый инстанс получит ВЕСЬ старый snapshot** (включая `kingside`, `broadcasts_kingside`) | низкая, но хвост: после restore нужно дропнуть лишние database | работает, но получится «новый инстанс с лишними данными» — нужен extra cleanup |

**Принимаем вариант A (pg_dump/pg_restore).** Workload архива даёт естественное окно: между TWIC-тиками неделя; внутри cutover-window archive-service отвечает 200 OK на GET с **той же** старой БД (мы её не трогаем до cutover'а), а новая БД готовится параллельно. После dump/restore — switch ARCHIVE_DATABASE_URL и перезапуск.

### 3.2 Минимальный downtime

Технически **видимого даунтайма для пользователей нет**, потому что:
- На время `pg_dump` старая БД продолжает обслуживать GET API.
- На время `pg_restore` новая БД пуста, но старая ещё в работе.
- Перерыв только в момент **switchover** (5–10 секунд на rolling restart `archive-service` task'ов) — за это время GET-запросы получат 502/503 или 30s timeout, ALB перенаправит на здоровые task'и (если их 2+).

Окно «нельзя писать в БД» (TWIC import заморожен) — от старта `pg_dump` до перезапуска archive-service. Если попадаем между TWIC-тиками — пользователь этого не заметит.

### 3.3 Оценка времени dump/restore

Зависит от размера архивных таблиц. Грубая оценка:

| Размер БД | Время `pg_dump --jobs=4` (gp3 125 MB/s) | Время `pg_restore --jobs=4` |
|---|---|---|
| 1 GiB | 15–30 сек | 1–3 мин |
| 10 GiB | 2–5 мин | 10–20 мин |
| 50 GiB | 10–20 мин | 50–90 мин |

> Точные цифры — devops через `pg_database_size('archive_kingside')` перед стартом. Если БД >20 GiB, рассмотреть параллельные jobs (`-j N`) и временное повышение IOPS gp3 на стороне источника.

### 3.4 Runbook миграции (cutover window)

**Окно:** между TWIC-тиками (TWIC выходит обычно по вторникам вечером по UTC). Целевое окно — например, понедельник 03:00–05:00 UTC (вне TWIC, низкий трафик API).

#### Phase 0 — подготовка (без даунтайма, заранее)

1. **D-7** дней до cutover: создать новый RDS-инстанс `kingside-archive-db` через Terraform/Console по параметрам §2.1–2.5. Эмпиричный smoke: `psql` от bastion, `CREATE DATABASE archive_kingside`, `\dt`.
2. **D-7**: применить миграции `@kingside/archive-db` к пустой БД через `prisma migrate deploy` (или через ECS-job, если такой есть). Структура таблиц должна совпадать с источником.
3. **D-3**: завести новый секрет `ARCHIVE_DATABASE_URL_NEW` в Secrets Manager (старый `ARCHIVE_DATABASE_URL` остаётся как есть). Задать новый ARCHIVE_DATABASE_URL_NEW в task definition archive-service как **дублирующую** переменную — пока не используется, но проверяется CI на присутствие.
4. **D-1**: dry-run `pg_dump --schema-only --table=archive_*` на источнике, проверить что схема совпадает с тем, что применил `prisma migrate deploy` на целевой. Никаких неожиданных колонок/индексов.

#### Phase 1 — cutover (1–2 часа окна)

5. **T+0:** Поставить флаг maintenance в archive-service (опционально — фронт показывает «архив временно недоступен» вместо 503; если хук не реализован, пропустить).
6. **T+0:** Через AWS Console остановить TWIC scheduler / любой ручной импорт (на уровне ECS задачи — но в текущей архитектуре importer внутри archive-service, поэтому **просто не запускать** ручной trigger в окно).
7. **T+0:** Проверить отсутствие активных INSERT на источнике:
   ```sql
   SELECT pid, query, state FROM pg_stat_activity
   WHERE datname = 'archive_kingside' AND state = 'active';
   ```
   Если есть — дождаться завершения.
8. **T+0:** Сделать **ручной snapshot** общего инстанса перед операцией (страховка).
9. **T+1 мин:** Запустить `pg_dump --data-only --jobs=4 --format=directory --file=/tmp/archive_dump --table=archive_sources --table=archive_imports --table=archive_games --table=position_stats --table=archive_game_positions <SOURCE_URL>` на bastion / в одноразовом ECS-task'е.
10. **Когда dump готов:** залить в `pg_restore --data-only --jobs=4 /tmp/archive_dump <TARGET_URL>`.
11. **После restore:** запустить `ANALYZE` на всех 5 таблицах в новой БД (без него планировщик первое время будет тупить):
    ```sql
    ANALYZE archive_sources;
    ANALYZE archive_imports;
    ANALYZE archive_games;
    ANALYZE position_stats;
    ANALYZE archive_game_positions;
    ```
12. **Sanity-checks:** `SELECT COUNT(*)` по каждой таблице, сравнение с источником. Должно сходиться 1-в-1.
13. **Switchover:**
    - В Secrets Manager обновить `ARCHIVE_DATABASE_URL` (значение из `ARCHIVE_DATABASE_URL_NEW`).
    - Сделать rolling restart ECS service `archive-service` (через AWS CLI: `aws ecs update-service --force-new-deployment`). Min healthy 50% — чтобы не упало совсем; если task один, пользователи увидят несколько секунд 502.
14. **Verification (см. §3.6):**
    - `GET /_/health` возвращает 200.
    - `GET /archive/tree?...` возвращает реальные данные (не пусто).
    - Логи archive-service содержат строку успешного коннекта без ошибок.
    - CloudWatch RDS `DatabaseConnections` на новом инстансе > 0.
15. **T+end:** Снять maintenance-флаг.

#### Phase 2 — soak (7 дней)

16. Старая БД (`archive_kingside` в общем инстансе) **не трогаем**, оставляем как страховку для отката (§5).
17. CloudWatch dashboards на новом инстансе:
    - `DiskQueueDepth` < 1 (был 10).
    - `WriteLatency` < 5 ms (был 10 ms).
    - `BufferCacheHitRatio` > 99%.
    - `CPUCreditBalance` стабильный (для t-класса).
18. Через **2 дня после cutover**: дождаться следующего TWIC tick, проверить что importer успешно записал партии в новую БД. Throughput должен быть стабильным >18 игр/с.

#### Phase 3 — финальная зачистка (точка невозврата)

19. **D+14** (после успешного soak'а):
    - На общем RDS: `DROP DATABASE archive_kingside;`. **После этой команды откат невозможен.** Снапшот общего инстанса (см. шаг 8) — последний рубеж.
    - В Secrets Manager: удалить `ARCHIVE_DATABASE_URL_NEW` (она была временной для CI).
    - Документировать в runbook'е: следующий импорт TWIC происходит в новую БД.

### 3.5 Тюнинг после миграции

После шага 14 — применить per-table параметры:

```sql
ALTER TABLE archive_game_positions SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
ALTER TABLE archive_games SET (
  autovacuum_vacuum_scale_factor = 0.1
);
```

И первый VACUUM ANALYZE на больших таблицах — снимет накопленные dead tuples (если были) после restore.

### 3.6 Verification — что archive-service работает

После switchover (шаг 14) backend/devops запускают smoke-чеклист:

1. `curl https://archive.kingside.site/_/health` → `{"ok": true}`.
2. `curl https://archive.kingside.site/archive/tree?ply=1&limit=5` → JSON с непустым `data: [...]`.
3. `curl https://archive.kingside.site/archive/games/by-position?fen=...&limit=5` → JSON с непустым `games: [...]`.
4. Любой существующий `gameId` из топа: `GET /archive/games/<uuid>` → партия.
5. Логи archive-service за последний час — нет `ECONNREFUSED`, `connection terminated`, `prisma client init error`.
6. CloudWatch metrics:
   - `DatabaseConnections` на **новом** инстансе > 0.
   - `DatabaseConnections` на **старом** инстансе для database `archive_kingside` упали до 0 (потребитель ушёл).
7. RDS Performance Insights — топ запросов соответствует тому, что ожидаем (без неожиданных new query patterns).
8. Через 2 дня — следующий TWIC tick:
   - `archive_imports.status` = success, `gamesAdded` > 0.
   - Импорт прошёл за разумное время (>18 игр/с — индикатор, что bottleneck решён).

---

## 4. План отката

Откат **возможен до момента шага 19** (DROP старой database). Сценарии:

### 4.1 Откат сразу после switchover (шаги 13–15)

Симптом: archive-service не стартует с новым URL; задачи crashloop.

1. В Secrets Manager: вернуть `ARCHIVE_DATABASE_URL` к старому значению.
2. `aws ecs update-service --force-new-deployment` для archive-service.
3. После старта — verify §3.6 пунктами 1–5 на старой БД.
4. Diagnose: смотрим логи задачи, ищем причину (неправильный URL, не накачена migration, network — SG не пускает).
5. Фикс — повторный cutover через несколько часов / следующее окно.

**Время отката: 5–10 минут** (rotation секрета + rolling restart).

### 4.2 Откат через 1–7 дней (soak phase)

Симптом: на новом инстансе обнаружились проблемы (latency регрессия, нехватка RAM, ошибки в данных после restore).

1. То же что в §4.1 (вернуть ARCHIVE_DATABASE_URL, перезапустить).
2. **Расхождение данных:** за период soak в новую БД могли попасть новые TWIC-партии (если был tick во время soak). Эти партии **потеряются** при возврате на старую БД, потому что:
   - Старая БД не получала insert'ов с момента cutover.
   - В новой БД появились свежие записи, которых нет в старой.
3. Решение: до отката сделать `pg_dump --data-only --table=archive_imports --table=archive_games --where="created_at > '<cutover time>'"` из новой БД и накатить в старую. Это нужно если за soak был хотя бы один TWIC tick.
4. Альтернатива: пропустить пришедшие во время soak записи (TWIC всё равно подтянет недостающие при следующем tick — `content_hash` deduplication гарантирует, что повторно та же партия не вставится).

**Время отката: 5–30 минут** (с реконсиляцией данных).

### 4.3 Откат после Phase 3 (DROP DATABASE)

**Невозможен** без восстановления из snapshot общего инстанса (шаг 8). Snapshot восстанавливается как новый инстанс — full restore с downtime ~1 час и реконфигурацией всего. Это аварийный сценарий, не штатный откат.

### 4.4 Tabletop check на rollback готовность

Перед каждой фазой — devops проверяет:
- Старая БД жива и доступна, последний backup свежий.
- Snapshot общего инстанса перед cutover сделан (шаг 8).
- Скрипт смены секрета и rolling restart протестирован (хотя бы dry-run в stage).

---

## 5. Риски и подводные камни

| # | Риск | Mitigation |
|---|---|---|
| 1 | Точный размер БД неизвестен — может быть >50 GiB, тогда dump/restore долго | До cutover'а: `SELECT pg_size_pretty(pg_database_size('archive_kingside'));`. Если >20 GiB — увеличить gp3 throughput на источнике на время dump'а или рассмотреть `pg_dump --jobs=8` |
| 2 | На новом RDS не накатили миграции `@kingside/archive-db` — `pg_restore` в пустую БД упадёт на FK | Phase 0 шаг 2: `prisma migrate deploy` обязателен **до** dump'а; шаг 4 проверяет схему. Используем `pg_restore --data-only` (только данные, без DDL) |
| 3 | Версии PostgreSQL не совпадают (старая 15, новая 16) | До cutover'а: `SHOW server_version` на обеих БД. Если расхождение — либо ставить такую же версию на новый инстанс, либо учесть upgrade-нюансы (на minor-bump обычно OK, на major — отдельная история) |
| 4 | После switchover archive-service пытается коннектиться, но новый SG не пускает | Phase 0 шаг 1: SG inbound от `archive-service-sg` настраивается при создании; шаг 4 проверяет коннект из bastion. Smoke-test до cutover'а |
| 5 | TWIC-tick попал в окно cutover'а | Phase 1 шаг 6: вручную приостановить scheduler; в худшем случае — пропустить один tick, следующий подтянет (TWIC дельта-импорт работает корректно) |
| 6 | Изменения в Secrets Manager не подхватились ECS task'ом без рестарта | Это нормально для AWS Secrets Manager: значение пуллится при старте контейнера. `--force-new-deployment` обязательно. При желании — настроить ротацию (вне скоупа) |
| 7 | Старый инстанс перестаёт быть утилизирован (вынесли archive — освободилось ~25% RAM) | После Phase 3 (DROP) рассмотреть, нужно ли **уменьшить** общий инстанс до меньшего класса (отдельная задача, потенциальная экономия) |
| 8 | Performance regression на новом инстансе несмотря на больший RAM | Performance Insights показывает конкретные запросы; tuning через `pg_stat_statements`. До cutover'а snapshot текущих метрик для baseline-сравнения |
| 9 | Multi-AZ standby не успевает за write-tick TWIC | Многозонные read-replicas в RDS PostgreSQL синхронны (Multi-AZ deploy = standby + sync streaming). Lag — десятки ms. На weekly-write workload не должно быть проблемой |
| 10 | Rolling restart в ECS требует min 2 task'а | По ADR-018 §2.6: archive-service min=1 / max=2. На старте 1 task — рестарт даст 5–30 секунд недоступности. Опция: временно scale до 2 на момент cutover'а, после soak'а вернуть к 1 |
| 11 | После DROP DATABASE снапшот общего инстанса хранится только 7 дней (стандартный retention) | Снять manual snapshot шага 8 — он не удалится автоматически. Удалить вручную после успешной зачистки (через 30+ дней) |
| 12 | `pg_stat_activity` показывает старые коннекты после остановки task'ов | Это idle коннекты от закрывающегося Prisma pool — закроются за 1–2 мин. Если нет — `pg_terminate_backend(pid)` |
| 13 | Параметры `autovacuum_*_scale_factor` per-table не накатились | Проверка после §3.5: `SELECT relname, reloptions FROM pg_class WHERE relname IN ('archive_games', 'archive_game_positions');` — должны видеть свои значения |
| 14 | `pg_dump --jobs=N` требует снапшот-изоляции; на источнике должно хватить slots | Параметр `max_replication_slots` дефолтно 10, нам нужно ≤ N+1. На t3.micro может быть тесно — проверить заранее |
| 15 | Отсутствие IPv6 в новом subnet group | Не критично, archive-service подключается по IPv4. Если в будущем потребуется — отдельная задача |
| 16 | Encrypted snapshots не передаются между регионами без re-encrypt | Не наш случай (один регион), но стоит знать |
| 17 | После миграции старый общий инстанс продолжает реплицировать в Multi-AZ standby пустую `archive_kingside` (так как DROP не сразу) | Незначительная стоимость; устраняется в Phase 3 |

---

## 6. Открытые вопросы для пользователя

### 6.1 Класс инстанса: t4g.medium или сразу m6g.large?

- t4g.medium: дешевле, ×4 RAM по сравнению с текущим. Подходит, если запас на 6–12 месяцев приемлем (потом — modify-instance в m6g.large).
- m6g.large: ×8 RAM, не burstable CPU. Дороже, но даст запас на 2+ года и стабильный CPU без credit-cliff.

Моя рекомендация — t4g.medium. Если приоритет «один раз и на годы» — сразу m6g.large.

### 6.2 Текущий размер БД и темп роста

Чтобы зафиксировать sizing storage и план выкатки, devops до старта:
```sql
SELECT pg_size_pretty(pg_database_size('archive_kingside'));
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

Если БД >50 GiB — увеличить gp3 size до 100 GiB и/или повысить throughput на момент dump.

### 6.3 Версия PostgreSQL и SSL

- Какая версия PG на текущем общем инстансе? (`SHOW server_version`)
- Подключения уже идут с `sslmode=require` или нет?

Ответы влияют на parameter group и connection string в Secrets Manager.

### 6.4 Окно cutover

Когда удобно для devops? Предлагаемое окно:
- Понедельник 03:00–05:00 UTC (вне TWIC, низкий трафик).
- Альтернатива — суббота утром UTC.

### 6.5 Multi-AZ обязательно?

Multi-AZ удваивает стоимость инстанса (standby оплачивается). Архив — не критичный сервис (ADR-018 §2.2: «архив вторичный для большинства пользователей»). Можно стартовать без Multi-AZ (single-AZ) и включить позже, когда архив станет критичным.

Решение пользователя: Multi-AZ on/off.

### 6.6 Уменьшение старого общего инстанса

После выноса архива потребление RAM на общем инстансе снизится. Через 1–2 месяца после Phase 3 — рассмотреть downgrade общего RDS (например, t3.micro → t3.small был уже мал, может и t3.micro хватит без архива; либо наоборот, если api+broadcasts тоже жмёт — оставить как есть).

Это **отдельная** задача (KS-XXXX), не в этом скоупе.

### 6.7 Используется ли сейчас Multi-AZ на общем инстансе?

Если да — план миграции наследует Multi-AZ для нового инстанса. Если нет — devops решает.

---

## 7. Разбивка на задачи

| # | Агент | Задача | Зависит от | Метки |
|---|---|---|---|---|
| **D-1** | devops | Создать новый RDS-инстанс `kingside-archive-db` (t4g.medium / gp3 50 GB / Multi-AZ если решено / SG / parameter group) через Terraform или Console. | — | `infra` |
| **D-2** | devops | Накатить миграции `@kingside/archive-db` на пустой новый инстанс через `prisma migrate deploy` (или одноразовый ECS task). Проверить схему. | D-1 | `prisma`, `infra` |
| **D-3** | devops | Завести секрет `ARCHIVE_DATABASE_URL_NEW` в Secrets Manager со строкой коннекта на новый инстанс. Прокинуть как доп. ENV в task definition archive-service (для smoke в Phase 0). | D-1 | `infra` |
| **D-4** | devops | Smoke-test: bastion → `psql` к новому инстансу, `\dt` показывает 5 таблиц. Connection из ECS task проходит (test-task с `psql -c 'SELECT 1'`). | D-2, D-3 | `infra`, `tests` |
| **D-5** | devops | Cutover (Phase 1, runbook §3.4): manual snapshot, pg_dump → pg_restore, ANALYZE, sanity COUNT, smens secret + rolling restart. | D-4 | `infra` |
| **D-6** | devops | Verification (§3.6): smoke 8 пунктов, наблюдение CloudWatch dashboards 24 часа после cutover. | D-5 | `infra` |
| **D-7** | devops | Soak monitoring 7 дней. После следующего TWIC-tick'а проверить throughput. | D-6 | `infra` |
| **D-8** | devops | Phase 3 cleanup: `DROP DATABASE archive_kingside;` на старом инстансе. Удалить ARCHIVE_DATABASE_URL_NEW из Secrets Manager. Document. | D-7 | `infra` |
| **B-1** | backend | (Опционально) Подготовить health-check endpoint на ECS task definition уровне, который зависит от `SELECT 1` к archive DB — уже реализовано в `apps/archive-service/src/health/`, проверить что enabled. | — | `tests` |
| **B-2** | backend | (Опционально) Добавить unit-тест на ENV-парсинг `ARCHIVE_DATABASE_URL` (валидация что значение читается, parse валидный URL). Защита от опечаток в Secrets Manager. | — | `tests` |
| **D-9** | devops | (Отдельная задача, после soak'а) Рассмотреть downgrade общего RDS после освобождения RAM. | D-8 | `infra` |

**Критический путь:** D-1 → D-2 → D-4 → D-5 → D-6 → D-7 → D-8. Backend-задачи параллельны.

---

## 8. Что меняется в долгосрочной перспективе

- **Биллинг:** появляется отдельная статья за archive RDS. Точная цифра — у devops по AWS Calculator (на момент написания не считаю, чтобы не давать устаревшие значения). Грубо: t4g.medium Multi-AZ + 50 GiB gp3 + базовый IO = от $50/мес.
- **Operational:** один лишний RDS под мониторингом, бэкапами, патчингом. Devops добавляет в существующий runbook (CloudWatch dashboards, alerting).
- **Архитектурно:** разделение storage по сервису-владельцу — здоровый шаг к настоящему microservice-podходу. ADR-018 §2.2 предсказывал этот переход; KS-2004 его выполняет.
- **Будущее:** при дальнейшем росте архива (>5M партий, ClickHouse-перенос `position_stats`) RDS остаётся для primary-данных, ClickHouse становится отдельным аналитическим стором — этот RDS-инстанс не становится тупиком развития.
