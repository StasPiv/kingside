import AdmZip from 'adm-zip';
import type { PrismaClient } from '@kingside/archive-db';
import { decodePgnBuffer, parseBatch, type ParsedGame } from '../pgn-utils.js';
import { PositionIndexer } from '../position-indexer.js';
import { ArchivePositionWriter } from '../archive-position-writer.js';
import {
  buildPositionRowsForGame,
  type PositionRow,
} from '../position-row-builder.js';
import { filterAlreadyImported } from '../dedup.js';
import {
  archiveClassicalRatio,
  archiveGamesByCategoryTotal,
  archiveImportGamesTotal,
  archiveImportedNonClassicalTotal,
  archiveRejectedUnknownReasonTotal,
} from '../metrics.js';

const DEFAULT_BUCKET = 'master';

/**
 * TWIC (The Week In Chess) — еженедельный архив партий, выпуски нумерованы
 * монотонно. URL: `https://theweekinchess.com/zips/twic{N}g.zip`.
 *
 * Воркер хранит текущий `cursor` в `archive_sources` — последний успешно
 * обработанный номер выпуска. На каждый импорт пробует `cursor + 1`.
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

interface ArchiveSourceRow {
  id: string;
  code: string;
  cursor: string | null;
}

export class TwicImporter {
  private readonly indexer: PositionIndexer;
  private readonly positionWriter: ArchivePositionWriter | null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly source: ArchiveSourceRow,
    positionWriter?: ArchivePositionWriter,
  ) {
    this.indexer = new PositionIndexer(prisma, source.code);
    // Writer общий на воркер — ждём его снаружи; в CLI/тесте допустим null,
    // тогда пропускаем запись в archive_game_positions.
    this.positionWriter = positionWriter ?? null;
  }

  /** Формирует URL для указанного номера выпуска. */
  private static urlFor(issue: number): string {
    return TWIC_URL_TEMPLATE.replace('{N}', issue.toString());
  }

  /** Скачивает zip-файл. Возвращает null на 404 (нет ещё такого выпуска). */
  private async downloadZip(issue: number): Promise<Buffer | null> {
    const url = TwicImporter.urlFor(issue);
    console.log(`[archive-importer][twic] GET ${url}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      console.log(`[archive-importer][twic] issue ${issue} not yet published (404)`);
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
   * Выполняет один проход импорта. Возвращает структуру для `archive_imports`.
   * Метод идемпотентен: дубликаты отсекаются через UNIQUE `content_hash`.
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

    let zipBuffer: Buffer | null;
    try {
      zipBuffer = await this.downloadZip(nextIssue);
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
    console.log(`[archive-importer][twic] issue ${nextIssue}: parsed=${games.length} failed=${failed}`);

    // KS-1621: idempotent index. Отфильтровываем одним SELECT'ом уже
    // сохранённые content_hash — чтобы retry того же TWIC-пакета не
    // инкрементировал `position_stats` второй раз. Cycle insert ниже
    // остаётся защищённым catch'ем P2002 на случай race'а.
    const freshGames = await filterAlreadyImported(this.prisma, games);
    const preSkipped = games.length - freshGames.length;

    // Запись в archive_imports с `status=running` и полученный id привязан к каждой партии.
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
        archiveGamesByCategoryTotal.inc({
          source: this.source.code,
          category: game.category,
        });
        archiveRejectedUnknownReasonTotal.inc({
          source: this.source.code,
          rule: game.classificationReason,
        });
        if (!game.isClassical) {
          archiveImportedNonClassicalTotal.inc({ source: this.source.code });
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
          console.warn(`[archive-importer][twic] game insert failed: ${msg}`);
        }
      }
    }

    // Позиционный индекс обновляем только по новым КЛАССИЧЕСКИМ партиям
    // (ADR-015 §2.4: non-classical не попадают в position_stats / дерево).
    const classicalGames = addedGames.filter((g) => g.isClassical);
    if (classicalGames.length > 0) {
      try {
        await this.indexer.index(classicalGames);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[archive-importer][twic] position-indexer failed: ${msg}`);
        // Партии вставлены — оставляем как есть, индексацию можно догнать backfill-процедурой.
      }
    }

    // Gauge: доля классических в последнем импорте источника.
    if (addedGames.length > 0) {
      archiveClassicalRatio.set(
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
        console.error(`[archive-importer][twic] position-writer failed: ${msg}`);
      }
    }

    const status: ImportResult['status'] =
      failed > 0 ? 'partial' : 'ok';

    const cursorAfter = String(nextIssue);
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

    archiveImportGamesTotal.inc({ source: this.source.code, status: 'added' }, added);
    archiveImportGamesTotal.inc({ source: this.source.code, status: 'skipped' }, skipped);
    archiveImportGamesTotal.inc({ source: this.source.code, status: 'failed' }, failed);

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
