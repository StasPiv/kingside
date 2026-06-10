/**
 * KS-2775. После успешного TWIC-импорта запускаем ECS run-task
 * `tactic-worker` с параметрами `--import-id=<свежий>` `--exclude-used`
 * `--min-rating=2400`, чтобы автоматически генерировать PVE-пазлы
 * на новых партиях. Запуск идёт строго по событию импорта — без
 * polling'а или cron'а.
 *
 * Feature-flag `AUTO_TRIGGER_PVE_GEN`:
 *   - `'true'` / `'1'` / `'on'` — триггер активен.
 *   - всё остальное / unset — no-op (импорт работает как раньше).
 *
 * Безопасность: при отсутствии env или ошибке AWS-SDK логируем
 * warning и возвращаем `{triggered: false}` — TWIC-импорт ОСТАЁТСЯ
 * успешным. Регенерация — best-effort: при провале её можно перезапустить
 * руками или подождать следующего цикла.
 */
import type { Logger } from '@nestjs/common';

export interface TriggerPveGenerationArgs {
  /** UUID `pgn_imports.id` свежего импорта — пробрасывается в `--import-id`. */
  importId: string;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /**
   * Подмена ECSClient для тестов. В production создаётся внутри
   * через dynamic `import('@aws-sdk/client-ecs')` — пакет ставится как
   * dependency в `apps/archive-service/package.json` (KS-2775).
   */
  ecsClientFactory?: () => Promise<{
    send: (cmd: unknown) => Promise<{ tasks?: Array<{ taskArn?: string }> }>;
  }>;
  /** Подмена RunTaskCommand-фабрики для тестов. */
  runTaskCommandFactory?: (input: unknown) => unknown;
  /** Подмена `process.env` для тестов. */
  env?: NodeJS.ProcessEnv;
}

export interface TriggerPveGenerationResult {
  /** true — хотя бы один RunTask успешно отправлен. */
  triggered: boolean;
  /**
   * ARN первого успешно запущенного task'а (обратная совместимость).
   * При шардинге см. `taskArns`.
   */
  taskArn?: string;
  /** KS-3396. ARN всех успешно запущенных task'ов (по одному на шард). */
  taskArns?: string[];
  /** KS-3396. Сколько шардов пытались запустить (= PVE_SHARD_COUNT). */
  shardCount?: number;
  /** Причина пропуска / ошибки (для `triggered=false` или частичного успеха). */
  reason?:
    | 'feature-flag-off'
    | 'missing-env'
    | 'sdk-load-failed'
    | 'run-task-failed'
    | 'no-task-returned'
    | 'partial';
  /** Текст ошибки при `triggered=false` (для логирования). */
  error?: string;
}

const TAG = '[pve-gen-trigger]';

const TACTIC_CONTAINER_NAME = 'tactic-worker';

function isFlagOn(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === 'true' || s === '1' || s === 'on';
}

/**
 * Собирает массив argv для `node dist/main.js generate-puzzles ...`.
 * Зафиксированный набор флагов соответствует запросу пользователя:
 * play-vs-engine, --min-rating=2400, --nodes=10000000, --half-moves-n=6.
 *
 * KS-3364: серверная prod-генерация переведена с `--time-ms=400` на
 * `--nodes=10_000_000` ради детерминизма и качества WDL.
 *
 * KS-3398: откат к `--time-ms=1000` (movetime 1 сек на позицию, как у
 * клиента). Причина (KS-3397): на 10M nodes движок уходит слишком
 * глубоко и чаще видит защиту/компенсацию → ход перестаёт быть зевком
 * (deltaW < порога) → аномально низкий выход пазлов (единицы/час против
 * ~4/партия на клиенте). Решение пользователя — уравнять строгость
 * отбора с клиентской; финальное качество страхует клиентский глубокий
 * реалтайм-анализ при решении (analyzeLive, KS-3391/3394). Нативный
 * сервер за 1 сек уходит чуть глубже WASM-клиента — это принято как ОК.
 *
 * KS-3396: при `shard` (shardCount>1) добавляем `--shard=i/N` — задача
 * берёт только свою непересекающуюся долю партий. Без shard (или N≤1)
 * флаг не добавляется — поведение прежнее (вся база в одной задаче).
 */
function buildTacticCommand(
  importId: string,
  shard?: { index: number; count: number },
): string[] {
  const cmd = [
    'node',
    'dist/main.js',
    'generate-puzzles',
    '--solution-mode=play-vs-engine',
    `--import-id=${importId}`,
    '--exclude-used',
    '--min-rating=2400',
    '--max-games=inf',
    '--time-ms=1000',
    '--half-moves-n=6',
  ];
  if (shard && shard.count > 1) {
    cmd.push(`--shard=${shard.index}/${shard.count}`);
  }
  return cmd;
}

/**
 * KS-3396. Число шардов из env `PVE_SHARD_COUNT`. default 1 (без
 * шардинга). Невалидное / <1 → 1.
 */
function resolveShardCount(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PVE_SHARD_COUNT ?? 1);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

export async function triggerPveGeneration(
  args: TriggerPveGenerationArgs,
): Promise<TriggerPveGenerationResult> {
  const env = args.env ?? process.env;
  const logger = args.logger;

  if (!isFlagOn(env.AUTO_TRIGGER_PVE_GEN)) {
    return { triggered: false, reason: 'feature-flag-off' };
  }

  const cluster = env.ECS_CLUSTER;
  const taskDefinition = env.TACTIC_TASK_DEF_ARN;
  const subnetsCsv = env.ECS_SUBNETS;
  const securityGroupsCsv = env.ECS_SECURITY_GROUPS;
  if (!cluster || !taskDefinition || !subnetsCsv || !securityGroupsCsv) {
    logger.warn(
      `${TAG} skip: feature-flag on, но не задана одна из ENV: ` +
        `ECS_CLUSTER=${cluster ? 'set' : 'MISSING'} ` +
        `TACTIC_TASK_DEF_ARN=${taskDefinition ? 'set' : 'MISSING'} ` +
        `ECS_SUBNETS=${subnetsCsv ? 'set' : 'MISSING'} ` +
        `ECS_SECURITY_GROUPS=${securityGroupsCsv ? 'set' : 'MISSING'}`,
    );
    return { triggered: false, reason: 'missing-env' };
  }
  const subnets = subnetsCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const securityGroups = securityGroupsCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Динамический load пакета — на случай если @aws-sdk/client-ecs
  // не встал в production image (пример из api/ScalingService).
  //
  // KS-3150 fix (20.05.2026): `RunTaskCommand` — это конструктор-класс
  // в AWS-SDK v3, его НУЖНО вызывать через `new`. Раньше тип был
  // объявлен как обычная функция и ниже использовался `RunTaskCommand(
  // input)` без `new` — runtime в проде падал с
  // `Class constructor RunTaskCommand cannot be invoked without 'new'`.
  // Сейчас тип объявлен как `new (input: unknown) => unknown` и вызов
  // ниже идёт через `new RunTaskCommand(input)`.
  type RunTaskCtor = new (input: unknown) => unknown;
  let RunTaskCommand: RunTaskCtor;
  let ecsClient: {
    send: (cmd: unknown) => Promise<{ tasks?: Array<{ taskArn?: string }> }>;
  };
  try {
    if (args.ecsClientFactory && args.runTaskCommandFactory) {
      ecsClient = await args.ecsClientFactory();
      // Тестовая фабрика — оборачиваем в no-op-конструктор, чтобы
      // `new` работал единообразно с production-веткой.
      const factory = args.runTaskCommandFactory;
      RunTaskCommand = class {
        constructor(input: unknown) {
          return factory(input) as object;
        }
      } as unknown as RunTaskCtor;
    } else {
      const mod = (await import('@aws-sdk/client-ecs')) as unknown as {
        ECSClient: new (opts: object) => typeof ecsClient;
        RunTaskCommand: RunTaskCtor;
      };
      ecsClient = new mod.ECSClient({});
      RunTaskCommand = mod.RunTaskCommand;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`${TAG} skip: AWS-SDK load failed: ${msg}`);
    return { triggered: false, reason: 'sdk-load-failed', error: msg };
  }

  // KS-3396. N шардов из env. N=1 → один RunTask без --shard (старое
  // поведение). N>1 → N независимых RunTask с --shard=0/N..(N-1)/N.
  // Диапазоны id не пересекаются (hashtext mod N) → дубликатов между
  // шардами нет; UNIQUE fen дополнительно защищает от гонок INSERT.
  const shardCount = resolveShardCount(env);

  const buildInput = (command: string[]): unknown => ({
    cluster,
    taskDefinition,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        securityGroups,
        // KS-4029: ENABLED — временно, до KS-3061 (поднять VPC endpoint'ы
        // для ECR / Secrets Manager / CloudWatch Logs в подсетях). Без
        // публичного IP контейнер шарда зависает в PENDING (не может
        // скачать образ из ECR и забрать секреты).
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: TACTIC_CONTAINER_NAME,
          command,
        },
      ],
    },
  });

  const taskArns: string[] = [];
  let lastError: string | undefined;
  let noTaskReturned = false;

  for (let i = 0; i < shardCount; i++) {
    const shard =
      shardCount > 1 ? { index: i, count: shardCount } : undefined;
    const command = buildTacticCommand(args.importId, shard);
    const shardLabel = shard ? `shard=${i}/${shardCount}` : 'shard=none';
    try {
      const cmd = new RunTaskCommand(buildInput(command));
      const resp = await ecsClient.send(cmd);
      const taskArn = resp.tasks?.[0]?.taskArn;
      if (!taskArn) {
        noTaskReturned = true;
        logger.warn(
          `${TAG} RunTask returned no tasks (failures?) ${shardLabel} importId=${args.importId}`,
        );
        continue;
      }
      taskArns.push(taskArn);
      logger.log(
        `${TAG} triggered tactic-worker run-task=${taskArn} ${shardLabel} importId=${args.importId}`,
      );
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      logger.warn(
        `${TAG} RunTask failed ${shardLabel} importId=${args.importId}: ${lastError} ` +
          `(импорт не падает; шард можно перезапустить вручную)`,
      );
    }
  }

  if (taskArns.length === 0) {
    return {
      triggered: false,
      shardCount,
      reason: lastError
        ? 'run-task-failed'
        : noTaskReturned
          ? 'no-task-returned'
          : 'run-task-failed',
      error: lastError,
    };
  }

  // Частичный успех: запустилась часть шардов — triggered=true, но
  // помечаем reason='partial' для диагностики (импорт всё равно ок).
  const partial = taskArns.length < shardCount;
  return {
    triggered: true,
    taskArn: taskArns[0],
    taskArns,
    shardCount,
    ...(partial ? { reason: 'partial' as const, error: lastError } : {}),
  };
}
