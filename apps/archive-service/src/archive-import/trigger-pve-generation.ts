/**
 * KS-2775 + KS-4388. После успешного TWIC-импорта запускаем ECS run-task
 * `tactic-worker` для автоматической генерации пазлов раздела
 * /critical-moment (Maia-difficulty, ADR-135).
 *
 * KS-4388: команда переведена со старого `generate-puzzles` (blunder-
 * пайплайн для /precision) на `generate-tactic-puzzles-from-twic`
 * (Maia-difficulty pipeline, KS-4340). /precision как раздел остаётся
 * на старых данных, но новыми задачами не пополняется. Фильтр выборки
 * партий (`white_elo>=2600 AND black_elo>=2600 AND
 * time_control_category='classical'`) зашит в SQL самого CLI; идемпотентность
 * — по `tactic_puzzles.source_game_id`, повторный запуск не задвоит.
 *
 * Шардирование — `PVE_SHARD_COUNT` (имя env сохранено для совместимости
 * с прод-инфрой). По KS-4388 рекомендованное значение — 8.
 *
 * Feature-flag `AUTO_TRIGGER_PVE_GEN`:
 *   - `'true'` / `'1'` / `'on'` — триггер активен.
 *   - всё остальное / unset — no-op (импорт работает как раньше).
 *
 * Безопасность: при отсутствии env или ошибке AWS-SDK логируем
 * warning и возвращаем `{triggered: false}` — TWIC-импорт ОСТАЁТСЯ
 * успешным. Генерация — best-effort: при провале её можно перезапустить
 * руками или подождать следующего цикла.
 */
import type { Logger } from '@nestjs/common';

export interface TriggerPveGenerationArgs {
  /** UUID `pgn_imports.id` свежего импорта — пробрасывается в `--import-id`. */
  importId: string;
  /**
   * KS-4605. Имя файла импорта (`archive_imports.file_name`),
   * например `twic1650.pgn`. Из него извлекается номер выпуска N,
   * который уходит в команду шарда как `--twic-issue=N`. Если файл
   * не соответствует шаблону `twicNNNN` — триггер пропускается
   * (warn в лог), импорт от этого не падает.
   */
  fileName?: string | null;
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
    | 'partial'
    | 'unrecognized-file-name';
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
 * KS-4388. Команда для нового CLI `generate-tactic-puzzles-from-twic`
 * (Maia-difficulty pipeline, KS-4340). Фильтр выборки (`white_elo>=2600
 * AND black_elo>=2600 AND time_control_category='classical'`) и
 * идемпотентность по `source_game_id` зашиты в самом CLI. `--limit=none`
 * снимает default-ограничение в 100 партий, нужное только для smoke-
 * прогона.
 *
 * KS-4605. Передаём `--twic-issue=N`, чтобы шард обработал только
 * партии из свежего TWIC-импорта, а не молотил весь архив (до KS-4605
 * CLI был без обязательного scope-флага и шёл по всему `archive_games`,
 * до новых партий доходил через ~12 часов). Номер N — из имени файла
 * импорта (`twicNNNN.pgn`), резолв `N → import_id[]` уже внутри
 * tactic-worker через `archive_imports`.
 *
 * Шардирование: при `count>1` добавляем `--shard-index=i --shard-count=N`
 * (раздельные флаги, отличие от старого `--shard=i/N`). В новом CLI
 * шардирование идёт по тому же `hashtext(id)%N`, что и в старом —
 * непересекающееся разбиение.
 */
function buildTacticCommand(
  _importId: string,
  twicIssue: number,
  shard?: { index: number; count: number },
): string[] {
  const cmd = [
    'node',
    'dist/main.js',
    'generate-tactic-puzzles-from-twic',
    `--twic-issue=${twicIssue}`,
    '--limit=none',
  ];
  if (shard && shard.count > 1) {
    cmd.push(`--shard-index=${shard.index}`);
    cmd.push(`--shard-count=${shard.count}`);
  }
  return cmd;
}

/**
 * KS-4605. Парсер номера TWIC из `archive_imports.file_name`.
 * Шаблон `twicNNNN` (с любым опциональным хвостом — расширение,
 * вариант с буквой для retry). При несоответствии шаблону возвращает
 * `null` — caller пропускает триггер с warn-логом.
 */
export function parseTwicIssueFromFileName(
  fileName: string | null | undefined,
): number | null {
  if (!fileName) return null;
  const m = /^twic(\d+)/i.exec(fileName.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * KS-4388. Число шардов из env `PVE_SHARD_COUNT` (имя сохранено для
 * совместимости с прод-инфрой). Default 8 — рекомендованное значение
 * для нового /critical-moment-генератора (4037 партий, 110 с/партия на
 * 1 поток → ~19 ч на полный первый прогон в 8 шардов; после первого
 * проходит ~30 мин/импорт на свежих партиях). Невалидное / <1 → 8.
 */
function resolveShardCount(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PVE_SHARD_COUNT ?? 8);
  if (!Number.isFinite(raw) || raw < 1) return 8;
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

  // KS-4605. Без распознанного TWIC-номера триггер не запускаем —
  // tactic-worker теперь требует обязательный scope-флаг (`--twic-issue` /
  // `--import-id` / `--all`), и автотриггер должен передавать `--twic-issue`.
  // Иначе шарды упадут с ошибкой парсера CLI. Импорт от пропуска не падает —
  // ручной запуск через ECS RunTask остаётся доступен (с `--import-id`).
  const twicIssue = parseTwicIssueFromFileName(args.fileName);
  if (twicIssue == null) {
    logger.warn(
      `${TAG} skip: file_name=${args.fileName ?? '∅'} does not match twicNNNN ` +
        `pattern — tactic-worker requires --twic-issue=N for scoped run. ` +
        `If this is a non-TWIC source, leave feature-flag off or implement ` +
        `a per-source resolver.`,
    );
    return { triggered: false, reason: 'unrecognized-file-name' };
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
    const command = buildTacticCommand(args.importId, twicIssue, shard);
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
