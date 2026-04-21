import AdmZip from 'adm-zip';
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@kingside/archive-db';
import { decodePgnBuffer, parseBatch, type ParsedGame } from '../pgn-utils';
import { PositionIndexerService } from '../position-indexer.service';
import { ArchivePositionWriterService } from '../archive-position-writer.service';
import {
  buildPositionRowsForGame,
  type PositionRow,
} from '../position-row-builder';
import { filterAlreadyImported } from '../dedup';
import { ArchiveImportMetricsService } from '../archive-import-metrics.service';

const DEFAULT_BUCKET = 'master';

/**
 * TWIC (The Week In Chess) — еженедельный архив партий, выпуски нумерованы
 * монотонно. URL: `https://theweekinchess.com/zips/twic{N}g.zip`.
 *
 * Воркер хранит текущий `cursor` в `archive_sources` — последний успешно
 * обработанный номер выпуска. На каждый импорт пробует `cursor + 1`.
 *
 * Для ad-hoc-импорта конкретного выпуска (KS-1679) — `runAdHoc(issue)`:
 * скачивается `twic{issue}g.zip`, `archive_sources.cursor` НЕ изменяется,
 * в `archive_imports` пишется строка с `cursorBefore = cursorAfter =
 * source.cursor` (ad-hoc-маркер: cursor не сдвинулся).
 */

const TWIC_URL_TEMPLATE = 'https://theweekinchess.com/zips/twic{N}g.zip';
const USER_AGENT = 'Kingside/1.0 (https://kingside.app)';
const FETCH_TIMEOUT_MS = 60_000;

export interface ImportResult {
  status: 'ok' | 'partial' | 'noop' | 'failed';
  cursorBefore: string | null;
  cursorAfter: string | null;
  fileName: string | null;
  gamesParsed: number;
  gamesAdded: number;
  gamesSkipped: number;
  error?: string;
}

export interface ArchiveSourceRow {
  id: string;
  code: string;
  cursor: string | null;
}

/**
 * Plain класс (не `@Injectable()`): инстанцируется per-run внутри
 * `ArchiveImportService.runSource(...)` или ad-hoc-CLI
 * `cli/import-twic-issue.ts`.
 */
export class TwicImporter {
  private readonly logger = new Logger(TwicImporter.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly source: ArchiveSourceRow,
    private readonly positionWriter: ArchivePositionWriterService | null,
    private readonly indexer: PositionIndexerService,
    private readonly metrics: ArchiveImportMetricsService,
  ) {}

  /** Формирует URL для указанного номера выпуска. */
  private static urlFor(issue: number): string {
    return TWIC_URL_TEMPLATE.replace('{N}', issue.toString());
  }

  /** Скачивает zip-файл. Возвращает null на 404 (нет ещё такого выпуска). */
  private async downloadZip(issue: number): Promise<Buffer | null> {
    const url = TwicImporter.urlFor(issue);
    this.logger.log(`[twic] GET ${url}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      this.logger.log(`[twic] issue ${issue} not yet published (404)`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`TWIC fetch failed: HTTP ${res.status} for issue ${issue}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  /** Распаковывает zip и возвращает содержимое первого .pgn в декодированном виде. */
  private extractPgn(buffer: Buffer): { content: string; fileName: string } {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.pgn'));
    if (entries.length === 0) {
      throw new Error('TWIC zip contains no .pgn entries');
    }
    const entry = entries[0];
    const raw = entry.getData();
    const content = decodePgnBuffer(raw);
    return { content, fileName: entry.entryName };
  }

  /**
   * Scheduler-путь: считает следующий выпуск как `cursor + 1` и выполняет
   * импорт с обновлением `archive_sources.cursor` при успехе.
   */
  async run(): Promise<ImportResult> {
    const cursorBefore = this.source.cursor;
    const nextIssue = (cursorBefore != null ? parseInt(cursorBefore, 10) : 0) + 1;
    if (!Number.isFinite(nextIssue) || nextIssue <= 0) {
      return {
        status: 'failed',
        cursorBefore,
        cursorAfter: cursorBefore,
        fileName: null,
        gamesParsed: 0,
        gamesAdded: 0,
        gamesSkipped: 0,
        error: `invalid cursor: ${cursorBefore}`,
      };
    }
    return this.runForIssue(nextIssue, { updateSourceCursor: true });
  }

  /**
   * Ad-hoc-импорт конкретного выпуска (KS-1679).
   *
   * НЕ изменяет `archive_sources.cursor` (и `lastRunAt` / `lastSuccessAt` /
   * `totalGames`) — scheduler продолжит работать от своего текущего cursor.
   * В `archive_imports.cursor_before = cursor_after = source.cursor` — знак,
   * что этот импорт курсор не двигал (ad-hoc-маркер).
   *
   * Использует тот же Redis-lock `archive:import:lock:twic`, что и
   * scheduler (lock берётся снаружи, в CLI через `ArchiveImportService`
   * или напрямую), поэтому параллельный scheduler-tick увидит `lock held,
   * skipping` и корректно пропустит свой заход.
   *
   * Идемпотентность: если выпуск уже есть в БД, `filterAlreadyImported`
   * отбросит все игры и `gamesAdded=0`, `gamesSkipped=<всё>`, status='ok'
   * (failed=0).
   */
  async runAdHoc(issue: number): Promise<ImportResult> {
    if (!Number.isFinite(issue) || issue <= 0) {
      return {
        status: 'failed',
        cursorBefore: this.source.cursor,
        cursorAfter: this.source.cursor,
        fileName: null,
        gamesParsed: 0,
        gamesAdded: 0,
        gamesSkipped: 0,
        error: `invalid issue: ${issue}`,
      };
    }
    return this.runForIssue(issue, { updateSourceCursor: false });
  }

  /**
   * Общая реализация импорта одного выпуска.
   *
   * - `updateSourceCursor=true`  — scheduler-режим: по успеху пишет
   *   `archive_sources.cursor=String(issue)`, `lastRunAt`,
   *   `lastSuccessAt`, `totalGames += added`.
   * - `updateSourceCursor=false` — ad-hoc: `archive_sources` вообще не
   *   трогается; `archive_imports.cursor_after = source.cursor` (как
   *   `cursor_before`), чтобы в таблице читалось «этот импорт курсор не
   *   двигал».
   *
   * Путь fetch → extract → parse → dedup → insert → index → copy →
   * update archive_imports — общий, метрики пишутся в оба режима
   * одинаково (label `source="twic"`, имена 1:1 по ADR-019 §2.7).
   */
  private async runForIssue(
    issue: number,
    opts: { updateSourceCursor: boolean },
  ): Promise<ImportResult> {
    const cursorBefore = this.source.cursor;

    let zipBuffer: Buffer | null;
    try {
      zipBuffer = await this.downloadZip(issue);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        cursorBefore,
        cursorAfter: cursorBefore,
        fileName: null,
        gamesParsed: 0,
        gamesAdded: 0,
        gamesSkipped: 0,
        error: msg,
      };
    }

    if (!zipBuffer) {
      return {
        status: 'noop',
        cursorBefore,
        cursorAfter: cursorBefore,
        fileName: null,
        gamesParsed: 0,
        gamesAdded: 0,
        gamesSkipped: 0,
      };
    }

    let content: string;
    let fileName: string;
    try {
      ({ content, fileName } = this.extractPgn(zipBuffer));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        cursorBefore,
        cursorAfter: cursorBefore,
        fileName: null,
        gamesParsed: 0,
        gamesAdded: 0,
        gamesSkipped: 0,
        error: `unzip: ${msg}`,
      };
    }

    const { games, failed } = parseBatch(content);
    this.logger.log(`[twic] issue ${issue}: parsed=${games.length} failed=${failed}`);

    // KS-1621: idempotent index. Отфильтровываем одним SELECT'ом уже
    // сохранённые content_hash — чтобы retry того же TWIC-пакета не
    // инкрементировал `position_stats` второй раз. Cycle insert ниже
    // остаётся защищённым catch'ем P2002 на случай race'а.
    const freshGames = await filterAlreadyImported(this.prisma, games);
    const preSkipped = games.length - freshGames.length;

    // Запись в archive_imports с `status=running`. В ad-hoc-режиме
    // `cursor_before` = текущий source.cursor; финальный `cursor_after`
    // в scheduler-режиме станет `String(issue)`, в ad-hoc останется
    // равным `cursor_before`.
    const importRow = await this.prisma.archiveImport.create({
      data: {
        sourceId: this.source.id,
        status: 'running',
        fileName,
        cursorBefore: cursorBefore,
      },
    });

    let added = 0;
    let skipped = failed + preSkipped; // битые + уже в БД
    const addedGames: ParsedGame[] = [];
    const positionRows: PositionRow[] = [];

    // Вставляем только неизвестные content_hash'и. Доп. catch на P2002 —
    // защита от race'а между pre-SELECT и INSERT (параллельный запуск).
    for (const game of freshGames) {
      // Копируем хэш в Uint8Array с собственным ArrayBuffer — Prisma не принимает
      // Buffer/SharedArrayBuffer-backed views в качестве входа `Bytes`.
      const hashBytes = new Uint8Array(game.contentHash.length);
      hashBytes.set(game.contentHash);
      try {
        const created = await this.prisma.archiveGame.create({
          data: {
            sourceId: this.source.id,
            importId: importRow.id,
            contentHash: hashBytes,
            event: game.event,
            site: game.site,
            round: game.round,
            date: game.date,
            playedAt: game.playedAt,
            whiteName: game.white,
            blackName: game.black,
            whiteElo: game.whiteElo,
            blackElo: game.blackElo,
            whiteTitle: game.whiteTitle,
            blackTitle: game.blackTitle,
            result: game.result,
            eco: game.eco,
            opening: game.opening,
            plyCount: game.plyCount,
            pgn: game.raw,
            finalFen: game.finalFen,
            timeControl: game.timeControl,
            category: game.category,
            isClassical: game.isClassical,
          },
          select: { id: true },
        });
        added++;
        addedGames.push(game);
        // KS-1626: метрики классификации.
        this.metrics.archiveGamesByCategoryTotal.inc({
          source: this.source.code,
          category: game.category,
        });
        this.metrics.archiveRejectedUnknownReasonTotal.inc({
          source: this.source.code,
          rule: game.classificationReason,
        });
        if (!game.isClassical) {
          this.metrics.archiveImportedNonClassicalTotal.inc({ source: this.source.code });
        } else {
          // В агрегаты/индекс позиций только классика.
          for (const row of buildPositionRowsForGame(created.id, game, DEFAULT_BUCKET)) {
            positionRows.push(row);
          }
        }
      } catch (err: unknown) {
        // P2002 — UNIQUE violation по content_hash → дубликат, это ОК.
        if (isUniqueViolation(err)) {
          skipped++;
        } else {
          skipped++;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[twic] game insert failed: ${msg}`);
        }
      }
    }

    // Позиционный индекс обновляем только по новым КЛАССИЧЕСКИМ партиям
    // (ADR-015 §2.4: non-classical не попадают в position_stats / дерево).
    const classicalGames = addedGames.filter((g) => g.isClassical);
    if (classicalGames.length > 0) {
      try {
        await this.indexer.index(classicalGames, this.source.code);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[twic] position-indexer failed: ${msg}`);
        // Партии вставлены — оставляем как есть, индексацию можно догнать backfill-процедурой.
      }
    }

    // Gauge: доля классических в последнем импорте источника.
    if (addedGames.length > 0) {
      this.metrics.archiveClassicalRatio.set(
        { source: this.source.code },
        classicalGames.length / addedGames.length,
      );
    }

    // COPY в archive_game_positions — отдельный путь (staging + ON CONFLICT DO NOTHING).
    // Падение не откатывает archive_games — индекс по позициям догоним backfill'ом.
    if (this.positionWriter && positionRows.length > 0) {
      try {
        await this.positionWriter.write(positionRows, this.source.code);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[twic] position-writer failed: ${msg}`);
      }
    }

    const status: ImportResult['status'] =
      failed > 0 ? 'partial' : 'ok';

    // В scheduler-режиме cursor двигается на processed issue; в ad-hoc
    // он остаётся равным cursorBefore — маркер «ad-hoc-импорт не сдвинул
    // source.cursor».
    const cursorAfter = opts.updateSourceCursor
      ? String(issue)
      : cursorBefore;
    await this.prisma.archiveImport.update({
      where: { id: importRow.id },
      data: {
        status,
        cursorAfter,
        gamesParsed: games.length + failed,
        gamesAdded: added,
        gamesSkipped: skipped,
        finishedAt: new Date(),
      },
    });

    if (opts.updateSourceCursor) {
      await this.prisma.archiveSource.update({
        where: { id: this.source.id },
        data: {
          cursor: cursorAfter,
          lastRunAt: new Date(),
          lastSuccessAt: new Date(),
          lastError: null,
          totalGames: { increment: added },
        },
      });
    }

    this.metrics.archiveImportGamesTotal.inc(
      { source: this.source.code, status: 'added' },
      added,
    );
    this.metrics.archiveImportGamesTotal.inc(
      { source: this.source.code, status: 'skipped' },
      skipped,
    );
    this.metrics.archiveImportGamesTotal.inc(
      { source: this.source.code, status: 'failed' },
      failed,
    );

    return {
      status,
      cursorBefore,
      cursorAfter,
      fileName,
      gamesParsed: games.length + failed,
      gamesAdded: added,
      gamesSkipped: skipped,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}
