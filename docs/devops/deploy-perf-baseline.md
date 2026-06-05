# Baseline производительности деплоя backend-сервисов

Замеры реального времени выполнения этапов скрипта `scripts/deploy-aws.sh` по
всем backend-сервисам в warm-сценарии. Использовано для расстановки приоритетов
работ E2–E7 по ADR-045.

**Источники:**
- KS-3048 — задача с замерами (devops), полный комментарий с raw-данными.
- [ADR-045 — Backend deploy performance](../adr/045-backend-deploy-perf.md), §3.1 (предварительные оценки), §5 (меры E1–E7).

---

## 1. Параметры замера

- **Дата:** 2026-05-15
- **Хост агента:** агентский контейнер (тот же, где `webhook-server`)
- **Build SHA:** `cb2c36c4` (warm-сценарий: код между прогонами не менялся)
- **Инструмент:** функция `_perf_stamp` в `scripts/deploy-aws.sh` (коммит `50396d11`).
  Ms-precision таймстампы пишутся в `/project/logs/deploy-perf-<ts>-<pid>.log`,
  summary — в stdout.

## 2. Методика

- В `deploy-aws.sh` добавлены 25 точек `_perf_stamp` между всеми этапами:
  git / ECR / build / push / register-taskdef / migrate / update-service /
  services-stable / smoke / atomic-latest.
- На каждый сервис — один warm-прогон; broadcast-service дополнительно прогнан
  дважды, чтобы отделить «cold-cache warm» от «true-warm».
- `scope:'all'` не запускался по согласованию с пользователем — реальный
  сценарий это одиночные деплои.
- Сценарий с реальной pending-миграцией не запускался: broadcast-service
  миграций сам не имеет, но Fargate `run-task` всё равно гонится, и его 68–83 с —
  это чистый overhead Fargate task lifecycle (нижняя граница для api/archive
  при пустом diff миграций).

## 3. Сводная таблица (сервис × этап, секунды)

| Этап | broadcast #1 | broadcast #2 (true-warm) | api | game-service | archive-service | tactic-worker |
|------|--------------:|--------------------------:|----:|-------------:|----------------:|--------------:|
| `pre_git_sync` (git fetch+ff) | 0.37 | 0.35 | 0.37 | 0.41 | 0.38 | 0.40 |
| `ecr_login` | 0.79 | 0.66 | 0.77 | 0.82 | 0.80 | 0.79 |
| `docker_build` | 53.08 | 0.98 | 1.28 | 1.36 | 47.03 | 73.74 |
| `docker_push` | 50.58 | 0.69 | 0.83 | 0.81 | 50.87 | 51.67 |
| `describe_svc + register_taskdef` | 1.84 | 1.73 | 1.30 | 1.58 | (см. note A) | (см. note B) |
| `migrate_run_task` (Fargate cold task) | 67.98 | 83.24 | 84.69 | — | ~80 (note A) | — |
| `update_service + services_stable` (ECS rollout) | 168.69 | 153.45 | 183.79 | 184.11 | ~155 (note A) | — |
| `smoke` (curl health) | 3.16 | 2.40 | — | — | ~5 (note A) | — |
| `atomic_latest_move` | <0.1 | <0.1 | 3.10 | 3.32 | (в `archive_done`) | 7.41 |
| **TOTAL** | **346.62** | **243.60** | **276.15** | **192.41** | **339.54** | **134.01** |

> **Note A (archive-service):** stamps между `docker_push` и финалом не
> разделены — все этапы (register-3-task-def-families + migrate + update-service
> + services-stable + smoke + EventBridge update + atomic latest) попадают в
> один bucket `archive_done = 240.46 с`. По аналогии с broadcast/api: ≈ 80 с
> migrate + 150 с services-stable + 10 с прочее. Детализация — follow-up правкой
> `deploy-aws.sh` без нового деплоя сейчас.
>
> **Note B (tactic-worker):** пайплайн короткий — нет ECS service, нет миграций.
> После push идёт только `register-task-def` (~7 с) + atomic latest (<1 с),
> всё в bucket `tactic_atomic_latest_done`.

## 4. Прогон broadcast-service: «cold-warm» vs «true-warm»

| Этап | #1 (warm после паузы) | #2 (true-warm, сразу после #1) | Δ |
|------|----------------------:|-------------------------------:|---:|
| `docker_build` | 53.08 | 0.98 | −52.10 |
| `docker_push` | 50.58 | 0.69 | −49.89 |
| `migrate_run_task` | 67.98 | 83.24 | +15.26 (шум Fargate cold start) |
| `services_stable` | 167.68 | 152.50 | −15.18 (шум rollout) |
| **TOTAL** | 346.62 | 243.60 | −103.02 |

`docker build+push` на true-warm — ~2 с (околонулевые). Между деплоями всё
уходит в AWS-этапы.

## 5. Top-3 сервисов по общему времени warm-деплоя

| Место | Сервис | Time | Доминирующая причина |
|-------|--------|-----:|----------------------|
| 1 | **archive-service** | 339.54 с | 2 ECS-service updates + migrate + 3 task-def registrations + EventBridge update |
| 2 | **api** | 276.15 с | migrate run-task (84.7 с) + services-stable (182.8 с) |
| 3 | **broadcast-service** | 243–347 с | migrate run-task (68–83 с) + services-stable (152–168 с) |

`game-service` — 192 с (нет миграций, только services-stable).
`tactic-worker` — 134 с (нет ECS-сервиса, нет миграций).

## 6. Top-3 этапов по абсолютному времени (на warm single-service)

| Место | Этап | Среднее warm | Доля от total | Узкое место |
|-------|------|-------------:|--------------:|-------------|
| 1 | **`services_stable`** (ECS rollout, MAX 200 / MIN 100) | 152–184 с | **62–95%** для сервисов с ECS service | Fargate rolling deploy: новый task → health-check → drain old |
| 2 | **`migrate_run_task`** (Fargate run-task для `prisma migrate deploy`) | 68–85 с | **24–30%** для api/broadcast/archive | Fargate cold start: ECR pull + task lifecycle + 5–15 с фактический migrate |
| 3 | **`docker_build` + `docker_push`** | 0–105 с | **0–30%** | На true-warm ≈ 0; на «warm после паузы» 100 с из-за частичной инвалидации cache |

На true-warm (прогон сразу после прогона) этапы 1+2 = ~95% времени.

## 7. Подтверждённые цифры vs ADR-045 §3.1

| Этап | ADR-045 оценка | Факт замера | Расхождение |
|------|---------------|-------------|-------------|
| `ensure_main_synced + ECR login` | 5–10 с | 1.0–1.2 с | ADR переоценил в 5–10× |
| `docker build` (warm) | 30–90 с | 0.7–1.4 с (true-warm) / 47–74 с (cold-cache) | ADR описывал «warm после паузы»; true-warm быстрее |
| `docker push` | 30–120 с | 0.6–0.9 с (true-warm) / 50 с (cold-cache) | то же |
| `register-task-def` | 2–3 с | 1.1–1.6 с | в пределах оценки |
| `migrate run-task` | 60–90 с | 68–85 с | подтверждено |
| `update-service + services-stable` | 90–180 с | 152–184 с | подтверждено (в верхней границе) |
| `atomic put-image :latest` | ~2 с | 0.0–3.3 с | в пределах оценки |
| **Total warm single-service** | 4–6 мин | 192–347 с (3:12–5:46) | подтверждено |

**Что подтвердилось:** `services-stable` и `migrate run-task` — главные узкие
места. Размеры образов и оценки ADR §3.1 (4–6 мин warm single-service) точны.

**Что неожиданно:** `docker build+push` на true-warm нулевые (~2 с), а не
30–90 с как в ADR. ADR описывал кейс «warm после паузы», но в реальности при
последовательных деплоях одного сервиса cache идеален, и весь хвост уходит
в AWS. → Меры §5.2 (ECR registry cache) и §5.5 (prune devDependencies) для
warm-сценария дают минимальный эффект; основные таргеты — §5.1 (skip-migrate)
и §5.4 (health-tuning).

## 8. Top-3 узких мест для расстановки E2–E7

1. **`services_stable` ECS rollout (152–184 с, 60–95% времени)** —
   структурное звено. Сокращается через health-check tuning
   (`startPeriod`, `interval`, `retries`) + ALB `deregistrationDelay`. →
   **E5 (health-tuning)** — главный кандидат для warm-сценария.

2. **`migrate_run_task` Fargate cold task (68–85 с, 24–30% времени)** —
   гонится ВСЕГДА, даже при пустом diff `prisma/migrations/`. Чистый
   overhead Fargate. → **E2 (skip-migrate при пустом diff)** — самый
   «дешёвый» вин, до −85 с с warm-деплоя api/broadcast/archive.

3. **Docker layer cache хрупкий между прогонами разных сервисов
   (47–105 с)** — правка в `apps/A/...` инвалидирует слои в `apps/B/...`
   через общий `package-lock.json`. На true-warm нивелируется, но в
   реальности cache часто не идеален между деплоями разных сервисов. →
   **E7 (ECR registry cache)** + **E4 (prune devDependencies)** дают
   устойчивость и компактный push.

## 9. Связь с целевым бюджетом ADR-045 (≤90 с warm single-service)

Сейчас 192–347 с. После мер:

- E2 (skip-migrate) убирает 68–85 с для api/broadcast/archive
- E5 (health-tuning) убирает 30–60 с со `services_stable` (~150 с → ~110 с)
- E4 (prune dev-deps) уменьшает образ ~150 MB → −10 с на rollout
- E6 (parallel-all) — эффекта на single-service нет
- E7 (ECR cache) — устойчивость cold/cross-host, на true-warm эффекта нет

Суммарно: **192 − 85 − 45 − 10 ≈ 52 с** для api/broadcast/archive;
для `game-service` (без миграции): **192 − 45 ≈ 147 с** — единственный кейс,
где бюджет ≤90 с не достижим без дополнительных мер на rollout.

## 10. Raw trace files (на хосте агента)

```
/project/logs/deploy-perf-20260515-081225-397463.log   # broadcast-service #1
/project/logs/deploy-perf-20260515-081820-423792.log   # broadcast-service #2 (true-warm)
/project/logs/deploy-perf-20260515-084810-554576.log   # api
/project/logs/deploy-perf-20260515-085253-575573.log   # game-service
/project/logs/deploy-perf-20260515-085612-591229.log   # archive-service
/project/logs/deploy-perf-20260515-090206-617403.log   # tactic-worker
```

Формат: `<epoch_ms>\t<stage_name>\n`. Парсится `_perf_summary` (awk) или
внешним инструментом.

## 11. Состояние инструментации

- Файл `scripts/deploy-aws.sh` инструментирован, синтаксис валиден
  (`bash -n` OK), коммит **`50396d11`**.
- 6 warm-прогонов выполнены без сбоев, все deploy завершились `success`,
  `services-stable` + `smoke` прошли.
- В прод записаны те же образы (`:cb2c36c4`), что и были — никаких
  изменений кода, только повторные деплои.

## 12. KS-3719 — пошаговая разбивка `docker build` и `docker push`

С коммита **`6b36c8a3`** в `_perf_summary` добавлены два дополнительных блока
для каждого сервиса, который реально билдил/пушил в текущем прогоне:

```
--- docker build steps (<service>) ---
  <dur>s  #<step>  <command>
  ...
--- docker push layers (<service>) ---
  <dur>s  <status>  <layer-id>
  ...
```

Блоки печатаются ПОСЛЕ строки `raw trace: ...` основного perf-summary.
Существующие метки `*_docker_build_done` / `*_docker_push_done` сохранены
1-в-1.

### Источники данных

| Файл | Что внутри | Как пишется |
|------|------------|-------------|
| `$REPO_DIR/logs/<svc>-build-${DEPLOY_SHA}.log` | Полный stdout/stderr `docker build --progress=plain`. Каждая строка с префиксом `[NNNN.NNN] ` — секунды от старта pipe. | `docker build --progress=plain ... 2>&1 \| _with_ts \| tee $BUILD_LOG` |
| `$REPO_DIR/logs/<svc>-push-${DEPLOY_SHA}.log` | Полный stdout/stderr `docker push`. Такой же префикс таймштампа. | `docker push ... 2>&1 \| _with_ts \| tee $PUSH_LOG \| tail -3` |

`<svc>` — один из: `api`, `game-service`, `broadcast-service`,
`archive-service`, `tactic-worker`. Имя для `tactic-worker` унифицировано на
`tactic-worker-build-*.log` (ранее было `tactic-build-*.log`).

### Helper `_with_ts`

Perl + `Time::HiRes`. Префиксует каждую строку stdin секундами от старта pipe
в формате `[NNNN.NNN] <line>`. `ts` из `moreutils` на хосте не гарантирован,
поэтому используется perl.

### Парсер `_parse_build_steps`

Понимает оба формата вывода `docker build --progress=plain`:

1. **Classic builder** — строки вида `[ 12.345] Step 6/24 : RUN apt-get install ...`.
   Длительность шага = разница таймштампов до следующей строки `Step`
   (или до `Successfully built`).
2. **BuildKit / buildx** — строки `[ 1.234] #6 [build 3/15] RUN apt-get install ...`
   (описание шага) и `[ 12.345] #6 DONE 11.1s` (длительность).
   `#N CACHED` показывается как `0.00s [CACHED]`.

Технические строки BuildKit (`transferring`, `sha256:`, `naming to`,
`exporting`, `writing`, размеры) пропускаются. Сортировка — по убыванию
длительности.

### Парсер `_parse_push_layers`

Берёт `<id>: Preparing|Pushing|Waiting` как старт слоя и
`<id>: Pushed|Layer already exists|Mounted from` как финал. Статус выводится
как:

- `uploaded` — слой реально ушёл в сеть (`Pushed`)
- `cached` — `Layer already exists` в ECR
- `mounted` — `Mounted from <repo>` (cross-repo deduplication)

Сортировка — по убыванию длительности.

### Как читать

- Жирный шаг в build (`#N DONE Xs` сверху списка) → кандидат на кэширование
  или вынос в отдельный слой.
- Длинная серия `uploaded` слоёв в push с большой длительностью → раздутые
  слои в Dockerfile (например, `COPY node_modules` без prune dev-deps,
  см. меру E4 ADR-045).
- Если все слои `cached` / `mounted`, а суммарный push-этап всё равно
  ощутимый — узкое место в HTTP-overhead к ECR, не в самих слоях.

### Поведение при отсутствии журналов

Если для текущего `DEPLOY_SHA` журналы не найдены (например, сервис не
деплоился в этом прогоне или `*_SKIPPED=1`) — блок просто не печатается,
ошибки нет.
