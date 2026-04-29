# ADR-020: Перевод archive-importer с постоянной ECS task на EventBridge Scheduler + RunTask

**Статус:** Предложено
**Дата:** 2026-04-21
**Задача:** KS-1680
**Связанные ADR:** [ADR-013](./013-game-archive-and-tree.md), [ADR-018](./018-archive-service-extraction.md), [ADR-019](./019-archive-importer-merge-into-service.md)

## 0. Проектный инвариант: code optimization first, hardware bump second

**Общий проектный принцип (не локальный для archive-importer):** повышение infrastructure sizing'а (CPU / RAM / disk / instance class) рассматривается ТОЛЬКО после исчерпания code-optimization путей. Формальный чек-лист перед любым sizing-bump'ом:

1. Профилирован ли фактический ресурс? (не догадки, а измерение — heap snapshot, flamegraph, SQL `EXPLAIN`, ECS container insights.)
2. Существует ли in-code способ снять нагрузку? — streaming/chunking, lazy loading, indexing, query push-down в БД, кеширование, batching, back-pressure.
3. Если существует — какова его стоимость (человеко-дни) и риск регрессии? Зафиксировано ли это тикетом?
4. Если in-code путь выбран — sizing остаётся на минимуме; bump вводится только если code-fix провалился или стоимость code-fix'а превышает N-летнюю стоимость bump'а с учётом роста нагрузки.

**Причины инварианта:**

- Sizing-bump маскирует архитектурные проблемы (утечки, O(N²) алгоритмы, ненужная in-memory аккумуляция), откладывая их на следующий выпуск/источник/порядок масштаба данных. Исправление становится кратно дороже.
- В продукте с одним разработчиком time-to-fix дешевле дополнительного \$/мес только пока проблема активна; как только нагрузка вырастет, bump упирается в новый cap, и платить нужно ещё раз.
- Bump'ами трудно анализировать фактический baseline-профиль сервиса. Минимальный sizing + streaming код даёт предсказуемые limits, видимые в мониторинге.
- Stability через minimalism: меньше vCPU/RAM — меньше скрытых трат на memory leaks, zombie threads, непрочищенные connection pools.

**Что инвариант НЕ означает:**

- Не запрет на bump при объективной нехватке ресурсов (например, для чисто CPU-bound задач типа stockfish-анализа 24-ply). Запрет — на bump «потому что сейчас быстрее чем писать код».
- Не требование прогонять чек-лист для микро-изменений (например, +50 MiB на контейнер по результатам upgrade-а зависимости). Применяется к существенным bump'ам (kx2+).
- Не освобождение от bump'ов, если code-optimization пути проработаны и исчерпаны (ADR обязан это зафиксировать).

**Следствие для этого ADR:** конкретный кейс применения инварианта — KS-1684 OOM (§2.4.5). Факт OOM на `256 CPU / 512 MiB` НЕ ведёт к sizing-bump'у; ведёт к KS-1687 (streaming/chunked PGN pipeline, §2.4.5). Sizing обеих task-def (`oneshot`, `adhoc`) остаётся на `256 / 512`.

## 1. Контекст

### Что есть сейчас (факт, после KS-1676 / ADR-019)

1. `apps/archive-service` — один пакет, один ECR-образ, **два entrypoint'а**:
   - `dist/main.js` — HTTP API (`:3003`, контроллер `/tree`, `/games*`, health/metrics на `/_/health`, `/_/metrics`).
   - `dist/importer-main.js` — standalone NestJS-процесс (`:3004`): `@Interval(60_000)` tick через `ArchiveImportService.tick()` + те же `/_/health`, `/_/metrics`.
2. ECS:
   - `archive-service` — Fargate service, desiredCount auto-scale min=1 / max=2, `command: ["node","dist/main.js"]`.
   - `archive-importer` — Fargate service, desiredCount=1, 24/7, `command: ["node","dist/importer-main.js"]`.
3. `ArchiveImportService.tick()` (`apps/archive-service/src/archive-import/archive-import.service.ts:85`) делает `archiveSource.findMany({enabled:true})`, проходит источники, для «созревших» берёт Redis-lock `archive:import:lock:{code}` и запускает `TwicImporter.run()`. `isDue` вычисляет интервал через `intervalFromSchedule(source.schedule)` — MVP cron-parser (`*/N * * * *`, `0 */N * * *`).
4. TWIC `archive_sources.schedule` в проде — недельный cron (факт — источник в БД, подтвердить у devops перед cutover'ом; по ADR-018 §2.3 один выпуск/неделю). Значит `isDue == true` ≈ раз в неделю. Остальные ~10080 тик'ов за неделю — no-op (`isDue == false`, два-три SQL-запроса на tick).
5. Prometheus scrape: ECS service discovery sidecar резолвит endpoint'ы обоих процессов (`archive-service:3003/_/metrics`, `archive-importer:3004/_/metrics`) и pulls раз в 15–30 сек.
6. Ad-hoc CLI `cli:import-twic-issue <N>` (KS-1679, уже done): запускается вручную через ECS RunTask, использует `NestFactory.createApplicationContext(ImporterModule)` + `TwicImporter.runAdHoc(issue)`, не трогает `archive_sources.cursor`. Работает поверх Redis-lock `archive:import:lock:twic`.
7. Fargate 24/7 на `archive-importer` при профиле `256 CPU / 512 MiB` ≈ \$10–15/мес (на `us-east-1` on-demand). 99.95% времени — idle/no-op.

### Что просит KS-1680

Сменить постоянный ECS service на триггерный запуск:
- **EventBridge Scheduler** → **ECS RunTask** раз в неделю (или по более частому расписанию — см. §2.3).
- Importer запускает **один tick**, завершается с exit 0 при успехе / non-zero при ошибке.
- Prometheus scrape для short-lived task не работает → метрики нужно снимать иначе.
- CloudWatch Alarm «нет успешных импортов >14 дней».
- Миграция без риска: параллельный ран сначала, потом `desired=0` старого service, потом удаление.

### Что НЕ в скоупе ADR-020

- Prewarm-lock в HTTP-процессе (`archive-service:3003`) — отдельный follow-up из ADR-019 KS-M07.
- Переход на Lambda — отклонён: образ с `pg.Pool` + `adm-zip` + `iconv-lite` + Prisma engine тянет ~200 MiB сжатый, Lambda cold-start + layer-limits дают хуже UX, чем Fargate RunTask с тем же образом.
- Множественные источники архивов (lichess, chess.com) — остаётся одна EventBridge schedule на весь `enabled=true` набор `archive_sources`; при добавлении новых источников схема не меняется, только schedule expression при необходимости.
- Переход `desiredCount=0` на `archive-service` (HTTP) — он остаётся long-running service для публичных GET-запросов.
- Замена MVP cron-parser `intervalFromSchedule` — отдельная задача (KS-158x, упомянуто в ADR-019 §2.3).
- Изменение ad-hoc CLI `cli:import-twic-issue` (KS-1679) — остаётся как manual RunTask.

## 2. Решение

### 2.1 Как переключить: EventBridge Scheduler → ECS RunTask

**Выбор сервиса:** AWS **EventBridge Scheduler** (не legacy EventBridge Rules). Причины:
- Scheduler — новый managed-сервис (GA с ноября 2022), специально под cron-триггеры: лучше лимиты, DLQ, retry policy, группы schedules. Старые EventBridge Rules тоже умеют cron, но в основном поддерживаются по inertia.
- Scheduler напрямую интегрирован с ECS RunTask через `Universal target` + IAM role, без Lambda-прокладки.
- Free tier до 14M invocations/month — наш объём (1–7 invocations/week) занимает < 0.001% free tier'а.

**Schedule objект (ориентировочная конфигурация, финальный JSON — devops-задача):**

```jsonc
{
  "Name": "kingside-archive-importer-twic",
  "GroupName": "kingside-archive",                    // логическая группа
  "ScheduleExpression": "cron(0 20 ? * * *)",         // см. §2.3
  "ScheduleExpressionTimezone": "UTC",
  "State": "ENABLED",
  "FlexibleTimeWindow": { "Mode": "OFF" },            // строгий тайминг — см. §2.3
  "Target": {
    "Arn": "arn:aws:ecs:us-east-1:<acct>:cluster/kingside",
    "RoleArn": "arn:aws:iam::<acct>:role/EventBridgeSchedulerArchiveImporterRole",
    "EcsParameters": {
      "TaskDefinitionArn": "arn:aws:ecs:us-east-1:<acct>:task-definition/kingside-archive-importer-oneshot",
      "LaunchType": "FARGATE",
      "PlatformVersion": "LATEST",
      "NetworkConfiguration": {
        "AwsvpcConfiguration": {
          "Subnets": ["subnet-..."],                  // те же subnet, что у текущего service
          "SecurityGroups": ["sg-..."],               // та же SG — доступ к RDS и Redis
          "AssignPublicIp": "DISABLED"
        }
      },
      "TaskCount": 1,
      "PropagateTags": "TASK_DEFINITION"
    },
    "Input": "{}",
    "RetryPolicy": {
      "MaximumEventAgeInSeconds": 3600,               // retry до 1 часа
      "MaximumRetryAttempts": 2                       // 3 попытки всего
    },
    "DeadLetterConfig": {
      "Arn": "arn:aws:sqs:us-east-1:<acct>:kingside-archive-importer-dlq"
    }
  }
}
```

**Важные моменты:**
- `RoleArn` — новая IAM role с permissions `ecs:RunTask`, `iam:PassRole` (для task execution role и task role), `sqs:SendMessage` (в DLQ). Minimum-privilege policy — задача devops.
- `DeadLetterConfig` → SQS DLQ: если RunTask упал в момент invocation'а (нет capacity, permission issue), событие уходит в DLQ. CloudWatch Alarm на `ApproximateNumberOfMessagesVisible > 0` (см. §2.7).
- **Почему `FlexibleTimeWindow=OFF`:** flexible даёт AWS право сдвинуть запуск ±15 мин, чтобы сгладить нагрузку. Нам это не критично, но более предсказуемый тайминг в логах удобнее для ручной отладки. Можно включить flexible позже, если биллинг ECS зажмётся.

**Task definition `kingside-archive-importer-oneshot`:**
- Новая отдельная family, **та же image URI**, что и у current `kingside-archive-importer`.
- `containerDefinitions[0].command: ["node", "dist/importer-once.js"]` (см. §2.2).
- Те же env (`ARCHIVE_DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `NODE_ENV=production`). **Добавляется**: `AWS_EMF_ENVIRONMENT=Lambda|ECS`, `AWS_EMF_NAMESPACE=Kingside/ArchiveImporter`, `AWS_EMF_LOG_GROUP_NAME=/ecs/archive-importer-oneshot` — для EMF client (§2.5).
- `logConfiguration`: `awslogs` driver → CloudWatch Logs group `/ecs/archive-importer-oneshot`. **Обязательно** — отсюда EMF метрики извлекаются.
- `cpu=256, memory=512`. Sizing НЕ повышается после OOM на KS-1684 — применяется §0 «code optimization first». Фактический пик RSS (~600–900 MiB на TWIC-выпуск ~8 000 партий) превышает лимит контейнера, но решение — streaming pipeline (KS-1687, §2.4.5), а не bump. Принятый риск до закрытия KS-1687: scheduler-tick на крупных TWIC (>~2k партий) уязвим к OOM; обнаруживается через alarm A3 (`SourcesFailed > 0 за 1 ч`, §2.7) в течение часа, не через 14-дневный A4.
- `essential: true`, `stopTimeout: 120` сек — даём Nest `onModuleDestroy` закрыть `pg.Pool`, Redis, Prisma gracefully.

**ECR image tag:** каждый CI-build публикует `kingside-archive-service:<sha>`. `kingside-archive-importer-oneshot` task-def шаблон ссылается на **тот же tag**, что и `kingside-archive-importer` и `kingside-archive-api` — cutover единый (deploy пайплайн обновляет все три task definitions одновременно). Это инвариант: `dist/main.js`, `dist/importer-main.js`, `dist/importer-once.js` — из одного `nest build` одного `src/`, код одинаковый.

### 2.2 Как реализовать one-shot режим

**Три варианта, сравнение:**

| # | Вариант | Плюсы | Минусы |
| - | - | - | - |
| A | Флаг `--once` в `importer-main.ts` (ветвление внутри bootstrap'а) | Один entrypoint, минимум файлов. | Ветвится всё: HTTP listen vs no-listen, Scheduler on/off, exit vs loop. Легко сломать non-once путь правкой once-пути и наоборот. |
| B | **Отдельный entrypoint `importer-once.ts` + `ImporterOnceModule` без ScheduleModule/HealthModule** | Чистое разделение. No HTTP listen (не нужен `/_/health` для short-lived task — RunTask lifecycle сам показывает состояние). `@Interval` не регистрируется → нет риска, что EventBridge тикнет 1 раз, а внутри за 5 мин Task'а успеет ещё самоустроиться. | Два entrypoint'а, два Module-корня. Дубль config-bootstrap на ~15 строк. |
| C | Env `IMPORTER_RUN_MODE=once\|loop` в `importer-main.ts` | Минимум файлов, явный переключатель. | Та же ветвящаяся сложность что в A, плюс неявная зависимость от env-значения (забыли выставить — получили loop в one-shot таск-деф'е). |

**Рекомендация — Вариант B.**

Структура (НЕ код, архитектурный контракт; реализацию делает backend):

```
apps/archive-service/src/
  importer-main.ts                          # существует, НЕ трогаем
  importer.module.ts                        # существует
  importer-once.ts                          # NEW
  importer-once.module.ts                   # NEW
  archive-import/
    archive-import.service.ts               # существует, добавить метод tickOnce() — см. ниже
```

**`importer-once.module.ts` (контракт):**
- `imports: [ConfigModule.forRoot(...), PrismaModule, RedisModule, MetricsModule, ArchiveImportModule]`
- **НЕ импортит** `ScheduleModule.forRoot()` — `@Interval` в `ArchiveImportService.tick` не зарегистрируется. tick() доступен как обычный метод, но автоматически не тикает.
- **НЕ импортит** `HealthModule` — HTTP сервер не поднимается, `/_/health` не нужен, ECS task status = health.

**`importer-once.ts` (контракт):**
```ts
// псевдокод
async function main() {
  const app = await NestFactory.createApplicationContext(ImporterOnceModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();
  const importer = app.get(ArchiveImportService);
  const emf = app.get(EmfMetricsPublisher);    // §2.5
  const logger = new Logger('importer-once');

  const startedAt = Date.now();
  let exitCode = 0;
  try {
    const result = await importer.tickOnce();  // см. ниже
    logger.log(`tickOnce done: ${JSON.stringify(result)}`);
  } catch (err) {
    logger.error(`tickOnce failed: ${(err as Error).message}`);
    exitCode = 2;
  } finally {
    // Flush EMF — публикуем metrics snapshot в stdout до закрытия логгера.
    await emf.publishSnapshot({
      durationSec: (Date.now() - startedAt) / 1000,
      exitCode,
    });
    await app.close().catch(() => {});
  }
  process.exit(exitCode);
}
if (require.main === module) main().catch(...);
```

**Новый метод `ArchiveImportService.tickOnce()` (контракт, не код):**

Возвращает структурированный результат — сколько source'ов обработано, сколько lock-hit, сколько failed:

```ts
interface TickResult {
  sourcesChecked: number;
  sourcesSkippedNotDue: number;
  sourcesSkippedLocked: number;
  sourcesProcessed: number;
  sourcesFailed: number;
  runs: Array<{
    code: string;
    kind: string;
    status: 'ok' | 'partial' | 'noop' | 'failed' | 'not-due' | 'locked';
    gamesAdded?: number;
    gamesSkipped?: number;
    error?: string;
  }>;
}
```

**Отличия от существующего `tick()`:**
1. Не использует `this.running` guard — он избыточен при one-shot invocation (нет параллельного tick'а).
2. Возвращает `TickResult` (сейчас `tick()` возвращает `void`). `TickResult` попадает в EMF snapshot и в CloudWatch Logs.
3. Global timeout: внутри — `Promise.race([this.processAllSources(), timeoutPromise(resolveTickOnceTimeoutMs())])` — 30 минут hard cap (default, env-override `IMPORTER_TICK_TIMEOUT_MS`, см. §2.7.1). После таймаута — throw, exit code 2, EventBridge DLQ retry. *Обоснование лимита:* TWIC weekly после 24-04-2026 парсится 5–17 мин (ранее 30–120 сек, регрессия — KS-2128); 30 мин — запас на ~2× от наблюдаемого пика. Backstop в `importer-once.ts` 35 мин (env `IMPORTER_BACKSTOP_TIMEOUT_MS`) — отдельным уровнем выше. ECS `stopTimeout` (см. §2.1 task-def, 120 сек) — про graceful shutdown после `process.exit()`, не про прикладной таймаут; не пересекается.
4. `tick()` (loop-mode, остаётся) может делегировать в `tickOnce()` + set `this.running` — чтобы логика не раздваивалась. Это рефакторинг backend'ом; архитектурно оба метода идут из одной функции `processAllSources()`.

**Dockerfile НЕ меняется**. `nest build` продолжает строить весь `src/`, новые файлы попадают в `dist/` автоматически. В `apps/archive-service/Dockerfile` `CMD` остаётся `["node","dist/main.js"]` — это default для HTTP image, task-def для importer-oneshot переопределяет.

### 2.3 Выбор cron expression

TWIC выпускается раз в неделю, обычно вторник вечером UTC (проверено публичной историей релизов `theweekinchess.com`; не контракт и может сдвинуться). Варианты расписания:

| Cron | Invocations/week | Задержка детекции нового выпуска (p99) | Стоимость Fargate | Риск пропуска |
| - | - | - | - | - |
| **Weekly**: `cron(0 20 ? * WED *)` | 1 | до 7 дней если TWIC задержался или сбой | ~\$0.003/неделя | Высокий: один сбой = одна неделя пропуска |
| **Weekly + safety net**: `cron(0 20 ? * TUE,WED,SAT *)` | 3 | до ~2–3 дня | ~\$0.009/неделя | Средний |
| **Daily**: `cron(0 20 ? * * *)` | 7 | до 24 ч | ~\$0.021/неделя | Низкий |
| **Every 6h**: `cron(0 */6 ? * * *)` | 28 | до 6 ч | ~\$0.084/неделя | Минимальный, но excessive |

**Стоимостная калькуляция:**
Fargate 256 CPU / 512 MiB on-demand (us-east-1) ≈ \$0.0122/vCPU-hour + \$0.00134/GB-hour = \$0.00371/task-hour при 256/512. Один invocation длится 30 сек–30 мин (потолок поднят 2026-04-29, KS-2123, см. §2.7.1); medium estimate ≈ 5 мин при текущем размере TWIC weekly = ~\$0.00031/task. Значит:
- Weekly: 1 × \$0.00031 = \$0.00031/week ≈ **\$0.0013/мес**.
- Daily: 7 × \$0.00031 = \$0.00217/week ≈ **\$0.0094/мес**.
- Every 6h: 28 × \$0.00031 = \$0.0087/week ≈ **\$0.038/мес**.

Разница между weekly и daily — **менее цента в месяц**. Все три варианта — drop-in замена текущим \$10–15/мес за 24/7 Fargate. (Числа пересчитаны 2026-04-29 после повышения medium estimate до 5 мин, см. §2.7.1.)

**Рекомендация — Daily: `cron(0 20 ? * * *)` UTC (каждый день в 20:00 UTC).**

Обоснование:
- Max задержка обнаружения нового TWIC = 24 ч (vs 7 дней для weekly). Для продукта с архивом, который пополняется раз в неделю, 24 ч vs 7 дней — значимая разница в UX (в частности, если пользователь зашёл посмотреть свежие партии вторника вечером).
- 6 из 7 дней — no-op ценой <1 cent/mes. Source.schedule (в БД) сам отсеивает tick'и, не готовые к запуску, через `isDue()` → запрос `archiveSource.findMany` + MVP cron-check → exit через 2–5 сек.
- Если TWIC публикатор задержит один выпуск (случилось несколько раз за 2010-е) — daily ловит на следующий день; weekly потеряет неделю.
- Redis-lock защищает от гонки с ad-hoc CLI: если `cli:import-twic-issue` в момент EventBridge invocation'а держит lock, one-shot увидит `lock held, skipping` на этом source'е (ожидаемое поведение, не ошибка, возврат `status='locked'` в TickResult).

**Отклонено — weekly `cron(0 20 ? * WED *)`:** экономия \$0.003 в месяц не стоит потери детекционного окна в 6 дней.

**Отклонено — every 6h:** избыточно, нагрузка на RDS query.planner не нулевая (4 лишних `findMany` в день), никакой платной пользы.

**Отклонено — flexible time window ±15 мин:** см. §2.1.

**Альтернатива для devops (не решаем в ADR):** добавить второй schedule раз в час только на `TUE 18:00–23:00 UTC` (когда наиболее вероятен новый выпуск) — окно <6 ч для wednesday window. Marginal улучшение, сложнее. Сейчас: **daily 20:00 UTC, один schedule.**

### 2.4 Ad-hoc CLI `cli:import-twic-issue` (KS-1679)

**Код не трогаем.** Живёт в `apps/archive-service/src/cli/import-twic-issue.ts`, запускается отдельной ECS RunTask'ой вручную (devops или оператор-администратор).

**Corrigendum (KS-1683, 2026-04-21):** исходный черновик §2.4 предписывал переиспользовать `kingside-archive-importer-oneshot` task-def с `containerOverrides.command`. После фактического запроса на ретроспективный импорт (TWIC-1639 и потенциально несколько выпусков назад) решение пересмотрено — см. §2.4.1 ниже.

#### 2.4.1 Инфраструктура ad-hoc запуска — отдельный task-def

**Решение:** отдельная task-def family `kingside-archive-importer-adhoc`.

| Критерий | `--overrides` на `oneshot` (исходный вариант) | Отдельный `adhoc` task-def (принято) |
| - | - | - |
| Log group | `/kingside/archive-importer-oneshot` (смешан с daily) | `/kingside/archive-importer-adhoc` (изолирован) |
| Log retention | 90 дней (единая политика daily) | 30 дней достаточно — ad-hoc-аудит короче |
| IaC (инфраструктурный скрипт) | Ad-hoc как эфемерная команда, не отражён в IaC | Task-def, log group и retention видны в `scripts/archive-service-aws-setup.sh` |
| CloudWatch Logs Insights фильтр | По `[cli:import-twic-issue]` префиксу (работает, но хрупко) | По `logGroupName` — тривиально |
| Alarm collision | EMF из daily и ad-hoc в одном namespace (см. §2.4.2) | Физически разделить проще |
| Дополнительная работа devops | Никакой | Один task-def + один log group + один retention parameter |

**Почему это важно:** KS-1683 подразумевает одиночный запуск TWIC-1639, но реальный план оператора — заливать выпуски 1638, 1637, … назад (ручной backward-walk архива) с проверкой метрик между итерациями. При двух-трёх десятках ad-hoc run'ов смешение с daily log-stream'ом делает пост-мортем-аудит трудоёмким. Стоимость «лишнего» task-def и log group'ы ≈ \$0/мес (billable только log ingest), девопс-работа — ~20 минут к `scripts/archive-service-aws-setup.sh`.

**Конфигурация task-def `kingside-archive-importer-adhoc`:**
- **Та же image URI**, что у `oneshot` (один ECR build на весь archive-service).
- `containerDefinitions[0].command: ["node", "dist/cli/import-twic-issue.js"]`. Номер выпуска подаётся через `--overrides.containerOverrides.command[1]`, см. команду ниже.
- Env: те же, что у `oneshot` (`ARCHIVE_DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `NODE_ENV=production`). **Исключение:** `AWS_EMF_*` переменные — не задаём (см. §2.4.2).
- `logConfiguration.awslogs-group: /kingside/archive-importer-adhoc`, `retention: 30 days`.
- `cpu=256, memory=512`, `stopTimeout: 120` — тот же sizing, что и у `oneshot` (§2.1, §2.4.5). Общий код-путь `TwicImporter.runForIssue` одинаково аллоцирует память в обоих режимах; bump одного из них без другого не имеет смысла. До закрытия KS-1687 (streaming) ретроспективный импорт крупных TWIC-выпусков на этом sizing'е НЕ работает (OOM); KS-1686 ждёт KS-1687.

**Команда запуска (пример, TWIC-1639):**

```bash
aws ecs run-task \
  --cluster kingside \
  --task-definition kingside-archive-importer-adhoc \
  --launch-type FARGATE \
  --network-configuration '{"awsvpcConfiguration":{"subnets":["subnet-..."],"securityGroups":["sg-..."],"assignPublicIp":"DISABLED"}}' \
  --overrides '{"containerOverrides":[{"name":"archive-importer","command":["node","dist/cli/import-twic-issue.js","1639"]}]}'
```

(Фактические subnet/SG/name берёт devops из `scripts/archive-service-aws-setup.sh` при регистрации task-def.)

#### 2.4.2 EMF-метрики из ad-hoc CLI — НЕ публикуем

**Решение:** ad-hoc CLI НЕ эмитит EMF. Ни исходный код, ни task-def не содержат EMF-publishing. Мониторинг ad-hoc — через CloudWatch Logs Insights поверх `PROGRESS_TAG='[cli:import-twic-issue]'`.

**Обоснование:**
1. `LastSuccessAgeSeconds` (§2.6) считается EMF-паблишером от `archive_sources.lastSuccessAt`. Ad-hoc, по §2.4.3, это поле НЕ обновляет. Если CLI опубликует EMF — метрика покажет корректное, но «старое» значение относительно ПОСЛЕДНЕГО scheduler-run'а, что исказит форму графика без полезного сигнала.
2. `GamesAdded`/`ClassicalRatio` от ad-hoc попадут в тот же namespace `Kingside/ArchiveImporter{Source=twic}` — пики, которых не было в scheduler-рамке. Алёртам они не помешают (их thresholds грубее), но dashboard'ы daily-мониторинга станут шумнее.
3. Если позже понадобится именно CloudWatch-дашборд ad-hoc-активности — заводим отдельный namespace `Kingside/ArchiveImporterAdhoc` с dimension `Source=twic`. Это ровно один `aws-embedded-metrics` config + `import './setup-emf-env'` в CLI. Делаем как follow-up, не сейчас — YAGNI.

**Инвариант кода:** `import-twic-issue.ts` использует `ImporterModule` (а не `ImporterOnceModule`), поэтому `setup-emf-env` side-effect-модуль НЕ импортируется транзитивно — `AWS_EMF_ENVIRONMENT` не устанавливается, `aws-embedded-metrics` в Local-mode не инициализируется, stdout не получает EMF-JSON. Регрессия сломается, только если backend явно добавит EMF-publishing в CLI. Защитный тест: `import-twic-issue.spec.ts` должен проверить, что `setup-emf-env` не импортирован в dependency graph'е CLI (или что `console.log` CLI не содержит `_aws.CloudWatchMetrics` блок в stdout-фикстуре).

**Следствие для task-def:** env-переменные `AWS_EMF_NAMESPACE` / `AWS_EMF_LOG_GROUP_NAME` в `kingside-archive-importer-adhoc` НЕ задаются — явная защита от случайного вовлечения EMF при будущей правке кода.

#### 2.4.3 Инварианты runtime поведения ad-hoc (инфраструктурное + DB)

Текущая реализация `TwicImporter.runAdHoc(issue)` и `cli/import-twic-issue.ts` уже удовлетворяет нижеперечисленному. Этот пункт фиксирует инварианты как ОБЯЗАТЕЛЬНЫЕ — любая будущая правка обязана сохранять поведение или обновлять этот ADR:

1. **`archive_sources.cursor` НЕ меняется.** Scheduler продолжит идти с `cursor+1`, ретроспективный ad-hoc не «проглатывает» будущие выпуски.
2. **`archive_sources.lastRunAt` / `lastSuccessAt` / `lastError` / `totalGames` НЕ меняются.** Alarm `LastSuccessAgeSeconds > 14 days` (§2.6) измеряет исключительно scheduler-pipeline. Ad-hoc-активность невидима для alarm'ов и не «маскирует» реальный сбой.
3. **`archive_imports` строка создаётся с `cursorBefore = cursorAfter = source.cursor`** — это ad-hoc-маркер для SQL-аудита (`WHERE cursor_before = cursor_after`). Добавленные партии атрибутируются через `archive_imports.sourceId + finishedAt`.
4. **Redis-lock `archive:import:lock:twic`, TTL 1800 сек (30 мин), NX.** Тот же ключ, что и у scheduler-tick (ADR-019 §2.11). Race между scheduler и ad-hoc разрешается в пользу того, кто взял lock первым; второй получает `lock held, skipping`:
   - scheduler → `TickResult.runs[twic].status='locked'`, exit 0 (не ошибка).
   - ad-hoc CLI → `throw` с текстом `lock "archive:import:lock:twic" is held`, exit 1 (fatal, оператор видит и ретраит через минуту).
5. **TTL 30 мин достаточен.** Нормальный ad-hoc-импорт одного выпуска ≈ 30–120 сек (один zip 2–5 MiB, ~3000 партий, COPY + position-indexer). 30 мин — 15–60x safety-margin. Если CLI будет SIGKILL'нут извне (OOM, task stopped externally), lock повисит ≤ 30 мин; следующий scheduler-tick в это окно skip'нет — приемлемый blast radius.
6. **Dedup (идемпотентность).** Повторный запуск CLI на уже импортированный выпуск:
   - `filterAlreadyImported(prisma, games)` отбрасывает все `content_hash` из БД → `freshGames=[]` → цикл insert не выполняется → `gamesAdded=0`, `gamesSkipped=<all>`.
   - `status='ok'` (не `'failed'`), exit code = 0.
   - `PUBLISH archive:imported` НЕ вызывается (условие `gamesAdded > 0`).
   - Контракт: `no-op idempotent`. Fail-fast / `--force` режимы НЕ вводятся (YAGNI — оператор различает повторный запуск по `gamesSkipped > 0 && gamesAdded == 0` в логе; перезаливка возможна только через ручной DELETE в `archive_games`).
7. **`PUBLISH archive:imported` в Redis при `gamesAdded > 0`.** Подписчик — HTTP-процесс `archive-service:3003`, сбрасывает кеш `/tree` и `/games`. Если publish упал (Redis недоступен), CLI логирует warning и завершается exit 0 — кеш всё равно TTL-инвалидируется.

**Тесты (backend, в рамках последующего тикета KS-E08-like):**
- Integration-тест на `TwicImporter.runAdHoc` с fixture Prisma: проверяет что `archive_sources` row НЕ изменился после вызова (все 6 полей из инварианта #2 остались равны), а в `archive_imports` создана строка с `cursor_before = cursor_after`.
- Integration-тест на повторный `runAdHoc(1639)` → второй вызов даёт `{gamesAdded:0, gamesSkipped=N, status:'ok'}`, `archive_sources` не тронут.
- Unit-тест CLI (уже есть в `import-twic-issue.spec.ts:119`) проверяет `PUBLISH` не вызывается при `gamesAdded=0`.

#### 2.4.4 Взаимодействие с EventBridge Scheduler

- Оба (scheduler-triggered `importer-once.js` и ad-hoc `cli:import-twic-issue.js`) берут **один и тот же Redis-lock** `archive:import:lock:twic` (ADR-019 §2.11). Поведение при race описано в §2.4.3 #4.
- Ad-hoc CLI, запущенный в 20:00 UTC ± минуты со scheduler'ом — один из них возьмёт lock, второй получит busy. Low-probability, но терпимо.

#### 2.4.5 Memory budget, OOM KS-1684 и streaming-фикс KS-1687

**Факт (KS-1684 smoke, 2026-04-21):** задача `kingside-archive-importer-adhoc` с sizing'ом `256 CPU / 512 MiB` упала OOM exit 137 через 23m37s на ретроспективном импорте TWIC-1639. CLI успел: поднять Nest-context, подключиться к Redis+Postgres, скачать zip, выполнить `parseBatch()` → `parsed=8182 failed=389`. OOM случился ДО `filterAlreadyImported` / insert-loop.

**Диагностика пика RSS (анализ `TwicImporter.runForIssue` + `pgn-utils.parseBatch`):**

| Этап | Источник памяти | Оценка (8 000 партий) |
| - | - | - |
| `decodePgnBuffer` | Полная PGN-строка в памяти (buffer → utf8) | 20–40 MiB |
| `splitPgn` | Массив raw-строк на партию | 20–30 MiB |
| `parseBatch` → `ParsedGame[]` | `raw: string` + `moves: GameMoveStep[]` (UCI+FEN-after на каждый ход, 50–100 плайев на партию) + `finalFen` + contentHash | 100–160 MiB |
| `filterAlreadyImported` | Prisma findMany with IN (8 000 × 20 bytes) + Set<hex> в памяти | 5–15 MiB |
| `addedGames[]` + `positionRows[]` во время insert-loop | position rows копятся для classical партий (≈ 70% × 8 000 × 70 плайев × ~500 байт) | 150–200 MiB |
| V8 heap overhead + GC headroom | 2× пика пользовательских данных | 300–400 MiB |
| NestJS context + Prisma engine + ioredis baseline | | 80–120 MiB |
| **Пик RSS при in-memory пайплайне** | | **~600–900 MiB** |

**Решение: НЕ повышаем sizing. Переписываем пайплайн в streaming (KS-1687).**

Применяется инвариант §0 «code optimization first, hardware bump second». Sizing-bump до 1024/4096 обсуждался и **отклонён пользователем**; причина — маскирование архитектурной проблемы (in-memory аккумуляция всего TWIC-выпуска) на очередные 6–12 месяцев до следующего роста TWIC / добавления Lichess-источника. Корень проблемы — не размер контейнера, а то, что `parseBatch` + `addedGames[]` + `positionRows[]` держат O(N) по всему выпуску вместо O(chunk).

**План KS-1687 (streaming/chunked PGN pipeline, HIGH priority, БЛОКЕР KS-1686):**

*Уровень 1 — chunk-loop в `runForIssue` (обязательный):*

- `splitPgn` и `parseBatch` вызываются как сейчас, но результат не передаётся целиком в дальнейший пайплайн. Вместо этого — chunk-итерация с размером **N=500 партий**:
  ```
  for chunk of chunks(games, 500):
      freshChunk = filterAlreadyImported(prisma, chunk)
      for game of freshChunk:
          try create archive_game (P2002 → skipped++)
          if isClassical: positionRows.push(...)
      PositionIndexer.index(chunk-classical)
      PositionWriter.write(positionRows)
      addedGames += chunk.added; positionRows = []; addedGames-stats tracked
  ```
- После каждого chunk'а `positionRows`, `addedGames`-внутренний буфер и `freshChunk` становятся eligible к GC. Heap growth линейный по одному chunk'у, не по всему выпуску.
- Агрегированная статистика (`gamesParsed`, `gamesAdded`, `gamesSkipped`, `classicalRatio`) копится по chunk'ам и пишется в `archive_imports` одной финальной `update()`-строкой (как сейчас — один audit row на issue, не по одному на chunk).
- Ожидаемый peak RSS: ~250–300 MiB (PGN-строка `decodePgnBuffer` и `ParsedGame[]` после `parseBatch` всё ещё держатся полностью; в 512 MiB с запасом для GC).

*Уровень 2 — streaming split/parse (условный, если уровень 1 не укладывается в < 400 MiB):*

- `splitPgn` → async generator `splitPgnStream(buffer)` с построчной детекцией headers'ов. Yield по одной партии, без накопления полного `string[]`.
- `parseBatch` заменяется на потребление генератора: батчами по 500 передаём в chunk-loop уровня 1, после чего батч eligible к GC.
- `decodePgnBuffer` — возможно заменить на streaming-decode через `iconv-lite` streaming-transform (buffer → utf8 chunk → pgn-line-splitter).
- `AdmZip` — если станет узким местом (держит полный unzip в памяти), заменить на streaming-unzip (`unzipper` или `yauzl`).
- Ожидаемый peak RSS после уровня 2: ~150 MiB постоянно, независимо от размера TWIC-выпуска.

**Критерии приёмки KS-1687 (must-have в тикете backend'а):**

1. **Memory-smoke тест** в Jest: создаётся fixture TWIC-pgn 8 000 партий (или рекорд TWIC-1639 как fixture в tests/fixtures), запускается `runForIssue` с `--max-old-space-size=384` (ограничение V8 heap до 384 MiB). Тест проходит без OOM. Если не проходит после уровня 1 — реализуется уровень 2.
2. **Chunk-boundary dedup correctness**: unit-тест на сценарий когда один `content_hash` встречается в двух разных chunk'ах одного выпуска (дубликат партии внутри выпуска). Первый chunk вставит, второй должен увидеть через `filterAlreadyImported` → skipped. Контракт: dedup работает независимо от границы chunk'а.
3. **Aggregate audit row**: `archive_imports` получает **один** row на issue (не по chunk), с правильно агрегированными `gamesParsed`, `gamesAdded`, `gamesSkipped`. Тест проверяет, что после импорта в БД ровно один audit row со всеми тремя счётчиками == сумме по chunk'ам.
4. **Metric parity**: `archive_import_games_total{status='added|skipped|failed'}` инкрементируется ровно столько же раз, сколько в старой in-memory реализации, на том же fixture. Без «double-counting» на chunk-boundary.
5. **Transactional semantics per-chunk**: см. подраздел ниже.

**Transactional semantics chunk'а (консультация backend'у):**

Три варианта, для KS-1687 рекомендуется вариант C:

- **A: chunk в одной `$transaction`.** Все 500 inserts + `PositionIndexer.index` + `PositionWriter.write` в одной Prisma-транзакции. Плюс: atomic — либо весь chunk записан, либо ничего. Минус: долгая транзакция (500 × ~10 ms = 5 сек) держит connection + locks; race с параллельными scheduler/ad-hoc через Redis-lock уже защищает, но connection pool всё равно занят; на 16 chunk'ах (8000 партий) — 80 сек занятой транзакции, близко к `statement_timeout` в Postgres. Overkill для idempotent'ного импорта.
- **B: chunk вне транзакций, каждый `create()` в auto-commit.** Как сейчас. Плюс: connection free после каждой записи, короткие транзакции. Минус: partial chunk возможен (если процесс упал на 250-м create'е из 500) — но это не проблема: `content_hash` UNIQUE + P2002 catch делает retry idempotent'ным.
- **C (РЕКОМЕНДУЕТСЯ): chunk вне транзакций, insert-loop в auto-commit, только `PositionWriter.write` (COPY staging) — в собственной короткой транзакции.** `archive_games.create` — auto-commit, как в текущей реализации (catches P2002). `PositionIndexer.index` и `PositionWriter.write` внутри себя уже используют собственные транзакции или ON CONFLICT semantics (ADR-015/ADR-019) — не трогаем, у них контракт идемпотентности. Aggregate-update `archive_imports` в finale одной транзакцией с локом на row'е.

  Обоснование: chunk уже идемпотентен через UNIQUE `content_hash`. `$transaction` не добавляет ценности (partial chunk безопасен при retry), но добавляет lock-contention. Chunk-boundary crash просто значит что половина partий уже в `archive_games`, retry импорта того же issue подхватит, `filterAlreadyImported` их отсечёт на следующем пробеге.

  **Явное следствие:** `archive_imports` audit-row обновляется только один раз финально. Если crash между chunk'ами — audit row останется в `status='running'`. Это бага текущей реализации (KS-1687 не обязан её чинить, но может). Follow-up: stale `archive_imports.status='running' AND finished_at IS NULL AND created_at < now() - interval '2 hour'` → sweeper marks as `'failed'`. Отдельный тикет.

**Риск до закрытия KS-1687:**

Пока KS-1687 не реализован, `oneshot` scheduler-tick **уязвим к OOM** при `cursor+1` → крупный TWIC-выпуск (>~2k партий). Конкретные последствия:

- OOM на scheduled-tick → exit 137 → ECS Task State Change с `containers.exitCode=137` → alarm A3 (`SourcesFailed > 0 за 1 ч`, §2.7) триггерится **в течение часа**, НЕ через 14-дневный A4.
- Cursor не сдвинется (в auto-commit `update archive_sources SET cursor=...` выполняется только после успеха `tickOnce()`). Следующий scheduled-tick через 24 ч попробует тот же выпуск — если KS-1687 ещё не задеплоен, OOM повторится. Gap в импорте = 24 ч × N дней до реализации KS-1687.
- `archive_imports.status='running'` с незакрытым `finished_at` — остаётся stale до ручной чистки / KS-1687 sweeper'а.

Принятый риск: пользователь + координатор подтвердили, что такой gap в impor'те (до недели, пока backend делает KS-1687) приемлем; alarm A3 ловит сбой в течение часа, оператор видит. Если во время этого окна приходит «большой» TWIC-выпуск (среда вечером UTC — штатное время release'ов TWIC), gap продлевается на каждый последующий daily-retry до закрытия KS-1687.

**Ретроспективный импорт (KS-1686) ЖДЁТ KS-1687.** До реализации streaming ни один ад-хок запуск крупного выпуска не сработает. KS-1686 не запускать на `256/512` — это повторный OOM, бесполезный цикл.

### 2.5 Мониторинг short-lived tasks

**Проблема:** Prometheus scrape работает только при running-контейнере, достижимом по ecs-discovery. Short-lived task (живёт 30с–30мин — потолок поднят 2026-04-29 KS-2123, см. §2.7.1) не попадёт в scrape interval (15–30с) на N=1 scrape'е гарантированно, а на продолжительности 30с — вероятность ~50%. Потеря метрик недопустима для CloudWatch Alarm'а из §2.6.

**Варианты (уже сравнены в постановке):**

| # | Вариант | Оценка |
| - | - | - | - |
| A | **Prometheus PushGateway** | Поднимать managed/self-hosted PushGateway, new long-running компонент в стеке. Prometheus-native semantics (`instance` label теряется — все task'и выглядят как одна instance без хитрого labeling). Не решает RunTask failed до start (metrics вообще не пришли). Требует outbound доступ от task до PushGateway. Overkill для одной метрики. |
| B | **CloudWatch Embedded Metric Format (EMF) через awslogs** | Task stdout пишет EMF-JSON (строка JSON с метрикой + dimensions + timestamp). CloudWatch Logs агент (ECS Fargate, awslogs driver) автоматически парсит и создаёт CloudWatch Metric. Zero infra. Лаг до появления в CloudWatch ~30 сек. Работает даже если task упала — метрики, записанные до ошибки, попадают. |
| C | **CloudWatch PutMetricData API прямой** | `aws-sdk/client-cloudwatch` → 1 HTTP-вызов на метрику. Нужны IAM permissions `cloudwatch:PutMetricData`. Синхронный, добавляет 100–300ms к shutdown. Просто, но зависит от AWS SDK в образе. |
| D | **ECS task_stopped EventBridge event** | Пассивный monitoring через `"ECS Task State Change", "lastStatus": "STOPPED", "stopCode": "EssentialContainerExited", "exitCode": !=0` → SNS. Детектирует только факт падения, а не бизнес-метрики (games_added, classical_ratio). |

**Рекомендация — комбинация B + D:**

1. **EMF для бизнес-метрик:** `ArchiveImportMetricsService` в один-раз-режиме дополняется `EmfMetricsPublisher` — утилитарный `@Injectable()`, который в `importer-once.ts` после `tickOnce()` читает все Counter/Histogram/Gauge из `MetricsService.registry` и эмитит их в stdout как EMF JSON. Формат EMF:
   ```json
   {
     "_aws": {
       "Timestamp": 1734023400000,
       "CloudWatchMetrics": [{
         "Namespace": "Kingside/ArchiveImporter",
         "Dimensions": [["Source"]],
         "Metrics": [
           {"Name": "ImportDurationSeconds", "Unit": "Seconds"},
           {"Name": "GamesAdded", "Unit": "Count"},
           {"Name": "ClassicalRatio", "Unit": "None"},
           {"Name": "LastSuccessAgeSeconds", "Unit": "Seconds"}
         ]
       }]
     },
     "Source": "twic",
     "ImportDurationSeconds": 47.2,
     "GamesAdded": 2143,
     "ClassicalRatio": 0.84,
     "LastSuccessAgeSeconds": 604800,
     "ExitCode": 0,
     "SourcesChecked": 1,
     "SourcesProcessed": 1,
     "SourcesFailed": 0
   }
   ```
   Прицип: один EMF-log-record на `tickOnce()`, заполняет все существенные метрики. `prom-client` **оставляем как есть** в коде (counters растут внутри tick'а), но в one-shot режиме `/_/metrics` endpoint не поднимается, поэтому снимаем snapshot перед exit'ом через EMF.

   **Библиотека:** `aws-embedded-metrics` (NPM). Легковесная, без транзитивного `aws-sdk`. Альтернатива — самописать ручной `console.log(JSON.stringify(emfObject))`, но EMF-формат чувствителен к structure'у, библиотека проверяет.

2. **ECS Task State Change для exit code monitoring:**
   EventBridge rule (отдельный от Scheduler):
   ```json
   {
     "source": ["aws.ecs"],
     "detail-type": ["ECS Task State Change"],
     "detail": {
       "clusterArn": ["arn:aws:ecs:...:cluster/kingside"],
       "taskDefinitionArn": [{"prefix": "arn:aws:ecs:...:task-definition/kingside-archive-importer-oneshot"}],
       "lastStatus": ["STOPPED"],
       "stopCode": [{"anything-but": ["EssentialContainerExited"]}]
     }
   }
   ```
   → SNS topic `kingside-archive-importer-alerts` → email/Slack webhook.

   Это ловит: OOM, network timeout, permission denied на RunTask-starting-phase, impossible-to-pull-image (rare). `EssentialContainerExited` — штатное завершение контейнера с exit code (нужно отдельно: если `exitCode != 0` — alert, через другой rule fragment):
   ```json
   {
     "source": ["aws.ecs"],
     "detail-type": ["ECS Task State Change"],
     "detail": {
       "clusterArn": ["arn:aws:ecs:...:cluster/kingside"],
       "taskDefinitionArn": [{"prefix": "..."}],
       "lastStatus": ["STOPPED"],
       "containers": {
         "exitCode": [{"anything-but": 0}]
       }
     }
   }
   ```

3. **Prometheus на HTTP-процессе (`archive-service:3003/_/metrics`) остаётся.** HTTP-процесс long-running; `archive_tree_*` и `archive_tree_cache_hit_ratio` продолжают scrape'иться. **Ecs-discovery sidecar для `archive-importer:3004`** — удаляется в шаге 5 (см. §2.8).

**Имена EMF метрик** — **отличаются** от `prom-client` имен (PascalCase в CloudWatch vs snake_case в Prometheus). Обоснование: CloudWatch и Prometheus — разные системы мониторинга, смешивать naming convention'ы опаснее, чем принять каждой её стиль. Все alarm'ы ADR-020 (§2.6, §2.7) — на EMF/CloudWatch; grafana-дэшборды — на Prometheus и только для HTTP-процесса.

**Имена метрик prom-client НЕ меняем** (ADR-019 §2.8 — инвариант стабильности). Prom-client для importer-once не видим наружу, но код инкрементирует их внутри tick'а — тесты спецификации продолжают работать.

### 2.6 CloudWatch Alarm «нет успешных импортов >14 дней»

**Решение:** добавить вычисляемую метрику `LastSuccessAgeSeconds` в EMF snapshot (§2.5). Importer-once в конце `tickOnce()`:
```ts
const src = await prisma.archiveSource.findFirst({ where: { code: 'twic' } });
const ageSec = src.lastSuccessAt ? (Date.now() - src.lastSuccessAt.getTime()) / 1000 : Infinity;
emf.setMetric('LastSuccessAgeSeconds', ageSec, 'Seconds', { Source: 'twic' });
```

Даже при no-op tick'е (isDue == false) EMF snapshot публикуется и метрика обновляется. CloudWatch alarm:

```
AlarmName: kingside-archive-importer-stale-success
Namespace: Kingside/ArchiveImporter
MetricName: LastSuccessAgeSeconds
Dimensions: [{Source: twic}]
Statistic: Maximum
Period: 3600                          # 1 hour
EvaluationPeriods: 2
DatapointsToAlarm: 2
Threshold: 1209600                    # 14 days = 14*24*3600
ComparisonOperator: GreaterThanThreshold
TreatMissingData: breaching           # если метрики нет 1+ часов — alarm тоже
AlarmActions: [SNS topic kingside-archive-importer-alerts]
```

**Почему `TreatMissingData=breaching`:** если EMF метрика не приходит (importer-once не запустился, не смог EMF-писать, task упала до shutdown-hook'а) — это тоже signal проблемы, alarm должен сработать. Альтернатива `missing` даст false-negative на случай scheduler disabled.

**Почему `Period=1h, Evaluation=2`:** daily schedule → минимум одно прибытие в сутки → метрика точно обновляется. 1h period + 2 periods = alarm после 2 часов missing data + на фоне 14 дней значения. Запас для кратковременных сбоев (AWS zone degradation на час не вызывает алерт).

**Комментарий про 14 дней.** TWIC выходит раз в неделю. `LastSuccessAgeSeconds` обновляется при каждом **успешном** `TwicImporter.run()`, то есть при `status in ('ok', 'partial', 'noop')`. Значит штатно age < 8 дней в любой момент. Threshold 14 дней — один пропущенный цикл это нормальная картина при задержке TWIC publisher'а, два пропущенных — уже аномалия. Можно ужесточить до 10 дней, если devops хочет более агрессивный alert. Решение: **14 дней как в постановке**, оставляем follow-up tuning.

### 2.7 Риски отказа + быстрая детекция

Кроме alarm'а §2.6 (14 дней), нужны ранние детекторы:

| # | Сценарий отказа | Детектор | Лаг детекции |
| - | - | - | - |
| 1 | EventBridge Scheduler не вызвал RunTask (AWS issue) | CloudWatch metric `AWS/Scheduler InvocationsFailedToBeSentToDeadLetterCount > 0` + DLQ `ApproximateNumberOfMessagesVisible > 0`. Alarm SNS. | 1–5 мин |
| 2 | RunTask отвергнут (permissions, capacity, task-def invalid) | EventBridge sends event to DLQ. CloudWatch metric `AWS/Scheduler InvocationAttemptCount` vs `InvocationDroppedCount`. Alarm. | 1–5 мин |
| 3 | Task запустилась, но контейнер не стартанул (image pull fail, task-def malformed) | EventBridge ECS Task State Change → `lastStatus=STOPPED`, `stopCode != EssentialContainerExited` → SNS. | 1–2 мин |
| 4 | Контейнер стартовал, упал с non-zero exit code | EventBridge ECS Task State Change → `containers[*].exitCode != 0` → SNS. | 30 сек |
| 5 | Контейнер вечно висит (TWIC server unresponsive, Redis/DB stall) | Global timeout 30 мин в `tickOnce()` (env `IMPORTER_TICK_TIMEOUT_MS`, default 1 800 000) → throw → exit 2 → детектор #4. Backstop 35 мин в `importer-once.ts` (env `IMPORTER_BACKSTOP_TIMEOUT_MS`, default 2 100 000) ловит зависание самой timeout-ветки. ECS `stopTimeout: 120` остаётся отдельным уровнем graceful shutdown. См. §2.7.1 — обновлено 2026-04-29 (KS-2123). | до 35 мин |
| 6 | Контейнер успешно отработал, но `archive_sources.last_success_at` НЕ обновился (например, один source failed среди нескольких) | EMF metric `SourcesFailed > 0` → CloudWatch Alarm `period=1h, threshold>0`. | 1 ч |
| 7 | `LastSuccessAgeSeconds > 14 days` | §2.6 alarm. | 14 дней |
| 8 | EventBridge Scheduler disabled случайно (человек кликнул в AWS console) | CloudWatch Metric `AWS/Scheduler Invocations` = 0 за >24 ч → alarm. Отдельный от #7, более быстрый. | 1–2 дня |

**Рекомендуемый набор alarm'ов (resumé):**
- A1: DLQ size > 0 (1 мин)
- A2: ECS task stopped with non-ok exit (1 мин)
- A3: `SourcesFailed > 0` за 1 ч (1 ч)
- A4: `LastSuccessAgeSeconds > 14 days` (2 ч после missing, 14 дней значения)
- A5: `AWS/Scheduler Invocations == 0` за 24 ч (1 день)

Все → single SNS topic `kingside-archive-importer-alerts` → Slack webhook / email.

### 2.7.1 Update 2026-04-29 (KS-2123): дефолты таймаутов повышены до 30 / 35 мин

**Контекст.** С 24-04-2026 дневной импортёр (`kingside-archive-importer-daily`, EventBridge cron 20:00 UTC) стабильно падал с exit 124. Корень — рост размера TWIC weekly: выпуск `twic1642` (7 119 партий) парсится ~17 мин при исторических 30–120 сек. Прежний потолок `tickOnce` 8 мин (480 000 мс) и backstop 10 мин (600 000 мс), изначально заявленный как «4×–60× safety margin», перестал покрывать реальный размер.

**Решение (в коде, KS-2123, commit `0bc38406`).**

| Параметр | Было | Стало (default) | Env-override |
| - | - | - | - |
| `tickOnce` global timeout | 480 000 мс (8 мин) | 1 800 000 мс (30 мин) | `IMPORTER_TICK_TIMEOUT_MS` |
| `importer-once.ts` backstop | 600 000 мс (10 мин) | 2 100 000 мс (35 мин) | `IMPORTER_BACKSTOP_TIMEOUT_MS` |

Дефолты и резолверы env вынесены в `apps/archive-service/src/archive-import/importer-timeouts.ts`. Контракт резолвера: пустой / отсутствующий / `NaN` / `≤0` env → fallback на default без ошибки. Резолв происходит на каждый `tickOnce()` / bootstrap — менять значения через task definition env можно без redeploy кода (только перезапуск task'а).

**Инвариант (зафиксирован в `importer-timeouts.spec.ts`):** `backstop > tickOnce` (35 > 30 мин). Backstop ловит зависание самой timeout-ветки `tickOnce` (Promise.race / EMF flush / Nest shutdown hooks); если эти 5 мин запаса исчезнут, контейнер может зависнуть на отдельном уровне выше exit 2 — детектор #4 §2.7 потеряет достоверность.

**ECS `stopTimeout: 120` остаётся 120 сек.** Это про SIGTERM→SIGKILL после прикладного `process.exit()`, а не про прикладной таймаут. Внутренний `exit(124)` всегда опережает ECS stop. Если контейнер не успевает завершиться за 120 сек после внутреннего exit — отдельная задача devops, не покрывается этим ADR.

**Known issue (KS-2128, параллельно).** Парсер деградировал: 7 119 партий за ~17 мин ≈ 7 партий/сек против исторических ~50–100 партий/сек на меньших выпусках. Это не блокирует импорт после повышения таймаутов, но указывает на регрессию (возможно — O(N²) в дедупликации, position-indexer'е или PGN-парсере). KS-2128 — профилирование. **Если устранится — defaults можно вернуть к меньшим значениям**, не трогая контракт env-override.

**Откат / тюнинг без redeploy.** Через task definition env:

```
IMPORTER_TICK_TIMEOUT_MS=2400000      # 40 мин (если 30 окажется мало)
IMPORTER_BACKSTOP_TIMEOUT_MS=2700000  # 45 мин (соблюдая инвариант backstop > tickOnce)
```

Любая правка должна сохранять `backstop > tickOnce` и оставлять оба меньше суммарного времени, после которого EventBridge может стартовать следующий tick (для weekly schedule — 7 дней, не угроза; для daily — 24 ч, тоже не угроза при потолке 35 мин).

**Влияние на §2.7 таблицу:** строка #5 «Контейнер вечно висит» — обновлена inline (timeout 30 мин, backstop 35 мин, лаг детекции «до 35 мин» вместо «до 10 мин»).

**Влияние на §2.3 cost.** Medium estimate task duration вырос 2 мин → 5 мин (TWIC weekly после роста выпусков). Числа в §2.3 пересчитаны; общий вывод «копейки против \$10–15/мес 24/7» не меняется.

### 2.8 План миграции без риска

Инвариант: в любой момент между шагами 1 и 4 либо постоянный importer service, либо EventBridge schedule, либо **оба** активны. Никогда не оставляем zero-source-of-truth ticks.

**Шаг 0 (backend, обратимо, код).** PR добавляет:
- `apps/archive-service/src/importer-once.ts`.
- `apps/archive-service/src/importer-once.module.ts`.
- Метод `ArchiveImportService.tickOnce(): Promise<TickResult>` + его вызов из существующего `@Interval tick()` (не ломает loop-режим).
- `ArchiveImportService` метрика `LastSuccessAgeSeconds` — вычисляется после обхода source'ов.
- Класс `EmfMetricsPublisher` (`apps/archive-service/src/metrics/emf-metrics-publisher.ts`), регистрируется в `MetricsModule` (exports).
- Dev-зависимость: `aws-embedded-metrics` (runtime dep).
- Unit-тесты: `importer-once.spec.ts` (mock NestJS context, mock EMF, mock `ArchiveImportService.tickOnce`), `emf-metrics-publisher.spec.ts` (EMF JSON format проверка).

**НЕ трогает** `importer-main.ts`, `ImporterModule`, `ArchiveImportModule` impl — loop-режим остаётся работать ровно как сейчас.

Commit mergeable, deploy безрисковый (новый код не исполняется, пока кто-то не вызовет `node dist/importer-once.js`).

**Шаг 1 (devops, параллельный).** Новые AWS-артефакты, **не трогая** старого `kingside-archive-importer` service:
- ECS task-def family `kingside-archive-importer-oneshot`, image URI = current ECR `kingside-archive-service:<latest-sha>`.
- IAM role `EventBridgeSchedulerArchiveImporterRole`.
- SQS queue `kingside-archive-importer-dlq` + Alarm A1.
- EventBridge Scheduler `kingside-archive-importer-twic`, **`State=DISABLED`** (важно).
- EventBridge rule + SNS topic для A2/A3.
- CloudWatch alarms A1–A5 (подписаны на SNS, пока только лог в Slack, без срочной эскалации).
- `aws ecs run-task ... --task-definition kingside-archive-importer-oneshot` вручную для smoke — ожидаем exit 0, EMF record в CloudWatch Logs.

**Шаг 2 (devops, параллельный запуск).** `State=ENABLED` на EventBridge schedule. **Старый service `kingside-archive-importer` продолжает desired=1**. Оба теперь тикают: old service каждые 60с через `@Interval`, new schedule ежедневно в 20:00 UTC.
- Redis-lock гарантирует отсутствие двойного импорта одного source'а.
- В логах new-task увидим `lock held, skipping` для twic большинство дней — это штатно, scheduler-of-scheduler'ов.
- Единственное отличие от штатной работы: EMF метрики начнут приходить, на Prometheus scrape длящиеся task'ы одноразово попадать, но мы не полагаемся на это для alerting — только EMF.

Soak 7 дней. Проверяем:
- `LastSuccessAgeSeconds` в CloudWatch — видит текущее обновление (< 8 дней сразу после first success).
- `SourcesFailed == 0`.
- No DLQ messages.
- ECS task events: exit codes всегда 0.
- EMF snapshot содержит ожидаемые поля.

**Шаг 3 (devops, cutover).** После успешного soak'а:
- `aws ecs update-service --service kingside-archive-importer --desired-count 0`. Старый контейнер остановлен. EventBridge schedule — единственный триггер importer'а.
- Soak ещё 14 дней (минимум два цикла недельного TWIC, чтобы убедиться, что schedule-triggered import реально двигает `last_success_at`).

Rollback: `--desired-count 1` — мгновенно возвращает постоянный importer. EventBridge schedule продолжает тикать, Redis-lock предотвращает double-import.

**Шаг 4 (devops, удаление).** После soak'а шага 3:
- `aws ecs delete-service --service kingside-archive-importer`.
- Удалить Prometheus scrape target `archive-importer:3004/_/metrics` из ecs-discovery конфига.
- Удалить старую task-def family `kingside-archive-importer` (оставить в ECS task-def архиве на 90 дней — AWS архивирует, не сразу deregister).
- Обновить `docker-compose.yml`: удалить сервис `archive-importer` с `command: node dist/importer-main.js`. Заменить на вручную-запускаемый `docker compose run --rm archive-importer-oneshot`-style в локальном dev (опционально; альтернатива — оставить loop-сервис только в dev).

**Шаг 5 (backend, опциональный, follow-up).** Решить судьбу `importer-main.ts`:
- **Вариант A (оставить):** удобный dev-mode для локальной разработки (в compose тикает каждую минуту, не нужен EventBridge в docker-compose). `@Interval` код остаётся in repo, в проде не используется.
- **Вариант B (удалить):** убрать `importer-main.ts`, `importer.module.ts`, `ScheduleModule.forRoot()` зависимость, `@Interval` декоратор из `ArchiveImportService`. Dev-тестирование через `docker compose run --rm archive-importer-oneshot`. Меньше dead code, но больше friction в dev.
- **Рекомендация:** Вариант A. Оставляем dead (для прода) код, ценность dev-UX выше. Код тривиальный, не ломается сам.

**Итого таймлайн:**
- Шаг 0: 1–2 дня backend (малый PR).
- Шаг 1: 1 день devops.
- Шаг 2 soak: 7 дней.
- Шаг 3: 1 момент + 14 дней soak.
- Шаг 4: 1 день devops.
- Шаг 5: на усмотрение, через 1–2 месяца.

**Общая продолжительность до удаления старого service:** ~3–4 недели от мерджа backend-PR'а.

## 3. Последствия

- **Backend.** Малый PR (`importer-once.ts` + `importer-once.module.ts` + `tickOnce()` + `EmfMetricsPublisher` + `aws-embedded-metrics` dep + тесты). Не меняет существующий loop-режим. Не меняет публичный API archive-service HTTP.
- **DevOps.** Новая EventBridge schedule, новая IAM role, **две новые task-def family** (`kingside-archive-importer-oneshot` для daily scheduler + `kingside-archive-importer-adhoc` для CLI ретроспективного импорта, §2.4.1), SQS DLQ, 5 CloudWatch alarms, SNS topic + Slack-webhook. Два отдельных log group'а: `/kingside/archive-importer-oneshot` (retention 90d) и `/kingside/archive-importer-adhoc` (retention 30d). Удаление ECS service `kingside-archive-importer` + Prometheus scrape target. Чистка `docker-compose.yml` (опционально).
- **Biz-выгода.** Экономия \$10–15/мес (1 Fargate task 24/7 → weekly 2-мин task). Нематериально для MVP, но сам паттерн «event-driven serverless для нерегулярных задач» правильно зафиксировать.
- **Мониторинг.** EMF метрики в CloudWatch (имена PascalCase, namespace `Kingside/ArchiveImporter`). Prometheus продолжает scrape HTTP-процесса (`archive-service:3003`); importer-процесс больше не source Prometheus metrics (CloudWatch EMF вместо этого).
- **Grafana.** Если есть dashboard на `archive_import_*` prom-client метриках — он **перестанет обновляться** после Шаг 3. Задача devops: либо мигрировать на CloudWatch datasource + EMF metric names, либо оставить исторические графики «до 2026-05-XX». Решение в ADR не фиксируется — зона devops.
- **Тесты.** Unit'ы на `tickOnce()` (успешный run, lock-held, partial failure), на EMF-publisher (формат JSON), на CLI entrypoint `importer-once.ts` (exit codes 0/1/2).
- **Документация.** Обновить `apps/archive-service/README.md` секцией «One-shot importer mode (EventBridge)». Уточнить в ADR-019 §2.2 (рекомендация "вариант B singleton") ссылку на ADR-020: "этот singleton pattern остаётся только для dev; в проде заменён на EventBridge Scheduler+RunTask per ADR-020".

## 4. Подводные камни и риски

1. **Race с ad-hoc CLI.** Если scheduler тикнул в 20:00:00 и оператор запускает `cli:import-twic-issue` в 20:00:05, один из них получит `lock held, skipping` и exit ≠ 0 (для CLI — это сигнал оператору). CLI в текущей реализации (`apps/archive-service/src/cli/import-twic-issue.ts:100-104`) бросает ошибку если lock занят — оператор получит exit 1. Это ожидаемое поведение, не исправляем.
2. **EMF client flush timing.** `aws-embedded-metrics` использует stdout.write с буферизацией. Если process.exit() вызван сразу, потенциально теряется последний flush. Mitigation: `await emf.flush()` перед `app.close()`; библиотека должна поддерживать явный flush. Если нет — ручной `console.log(JSON.stringify(emfObject))` гарантирует flush перед exit'ом (stdout в ECS awslogs — line-buffered).
3. **CloudWatch Logs awslogs driver batching.** Stdout → logs агент → CloudWatch Logs API в батчах по 5 сек / 64 KiB. Если task завершилась быстрее (2 сек в edge-case идеального lock-skip noop'а) — задержка flush до 5 сек после task stop. ECS `stopTimeout: 120` сек закрывает этот риск: task не стопается моментально, ждёт graceful shutdown.
4. **Task размер памяти.** **Зафиксировано KS-1684:** профиль `256 CPU / 512 MiB` недостаточен для in-memory пайплайна на TWIC-выпусках >~2 000 партий — OOM exit 137 на TWIC-1639 (8 182 партии). Реальный пик RSS ≈ 600–900 MiB (детали в §2.4.5). **Sizing НЕ повышается** (инвариант §0 «code first»). Решение — streaming/chunked pipeline KS-1687 (HIGH priority, блокер KS-1686, см. §2.4.5 и §5). Принятый риск до закрытия KS-1687: scheduler-tick на крупных TWIC-выпусках уязвим к OOM; обнаруживается через alarm A3 (`SourcesFailed > 0 за 1 ч`, §2.7) в течение часа.
5. **IAM ecs:RunTask permissions.** EventBridge Scheduler role требует `ecs:RunTask` + `iam:PassRole` на две роли (task execution role, task role). Подводный камень — policy должна указывать именно ARN task-def, иначе scheduler может запустить **любой** task-def. Least-privilege критичен: `Resource: arn:aws:ecs:...:task-definition/kingside-archive-importer-oneshot:*`.
6. **TWIC publisher availability.** EventBridge запускает каждый день в 20:00 UTC. `theweekinchess.com` может быть недоступен (сервер сайта редко, но падает). Exit 0 если `TwicImporter.run()` возвращает `{status:'failed', error:'HTTP 503'}`? Сейчас — да, task завершается штатно, failure записывается в `archive_sources.last_error`. Это приемлемо: DLQ и alarm 14 дней всё равно ловят persistent failures. Alarm A3 (`SourcesFailed > 0 за 1 ч`) ловит разовые.
7. **Cursor increment in TWIC.** `TwicImporter` идёт от `cursor+1`. Если один TWIC выпуск ещё не опубликован (404) → `status='noop'`, cursor не двигается. Schedule запустит снова завтра. Не ломается.
8. **`@Interval` декоратор при `createApplicationContext` без `ScheduleModule`.** Nest игнорирует декоратор если `ScheduleModule.forRoot()` не импортирован — проверено по исходникам `@nestjs/schedule`. В `ImporterOnceModule` без ScheduleModule `@Interval(60_000)` молча неактивен. Unit test проверяет явно: поднять context через `ImporterOnceModule`, подождать 70 сек, убедиться что `tick()` НЕ вызван автоматически.
9. **Time-zone surprises.** `ScheduleExpressionTimezone: UTC`. Проверить: ECS Fargate контейнер в UTC? Да (AWS default). Prisma `playedAt` timestamp — TIMESTAMPTZ, хранит UTC. `archive_sources.last_success_at` тоже TIMESTAMPTZ. Нет TZ-drift'а.
10. **`desired-count=0` всё ещё ест деньги?** ECS service с `desired-count=0` не имеет running task'ов, не биллится. Но task-def family сохраняется бесплатно. OK.
11. **Scheduler frequency drift.** EventBridge Scheduler не гарантирует точность до секунды, но в рамках минут — надёжен. Для cron(0 20 * * * *) invocation может прийти в 20:00:01–20:00:15, это нормально.
12. **Compare-and-swap для `archive_sources.cursor` при конкурентном ad-hoc + scheduler.** Не проблема: ad-hoc не трогает cursor, scheduler увеличивает только после успешного `run()`. Redis-lock sequences им.
13. **Dev-localhost EventBridge.** Нет. В dev (docker-compose) оставляем loop-режим `importer-main.ts` на `@Interval(60_000)` (Шаг 5 Вариант A из §2.8). EventBridge — только в AWS-облаке. Локальный пользователь вызывает `node dist/cli/import-twic-issue.js <N>` вручную для smoke'а.
14. **Cost of CloudWatch Logs ingest from EMF.** Каждая EMF строка ≈ 1–2 KB JSON. 7 invocations/week × 2 КB ≈ 56 KB/мес. CloudWatch Logs ingest \$0.50/GB. Копейки, не фактор.
15. **CloudWatch custom metrics billing.** Первые 10 metrics free, дальше \$0.30/metric/month. ADR добавляет ~5 уникальных custom metrics (`ImportDurationSeconds`, `GamesAdded`, `ClassicalRatio`, `LastSuccessAgeSeconds`, `SourcesFailed`) × 1 dimension value (`Source=twic`) = 5 metrics. В пределах free tier при одном source'е.
16. **Rollback after Шаг 4.** Удалили service + task-def → rollback требует re-creating (террайформ-снапшот поможет, но ручной откат — 1–2 часа работы devops). Шаг 3 → 4 — точка невозврата. Обязательный 14-дневный soak перед Шагом 4.
17. **Stopped-task log retention.** `/ecs/archive-importer-oneshot` default retention 30 дней в CloudWatch Logs (настраивается). При расследовании failed import важна 90-дневная retention — задача devops при создании log-group'ы.
18. **`importer-main.ts` → `importer-once.ts` случайная правка.** Code review должен отслеживать: правки в `ArchiveImportService.tickOnce()` затрагивают ОБА режима. Правки только в `importer-main.ts` — только loop-режим. Правки только в `importer-once.ts` — только one-shot. Это инвариант тестирования: `tickOnce()` покрыт unit'ом, прогон обоих entrypoints — e2e (hard).
19. **`TickResult` schema evolution.** Добавление нового поля — OK, CloudWatch Logs принимают любой JSON. Удаление поля — нужно синхронно обновить CloudWatch metric filter (если он тянет это поле). Семантическая стабильность схемы — обновлять с версионированием (`schemaVersion: 1` поле в EMF).
20. **Dependabot / security update cadence.** Short-lived task всё ещё должен получать патчи. Build pipeline пересобирает образ на каждый merge → next invocation берёт свежий image. Но если ничего не мержится неделями — image устаревает. Mitigation: CI nightly rebuild + tag bump → ECS task-def автоматически подхватывает (если family использует `:latest` tag — **запрещено для прода**; если semver-пин — нужен devops trigger на rebuild). **Рекомендация:** immutable SHA-pinned image URI в task-def. Дополнительный job в CI: еженедельное `docker build` → push → `aws ecs register-task-definition` с новым image URI → `aws scheduler update-schedule` → новый ARN task-def. Это отдельный тикет devops'а, не в scope ADR.

## 5. Предлагаемые тикеты

- **KS-E01 [backend]** — Шаг 0. Добавить `importer-once.ts`, `importer-once.module.ts`, метод `ArchiveImportService.tickOnce()` с `TickResult`. Добавить `EmfMetricsPublisher` в `MetricsModule`. Dep `aws-embedded-metrics`. Unit-тесты: `importer-once.spec.ts` (exit codes, mock tickOnce), `emf-metrics-publisher.spec.ts` (EMF JSON shape). Обновить `apps/archive-service/README.md` разделом one-shot mode. Не трогать existing `importer-main.ts`.
- **KS-E02 [devops]** — Шаг 1. IAM role + ECS task-def `kingside-archive-importer-oneshot` + SQS DLQ + EventBridge schedule (DISABLED) + EventBridge rule для ECS Task State Change + SNS topic + 5 CloudWatch alarms. Smoke через `aws ecs run-task` вручную.
- **KS-E02b [devops]** — (KS-1683 corrigendum, §2.4.1) ECS task-def `kingside-archive-importer-adhoc` + CloudWatch log group `/kingside/archive-importer-adhoc` retention 30d. Общие IAM/SG/subnet с `oneshot`. Обновить `scripts/archive-service-aws-setup.sh` так, чтобы оба task-def'а регистрировались IaC-скриптом.
- **KS-E02c [backend]** — (KS-1683 corrigendum, §2.4.2/§2.4.3) Защитный unit-тест: CLI `cli/import-twic-issue.ts` не тянет `setup-emf-env` в dependency graph (EMF не должен инициализироваться). Integration-тесты на `TwicImporter.runAdHoc`: инварианты `archive_sources` immutable + `archive_imports.cursor_before == cursor_after` + идемпотентность повторного запуска.
- ~~**KS-E02d [devops]** — Финальный запуск ретроспективного импорта TWIC-1639.~~ **Замещён** тикетом KS-1686 (см. ниже, блокирован KS-1687).
- **KS-E03 [devops]** — Шаг 2. `State=ENABLED` на schedule. 7 дней soak, проверка EMF + alarm'ов.
- **KS-E04 [devops]** — Шаг 3. `desired-count=0` на `kingside-archive-importer` service. 14 дней soak.
- **KS-E05 [devops]** — Шаг 4. `delete-service`, удаление Prometheus scrape target, cleanup docker-compose.yml.
- **KS-E06 [qa]** — Smoke-план по каждому шагу: manual invoke на стейдже → проверка EMF метрик → CloudWatch Alarm синтетический триггер (временно threshold=1 → проверка SNS → вернуть threshold) → проверка что `archive_sources.last_success_at` двигается.
- **KS-E07 [devops, опционально]** — Weekly ECR image rebuild trigger (security updates) + task-def registration pipeline. Follow-up, не блокирует KS-1680.
- ~~**KS-E08 [devops]** — Bump sizing task-def'ов.~~ **Отменён** (2026-04-21) после отказа пользователя от подхода «bump sizing». Применяется инвариант §0, решение — streaming. Тикет KS-E09 замещает.
- **KS-E09 ≡ KS-1687 [backend, HIGH priority, блокер KS-1686]** — Streaming/chunked PGN pipeline (§2.4.5). Переписать `TwicImporter.runForIssue` + insert-loop на chunk-iteration (N=500). Уровень 1 (chunk-loop) обязательный; уровень 2 (streaming split/parse + streaming unzip) — условный, включается если уровень 1 не укладывается в peak RSS <400 MiB на fixture 8k партий. Критерии приёмки:
  1. Memory-smoke test в Jest на fixture TWIC-1639 (8 182 партии) с `--max-old-space-size=384` — проходит без OOM.
  2. Chunk-boundary dedup correctness — unit-тест: один `content_hash` встречается в двух разных chunk'ах, второй chunk видит в БД через `filterAlreadyImported`.
  3. Aggregate audit row — один `archive_imports` row на issue, с правильно агрегированными счётчиками.
  4. Metric parity — `archive_import_games_total` инкрементируется то же N раз, что в in-memory версии.
  5. Transactional semantics — см. §2.4.5 «Transactional semantics chunk'а», рекомендация: chunk вне транзакций (C), insert-loop в auto-commit с P2002 catch, aggregate-update `archive_imports` одной финальной транзакцией.
- **KS-1686 [devops, заблокирован KS-1687]** — Финальный ретроспективный импорт TWIC-1639 через `kingside-archive-importer-adhoc`, после merge KS-1687 и re-deploy archive-service образа. Пост-проверка: `SELECT count(*) FROM archive_games WHERE import_id IN (SELECT id FROM archive_imports WHERE file_name='twic1639.pgn')` > 0; `archive_sources.cursor` не изменился; peak RSS контейнера < 512 MiB (из ECS container insights).
