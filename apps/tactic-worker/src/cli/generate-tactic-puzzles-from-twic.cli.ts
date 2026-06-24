/**
 * KS-4340 / ADR-135 §2.3. CLI `generate-tactic-puzzles-from-twic`.
 *
 * Прогон tactic-puzzle-generator (Maia-difficulty) по `archive_games`
 * с фильтром ADR §2.3 (`white_elo ≥ 2600 AND black_elo ≥ 2600 AND
 * time_control_category='classical'`).
 *
 * KS-4605. Скоуп выборки — ОБЯЗАТЕЛЬНЫЙ флаг, никакого default-резолва
 * внутри воркера и никакого молчаливого «возьму весь архив». Один из:
 *   `--twic-issue=<число>` — резолвится через `archive_imports.file_name
 *     LIKE 'twicN%' AND status IN ('ok','success')` (массив `import_id`
 *     для retry-импортов, фильтр `IN (...)`);
 *   `--import-id=<uuid>` — явный список UUID (можно повторять флаг),
 *     резолв в БД пропускается;
 *   `--all` / `--full-backlog` — явная перегенерация всего архива
 *     (миграция корпуса, смена predicate). Снимает фильтр по импорту.
 * Без этих флагов CLI завершается с понятным сообщением и exit≠0 —
 * это страховка от случайного полного прогона при автоматическом cron'е.
 *
 * Автотриггер archive-service передаёт `--twic-issue=N`, парся номер
 * из `archive_imports.file_name` свежего импорта (см.
 * `apps/archive-service/src/archive-import/trigger-pve-generation.ts`).
 *
 * Контракт:
 *   ARCHIVE_DATABASE_URL=... DATABASE_URL=... \
 *     node dist/main.js generate-tactic-puzzles-from-twic \
 *       (--twic-issue=N | --import-id=<uuid>… | --all)   обязательно
 *       [--limit=N]                  default: 100 (для T5 smoke)
 *       [--shard-index=I]            0-based (нужен с --shard-count)
 *       [--shard-count=N]            горизонтальный шардинг по hashtext(id)
 *       [--dry-run]                  не вставлять в БД, только посчитать
 *       [--algorithm-settings='{...}']  JSON-override
 *                                       `TACTIC_PUZZLE_GEN_DEFAULTS`.
 *                                       Ключи: startPly, sfMainNodes,
 *                                       sfVerifyNodes, sfMultiPv, maiaElo,
 *                                       epsEquiv, difficultyMin, loseMax,
 *                                       gapMin.
 *
 * Идемпотентность: партии, у которых уже есть хоть один пазл в
 * `tactic_puzzles` (по `source_game_id`), пропускаются — повторный запуск
 * не дублирует работу.
 *
 * Логирование: на каждую партию выдаётся строка с числом позиций,
 * candidates, inserted, drops по причинам, временем. В конце —
 * сводная статистика.
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import {
  TACTIC_PUZZLE_GEN_DEFAULTS,
  type TacticPuzzleGenSettings,
} from '@kingside/shared';
import {
  TacticPuzzleGeneratorService,
  type TacticGenRunOptions,
  type TacticGenStats,
} from '../tactic-puzzle-generator/tactic-puzzle-generator.service';

export interface TacticTwicCliFlags {
  options: TacticGenRunOptions;
}

// KS-4605. UUID-форма для валидации `--import-id`. Лояльно к регистру
// (в `archive_imports.id` хранятся lower-case `gen_random_uuid()`, но
// API/Postgres примут и upper-case).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: string[]): TacticTwicCliFlags {
  let limit: number | null = 100;
  let shardIndex: number | null = null;
  let shardCount: number | null = null;
  let dryRun = false;
  let settings: TacticPuzzleGenSettings = { ...TACTIC_PUZZLE_GEN_DEFAULTS };
  // KS-4605. Scope-флаги (один из обязателен). Взаимоисключающие.
  // `--import-id=<uuid>` можно повторять — собирается в массив `import_id
  // = ANY($::uuid[])` для selectGames. `--twic-issue=<число>` резолвится
  // внутри сервиса (там pg к archive-db уже открыт) через
  // `archive_imports.file_name LIKE 'twicN%'`. `--all` / `--full-backlog`
  // снимает фильтр по импорту вовсе — намеренная перегенерация архива.
  const importIds: string[] = [];
  let twicIssue: number | null = null;
  let fullBacklog = false;

  for (const arg of argv) {
    const [k, ...rest] = arg.replace(/^--/, '').split('=');
    const v = rest.join('=');
    switch (k) {
      case 'limit': {
        if (v === 'none' || v === 'null') {
          limit = null;
        } else {
          const n = parseInt(v, 10);
          if (!Number.isFinite(n) || n <= 0) {
            throw new Error(`bad --limit: ${v}`);
          }
          limit = n;
        }
        break;
      }
      case 'shard-index': {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`bad --shard-index: ${v}`);
        }
        shardIndex = n;
        break;
      }
      case 'shard-count': {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`bad --shard-count: ${v}`);
        }
        shardCount = n;
        break;
      }
      case 'dry-run':
        dryRun = v === undefined || v === '' || v === 'true';
        break;
      case 'import-id': {
        if (!UUID_RE.test(v)) {
          throw new Error(`bad --import-id (expected UUID): ${v}`);
        }
        importIds.push(v.toLowerCase());
        break;
      }
      case 'twic-issue': {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`bad --twic-issue (expected positive int): ${v}`);
        }
        twicIssue = n;
        break;
      }
      case 'all':
      case 'full-backlog':
        fullBacklog = v === undefined || v === '' || v === 'true';
        break;
      case 'algorithm-settings': {
        if (!v) throw new Error(`--algorithm-settings requires JSON value`);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(v) as Record<string, unknown>;
        } catch (err) {
          throw new Error(
            `bad --algorithm-settings JSON: ${(err as Error).message}`,
            { cause: err },
          );
        }
        settings = applySettingsOverride(settings, parsed);
        break;
      }
      default:
        throw new Error(`unknown flag: --${k}`);
    }
  }

  if ((shardCount == null) !== (shardIndex == null)) {
    throw new Error(
      `--shard-index and --shard-count must be set together`,
    );
  }
  if (shardCount != null && shardIndex != null && shardIndex >= shardCount) {
    throw new Error(`--shard-index must be < --shard-count`);
  }
  // KS-4605. Scope обязателен. Никакого молчаливого «возьму весь архив» —
  // это защита от случайного запуска полного прогона при еженедельном
  // cron'е. Должен быть ровно один из --twic-issue / --import-id / --all.
  const scopes = [
    importIds.length > 0 ? 'import-id' : null,
    twicIssue != null ? 'twic-issue' : null,
    fullBacklog ? 'all' : null,
  ].filter(Boolean) as string[];
  if (scopes.length === 0) {
    throw new Error(
      'one of --twic-issue=<N>, --import-id=<uuid>, --all is required ' +
        '(scope of generation must be explicit; refusing to run full backlog by default)',
    );
  }
  if (scopes.length > 1) {
    throw new Error(
      `scope flags are mutually exclusive, got: ${scopes.join(', ')}`,
    );
  }

  return {
    options: {
      limit,
      shardIndex,
      shardCount,
      dryRun,
      settings,
      importIds: importIds.length > 0 ? importIds : null,
      twicIssue,
      fullBacklog,
    },
  };
}

const NUMERIC_SETTINGS: ReadonlyArray<keyof TacticPuzzleGenSettings> = [
  'startPly',
  'sfMainNodes',
  'sfVerifyNodes',
  'sfMultiPv',
  'maiaElo',
  'epsEquiv',
  'difficultyMin',
  'loseMax',
  'gapMin',
];

function applySettingsOverride(
  base: TacticPuzzleGenSettings,
  overrides: Record<string, unknown>,
): TacticPuzzleGenSettings {
  const out: TacticPuzzleGenSettings = { ...base };
  for (const k of NUMERIC_SETTINGS) {
    if (!(k in overrides)) continue;
    const raw = overrides[k];
    const v = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(v)) {
      throw new Error(`bad --algorithm-settings.${k}: ${String(raw)}`);
    }
    out[k] = v;
  }
  return out;
}

export async function runGenerateTacticPuzzlesFromTwic(
  app: INestApplicationContext,
  argv: string[],
): Promise<TacticGenStats> {
  const logger = new Logger('cli:generate-tactic-puzzles-from-twic');
  const { options } = parseArgs(argv);

  // KS-4605. В логе видна выбранная стратегия скоупа (twic-issue / import-id /
  // all) — нужно для девопсов при разборе автотриггер-логов.
  const scopeLabel =
    options.fullBacklog
      ? 'all'
      : options.twicIssue != null
        ? `twic-issue=${options.twicIssue}`
        : `import-id×${options.importIds?.length ?? 0}`;
  process.stdout.write(
    `[tactic-twic-gen] start scope=${scopeLabel} limit=${options.limit ?? 'none'} ` +
      `shard=${options.shardIndex ?? '-'}/${options.shardCount ?? '-'} ` +
      `dryRun=${options.dryRun} ` +
      `settings=${JSON.stringify(options.settings)}\n`,
  );

  const service = app.get(TacticPuzzleGeneratorService);
  const stats = await service.run(options);

  process.stdout.write(
    `[tactic-twic-gen] result ${JSON.stringify(stats, null, 2)}\n`,
  );
  logger.log(
    `done scanned=${stats.gamesScanned} processed=${stats.gamesProcessed} ` +
      `inserted=${stats.inserted} duplicates=${stats.duplicates} ` +
      `failed=${stats.gamesFailed} totalMs=${stats.totalMs}`,
  );
  return stats;
}
