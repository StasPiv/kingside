# ADR-130 — Консолидация ECS-сервисов api/broadcast-service/archive-service

- Статус: **Частично реализован** (Proposed 2026-06-16 → Partially
  Implemented 2026-06-16)
- Задача: KS-4237
- Что реализовано:
  - HTTP-эндпоинты `archive-service` перенесены в `apps/api` —
    отдельный ADR-131, цепочка KS-4246 → KS-4247 → KS-4248 → KS-4249
    → KS-4250 (+ KS-4251 на ALB-пробел). Экономия ~$14/мес фактически
    (см. ADR-131 §6).
  - Sizing `archive-service` уже снижен с 0.5 vCPU + 1 GB на 0.25
    vCPU + 0.5 GB в рамках KS-4240 (сценарий В §6 шаг 2 этого ADR) —
    выполнено до ADR-131.
- Что отложено по решению пользователя:
  - Перенос `broadcast-service` в `apps/api` (полный сценарий А) — не
    запущен; broadcast-service остаётся отдельным ECS-сервисом
    (контракт KS-1702, поддомен `broadcasts.kingside.site`,
    WS-namespace `/`).
  - Консолидация `archive_kingside` на `kingside-db` (§6 шаг 5) —
    отложена; `kingside-archive-db` остаётся отдельным RDS instance,
    importer пишет туда без изменений.
  - Снижение `game-service` 0.5 → 0.375 vCPU (§6 шаг 3) — статус
    уточнить у devops, на момент финализации не отмечено как
    выполненное.
  - Отключение Container Insights (§6 шаг 4) — статус уточнить у
    devops.
- Связанные ADR / задачи:
  - ADR-017 — изначальное выделение `apps/game-service` (WS-приоритет).
  - ADR-018 — деплой `apps/archive-service` как отдельного ECS-сервиса.
  - ADR-019 — изначальное выделение `apps/archive-importer` (позже свёрнут
    обратно в `apps/archive-service` как `start:importer`).
  - ADR-020 — `importer-once` на EventBridge Scheduler + ECS RunTask
    (one-shot, не постоянный сервис).
  - ADR-021 — выделение `apps/broadcast-service` (KS-1702, поддомен
    `broadcasts.kingside.site`, WS namespace `/`).
  - ADR-022 — свёртывание `apps/broadcast-worker` обратно в
    `broadcast-service`.
  - ADR-090 §4.2 B2 — proxy от `apps/api` к `archive-service`.
  - KS-4202 — пример сценария (В): prerender-service 1 → 0.5 vCPU.
- Авторы: architect (анализ), devops (фактические данные по cpu/mem/cost — раздел 2.3).

---

## 1. Контекст и проблема

Пользователь обеспокоен расходами на ECS Fargate и поставил вопрос: имеет ли
смысл объединить три сервиса (`apps/api`, `apps/broadcast-service`,
`apps/archive-service`) в один, чтобы сократить compute-затраты.

Каждый сервис сейчас — отдельный Fargate task (отдельный compute, отдельный
deploy-pipeline, отдельный поддомен). Грубая оценка из тикета — ~$80-150/мес
на три сервиса; точные цифры — в разделе 2.3.

Этот ADR — **анализ**, не решение. Финальный выбор сценария — за пользователем
после прочтения. Архитектор не пишет код в рамках этой задачи.

---

## 2. Текущее состояние

### 2.1. Полный набор ECS-сервисов (для корректности контекста)

Кроме трёх, упомянутых в задаче, на ECS работает больше:

| Сервис | Назначение | БД-пакет | Публичный поддомен |
|--------|------------|----------|--------------------|
| `apps/api` | NestJS REST + WebSocket (`/tournament`, `/messages`, `/live-analysis`) | `@kingside/db` | `api.kingside.site` (предположительно) |
| `apps/game-service` | WS-приоритет для игровой логики, отдельный bootstrap, RedisIoAdapter | `@kingside/db` | свой WS-endpoint |
| `apps/broadcast-service` | Lichess mirror, sync раундов, watchdog, WS namespace `/` | `@kingside/broadcasts-db` | `broadcasts.kingside.site` |
| `apps/archive-service` | Архив PGN-партий (HTTP API + TWIC importer как `start:importer`) | `@kingside/archive-db` | `archive.kingside.site` |
| `apps/prerender-service` | Chromium SSR из SQS-очереди | — (S3-bucket) | внутренний |
| `apps/synthetic-bot-service` | Боты для тестового матчмейкинга | `@kingside/db` (предположительно) | внутренний |
| `apps/tactic-worker` | Воркер тактических задач | `@kingside/db` (предположительно) | внутренний |

Дополнительно on-demand (НЕ постоянные сервисы, не платят за idle):
- `archive-service` в режиме `start:importer-once` — EventBridge Scheduler +
  ECS RunTask, отрабатывает ≤30 мин и сам гасится (ADR-020).

В задаче упомянуты только три из семи постоянных сервисов. Это важно для
оценки реальной экономии — она составит долю от полной счёт-фактуры ECS, а
не всю инфраструктуру.

`apps/archive-importer` и `apps/broadcast-worker` — физически свёрнуты в
другие сервисы (ADR-022, KS-1676), их пустые папки в `apps/` — техдолг,
нужно удалить уборкой (вне scope этого ADR).

### 2.2. Зависимости и связность

**HTTP-coupling (api дёргает остальные через `BROADCAST_SERVICE_URL` /
`ARCHIVE_SERVICE_URL`):**
- `api → archive-service`: `/games/by-position` (opening-trainer proxy),
  reindex-all.
- `api → broadcast-service`: admin-reindex proxy, `guess.service` →
  `/internal/games/by-lichess`.

**БД:**
- Три отдельные Prisma-схемы / пакета (`@kingside/db`,
  `@kingside/broadcasts-db`, `@kingside/archive-db`).
- Физическое размещение (один RDS instance или три) — уточняет devops
  (раздел 2.3).
- Кросс-схемных FK нет — каждая БД самостоятельна.

**Redis:**
- Все три сервиса читают `REDIS_HOST` из env. Это общий ElastiCache instance
  (один шардинг между ключами разных сервисов, но префиксы разные).

**WebSocket-нэймспейсы:**
- `apps/api`: `/tournament`, `/messages`, `/live-analysis` (три gateway'я).
- `apps/broadcast-service`: default namespace `/` (KS-1702, без префикса).
- `apps/game-service`: WS-primary, отдельный сервис.

🔴 **Прямой конфликт при объединении api + broadcast-service:**
`broadcast-service` использует **дефолтный namespace `/`** (контракт
KS-1702). Если объединить в один процесс — нужно либо переименовать namespace
broadcast'а в `/broadcasts` (ломает фронт-контракт и кэширование), либо
переименовать одну из api-гейтвей-роутов (тоже не безболезненно). Это не
блокер, но цена.

### 2.3. Cpu/Memory/Cost — фактические данные

Данные собраны devops в рамках KS-4237 (CloudWatch 30 дней, Cost Explorer
май 2026, ECS describe).

**Поправка к разделу 2.1:** на ECS постоянно работают **5 сервисов**, не 7:
- `synthetic-bot-service` уже отсутствует как сервис.
- `tactic-worker` — RunTask по требованию (task-def revision 54, 16 vCPU +
  32 GB), не постоянный сервис.

**Конфигурация Fargate (все 5 симметричные):**

| Сервис | cpu | memory | desiredCount | Public IPv4 |
|--------|-----|--------|--------------|-------------|
| `kingside-api` | 0.5 vCPU | 1 GB | 1 | да |
| `kingside-archive-service` | 0.5 vCPU | 1 GB | 1 | да |
| `kingside-broadcast-service` | 0.5 vCPU | 1 GB | 1 | да |
| `kingside-game-service` | 0.5 vCPU | 1 GB | 1 | да |
| `kingside-prerender-service` | 0.5 vCPU | 1 GB | 1 | да |

Все в public subnet, NAT нет, IGW напрямую.

**CloudWatch утилизация (30 дней, daily granularity):**

| Сервис | CPU avg | CPU peak | Memory avg | Memory peak |
|--------|---------|----------|------------|-------------|
| `api` | 3.3% | **100%** | 26.1% | 68.3% |
| `archive-service` | 1.9% | 34.7% | 7.4% | 7.9% |
| `broadcast-service` | 12.4% | **100%** | 14.5% | 26.7% |
| `game-service` | 0.5% | 54.9% | 17.3% | 18.3% |
| `prerender-service` | 40.5% | **100%** | 30.6% | 81.0% (1 день) |

**Ключевые выводы из утилизации:**
- 🟢 `archive-service`: avg 1.9%, peak 34.7% — overprovisioned даже на
  0.5 vCPU. Burst TWIC weekly **не выходит за пределы 0.5 vCPU** —
  опасения из раздела 2.4 о burst-душит-co-located снимаются по факту.
- 🟢 `game-service`: avg 0.5%, peak 54.9% — overprovisioned. Можно
  снизить с осторожностью (peak показывает, что нагрузки бывают).
- 🔴 `api`, `broadcast-service`, `prerender-service`: peak 100% —
  упираются в потолок, нельзя снижать. `broadcast` упирается чаще
  (avg 12.4% vs api 3.3%) — поллер.

**RDS layout — 2 instance, 3 БД:**

| Instance | Class | Allocated | Used (факт) | Growth/мес | Peak CPU | Peak conn | Databases |
|----------|-------|-----------|-------------|------------|----------|-----------|-----------|
| `kingside-db` | db.t3.micro | 20 GB | 6.44 GB | +0.62 GB | 8.8% | 19 | `kingside` (main) + `broadcasts_kingside` |
| `kingside-archive-db` | db.t3.micro | 20 GB | 8.08 GB | 0 (backfill окончен) | 32.0% | 14 | `archive_kingside` |

`api` и `broadcast-service` уже на одном RDS instance (разные БД, один
compute). По БД-стороне сценарий «api+broadcast» уже реализован — выигрыш
там был получен ранее. `archive-service` — отдельный RDS instance
($15.62/мес сам по себе).

**Перенос `archive_kingside` на `kingside-db` — db.t3.micro выдержит
(подтверждено devops):**
- Used после слияния: 14.52 GB / 20 GB allocated, free 5.48 GB,
  growth ~0.6 GB/мес → ~9 месяцев до 100%, потом storage можно
  увеличить на лету без даунтайма.
- Peak CPU суммарно: 8.8% + 32% ≈ 30-40% (с учётом частичной
  корреляции). На 2 vCPU — запас.
- Peak connections суммарно: 33. Default max на db.t3.micro = 87.
  Запас 2.5×.
- Upgrade класса до `db.t3.small` **НЕ требуется**.
- Полная экономия: $15.62 instance + $2 backup + $2.5 storage ≈
  **$20/мес RDS**.

**Cost breakdown — май 2026, $317.42 total:**

| % | $/мес | Сервис AWS |
|---|-------|------------|
| 29.3% | $92.88 | **ECS** |
| 17.4% | $55.11 | Tax |
| 12.9% | $40.89 | **RDS** |
| 10.2% | $32.54 | **CloudWatch** |
| 9.7% | $30.66 | **VPC (Public IPv4)** |
| 6.3% | $20.11 | ELB |
| 4.8% | $15.32 | EC2 |
| 4.5% | $14.14 | ElastiCache |
| 2.5% | $7.93 | S3 |
| 1.1% | $3.50 | ECR |

ECS — 29.3% бюджета, не «копейки». Агрессивная оптимизация имеет смысл.

**ECS sub-breakdown ($92.88/мес):**
- $74.97 — Fargate vCPU-hours
- $16.46 — Fargate GB-hours
- $1.43 — DataTransfer

Per-service breakdown через Cost Explorer недоступен — тег
`aws:ecs:serviceName` не активирован для billing (см. дыру в данных
ниже). Расчёт «вручную» по eu-central-1 ценам: 0.5 vCPU + 1 GB × 730 ч =
**$18/мес/сервис**, 5 сервисов = $90 — совпадает с фактическим $91.43
($74.97+$16.46) минус Data Transfer.

**Прочие крупные статьи:**
- VPC $30.66 — целиком IPv4 (5 public IP × $0.005/ч ≈ $18, плюс ALB IP
  и idle). Объединение убирает 2 публичных IP = **−$7.30/мес**.
- CloudWatch $32.54 — целиком `MetricMonitorUsage`. Custom metrics
  (Prometheus-style EMF из воркеров). Отдельная задача оптимизации, вне
  scope этого ADR, но крупная статья для пользователя.
- RDS $40.89: $31.25 — 2 × db.t3.micro hours. Если перенести
  `archive_kingside` на `kingside-db` (требует +10-20 GB storage,
  потенциально +1 instance class) — экономия **~$15/мес** на RDS.

**Дыра в данных:** per-service ECS cost через Cost Explorer требует
активации тега `aws:ecs:serviceName` в Cost Allocation Tags (1 клик +
24-48 ч backfill). Если пользователь склонится к сценарию А/Б1 — стоит
активировать для финального обоснования. Сейчас расчёты построены на
формуле (все 5 сервисов симметричны по конфигурации).

### 2.4. Природа нагрузки (важно для оценки изоляции)

- **`apps/api`**: интерактивные REST + WS, 9 cron'ов и интервалов
  (sm2 03:00 UTC, sitemap 03:00 UTC, tactic-drill-sprint EVERY_MINUTE,
  lecture-audio EVERY_10_MINUTES, live-analysis-cleanup EVERY_5_MINUTES,
  tactic-drill-incremental EVERY_HOUR, scaling-service, overload-guard,
  arena-scheduler). Пики — пользовательские (игровое время).
- **`apps/broadcast-service`**: 6 постоянных таймеров (sync-loop,
  pinned-poll, watchdog, game-count-metric, sitemap-cron). По природе —
  поллер. Постоянная фоновая загрузка CPU + сеть к Lichess. Rate-limit
  Lichess зашит в задержки. Пиков нет, нагрузка плоская.
- **`apps/archive-service`** (`start:importer`): 23 интервала/cron'а,
  основной — `@Interval(60_000)` tick по TWIC. **Bursty**: TWIC weekly
  release = ~7K партий за один tick, ~30 мин CPU-burn + RDS-write-burst.
  Между release'ами — почти idle.

Это критическое различие. archive-service в burst-режиме может душить
любой со-located сервис (CPU 100% всего task'а). broadcast-service —
устойчиво занят (плоская нагрузка). api — пиковая по UX.

---

## 3. Сценарии

### Сценарий А — Полное объединение в один монолит `apps/api`

Перенос модулей `broadcast-service` и `archive-service` обратно в
`apps/api`, удаление двух отдельных Dockerfile'ов и ECS-сервисов. Один
процесс, один task, одна или несколько Prisma-схем под одним
PrismaService-DI.

**Экономия:** убирает 2 task'а из 3 рассматриваемых. Грубо — `0.66 ×
суммарной стоимости трёх` (если они симметричны). Но не учитывает: для
объединённого монолита, скорее всего, придётся увеличить cpu/mem
(хостить burst archive + плоский broadcast + интерактивный api в одном
task'е). Реальная экономия — меньше арифметической.

**Технические риски:**
- 🔴 **Изоляция падений ломается полностью.** OOM из archive importer'а
  (TWIC × 7K партий + Prisma write-buffer) → весь api лёг → WS-соединения
  ломаются → лекции/турниры/живой анализ режут пользователей.
- 🔴 **CPU-burst archive душит REST.** archive в burst-режиме держит CPU
  >80% по 30 мин — REST-запросы api начинают копить latency, WS pings
  отваливаются.
- 🟡 **WS namespace `/` конфликт.** broadcast использует root namespace.
  Объединение → пере-namespace + фронт-правки + CloudFront-кэширование
  под старый URL.
- 🟡 **Deploy-rolling restart влияет на всё.** Раньше: фикс архивного
  импортёра → перезагрузка только archive-task'а (broadcast и api живут).
  После: любой коммит в кодовую базу → graceful-restart api → обрыв WS
  у всех (`socket.io` reconnect ~3-5 сек, но всё равно UX-jitter).
- 🟡 **Масштабирование.** Сейчас при росте archive можно горизонтально
  растянуть только archive (1 → 2 task'а), api оставить. После: можно
  горизонтально только всё вместе. Растягивать api ради archive-burst
  дорого (api-инстансы — самые тяжёлые, держат WS-state).
- 🟢 **Связность кода.** api → archive/broadcast HTTP-вызовы исчезают,
  заменяются direct service-вызовами. Минус один сетевой hop, минус
  таймауты, минус токен-auth `BROADCAST_SERVICE_URL`.
- 🟡 **Поддомены `archive.kingside.site` / `broadcasts.kingside.site`.**
  Нужно переключить ALB на один target group + path-based routing, либо
  CNAME поддомены на `api.kingside.site`. Сами URL фронт-контракта
  ломать нельзя (SEO, индексация). Это deploy-effort, не блокер.

**Архитектурный долг:** разделить обратно стоит дороже, чем не разделять
изначально (миграции БД, разделение Prisma-схем под раздельные модули,
выделение `BroadcastModule` + `ArchiveModule` как stand-alone). Откат
сценария А — болезненный.

### Сценарий Б — Частичное объединение (две из трёх)

Три подварианта:

**Б1 — api + broadcast, archive отдельно:**
- broadcast — плоская предсказуемая нагрузка, не burst → меньше душит api.
- WS-namespace конфликт сохраняется (тот же риск 🔴/🟡 что в А).
- Изоляция от archive-burst сохраняется (главный operational risk
  убран).
- Экономия — ~1 task из 3 (умеренная, ~$15-30/мес ориентировочно).

**Б2 — api + archive, broadcast отдельно:**
- archive-burst в api — главный риск (🔴 как в А).
- broadcast WS namespace conflict исчезает.
- Не рекомендуется — берёт худший риск (burst), отказывается от
  главного бенефита (WS-связность с broadcast тоже была бы естественной).

**Б3 — broadcast + archive, api отдельно:**
- Странная пара: разные природы нагрузок (плоская vs burst), разные
  поддомены, разные WS-контракты, разные БД.
- Объединение даёт почти ничего: оба сервиса небольшие, экономия ~
  одного task'а.
- Не рекомендуется.

### Сценарий В — Оставить как есть, оптимизировать конфигурации

Не объединять. Пройтись по cpu/memory всех 7 сервисов, посмотреть
реальную утилизацию из CloudWatch, спустить overprovisioned task'и до
минимума (как KS-4202 сделала с prerender 1 → 0.5 vCPU).

Дополнительно:
- Включить autoscaling на api/broadcast/archive (если ещё не включён) —
  desiredCount по CPUUtilization, scale-to-zero где это возможно
  (archive — нет, broadcast — нет; api — нет, всегда нужен ≥1).
- Перевести `archive-service` `start:importer` (постоянный) → больше
  использовать `start:importer-once` через EventBridge (ADR-020), если
  частоту TWIC можно довести до cron'ового интервала. **Если archive
  постоянный сервис не нужен для HTTP API** — это даёт экономию ~1 task.
  Но HTTP API archive используется api (`/games/by-position` через
  opening-trainer) — нужен always-on minimum 1 task для HTTP.

**Экономия:** меньше А/Б по compute, но **не влечёт архитектурных
рисков**. Реалистично сокращение на 20-40% от каждого
overprovisioned task'а.

**Технические риски:** минимальные. Главный — autoscaling может
«thrash» (scale-up/down петля) если плохо подобраны метрики.

### Сценарий Г — Multi-module same-image (один Docker-образ, разные ECS-task'и)

Один Dockerfile собирает все три сервиса (`apps/api/dist`,
`apps/broadcast-service/dist`, `apps/archive-service/dist` в одном
образе). В ECS задаются три task-definition с разными `command` /
`ENTRYPOINT` (по env-var `SERVICE_NAME` или просто разный
`node dist/<app>/main.js`).

Это уже частично сделано: KS-1897 описывает три task-def family на один
archive-образ. Расширение паттерна на api + broadcast + archive
технически возможно.

**Экономия:** **минимальная по compute.** Task'ов остаётся три, ресурсы
не складываются. Экономия — только:
- ECR storage (один образ вместо трёх — копейки, единицы $/мес).
- Build CI time (одна сборка вместо трёх — 3-5 минут на PR — больше
  ценность для DX, чем для $).
- Deploy-pipeline проще (один build → три rolling-update).

**Технические риски:**
- 🟢 Изоляция падений сохраняется (разные task'и).
- 🟢 WS-namespace конфликта нет.
- 🟡 Размер образа растёт (все три node_modules + dist в одном). Холодный
  start ECS-task'а медленнее (pull большего образа из ECR).
- 🟡 «Один dist на всех» — изменение в archive триггерит pull/restart
  всех трёх task'ов (потому что digest образа меняется). Это не
  изоляция деплоя — это изоляция падений во время работы. Чтобы
  получить изоляцию деплоя, нужно три отдельных build'а — что
  отменяет смысл сценария.

**Это не оптимизация compute-стоимости, это оптимизация DX/CI.** Если
проблема — пайплайн, сценарий Г подходит. Если проблема — Fargate-счёт,
он этого не решает.

---

## 4. Сравнительная таблица (с фактическими цифрами)

| Критерий | (А) полное | (Б1) api+broadcast | (В) optimize-as-is | (Г) one-image |
|----------|-----------|--------------------|--------------------|----------------|
| Экономия ECS | ~$18/мес | ~$9/мес | ~$14/мес (archive 0.5→0.25, game 0.5→0.375) | ~$0 |
| Экономия Public IPv4 | +$7.30 (−2 IP) | +$3.65 (−1 IP) | $0 | $0 |
| Экономия RDS (перенос archive_kingside → kingside-db) | +$20 | $0 | $0 (или $20 параллельно, не зависит от А/Б/В) | $0 |
| **Итоговая экономия / % бюджета** | **~$45/мес ≈ 14%** | **~$13/мес ≈ 4%** | **~$14/мес ≈ 4.4%** (или $34/мес ≈ 11% с RDS) | **$0 / 0%** |
| Доп. экономия от отключения Container Insights | +$25-30/мес — **не зависит от выбора**, см. §7 |||||
| **Итог с Container Insights** | **~$70-75/мес ≈ 22-24%** | **~$40/мес ≈ 13%** | **~$60/мес ≈ 19%** | **~$25-30/мес ≈ 8-9%** |
| Риск изоляции падений | 🟡 средний (archive peak 34.7% — не критичный; api/broadcast/prerender peak 100% — будут душить друг друга) | 🟡 средний (api+broadcast оба peak 100%) | 🟢 нулевой | 🟢 нулевой |
| WS-namespace `/` конфликт | 🟡 ломает контракт KS-1702 | 🟡 то же | 🟢 нет | 🟢 нет |
| Deploy-rolling impact | 🔴 любой коммит → restart всего | 🟡 deploy api ≠ deploy archive | 🟢 нет изменений | 🟡 один digest → restart всех |
| Скорость масштабирования | 🔴 нельзя растянуть отдельно | 🟡 archive отдельно | 🟢 как сейчас | 🟢 как сейчас |
| Сложность отката | 🔴 высокая (Prisma schemas split) | 🟡 средняя | 🟢 нулевая | 🟡 переделать Dockerfile |
| Effort на реализацию | 🔴 2-4 недели backend + миграции | 🟡 1-2 недели | 🟢 1-3 дня devops | 🟡 3-5 дней devops |

---

## 5. Рекомендация

🎯 **Сценарий В (optimize-as-is) обязательно как первый шаг + параллельно
отключить Container Insights + параллельно перенести `archive_kingside`
на `kingside-db` — даёт ~$60/мес ≈ 19% бюджета без архитектурного риска.**

**Сценарий А — открытый вопрос для пользователя:** даёт ~$70-75/мес
(22-24% с Container Insights) ценой операционных рисков. **Сценарий Б1
— не рекомендуется** (экономия $13/мес не оправдывает конфликт
WS-namespace). **Сценарий Г — отдельная DX-задача**, не отвечает на
cost-вопрос.

### Обоснование

1. **Сценарий В — нулевой риск, ~$14/мес экономии:**
   - `archive-service`: avg 1.9% / peak 34.7% — overprovisioned. Снизить
     0.5 → 0.25 vCPU = экономия ~$7/мес. Burst TWIC weekly укладывается
     (peak 34.7% на 0.5 vCPU = ~17% на 0.25 vCPU после нормализации —
     с запасом до 100%).
   - `game-service`: avg 0.5% / peak 54.9% — overprovisioned, но с
     осторожностью (peak бывает). Снизить 0.5 → 0.375 vCPU безопаснее,
     чем до 0.25. Экономия ~$3-7/мес.
   - `api`, `broadcast-service`, `prerender-service`: peak 100% — НЕ
     снижать. broadcast (avg 12.4%) — кандидат на увеличение, если
     throttle бьёт UX.
   - **Параллельно:** перенести `archive_kingside` → `kingside-db`,
     остановить `kingside-archive-db` — экономия **~$15/мес на RDS**,
     не зависит от выбора по ECS. Это «бесплатные деньги».

   Итог сценария В + RDS-консолидация = **~$29/мес ≈ 9% бюджета без
   архитектурного риска**.

2. **Сценарий А — да или нет, решает пользователь.** Новые данные
   меняют картину vs первоначальный анализ:
   - 🟢 archive-burst оказался **не страшным** (peak 34.7%, не 100%).
     Опасение «archive душит api» по факту не подтверждается.
   - 🔴 Но `api` и `broadcast` оба peak 100% независимо друг от друга.
     В одном task'е они **точно будут конкурировать за CPU под пиковой
     нагрузкой**. Под нагрузкой одного UX другого деградирует.
   - 🟡 WS namespace `/` конфликт остаётся.
   - 💰 Экономия **до $40/мес (12.6% бюджета)** с учётом RDS — это уже
     ощутимо.

   **Если пользователь готов принять архитектурный долг (effort 2-4
   недели, риск UX-jitter при пиковых нагрузках, сложный откат) ради
   $40/мес** — сценарий А возможен. Если первичный приоритет —
   стабильность и низкие риски, не А.

3. **Сценарий Б1 (api + broadcast)** — экономия $12/мес против всех тех
   же рисков WS-конфликта + конкуренции за CPU (оба peak 100%). Не
   стоит компромисса. Лучше В + потом, если нужно, А.

4. **Сценарий Г** — отвечает на DX-проблему («три сборки в CI»), не на
   cost-проблему. Если CI-длительность проблема — отдельный ADR. К
   текущему вопросу не относится.

### Что ещё стоит посмотреть параллельно (не в scope этого ADR, но крупные статьи)

- **CloudWatch $32.54/мес (10.2%)** — `MetricMonitorUsage` через
  Prometheus-style EMF из воркеров. Аудит платных metric'ов может дать
  ещё $10-20/мес без потери observability.
- **VPC IPv4 $30.66/мес (9.7%)** — 5 public IP. Перевод сервисов в
  private subnet + один NAT — арифметически сомнительно (NAT Gateway
  $35-40/мес), но если ALB-only egress — может быть выгоднее. Требует
  отдельного расчёта.
- **Активация тега `aws:ecs:serviceName`** для Cost Allocation —
  позволит точно подтвердить per-service экономию перед/после
  изменений. 1 клик в Billing Console + 24-48 ч backfill. Сделать в
  любом случае.

---

## 6. Декомпозиция

### Если выбран сценарий В (рекомендуемый минимум)

1. **devops (уже сделано в KS-4237):** активирован Cost Allocation Tag
   `Service` + включён `enableECSManagedTags=true`,
   `propagateTags=SERVICE`. Через 24-48 ч после появления тегов в
   billing-индексе активировать `Service` и `aws:ecs:serviceName` в
   Cost Explorer → per-service breakdown как baseline для замера
   экономии. (devops пингнёт цифрами; architect обновит §2.3 ADR.)
2. **devops:** снизить `archive-service` 0.5 vCPU → 0.25 vCPU + 0.5 GB.
   Мониторить 1 неделю: TWIC weekly burst укладывается. Откат — если
   peak >85% устойчиво. Экономия ~$7/мес.
3. **devops:** снизить `game-service` 0.5 vCPU → 0.375 vCPU.
   Осторожно (peak 54.9% бывает). Мониторить. Экономия ~$3-5/мес.
4. **devops:** отключить Container Insights на кластере `kingside`:
   `aws ecs update-cluster-settings --cluster kingside --settings
   name=containerInsights,value=disabled`. Service-уровневые метрики
   `AWS/ECS` (CPUUtilization, MemoryUtilization) сохраняются —
   пропадут только per-container Network/Storage. Экономия
   **~$25-30/мес**. Если в будущем нужны per-container метрики —
   AWS Distro for OpenTelemetry → собственный Prometheus.
5. **backend (миграция БД) + devops (RDS):** перенести
   `archive_kingside` с `kingside-archive-db` на `kingside-db`
   (отдельная database на том же RDS instance). Этапы:
   - `pg_dump` archive_kingside + `pg_restore` на `kingside-db`.
   - Изменить `DATABASE_URL` для `@kingside/archive-db` на
     `kingside-db.../archive_kingside`.
   - Storage `kingside-db` — текущие 20 GB хватает (used после
     слияния 14.52 GB, growth 0.6 GB/мес = ~9 месяцев до 100%).
     Через год — `modify-db-instance --allocated-storage 30` без
     даунтайма.
   - После 1 недели мониторинга — остановить `kingside-archive-db`
     instance. Экономия **~$20/мес RDS** (instance + backup +
     storage минус прирост на основном).
6. **architect:** обновить этот ADR результатами шагов 1-5,
   перевести Proposed → Accepted, добавить факт-замеры до/после.

**Итог сценария В целиком: ~$60/мес ≈ 19% бюджета без архитектурного
риска.**

Если позже выбирается Г как DX-улучшение — отдельный ADR.

### Если выбран сценарий А (по решению пользователя)

После шагов 1-2 из В выше (baseline + измерение):

1. **architect:** ADR обновить решением о слиянии. Решить судьбу WS
   namespace `/` broadcast'а — переименовать в `/broadcasts` (+ фронт
   правки + CloudFront-кэш сброс) или сохранить через path-routing на
   ALB.
2. **backend:** перенести `apps/broadcast-service/src/*` в
   `apps/api/src/broadcast/*` как модуль. PrismaService либо общий
   (после миграции schema объединены), либо два экземпляра под разные
   DATABASE_URL.
3. **backend:** перенести `apps/archive-service/src/*` (HTTP-часть)
   как модуль `apps/api/src/archive/*`. `start:importer` остаётся
   отдельным процессом (EventBridge `importer-once` уже работает по
   ADR-020 — это не сервис, не идёт в счёт).
4. **devops:** обновить ECS task-definition api на 1 vCPU + 2 GB
   (под объединённую нагрузку), удалить task-definition broadcast +
   archive. Переключить ALB-правила: `broadcasts.kingside.site` и
   `archive.kingside.site` → CNAME на ALB api, path-prefix routing.
5. **backend + frontend:** удалить env-переменные
   `BROADCAST_SERVICE_URL`, `ARCHIVE_SERVICE_URL`, заменить
   HTTP-proxy на in-process service-вызовы (`opening-trainer`,
   `admin/reindex-broadcasts`, `guess.service`).
6. **architect:** ADR-021 и ADR-018 пометить Superseded ссылкой на
   этот ADR.

Effort: backend 2-4 недели + devops 1 неделя + frontend ≤1 неделя.

**Итог сценария А целиком (с Container Insights и RDS-консолидацией):
~$70-75/мес ≈ 22-24% бюджета.**

---

## 7. Открытые вопросы / не в scope

- **NAT Gateway** — не используется (все сервисы в public subnet с
  публичными IP, egress через IGW). Объединение не даёт экономии на
  NAT, но даёт **−$7.30/мес** на 2 публичных IPv4.
- **prerender-service** — отдельная история (Chromium, KS-4194). Avg
  CPU 40.5% / peak 100% — он реально нагружен, объединять с api не
  стоит. Вне scope.
- **`apps/archive-importer` / `apps/broadcast-worker`** — пустые папки
  (свёрнуты по ADR-022, KS-1676). Техдолг, нужно зачистить уборкой
  (вне scope этого ADR).
- **CloudWatch $32.54/мес — корень найден (devops, KS-4237):**
  на кластере `kingside` включён Container Insights, генерирует ~228
  custom-метрик (по 5-7 на task/service: CPU/Memory/Network/Storage).
  Отключение через `aws ecs update-cluster-settings --cluster kingside
  --settings name=containerInsights,value=disabled` даёт **~$25-30/мес
  экономии**. Service-уровневые метрики `AWS/ECS` (CPUUtilization,
  MemoryUtilization) остаются — пропадают только per-container
  Network/Storage. Это **отдельный шаг параллельно любому сценарию**
  (В/А) — экономия не зависит от выбора по ECS. Оформляется как часть
  декомпозиции, см. §6.
- **`synthetic-bot-service`** — уже отсутствует как сервис (поправка
  по факту от devops).

---

## 8. Статус и следующие шаги

Этот ADR — **Proposed**. Решение по сценарию (В минимум, опционально
А) — за пользователем. После решения:
- Если В — переводится в Accepted, запускается декомпозиция §6.
- Если А — переводится в Accepted с обновлением §5 и §6, ADR-021 и
  ADR-018 помечаются Superseded.
- Если «оставить как есть» — переводится в Rejected с комментарием.
