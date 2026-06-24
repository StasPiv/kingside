/**
 * KS-4340 / ADR-135 §2.3. Серверная обёртка над shared
 * `processGameForTacticPuzzles`:
 *   * выборка партий из `archive_games` через `pg.Client` к
 *     archive-RDS (`ARCHIVE_DATABASE_URL`);
 *   * прогон каждой партии через shared pipeline;
 *   * вставка принятых кандидатов в `tactic_puzzles` (Prisma) с
 *     идемпотентностью по UNIQUE(`fen`) — дубликаты считаем как
 *     `duplicates` без падения;
 *   * сборка статистики (gamesScanned / gamesProcessed / candidates /
 *     drops по причинам) для последующей корректировки дефолтов на T5.
 *
 * Фильтр TWIC: `white_elo >= 2600 AND black_elo >= 2600 AND
 * time_control_category = 'classical'` (ADR-135 §2.3, объём подтверждён
 * devops 2026-06-19 — 4037 партий).
 *
 * Идемпотентность партии: пропускаем партию, если в `tactic_puzzles`
 * уже есть строка с `source_game_id = game.id` — иначе риск разогнать
 * генерацию заново на уже частично обработанной партии (вставки
 * пройдут как duplicate на FEN UNIQUE, но wasted SF-tax будет).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import type { Prisma } from '@kingside/db';
import {
  processGameForTacticPuzzles,
  type MaiaPolicySource,
  type TacticPuzzleCandidate,
  type TacticPuzzleGenSettings,
  type TacticPuzzleRejectReason,
  type TacticSfEngine,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { StockfishService } from '../stockfish/stockfish.service';
import { MaiaAnnotationService } from '../maia/maia-annotation.service';
import { buildArchivePgClientConfig } from '../lib/pg-ssl';
import { TacticMaiaPolicyProvider } from './maia-policy-provider';
import { makeTacticSfEngine } from './sf-adapter';

const ALGORITHM_VERSION = 'maia-difficulty-v1';

interface ArchiveGameRow {
  id: string;
  pgn: string;
  white_elo: number | null;
  black_elo: number | null;
  ply_count: number | null;
  time_control_category: string | null;
}

export interface TacticGenRunOptions {
  /** Сколько партий ОБРАБОТАТЬ (не отскэнировать). null — без ограничения. */
  limit: number | null;
  /** Шардирование: остаток `((hashtext(id::text) % N) + N) % N = i` */
  shardIndex: number | null;
  shardCount: number | null;
  /** Не вставлять в БД; всё посчитать и залогировать. */
  dryRun: boolean;
  settings: TacticPuzzleGenSettings;
  /**
   * KS-4605. Явный список UUID импорта(ов). Используется в `selectGames`
   * как `AND import_id = ANY($::uuid[])`. Заполняется либо CLI-флагом
   * `--import-id` (можно повторять), либо результатом резолва
   * `twicIssue` в `run()` (см. `resolveImportIdsByTwicIssue`).
   * `null` означает «фильтр не применять» — допустимо только если
   * `fullBacklog === true`.
   */
  importIds: string[] | null;
  /**
   * KS-4605. Номер TWIC-выпуска (например 1650). Резолвится в `run()`
   * в массив `importIds` запросом `archive_imports WHERE file_name LIKE
   * 'twicN%' AND status IN ('ok','success')`. Если резолв пустой — run()
   * завершается с ошибкой (никаких выборок без фильтра).
   */
  twicIssue: number | null;
  /**
   * KS-4605. Явная перегенерация всего архива (миграции корпуса).
   * Без этого флага и без `importIds`/`twicIssue` `selectGames` не идёт.
   */
  fullBacklog: boolean;
}

export interface TacticGenStats {
  gamesScanned: number;
  gamesSkippedIdempotent: number;
  gamesProcessed: number;
  gamesFailed: number;
  candidatesFound: number;
  inserted: number;
  duplicates: number;
  drops: Record<TacticPuzzleRejectReason, number>;
  totalMs: number;
}

@Injectable()
export class TacticPuzzleGeneratorService {
  private readonly logger = new Logger(TacticPuzzleGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sf: StockfishService,
  ) {}

  async run(opts: TacticGenRunOptions): Promise<TacticGenStats> {
    const archiveUrl = process.env.ARCHIVE_DATABASE_URL;
    if (!archiveUrl) {
      throw new Error('ARCHIVE_DATABASE_URL env not set');
    }

    const maiaAnnotation = MaiaAnnotationService.fromEnv(this.sf);
    if (!maiaAnnotation.isEnabled()) {
      throw new Error(
        'MaiaAnnotationService disabled — set PRECISION_MAIA_ANNOTATION_ENABLED=true',
      );
    }
    const maia: MaiaPolicySource = new TacticMaiaPolicyProvider(maiaAnnotation);
    const sfEngine: TacticSfEngine = makeTacticSfEngine(this.sf);

    const pgCfg = buildArchivePgClientConfig(
      archiveUrl,
      process.env,
      undefined,
      (msg) => this.logger.warn(`[archive-pg] ${msg}`),
    );
    const pg = new PgClient(pgCfg);
    await pg.connect();

    // KS-4605. Резолв `--twic-issue=N` в массив `import_id` через
    // `archive_imports.file_name LIKE 'twicN%' AND status IN ('ok','success')`.
    // Делаем здесь, после pg.connect(), чтобы не дублировать подключение
    // в CLI. Retry-импорты одного файла даёт массив, фильтр `IN(...)`.
    // Если ничего не нашлось — fail-fast (никакой полной выборки).
    let resolvedImportIds = opts.importIds;
    if (opts.twicIssue != null && resolvedImportIds == null) {
      const issueN = opts.twicIssue;
      const rows = await pg.query<{ id: string }>(
        `SELECT id::text AS id
           FROM archive_imports
          WHERE file_name LIKE $1
            AND status IN ('ok', 'success')
          ORDER BY started_at DESC`,
        [`twic${issueN}%`],
      );
      if (rows.rows.length === 0) {
        await pg.end().catch(() => undefined);
        throw new Error(
          `--twic-issue=${issueN}: no successful imports found in archive_imports ` +
            `(filter: file_name LIKE 'twic${issueN}%' AND status IN ('ok','success'))`,
        );
      }
      resolvedImportIds = rows.rows.map((r) => r.id);
      this.logger.log(
        `[tactic-gen] --twic-issue=${issueN} resolved to ${resolvedImportIds.length} ` +
          `import(s): ${resolvedImportIds.join(', ')}`,
      );
    }
    // Дополнительная страховка инварианта (CLI его уже проверяет, но
    // дублируем — service может вызываться и не только из CLI).
    if (!opts.fullBacklog && (resolvedImportIds == null || resolvedImportIds.length === 0)) {
      await pg.end().catch(() => undefined);
      throw new Error(
        'scope is required: pass importIds (--import-id), twicIssue (--twic-issue), ' +
          'or set fullBacklog (--all)',
      );
    }
    const effectiveOpts: TacticGenRunOptions = {
      ...opts,
      importIds: resolvedImportIds,
    };

    const stats: TacticGenStats = {
      gamesScanned: 0,
      gamesSkippedIdempotent: 0,
      gamesProcessed: 0,
      gamesFailed: 0,
      candidatesFound: 0,
      inserted: 0,
      duplicates: 0,
      drops: {
        gameOver: 0,
        engineError: 0,
        noEngineLines: 0,
        notUniqueStrongMain: 0,
        maiaInferenceFailed: 0,
        maiaLowDifficulty: 0,
        notUniqueStrongVerify: 0,
        bestMoveMismatch: 0,
        bestMoveLoses: 0,
        gapTooSmall: 0,
      },
      totalMs: 0,
    };

    const t0 = Date.now();
    try {
      const games = await this.selectGames(pg, effectiveOpts);
      this.logger.log(
        `[tactic-gen] selected ${games.length} games from archive ` +
          `(elo ≥ 2600, classical, importIds=${effectiveOpts.importIds?.length ?? 'all'}) ` +
          `shard=${effectiveOpts.shardIndex ?? '-'}/${effectiveOpts.shardCount ?? '-'}`,
      );

      for (const game of games) {
        if (effectiveOpts.limit != null && stats.gamesProcessed >= effectiveOpts.limit) break;
        stats.gamesScanned++;

        if (await this.alreadyProcessed(game.id)) {
          stats.gamesSkippedIdempotent++;
          continue;
        }

        const gameT0 = Date.now();
        try {
          const result = await processGameForTacticPuzzles({
            pgn: game.pgn,
            sf: sfEngine,
            maia,
            settings: opts.settings,
            gameId: game.id,
          });
          if ('error' in result) {
            stats.gamesFailed++;
            this.logger.warn(`game=${game.id} skipped: ${result.error}`);
            continue;
          }

          stats.gamesProcessed++;
          stats.candidatesFound += result.candidates.length;
          for (const [k, v] of Object.entries(result.stats.drops)) {
            const key = k as TacticPuzzleRejectReason;
            stats.drops[key] += v;
          }

          let insertedThisGame = 0;
          if (!opts.dryRun) {
            for (const candidate of result.candidates) {
              const ok = await this.insertCandidate(
                candidate,
                game,
                result.headers,
                opts.settings,
              );
              if (ok) {
                stats.inserted++;
                insertedThisGame++;
              } else {
                stats.duplicates++;
              }
            }
          }

          const ms = Date.now() - gameT0;
          this.logger.log(
            `game=${game.id} positions=${result.stats.positionsAnalyzed} ` +
              `candidates=${result.candidates.length} inserted=${insertedThisGame} ` +
              `drops=${JSON.stringify(result.stats.drops)} time=${ms}ms`,
          );
        } catch (err) {
          stats.gamesFailed++;
          this.logger.error(
            `game=${game.id} crash: ${(err as Error).message ?? err}`,
          );
        }
      }
    } finally {
      await pg.end().catch(() => undefined);
      stats.totalMs = Date.now() - t0;
    }

    this.logger.log(
      `[tactic-gen] DONE scanned=${stats.gamesScanned} ` +
        `processed=${stats.gamesProcessed} ` +
        `skippedIdempotent=${stats.gamesSkippedIdempotent} ` +
        `failed=${stats.gamesFailed} ` +
        `candidates=${stats.candidatesFound} ` +
        `inserted=${stats.inserted} duplicates=${stats.duplicates} ` +
        `drops=${JSON.stringify(stats.drops)} ` +
        `totalMs=${stats.totalMs}`,
    );
    return stats;
  }

  private async selectGames(
    pg: PgClient,
    opts: TacticGenRunOptions,
  ): Promise<ArchiveGameRow[]> {
    const conds: string[] = [
      `white_elo >= 2600`,
      `black_elo >= 2600`,
      `time_control_category = 'classical'`,
    ];
    const params: (number | string | string[])[] = [];
    let idx = 1;
    // KS-4605. Жёсткий фильтр по import_id. При `--all` (fullBacklog)
    // фильтр снят — иначе попадание сюда без importIds означает баг
    // (run() уже бросил бы).
    if (opts.importIds && opts.importIds.length > 0) {
      const p = idx++;
      conds.push(`import_id = ANY($${p}::uuid[])`);
      params.push(opts.importIds);
    }
    if (
      opts.shardCount != null &&
      opts.shardCount > 1 &&
      opts.shardIndex != null
    ) {
      const nParam = idx++;
      const iParam = idx++;
      conds.push(
        `((hashtext(id::text) % $${nParam}) + $${nParam}) % $${nParam} = $${iParam}`,
      );
      params.push(opts.shardCount, opts.shardIndex);
    }
    // Запас 3x на отсев по idempotency (партия уже обработана раньше).
    // При --limit=null берём верхний потолок 10000 — больше за один запуск
    // не имеет смысла, для full-bank всегда есть шардирование.
    const cap = opts.limit != null ? Math.max(opts.limit * 3, 50) : 10000;
    const limitParam = idx;
    params.push(cap);
    const sql = `SELECT id::text AS id, pgn, white_elo, black_elo, ply_count,
                        time_control_category
                   FROM archive_games
                  WHERE ${conds.join(' AND ')}
                  ORDER BY id ASC
                  LIMIT $${limitParam}`;
    const res = await pg.query<ArchiveGameRow>(sql, params);
    return res.rows;
  }

  private async alreadyProcessed(gameId: string): Promise<boolean> {
    const found = await this.prisma.tacticPuzzle.findFirst({
      where: { sourceGameId: gameId },
      select: { id: true },
    });
    return found !== null;
  }

  /** Возвращает true при успешной вставке, false — при дубликате
   *  (UNIQUE fen). Любые другие ошибки пробрасываются. */
  private async insertCandidate(
    candidate: TacticPuzzleCandidate,
    game: ArchiveGameRow,
    headers: Record<string, string>,
    settings: TacticPuzzleGenSettings,
  ): Promise<boolean> {
    const data: Prisma.TacticPuzzleCreateInput = {
      fen: candidate.fen,
      bestMoveUci: candidate.bestMoveUci,
      solverSide: candidate.solverSide,
      bestE: candidate.bestE,
      secondE: candidate.secondE,
      gap: candidate.gap,
      difficulty: candidate.difficulty,
      wdlW: candidate.wdl.w,
      wdlD: candidate.wdl.d,
      wdlL: candidate.wdl.l,
      // KS-4368/KS-4370: поле `objective` удалено из TacticPuzzleCandidate
      // и из Prisma-модели (миграция `tactic_puzzles_drop_objective`).
      themes: '',
      sourceGameId: game.id,
      sourceMoveNum: candidate.ply,
      sourceWhiteElo: game.white_elo,
      sourceBlackElo: game.black_elo,
      sourceHeaders: headers as Prisma.InputJsonValue,
      algorithmVersion: ALGORITHM_VERSION,
      maiaElo: settings.maiaElo,
      sfMainNodes: settings.sfMainNodes,
      sfVerifyNodes: settings.sfVerifyNodes,
      sfMultiPv: settings.sfMultiPv,
    };
    try {
      await this.prisma.tacticPuzzle.create({ data });
      return true;
    } catch (err) {
      // Prisma выкидывает P2002 при нарушении UNIQUE — это и есть наш
      // путь дедупликации по `fen`. Любой другой код пробрасываем.
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return false;
      throw err;
    }
  }
}
