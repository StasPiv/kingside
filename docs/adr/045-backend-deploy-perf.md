# ADR-045 — Производительность деплоя backend-сервисов

- Статус: Proposed
- Дата: 2026-05-07
- Связанные задачи: KS-2475
- Связанные ADR: ADR-022 (broadcast-service merge), ADR-042 (tactic-worker), ADR-018 (archive-service)
- Авторы: architect (анализ), devops (фактические данные пайплайна)

---

## 1. Контекст и проблема

Жалоба: деплои backend-сервисов идут долго. На каждый hotfix теряется 5+ минут ожидания, итерации тормозят. Пайплайн нужно поджать.

Цель ADR — зафиксировать как устроен деплой сейчас, где основные узкие места, и составить декомпозицию работ с целевым бюджетом **≤90 секунд от вызова `deploy({scope: 'single-service'})` до health-check OK** на «warm»-сценарии (мелкая правка кода, без новых зависимостей и без миграций).

### Состав backend-сервисов под аудит

Пять сервисов в проде на AWS ECS Fargate:

| Сервис | Тип | ECR-образ (uncompressed) | Особенности |
|--------|-----|--------------------------|-------------|
| api | ECS Service (HTTP+WS, port 3001) | ~487 MB | `prisma migrate deploy` на старте контейнера |
| game-service | ECS Service (HTTP+WS, port 3002) | ~525 MB | Stockfish бинарь в образе |
| broadcast-service | ECS Service (HTTP+WS) | ~283 MB | Свой broadcasts-RDS |
| archive-service | ECS Service (HTTP) + EventBridge oneshot | ~284 MB | Свой archive-RDS, 3 task-def revision на одну выкладку |
| tactic-worker | RunTask-only (без ECS service) | ≈300 MB | Stockfish, EventBridge schedule (ADR-042) |

**broadcast-worker — НЕ существует** как отдельный сервис. Удалён в KS-1709 / ADR-022 (sync-цикл вынесен внутрь `broadcast-service`). Папки `apps/broadcast-worker/` нет в репо. В описании KS-2475 это устаревшее упоминание — в ADR не учитываем.

### Инфраструктура

- **Runtime**: AWS ECS **Fargate**, регион `eu-central-1`, cluster `kingside`. desiredCount=1 на сервис.
- **Registry**: AWS ECR private (`342946498289.dkr.ecr.eu-central-1.amazonaws.com/kingside-<svc>`).
- **Build host**: агентский контейнер (тот же хост, где webhook-server). Сборка происходит **на агенте**, не на CI и не на target.
- **Pipeline-скрипт**: единственный реально используемый — `scripts/deploy-aws.sh` (1102 LoC). Старые `deploy.sh / deploy-server-zero-downtime.sh / deploy-frontend.sh` — наследие Kamatera-эпохи, в проде сейчас не используются.
- **Триггер**: MCP-тул `deploy({scope})` → `bash scripts/deploy-aws.sh <scope>`.

---

## 2. Текущий пайплайн одного backend-сервиса

Шаги внутри одного блока deploy (пример api):

```
1. ensure_main_synced            git fetch + ff-only из origin/main
2. aws ecr get-login-password    | docker login
3. docker build -t kingside-<svc>:<sha> -f apps/<svc>/Dockerfile .
4. docker tag                    + retag под ECR
5. docker push <ECR>:<sha>
6. register-task-definition      jq-патч image, новая revision
7. aws ecs run-task              Fargate task для `prisma migrate deploy` (на api/archive)
8. aws ecs wait tasks-stopped    + проверка exitCode
9. aws ecs update-service        --task-definition <new-rev> --force-new-deployment
10. aws ecs wait services-stable rollout MAX 200 / MIN 100, дренирование старого task'а
11. ecr_move_latest_to_tag       atomic put-image :latest → :<sha>
```

`scope:'all'` (deploy-aws.sh:606) гоняет блоки **последовательно**: frontend → api → game-service → broadcast-service → archive-service → synthetic-bot → tactic-worker.

`auto`-режим (`detect_deploy_scope`, deploy-aws.sh:466) определяет scope по diff к `.deploy-commit-aws`. Изменения в `scripts/`, `infra/`, `justfile`, `packages/shared/*` триггерят `all`.

---

## 3. Baseline (текущие тайминги)

Точные инструментальные замеры по этапам **отсутствуют**. Цифры ниже — оценки devops по чтению пайплайна и косвенным данным (интервалы между ECR push'ами, BuildKit-логи). Пометка `[требует измерения]` — пункты, которые надо подтвердить в KS-2476 (см. §6).

### 3.1. Деплой одного сервиса (warm — мелкая правка кода)

| Этап | Текущее | Заметки |
|------|---------|---------|
| ensure_main_synced + ECR login | 5–10 с | стабильно |
| docker build (warm cache) | 30–90 с | большинство слоёв CACHED, пересобираются tsc + финальные COPY [требует измерения] |
| docker push (только новые слои) | 30–120 с | 283–525 MB образ; в реальности пушится только diff слоёв [требует измерения] |
| register-task-definition | 2–3 с | стабильно |
| migrate run-task (Fargate cold) | 60–90 с | **гонится даже при пустом diff миграций**; 30–45 с image pull + 10–30 с task lifecycle |
| update-service + services-stable | 90–180 с | **доминирующее звено**; новый task поднимается, health-check, дренирование старого |
| atomic put-image :latest | ~2 с | стабильно |
| **ИТОГО warm, single service** | **~4–6 мин** | для api ≈6–8 мин (двойной migrate цикл) |

### 3.2. Деплой одного сервиса (cold — после рестарта агентского контейнера, layer cache пуст)

| Этап | Текущее |
|------|---------|
| docker build (cold) | 5–10 мин (`npm ci` + `prisma generate` + `nest build`) |
| docker push (все слои) | 2–5 мин |
| Остальные этапы | как в §3.1 |
| **ИТОГО cold, single service** | **~10–15 мин** |

### 3.3. Деплой `scope:'all'` (5 backend-сервисов)

Последовательный прогон → суммарно **20–35 мин** при warm, **до часа** при cold. Распараллеливания нет.

### 3.4. Целевой бюджет

| Сценарий | Текущее | Цель |
|----------|---------|------|
| warm, single service | 4–6 мин | **≤90 с** |
| cold, single service | 10–15 мин | ≤4 мин |
| `all` (warm) | 20–35 мин | ≤4 мин |

Бюджет ≤90 с на warm single service — амбициозный, но достижимый при условии устранения двух доминирующих узких мест (skip миграций при пустом diff и сокращение services-stable rollout). См. §5.

---

## 4. Узкие места (с обоснованием)

### 4.1. Fargate run-task для миграций гонится всегда

`scripts/deploy-aws.sh` запускает `aws ecs run-task` для `prisma migrate deploy` независимо от того, есть ли pending-миграции. Cold Fargate task = ECR pull (487 MB образ) + lifecycle + 10–30 с фактического выполнения. Получается **60–90 с overhead на каждый деплой api/archive**, даже если миграций нет.

**Подтверждение**: чтение скрипта (devops). Skip-логики «нет diff в `packages/db/prisma/migrations` → пропустить run-task» НЕТ.

### 4.2. ECS services-stable rollout — самое тяжёлое звено

Стратегия Fargate MAX 200 / MIN 100 при desiredCount=1 означает: поднять второй task на новой revision, дождаться health-check, потом дренировать старый. В сумме 90–180 с на сервис, **последовательно** при `scope:'all'`.

Это структурная цена zero-downtime. Без compromise по downtime сократить можно только через:
- Уменьшение image pull time (registry locality / меньший образ).
- Меньшие health-check grace + interval.
- ALB deregistration delay снизить (если используется TG для http-сервисов).

### 4.3. Нет remote build cache

- `DOCKER_BUILDKIT` неявно включён (docker 23+), но `--cache-from <ECR>:cache` НЕ используется.
- `buildx` не используется.
- Кеш живёт **только в локальном docker layer cache агентского хоста**. Пересоздание агентского контейнера = cold build по всем сервисам.
- turbo.json минимальный (`outputs: ["dist/**"]`), нет `inputs`, нет `remoteCache`.

### 4.4. `scope:'all'` строго последовательный

Build, push, update-service для разных сервисов **независимы** и могли бы выполняться параллельно. Скрипт прогоняет блоки в for-loop. Потенциал ×3–4 ускорения для общего pipeline'а.

### 4.5. `packages/shared/*` триггерит `all`

`detect_deploy_scope` помечает изменения в shared как «затрагивают всё» → деплоятся все 5 сервисов. Часто избыточно (например, добавили тип, который реально использует только api).

### 4.6. Один lock-file на монорепо инвалидирует все образы

Все Dockerfile копируют `package-lock.json` корня. Любая правка зависимостей в любом сервисе валит слой `npm ci` во всех остальных образах. Из-за `--ignore-scripts` это не катастрофа, но в cold-сценарии каждый сервис заново тянет deps.

### 4.7. api/tactic-worker делают `node @prisma/engines/scripts/postinstall.js` руками

После `npm ci --ignore-scripts` приходится отдельным RUN-слоем тянуть schema-engine binary. На warm cache CACHED, но добавляет cold-time и ~50 MB к слою.

### 4.8. api: `npx prisma migrate deploy` в docker-entrypoint.sh при каждом старте контейнера

`apps/api/docker-entrypoint.sh` всегда запускает `npx prisma migrate deploy` перед `node dist/main.js`. Это ДУБЛИРУЕТ §4.1 (миграции уже применены через `aws ecs run-task` на шаге 7). Получается миграция гонится дважды на каждый деплой api: один раз pre-rollout, второй раз на старте контейнера.

При пустом diff миграций повторный вызов почти бесплатен (Prisma проверяет `_prisma_migrations` и выходит), но всё равно добавляет 1–3 с к старту каждого нового task'а — а это часть health-check grace.

### 4.9. Per-service tsc собирает packages/shared/db с нуля

В каждом Dockerfile стейдже build:
```
npx tsc --build packages/shared
cd packages/db && npm run build  # prisma generate + tsc
cd apps/<svc> && npx nest build
```

Нет TS project references поверх монорепо. Каждый из 5 образов независимо компилирует одну и ту же `packages/shared` (при cold). На warm — CACHED, но это работает только пока локальный layer cache жив.

### 4.10. ECR push 283–525 MB

Размеры образов крупные:
- api 487 MB — `node_modules` (включая dev и Nest CLI), prisma engines, schema-engine.
- game-service 525 MB — то же + Stockfish бинарь (~30 MB).

Большая часть веса — `node_modules`. Pruning не делается. Multi-stage финальный stage копирует **полный** `node_modules` из build-stage:

```dockerfile
COPY --from=build /app/node_modules ./node_modules
```

То есть в проде живут все devDependencies (`@nestjs/cli`, `@nestjs/schematics`, jest, ts-jest, supertest, ts-node-dev, и т.д. — это десятки MB).

---

## 5. Предлагаемые меры

Меры разбиты по эффекту и сложности. В скобках — оценка ожидаемого выигрыша на warm single-service deploy.

### 5.1. Skip migrate run-task при пустом diff миграций  ⭐ (-60–90 с)

**Что**: перед `aws ecs run-task` в deploy-aws.sh проверять, есть ли pending-миграции. Алгоритм:

1. `git diff <last-deployed-sha>..HEAD -- packages/db/prisma/migrations` → если пусто, пропускаем шаг 7 целиком.
2. Альтернатива (надёжнее): отдельный read-only Fargate run-task `prisma migrate status` → парсим вывод; если `Database schema is up to date` → skip apply-task.

`<last-deployed-sha>` уже отслеживается как `.deploy-commit-aws` в `detect_deploy_scope` — переиспользуем.

**Покрывает узкие места**: 4.1, 4.8.

**Риск**: если в коде образа есть изменение `migrations/`, но `last-deployed-sha` отсутствует или невалиден → fallback на текущее поведение (запускаем run-task). Безопасный default.

### 5.2. ECR registry cache для docker build  (-cold-build на 60–80%)

**Что**: использовать `docker buildx` с `--cache-from type=registry,ref=<ECR>:buildcache` и `--cache-to type=registry,ref=<ECR>:buildcache,mode=max`. ECR поддерживает.

Эффект: cold build на новом агентском хосте перестаёт быть «с нуля» — слои `npm ci` и `tsc/nest build` поднимаются из registry cache.

Не помогает на warm (там и так локальный layer cache работает). Ценность — устойчивость к рестартам агента и переезду между хостами.

**Покрывает**: 4.3.

### 5.3. Параллелизация `scope:'all'`  (-50–70% на all-deploy)

**Что**: build и push разных сервисов можно гонять параллельно, ECS update-service вызовы — тоже. В bash проще всего через `xargs -P` или GNU parallel:

```bash
echo "$services" | xargs -n1 -P3 -I{} bash -c 'deploy_one_service {}'
```

Параллелизм 3 — компромисс: docker build на одном хосте всё равно конкурирует за CPU/IO. На агентском контейнере (4 vCPU?) — ставить 2–3.

**Покрывает**: 4.4.

**Риск**: log interleaving, поэтому каждый блок пишет в отдельный файл `/project/logs/deploy-<svc>-<sha>.log`, в stdout summary в конце.

### 5.4. Health-check + deployment configuration tuning  (-30–60 с на single rollout)

**Что**: в task-def укажем
- `healthCheck.startPeriod: 10` (сейчас, вероятно, default 120) — у нас Nest стартует за 3–5 с.
- `healthCheck.interval: 5` (default 30).
- `healthCheck.retries: 2` (default 3).
- ALB target group `deregistrationDelay: 10` (default 300).

Это безопасно для stateless API/game-service. Для broadcast-service с активными WS-соединениями `deregistrationDelay` нужно подбирать осторожно — обсудить отдельно.

**Покрывает**: 4.2 (частично).

### 5.5. Prune devDependencies в production stage  (-100–200 MB на образ → faster ECR pull)

**Что**: в production stage Dockerfile перед `COPY --from=build node_modules` сделать prune:

```dockerfile
FROM build AS prune
RUN npm prune --omit=dev
FROM base AS production
COPY --from=prune /app/node_modules ./node_modules
```

`@nestjs/cli`, jest, ts-jest, supertest, ts-node-dev, eslint — всё это весит десятки MB и не нужно в проде. Prisma CLI нужен в api (для `migrate deploy` в entrypoint) — оставляем явно через `--include @prisma/client prisma`.

Эффект: меньшее image size → быстрее ECR pull в Fargate (3.1 §migrate run-task и rollout).

**Покрывает**: 4.10.

**Риск**: api использует `npx prisma migrate deploy` в entrypoint — `prisma` CLI ОБЯЗАН остаться в проде. Проверить, что `npm prune` не выкидывает.

### 5.6. Убрать `npx prisma migrate deploy` из api docker-entrypoint  (-1–3 с на старте контейнера)

**Что**: миграции уже применяются через `aws ecs run-task` (шаг 7). Дублирующий вызов в entrypoint удалить — `exec node dist/main.js` напрямую.

После §5.1 (skip при пустом diff) этот шаг становится явно осмысленным: миграции применяются ровно один раз, через preview run-task.

**Покрывает**: 4.8.

**Риск**: если в локальной разработке через docker-compose api полагается на этот шаг — нужно отдельно прокинуть migrate в локальный сценарий (compose-override).

### 5.7. Уменьшить scope-инвалидацию `packages/shared`  (структурный)

**Что**: в `detect_deploy_scope` различать «изменения в типах/контрактах» (триггерит всё) и «изменения только в локальных утилитах конкретного контекста» (триггерит подмножество). На практике сложно автоматически — проще вручную:

- Развести `packages/shared` на `packages/shared-api`, `packages/shared-game` и т.д. По месту использования. **Большая работа**, не для этой итерации.
- Или: оставить как есть, но позволить deploy-aws.sh принимать `--force-scope=api,game-service`, чтобы пользователь мог сузить вручную.

**Покрывает**: 4.5. 

**Решение**: на эту итерацию НЕ берём, фиксируем как known-issue. Возврат к вопросу — после §5.1–5.5 (если бюджет ≤90 с уложился в shared-кейс — проблема не критична).

### 5.8. Turbo remote cache (S3 backend)  (-warm-build до ×3)

**Что**: настроить `@turbo/remote-cache-s3` или self-hosted Vercel turbo-remote-cache на S3 bucket. Тогда `turbo run build` сможет выдать cached output если `inputs` совпадают с предыдущим билдом.

**Заметка**: на нашем pipeline это даст эффект только если докер build использует `turbo` для `nest build`, а не вызывает `npx tsc --build` / `npx nest build` напрямую. Сейчас Dockerfile'ы вызывают напрямую — turbo cache не подключён к docker build. Чтобы получить выгоду, нужно:

1. Перевести build-stage в Dockerfile на `turbo run build --filter=@kingside/<svc>...`
2. Прокинуть TURBO_TOKEN/TURBO_TEAM/TURBO_API через `--secret` в docker build.

Существенная работа. **На эту итерацию НЕ берём.** ECR registry cache (§5.2) даст похожий эффект быстрее.

### 5.9. Pre-build на CI (GitHub Actions) вместо агентского хоста  (структурный)

**Что**: build+push образов вынести в GitHub Actions (бесплатные минуты для приватного репо ограничены, но для нашего объёма хватит). Агентский pipeline тогда делает только register-task-definition + update-service + wait. Docker build исчезает с критического пути.

**Это серьёзная архитектурная развилка.** Открытый вопрос для пользователя (см. §7). Без CI cache build всё равно медленный, с CI cache — быстро, но требует настройки.

### Сводка по мерам

| # | Мера | Эффект на warm single-svc | Эффект на cold | Эффект на `all` | Сложность |
|---|------|----------------------------|----------------|-----------------|-----------|
| 5.1 | Skip migrate при пустом diff | **−60–90 с** | −60–90 с | −5–10 мин | S |
| 5.2 | ECR registry build cache | 0 | **−5–8 мин** | −15–30 мин | M |
| 5.3 | Параллелизация `scope:'all'` | 0 | 0 | **−50–70%** | M |
| 5.4 | Health-check / dereg tuning | **−30–60 с** | −30–60 с | −2–5 мин | S |
| 5.5 | Prune devDependencies | −15–30 с (push+pull) | −30–60 с | −2–4 мин | S |
| 5.6 | Убрать дубль-migrate из entrypoint | −1–3 с | −1–3 с | −5–15 с | XS |
| 5.7 | Развязать `packages/shared` | 0 на single, но снимает «лишний all» | — | — | L (вне scope) |
| 5.8 | Turbo remote cache | 0 (без переделки Dockerfile) | M | M | L (вне scope) |
| 5.9 | Pre-build на CI | M | XL | XL | L (открытый вопрос) |

Суммарный ожидаемый эффект мер 5.1+5.4+5.5+5.6 на warm single-service:
- Текущее: 4–6 мин (240–360 с)
- После: 240−90−45−20−2 ≈ **80–200 с**
- Целевой бюджет ≤90 с **достижим в нижней границе**, но требует чтобы warm docker build укладывался в 30 с (он сейчас 30–90 с, разброс большой → нужно мерить).

Если warm build стабильно >60 с → бюджет ≤90 с не уложится без мер 5.2 (для cold-устойчивости) или §5.9 (вынос build на CI). Решение по §5.9 — после инструментальных замеров KS-2476.

---

## 6. Декомпозиция на тикеты

Порядок реализации: сверху вниз (от безопасного к крупному). После каждого тикета — повторный замер.

| # | Тикет | Исполнитель | Размер | Зависит от |
|---|-------|-------------|--------|------------|
| 1 | KS-2476 — инструментальные замеры baseline (build cold/warm, push, migrate run-task, services-stable по каждому из 5 сервисов; зафиксировать в комментарии задачи и в этом ADR) | devops | S | — |
| 2 | KS-2477 — skip migrate run-task при пустом diff `packages/db/prisma/migrations` (и аналог для broadcasts-db, archive-db) | devops | S | KS-2476 |
| 3 | KS-2478 — убрать `npx prisma migrate deploy` из `apps/api/docker-entrypoint.sh`; проверить локальный docker-compose сценарий | backend | XS | KS-2477 |
| 4 | KS-2479 — `npm prune --omit=dev` в production stage всех 5 Dockerfile + явный `--include` для prisma CLI в api; замерить новый image size | backend | S | KS-2476 |
| 5 | KS-2480 — health-check / deregistration tuning в task-def (start-period=10, interval=5, retries=2, dereg-delay=10 для api/game; для broadcast обсудить отдельно из-за WS) | devops | S | KS-2476 |
| 6 | KS-2481 — параллелизация `scope:'all'` через `xargs -P3` или GNU parallel; раздельные log-файлы; summary в конце | devops | M | KS-2476 |
| 7 | KS-2482 — ECR registry build cache (`buildx --cache-from/--cache-to type=registry`); подготовить отдельный ECR repo `<svc>-cache` | devops | M | KS-2476 |
| 8 | KS-2483 — обновить ADR-045 фактическими цифрами after/before, зафиксировать достигнутый бюджет, поднять статус Proposed → Accepted | architect | S | все выше |

**Не в этой итерации (вне scope KS-2475)**:
- Развязка `packages/shared` (§5.7) — структурная работа, отдельная задача после замеров.
- Turbo remote cache S3 (§5.8) — даёт эффект только при переделке Dockerfile на `turbo run build`.
- Pre-build на CI (§5.9) — открытый вопрос для пользователя, см. §7.

---

## 7. Открытые вопросы

1. **CI vs agent build**: переносить ли docker build в GitHub Actions? Освобождает агентский хост, даёт стабильный cold-cache, но требует настройки (TURBO_TOKEN/Secrets, runner-минуты, потенциально self-hosted runner). Решение — за пользователем после KS-2476/KS-2482.

2. **broadcast-service WebSocket dereg-delay**: текущий 300 с был осознанно? Если активные WS долго переподключаются — снижение до 10 с приведёт к разрывам. Уточнить у backend (broadcast-service owner) в KS-2480.

3. **Task-def CPU/RAM**: я не запросил у devops точные значения, в ADR не зафиксированы. Если build cold-time или migrate run-task упирается в CPU/RAM — это материал для отдельного тикета. KS-2476 включает замер CPU-utilization во время сборки.

4. **`docker-entrypoint.sh` есть только у api**. Нужно проверить как стартуют остальные 4 сервиса (CMD `node dist/main.js`, без миграций) — судя по их Dockerfile так и есть, но валидировать в KS-2478.

---

## 8. Последствия

**Плюсы**:
- Для warm-deploy одного backend-сервиса — реалистично уложиться в 90–150 с (-3× относительно текущих 4–6 мин).
- Для `scope:'all'` — параллелизация даёт 3× минимум, в комбинации с §5.1–5.5 общий выигрыш ×4–5.
- Skip migrate (§5.1) и убрать дубль из entrypoint (§5.6) — без архитектурных рисков.

**Минусы / риски**:
- Health-check tuning (§5.4) → если приложение стартует медленнее, чем ожидаем, ECS будет крутить failed-replacements. Митигируется логированием boot-time в первый месяц и rollback task-def при инциденте.
- Skip migrate (§5.1) → если detect-логика ошибётся, пропустим действительно нужную миграцию. Безопасный default — fallback на «гнать как сейчас» при любом сомнении.
- Параллелизация (§5.3) → сложнее отладка при падении одного из блоков. Митигируется per-service логами и явным fail-fast на критических сервисах (api).

**Не делает этот ADR**:
- Не трогает frontend-деплой (отдельная история).
- Не пишет код — только декомпозиция и обоснование. Реализация идёт в KS-2476…KS-2482 силами devops/backend.
