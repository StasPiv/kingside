/**
 * KS-4107. Одноразовый CLI для паритет-теста weakChoiceProb
 * client↔server после внедрения soft-threshold (metric_version=2) и
 * выравнивания серверного Stockfish (KS-4111: SF18 native).
 *
 * Что делает: для каждого `--ids=<id>,<id>,...` читает puzzle из БД,
 * получает Maia policy (ELO=1500), строит searchMoves, прогоняет SF
 * с MultiPV=searchMoves.length и `searchmoves`, собирает WDL и
 * expectedScores, считает `computeWeakChoiceProb` по soft-threshold —
 * и печатает JSON-массив объектов с ПОЛНЫМ трейсом (см.
 * `MaiaInspectResult`). QA подаёт тот же `FEN + firstMovePV1` в
 * клиентский путь (apps/web) и сверяет prob и weakSet.
 *
 * Запуск через ECS RunTask на проде (tactic-worker уже на SF18 native +
 * Maia ONNX в /app/tools/maia3):
 *
 *   containerOverrides.command = [
 *     "node","dist/main.js","parity-check",
 *     "--ids=<full-uuid>,<full-uuid>,..."
 *   ]
 *
 * либо по 8-символьному префиксу id (`LEFT(id::text, 8)`):
 *
 *   containerOverrides.command = [
 *     "node","dist/main.js","parity-check",
 *     "--id-prefixes=754f93d5,aa9c8b2a,5830f706,712665fb"
 *   ]
 *
 * либо в РЕЖИМЕ САМПЛИНГА — берёт N пограничных и M «явных» пазлов
 * из puzzles, чтобы QA получил репрезентативный набор без знания
 * конкретных id (полезно когда оригинальные id-шники теста потеряны):
 *
 *   containerOverrides.command = [
 *     "node","dist/main.js","parity-check",
 *     "--sample-borderline-prob=2", "--sample-clear-prob=2"
 *   ]
 *
 * Пограничные — `maia_weak_choice_prob ∈ [0.001, 0.05]` при
 * `maia_metric_version = 1` (старая ступенька с тонкой границей).
 * Явные — `maia_weak_choice_prob = 0 OR ≥ 0.5`. Все пазлы — с
 * `solution_mode='play-vs-engine'` и непустым `firstMovePV1` в
 * `source_metadata` (иначе аннотация невозможна).
 *
 * При префиксном режиме / режиме сэмплинга CLI печатает полные id в
 * каждом объекте JSON, чтобы caller (QA) мог потом обратиться к
 * точечным id.
 *
 * Опциональные флаги:
 *   --elo=1500       (default 1500)
 *   --depth=15       (default 15)
 *   --policy-top=12  (сколько top-policy ходов писать в JSON, default 12)
 */
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MaiaAnnotationService } from '../maia/maia-annotation.service';
import { StockfishService } from '../stockfish/stockfish.service';

interface CliOpts {
  ids: string[];
  idPrefixes: string[];
  sampleBorderline: number;
  sampleClear: number;
  sampleAny: number;
  elo: number;
  depth: number;
  policyTop: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    ids: [],
    idPrefixes: [],
    sampleBorderline: 0,
    sampleClear: 0,
    sampleAny: 0,
    elo: 1500,
    depth: 15,
    policyTop: 12,
  };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    switch (k) {
      case 'ids':
        opts.ids = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'id-prefixes':
        opts.idPrefixes = (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case 'sample-borderline-prob':
        opts.sampleBorderline = parseInt(v, 10);
        break;
      case 'sample-clear-prob':
        opts.sampleClear = parseInt(v, 10);
        break;
      case 'sample-any-prob':
        opts.sampleAny = parseInt(v, 10);
        break;
      case 'elo':
        opts.elo = parseInt(v, 10);
        break;
      case 'depth':
        opts.depth = parseInt(v, 10);
        break;
      case 'policy-top':
        opts.policyTop = parseInt(v, 10);
        break;
      default:
        throw new Error(`unknown CLI option: ${arg}`);
    }
  }
  const hasIdMode =
    opts.ids.length > 0 || opts.idPrefixes.length > 0;
  const hasSampleMode =
    opts.sampleBorderline > 0 || opts.sampleClear > 0 || opts.sampleAny > 0;
  if (!hasIdMode && !hasSampleMode) {
    throw new Error(
      'one of --ids / --id-prefixes / --sample-borderline-prob / ' +
        '--sample-clear-prob / --sample-any-prob is required',
    );
  }
  return opts;
}

export async function runParityCheck(
  app: INestApplicationContext,
  argv: string[],
): Promise<void> {
  const logger = new Logger('cli:parity-check');
  const opts = parseArgs(argv);
  logger.log(
    `parity-check ids=${opts.ids.length} elo=${opts.elo} depth=${opts.depth}`,
  );

  const prisma = app.get(PrismaService);
  const stockfish = app.get(StockfishService);

  // ENV-вариант, чтобы переиспользовать PRECISION_MAIA_MODEL_PATH /
  // PRECISION_MAIA_ANNOTATION_ELO / PRECISION_MAIA_SF_DEPTH из task-def,
  // и при необходимости переопределить через --elo / --depth ниже.
  const svc = MaiaAnnotationService.fromEnv(stockfish, {
    ...process.env,
    PRECISION_MAIA_ANNOTATION_ENABLED: 'true',
    PRECISION_MAIA_ANNOTATION_ELO: String(opts.elo),
    PRECISION_MAIA_SF_DEPTH: String(opts.depth),
  });

  // ВАЖНО: `puzzles.source_metadata` — это `Text` (см.
  // `packages/db/prisma/schema.prisma:348`: `sourceMetadata String?
  // @map("source_metadata") @db.Text`), а не `jsonb`. PG-оператор
  // `?` (key-exists) к Text не применим — упадёт с
  // `42883 operator does not exist: text ? unknown`. Поэтому в
  // фильтрах sample-режимов используется `LIKE '%"firstMovePV1"%'`,
  // а на JS-стороне строка парсится через `JSON.parse` в try/catch.
  type Row = {
    id: string;
    fen: string;
    sourceMetadata: string | null;
  };

  type SampleType = 'borderline' | 'clear' | 'any' | 'id' | 'prefix';

  // ids/prefixes имеют приоритет: если они переданы, sample-флаги
  // игнорируются (вычитываем точечно по запросу). Иначе — выполняем
  // все 3 sample-режима параллельно и объединяем результат с
  // меткой `sampleType` в каждой строке (так QA в JSON-выдаче видит,
  // какой пазл из какого среза).
  const rows: Row[] = [];
  const sampleTypeByRowId = new Map<string, SampleType>();
  let keys: string[] = [];
  let mode: 'ids' | 'prefixes' | 'sample';

  if (opts.ids.length > 0) {
    mode = 'ids';
    const r = (await prisma.$queryRawUnsafe(
      `SELECT id, fen,
              source_metadata AS "sourceMetadata"
         FROM puzzles
        WHERE id::text = ANY($1::text[])`,
      opts.ids,
    )) as Row[];
    for (const row of r) sampleTypeByRowId.set(String(row.id), 'id');
    rows.push(...r);
    keys = opts.ids;
  } else if (opts.idPrefixes.length > 0) {
    mode = 'prefixes';
    // UUID-text имеет дефисы; первые 8 символов префикса совпадают
    // с первой группой UUID v4 (`xxxxxxxx-xxxx-...`).
    const r = (await prisma.$queryRawUnsafe(
      `SELECT id, fen,
              source_metadata AS "sourceMetadata"
         FROM puzzles
        WHERE LEFT(id::text, 8) = ANY($1::text[])`,
      opts.idPrefixes,
    )) as Row[];
    for (const row of r) sampleTypeByRowId.set(String(row.id), 'prefix');
    rows.push(...r);
    keys = opts.idPrefixes;
  } else {
    mode = 'sample';

    if (opts.sampleBorderline > 0) {
      // KS-4107. Пограничные при v1: prob ∈ [0.001, 0.05] — старая
      // ступенька зафиксировала «один слабый ход у границы 0.02».
      const r = (await prisma.$queryRawUnsafe(
        `SELECT id, fen,
                source_metadata AS "sourceMetadata"
           FROM puzzles
          WHERE maia_metric_version = 1
            AND maia_weak_choice_prob BETWEEN 0.001 AND 0.05
            AND solution_mode = 'play-vs-engine'
            AND source_metadata IS NOT NULL
            AND source_metadata LIKE '%"firstMovePV1"%'
          ORDER BY maia_weak_choice_prob ASC
          LIMIT $1`,
        opts.sampleBorderline,
      )) as Row[];
      logger.log(
        `sample-borderline: requested=${opts.sampleBorderline} found=${r.length}`,
      );
      for (const row of r) {
        if (sampleTypeByRowId.has(String(row.id))) continue;
        sampleTypeByRowId.set(String(row.id), 'borderline');
        rows.push(row);
      }
    }

    if (opts.sampleClear > 0) {
      // «Явные» — prob = 0 либо ≥ 0.5. На них soft-threshold должен
      // давать тот же ответ (далеко от переходной зоны).
      const r = (await prisma.$queryRawUnsafe(
        `SELECT id, fen,
                source_metadata AS "sourceMetadata"
           FROM puzzles
          WHERE maia_metric_version = 1
            AND (maia_weak_choice_prob = 0
                 OR maia_weak_choice_prob >= 0.5)
            AND solution_mode = 'play-vs-engine'
            AND source_metadata IS NOT NULL
            AND source_metadata LIKE '%"firstMovePV1"%'
          ORDER BY random()
          LIMIT $1`,
        opts.sampleClear,
      )) as Row[];
      logger.log(
        `sample-clear: requested=${opts.sampleClear} found=${r.length}`,
      );
      for (const row of r) {
        if (sampleTypeByRowId.has(String(row.id))) continue;
        sampleTypeByRowId.set(String(row.id), 'clear');
        rows.push(row);
      }
    }

    if (opts.sampleAny > 0) {
      // KS-4107. Последний резерв: любой пазл с непустым
      // `maia_weak_choice_prob`. QA добавил флаг чтобы убедиться,
      // что код-путь работает, когда узкие фильтры дают 0.
      const r = (await prisma.$queryRawUnsafe(
        `SELECT id, fen,
                source_metadata AS "sourceMetadata"
           FROM puzzles
          WHERE maia_weak_choice_prob IS NOT NULL
            AND solution_mode = 'play-vs-engine'
            AND source_metadata IS NOT NULL
            AND source_metadata LIKE '%"firstMovePV1"%'
          ORDER BY random()
          LIMIT $1`,
        opts.sampleAny,
      )) as Row[];
      logger.log(
        `sample-any: requested=${opts.sampleAny} found=${r.length}`,
      );
      for (const row of r) {
        if (sampleTypeByRowId.has(String(row.id))) continue;
        sampleTypeByRowId.set(String(row.id), 'any');
        rows.push(row);
      }
    }

    keys = rows.map((r) => String(r.id));
  }

  // Группировка по «запрошенному» ключу: для `ids` это сам id, для
  // `prefixes` — префикс (несколько строк под один префикс
  // допустимы; QA сам разрешит). Для sample-режимов ключ совпадает
  // с полным id строки.
  const buckets = new Map<string, Row[]>();
  for (const k of keys) buckets.set(k, []);
  for (const r of rows) {
    if (mode === 'prefixes') {
      const prefix = String(r.id).slice(0, 8);
      const arr = buckets.get(prefix);
      if (arr) arr.push(r);
    } else {
      const arr = buckets.get(String(r.id));
      if (arr) arr.push(r);
    }
  }

  const out: Array<Record<string, unknown>> = [];
  for (const key of keys) {
    const matched = buckets.get(key) ?? [];
    if (matched.length === 0) {
      out.push({ queryKey: key, error: 'not_found' });
      logger.warn(`key ${key}: not found`);
      continue;
    }
    if (matched.length > 1) {
      logger.warn(
        `key ${key}: matched ${matched.length} puzzles — emitting all`,
      );
    }
    for (const row of matched) {
      const sampleType = sampleTypeByRowId.get(String(row.id)) ?? null;
      // `source_metadata` хранится как Text (см. schema.prisma:348),
      // на JS прилетает строка. Парсим в JSON в try/catch — невалидный
      // JSON / NULL → пустой firstMovePV1 → отдельная error-ветка.
      let parsedMeta: Record<string, unknown> | null = null;
      if (typeof row.sourceMetadata === 'string') {
        try {
          const v = JSON.parse(row.sourceMetadata);
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            parsedMeta = v as Record<string, unknown>;
          }
        } catch {
          // оставляем parsedMeta=null — попадёт в error-ветку ниже
        }
      }
      const firstMovePV1 = parsedMeta
        ? String(parsedMeta.firstMovePV1 ?? '')
        : '';
      if (!firstMovePV1) {
        out.push({
          queryKey: key,
          sampleType,
          puzzleId: row.id,
          fen: row.fen,
          error: 'no_firstMovePV1_in_sourceMetadata',
        });
        logger.warn(
          `puzzle ${row.id}: no firstMovePV1 in sourceMetadata`,
        );
        continue;
      }
      try {
        const trace = await svc.inspect(row.id, row.fen, firstMovePV1);
        out.push({
          queryKey: key,
          sampleType,
          ...trace,
          maiaPolicyTop: trace.maiaPolicyTop.slice(0, opts.policyTop),
        });
        logger.log(
          `puzzle ${row.id}: weakChoiceProb=${trace.weakChoiceProb.toFixed(4)} ` +
            `metric_version=${trace.metricVersion} weakSet=${trace.weakSet.length}`,
        );
      } catch (e) {
        out.push({
          queryKey: key,
          sampleType,
          puzzleId: row.id,
          fen: row.fen,
          firstMovePV1,
          error: (e as Error).message,
        });
        logger.error(`puzzle ${row.id}: ${(e as Error).message}`);
      }
    }
  }

  process.stdout.write(JSON.stringify(out, null, 2));
  process.stdout.write('\n');
}
