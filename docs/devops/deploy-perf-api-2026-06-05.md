# Профиль развёртывания api — 2026-06-05

Связано: KS-3701 (родительская задача), KS-3060 (профиль ECR pull), KS-3061 (VPC PrivateLink, backlog), KS-3012 (auto-migrate, backlog).

## Контекст

Пользователь сообщает: развёртывание `api` занимает до 10 минут. Профилирование от вызова `deploy({scope:"api"})` до steady state с разбивкой по этапам, оценка узких мест и план сокращения без дополнительной стоимости.

## Сводная таблица этапов (контрольный прогон 2026-06-05 15:27 UTC)

Источник — perf-summary из MCP-тула `deploy({scope:"api"})`, raw trace: `/home/pivovartsev/work/kingside/logs/deploy-perf-20260605-152757-122475.log` (на хосте).

| этап | длительность | % от общего |
|---|---|---|
| `00_init → 01_pre_git_sync` | 0.00 с | — |
| `01_pre_git_sync → 02_post_git_sync` | 0.00 с | — |
| `02_post_git_sync → api_start` | 0.01 с | — |
| `api_start → api_ecr_login_done` | 0.79 с | 0.3% |
| `api_ecr_login_done → api_docker_build_done` | **1.34 с** | 0.5% |
| `api_docker_build_done → api_docker_push_done` | **0.86 с** | 0.3% |
| `api_docker_push_done → api_taskdef_done` | 1.21 с | 0.4% |
| `api_taskdef_done → api_migrate_done` | **83.90 с** | **30.6%** |
| `api_migrate_done → api_update_service_done` | 0.99 с | 0.4% |
| `api_update_service_done → api_services_stable_done` | **182.94 с** | **66.7%** |
| `api_services_stable_done → api_atomic_latest_done` | 2.34 с | 0.9% |
| `api_atomic_latest_done → 99_deploy_complete` | 0.00 с | — |
| **TOTAL** | **274.39 с (4:34)** | 100% |

## Что показывает контрольный замер

Прогон сделан на коммите `1ff046e4` без изменений кода (rebuild того же образа). Build+push заняли суммарно ~2.2 с — все слои уже были в локальном кеше Docker и в ECR (`Layer already exists`). Это правый край распределения «быстрый деплой».

В этом сценарии узкие места:
1. **ECS rollout до steady state — 183 с (67%)** — Fargate scheduling + ECR pull + старт контейнера + переключение трафика + draining старой задачи.
2. **Prisma migrate deploy — 84 с (31%)** — запускается на каждом деплое (KS-3474 убрал skip).

Build/push в этом замере не критичны — но это потому что не было реальных изменений.

## Слепая зона: что произойдёт при большой пересборке

Замер на «no-op» коммите не показывает реального времени `docker build` и `docker push` при изменении тяжёлых слоёв (например, обновление `package.json` → пересборка `RUN npm ci`). MCP-тул `deploy` выводит build/push единой меткой без разбивки по стадиям/слоям Dockerfile.

Что **известно** косвенно:
- Образ 710.9 МБ (см. ниже разбор слоёв), из них «горячий» слой `npm ci` ~351 МБ, `RUN apt-get install` ~125 МБ, `RUN pip3 install` ~117 МБ.
- При изменении только исходников api меняется верхний COPY-слой ±10 КБ (replays в ECR подтверждают), push занимает секунды.
- При изменении `package.json` пересобирается весь стек: build с нуля включая `npm ci` (на сборочной стадии ~250–400 МБ) + tsc + повторный `npm prune --omit=dev`. По ощущениям — десятки секунд до минут.
- При изменении `apt-get install` или `pip install` (редко, при правке Dockerfile) — пересборка всего основания, минуты.

**Нет инструментирования** на разбивку:
- Длительность каждой стадии multi-stage Dockerfile (build, production).
- Длительность каждого `RUN` / `COPY` шага.
- Длительность push каждого слоя отдельно.

Подтикет на добавление инструментирования — см. в конце документа.

## Разбор образа api (710.9 МБ)

### Параметры образа (тег `def28bb4`, активная ревизия на момент анализа)

| тег | размер | pushed |
|---|---|---|
| `def28bb4` (latest) | 710.9 МБ | 2026-06-05 10:09 |
| `9f029249` | 710.9 МБ | 09:34 |
| `16586680` | 710.9 МБ | 09:20 |
| `aeb8edc9` | 710.9 МБ | вчера 18:49 |

Размер от выкатки к выкатке колеблется в пределах ±10 КБ.

### Карта слоёв и команд Dockerfile

| # | размер | команда / источник |
|---|---|---|
| 1 | 29.2 МБ | `FROM node:20-slim` — Debian rootfs |
| 2 | 3.3 КБ | техслой `node:20-slim` |
| 3 | 41.4 МБ | `FROM node:20-slim` — Node.js runtime |
| 4 | 1.7 МБ | техслой |
| 5 | 447 Б | техслой |
| 6 | **124.8 МБ** | `RUN apt-get install openssl python3 python3-pip python3-venv libgl1 libglib2.0-0 libsm6 libxext6 awscli` |
| 7 | 92 Б | `WORKDIR /app` |
| 8 | 32 Б | `WORKDIR /app` |
| 9 | 1.7 МБ | `COPY --from=build /app/apps/api/dist` |
| 10 | 3.5 МБ | `COPY --from=build /app/apps/api/data` |
| 11 | **350.8 МБ** | `COPY --from=build /app/node_modules` |
| 12 | 0.4 МБ | `COPY --from=build /app/packages/shared` |
| 13 | 37.3 МБ | `COPY --from=build /app/packages/db` |
| 14 | 3.4 МБ | `COPY --from=build /app/packages/board-image-to-fen` |
| 15 | 440 Б | `COPY --from=build /app/apps/api/prisma.config.ts` |
| 16 | 1.2 КБ | `COPY apps/api/package.json` |
| 17 | **116.6 МБ** | `RUN pip3 install numpy + Pillow + opencv-python-headless + onnxruntime` |
| 18 | 76 КБ | `COPY apps/api/certs` |
| 19–21 | ~600 Б | `RUN rm -rf ... ln -s ...` × 3 (симлинки `@kingside/*`) |
| 22 | 32 Б | `WORKDIR /app/apps/api` |
| 23–24 | ~5 КБ | `COPY docker-entrypoint.sh` + `RUN chmod +x` |

**Три самых крупных слоя дают ~80% образа** (592.2 МБ из 710.9):
- `COPY node_modules` (#11) — 350.8 МБ (47%).
- `RUN apt-get install` (#6) — 124.8 МБ (17%).
- `RUN pip3 install` (#17) — 116.6 МБ (16%).

## ECS rollout (183 с) — детальная разбивка

По реальной выкатке `kingside-api:387` (task `be77695e`), завершилась 11:53 UTC.

| t (UTC) | dt | этап |
|---|---|---|
| 11:49:11 | 0:00 | RegisterTaskDefinition |
| 11:50:35 | +1:24 | UpdateService (deployment created) |
| 11:50:46 | +1:34 | has started 1 tasks |
| 11:50:51 | +1:39 | ENI connectivity |
| 11:50:57 | +1:45 | pullStarted |
| 11:51:30 | +2:19 | **pullStopped (pull 33.9 с)** |
| 11:51:40 | +2:28 | task RUNNING |
| 11:51:43 | +2:32 | **/health отвечает** |
| 11:52:09 | +2:57 | старая задача остановлена |
| 11:53:12 | +4:01 | **reached steady state** |

Ключевое:
- **ECR pull = 33.9 с** для 710.9 МБ → ~21 МБ/с через NAT Gateway (узкое место подтверждено KS-3060). VPC PrivateLink (KS-3061) даст прямое подключение к ECR без NAT.
- **Старт контейнера от entrypoint до /health = 12.3 с**, из них **7.3 с — три последовательных `aws s3 cp` моделей board-recognition** (60% старта).
- **Параллельная драйнировка старой задачи + steady state = ~1:30**.

### Параметры ECS-сервиса kingside-api

- `minimumHealthyPercent` = 100, `maximumPercent` = 200 — место для параллельной замены есть.
- `healthCheckGracePeriodSeconds` = 60.
- `desiredCount` = 1, CPU/Memory = 512/1024.
- Контейнерный health-check: `GET /health` на localhost:3001, interval 30, timeout 5, retries 3, startPeriod 60.

### Параметры целевой группы ALB kingside-api-tg

- `deregistration_delay.timeout_seconds` = **15** (дефолт 300 не стоит — это не источник 5-минутной задержки).
- `slow_start.duration_seconds` = 0.
- Health-check: `/health`, interval 5 с, timeout 2 с, healthy threshold 2 → минимум ~10 с от первого ответа до healthy.

**Вывод по rollout:** параметры ECS/ALB уже близки к оптимуму. Главные кандидаты на сокращение — pull (через размер образа и/или PrivateLink) и старт контейнера (через запекание моделей).

## Prisma migrate (84 с) — почему так долго

`api_taskdef_done → api_migrate_done` = 83.90 с. Скрипт `scripts/deploy-aws.sh` запускает `prisma migrate deploy` на каждый деплой (KS-3474 убрал skip-логику).

Что сюда уходит:
- Подъём временного контейнера с migrate (по логам — каждый раз заново тянется образ или запускается контейнер).
- Соединение с RDS (учитывая VPC, security group).
- Проверка `_prisma_migrations` и применение pending миграций (если нет — no-op, но overhead контейнера остаётся).

На задеплоенном коммите без изменений в `prisma/migrations` это **84 с overhead на пустом месте**. Это уже отслеживается в KS-3012 (автозапуск migrate из самого контейнера api на старте, без отдельного шага в деплое).

## План сокращения

### Уже заведённые подтикеты (без дополнительной стоимости)

| тикет | правка | оценка экономии | автор |
|---|---|---|---|
| **KS-3716** | Сузить `binaryTargets` в Prisma до одной цели (`debian-openssl-3.0.x`) | −30…−60 МБ образа, −1…−2 с pull | backend |
| **KS-3717** | Убрать `awscli` apt, заменить на `@aws-sdk/client-s3` в entrypoint | −80 МБ образа, −2…−3 с pull | backend |
| **KS-3718** | Ревизия `dependencies` в `apps/api/package.json`, перенести dev-only в `devDependencies` | −20…−80 МБ образа, −1…−3 с pull | backend |

**Итого по трём подтикетам:** −130…−220 МБ (с 710 МБ до 490–580 МБ), pull −4…−8 с, общий деплой −5…−10 с.

### Уже в backlog, требуют согласования стоимости/архитектуры

| тикет | правка | оценка экономии | блокер |
|---|---|---|---|
| KS-3061 | VPC PrivateLink endpoints в ECR | pull через локальную сеть, −15…−25 с | стоимость ~$48/мес |
| KS-3012 | Автозапуск `prisma migrate deploy` из контейнера на старте | −80…−84 с (целый этап migrate уходит) | согласовать стратегию multi-task (что если два контейнера стартуют параллельно) |

### Самый большой одиночный эффект (отдельный тикет, архитектура)

Перенос board-recognition из api в отдельный сервис по образцу KS-2433 (Stockfish). Уберёт из api:
- `RUN apt-get install ... libgl1 libglib2.0-0 libsm6 libxext6` (часть слоя #6, ~25 МБ).
- `RUN pip3 install onnxruntime opencv-python-headless numpy Pillow` (слой #17, 116.6 МБ).
- `COPY --from=build /app/packages/board-image-to-fen` (слой #14, 3.4 МБ).
- Энтрипоинт-скачивание моделей S3 (7.3 с старта).

Совокупно **~145 МБ образа и ~7 с старта** дополнительно. Требует ADR (архитектор) и согласования контракта между сервисами.

### Старт контейнера

- **Запекание моделей board-recog в образ при сборке** (модели версионируются через env, меняются редко). Если `BOARD_RECOG_MODEL_VERSION` совпадает с env — entrypoint пропускает скачивание. Экономия **~7 с старта при 99% запусков**, +24 МБ к образу. Не заводил отдельный тикет — становится бессмысленным после переноса board-recog в отдельный сервис.
- Параллельные `aws s3 cp` двух моделей (сейчас последовательно: 3.5 + 1.7 + 2.2 = 7.4 с; параллельно ~3.5 с). Экономия ~4 с. Аналогично — теряет смысл при выносе board-recog.

## Ожидаемый итог при реализации всех правок без дополнительной стоимости

Текущее (контрольный замер на «no-op» коммите): **274 с**.

| этап | сейчас | после KS-3716+3717+3718 | после KS-3012 (auto-migrate) |
|---|---|---|---|
| build+push | ~2 с (cache) | ~2 с | ~2 с |
| task-def + migrate | 85 с | 85 с | **~1 с** |
| rollout до steady state | 183 с | ~175 с (pull −5…−8 с) | ~175 с |
| прочее | ~5 с | ~5 с | ~5 с |
| **TOTAL** | **274 с** | **~267 с** | **~183 с** |

Реальный эффект пользователь увидит при «большом» деплое (пересборка тяжёлых слоёв) — там сейчас build+push занимают минуты, и сокращение размера образа дальше уменьшит push. Точный замер требует инструментирования внутри `docker build` (подтикет ниже).

## Подтикет на инструментирование build+push в скрипте деплоя

Сейчас в perf-summary `scripts/deploy-aws.sh` есть метки `api_ecr_login_done → api_docker_build_done` и `api_docker_build_done → api_docker_push_done` — это длительность целиком, без разбивки. При большом деплое мы не знаем, что внутри занимает больше всего — `RUN npm ci`, `RUN apt-get install`, `RUN pip3 install` или multi-stage COPY.

Тикет: KS-3719 (см. трекер).
