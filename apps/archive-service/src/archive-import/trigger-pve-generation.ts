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
  /** true — RunTask успешно отправлен (taskArn в `taskArn`). */
  triggered: boolean;
  /** ARN запущенного ECS task'а, если `triggered=true`. */
  taskArn?: string;
  /** Причина пропуска / ошибки. */
  reason?:
    | 'feature-flag-off'
    | 'missing-env'
    | 'sdk-load-failed'
    | 'run-task-failed'
    | 'no-task-returned';
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
 * play-vs-engine, --min-rating=2400, --time-ms=400, --half-moves-n=6.
 */
function buildTacticCommand(importId: string): string[] {
  return [
    'node',
    'dist/main.js',
    'generate-puzzles',
    '--solution-mode=play-vs-engine',
    `--import-id=${importId}`,
    '--exclude-used',
    '--min-rating=2400',
    '--max-games=inf',
    '--time-ms=400',
    '--half-moves-n=6',
  ];
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
  let RunTaskCommand: (input: unknown) => unknown;
  let ecsClient: {
    send: (cmd: unknown) => Promise<{ tasks?: Array<{ taskArn?: string }> }>;
  };
  try {
    if (args.ecsClientFactory && args.runTaskCommandFactory) {
      ecsClient = await args.ecsClientFactory();
      RunTaskCommand = args.runTaskCommandFactory;
    } else {
      const mod = (await import('@aws-sdk/client-ecs')) as unknown as {
        ECSClient: new (opts: object) => typeof ecsClient;
        RunTaskCommand: typeof RunTaskCommand;
      };
      ecsClient = new mod.ECSClient({});
      RunTaskCommand = mod.RunTaskCommand;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`${TAG} skip: AWS-SDK load failed: ${msg}`);
    return { triggered: false, reason: 'sdk-load-failed', error: msg };
  }

  const command = buildTacticCommand(args.importId);
  const input = {
    cluster,
    taskDefinition,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        securityGroups,
        assignPublicIp: 'DISABLED',
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
  };

  try {
    const cmd = RunTaskCommand(input);
    const resp = await ecsClient.send(cmd);
    const taskArn = resp.tasks?.[0]?.taskArn;
    if (!taskArn) {
      logger.warn(
        `${TAG} RunTask returned no tasks (failures?). importId=${args.importId}`,
      );
      return { triggered: false, reason: 'no-task-returned' };
    }
    logger.log(
      `${TAG} triggered tactic-worker run-task=${taskArn} importId=${args.importId}`,
    );
    return { triggered: true, taskArn };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      `${TAG} RunTask failed importId=${args.importId}: ${msg} ` +
        `(импорт не падает; PVE-генерацию запустить вручную)`,
    );
    return { triggered: false, reason: 'run-task-failed', error: msg };
  }
}
