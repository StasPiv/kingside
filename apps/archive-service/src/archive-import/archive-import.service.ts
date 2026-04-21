import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ArchivePositionWriterService } from './archive-position-writer.service';
import { PositionIndexerService } from './position-indexer.service';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';
import {
  TwicImporter,
  type ArchiveSourceRow,
  type ImportResult,
} from './sources/twic.importer';
import { intervalFromSchedule } from './interval-schedule';

/**
 * Результат запуска одного источника в рамках tickOnce (KS-1681).
 *
 * Содержит полный `ImportResult` импортёра (если запуск состоялся),
 * длительность (для EMF `ImportDurationSeconds`) и знание, был ли
 * источник вообще due + была ли успешная публикация ранее
 * (для EMF `LastSuccessAgeSeconds`).
 */
export interface TickSourceResult {
  sourceCode: string;
  /** due==false → источник не настал, runSource не вызывался. */
  due: boolean;
  /** lockHeld==true → другой worker держит lock, runSource пропущен. */
  lockHeld: boolean;
  /** Результат импортёра; null, если source был не-due/lockHeld/unknown-kind. */
  result: ImportResult | null;
  /** Длительность одного runSource в секундах (для EMF). */
  durationSec: number;
  /**
   * lastSuccessAt на момент старта runSource — даже для не-due источника
   * это значение публикуется как `LastSuccessAgeSeconds`, чтобы CloudWatch
   * alarm «14 дней без успехов» срабатывал независимо от due-окна.
   */
  lastSuccessAt: Date | null;
  /** Сообщение ошибки (если была выброшена, а не обёрнута в ImportResult.failed). */
  error?: string;
}

export interface TickResult {
  runs: TickSourceResult[];
  totalGamesAdded: number;
}

/**
 * Оркестратор импорта.
 *
 * Раз в `TICK_INTERVAL_MS` обходит `archive_sources` с `enabled = true`,
 * для каждого «созревшего» источника берёт Redis-lock
 * (`archive:import:lock:{code}`) и запускает соответствующий импортёр.
 *
 * Отличия от исторического `ArchiveImporter` класса (archive-importer
 * пакет, удалён по KS-1676):
 *   - планировщик — `@nestjs/schedule` `@Interval(60_000)` (ADR-019 §2.5)
 *     вместо setInterval;
 *   - зависимости инжектятся через DI, singleton-ы переживают tick'и;
 *   - ключ lock'а и TTL идентичны (`archive:import:lock:{code}`, 30 мин)
 *     — ADR-019 §2.11.
 */

const TICK_INTERVAL_MS = 60_000;
const LOCK_TTL_SEC = 30 * 60;
const LOCK_KEY_PREFIX = 'archive:import:lock';

type SourceKind = 'twic';

interface SourceRow {
  id: string;
  code: string;
  kind: string;
  enabled: boolean;
  schedule: string | null;
  cursor: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
}

@Injectable()
export class ArchiveImportService implements OnModuleInit {
  private readonly logger = new Logger(ArchiveImportService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly positionWriter: ArchivePositionWriterService,
    private readonly indexer: PositionIndexerService,
    private readonly metrics: ArchiveImportMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('ArchiveImportService starting...');
    const dbUrl = (process.env.ARCHIVE_DATABASE_URL || '').replace(
      /\/\/[^@]*@/,
      '//***@',
    );
    this.logger.log(`ARCHIVE_DATABASE_URL=${dbUrl}`);
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      this.logger.log('DB reachable');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`DB UNREACHABLE: ${msg}`);
      // Не бросаем — importer-main умеет подняться c degraded health.
      return;
    }
    // KS-1681: в one-shot режиме (EventBridge) initial tick не нужен —
    // tickOnce() вызовет importer-once.ts сам, явно. Иначе произошёл бы
    // двойной запуск (onModuleInit.tick() + tickOnce()), при котором
    // tickOnce попал бы в `this.running === true` и вернул пустой результат.
    if (process.env.IMPORTER_ONE_SHOT === '1') {
      this.logger.log('ArchiveImportService started in one-shot mode (initial tick skipped)');
      return;
    }
    // Первый tick — сразу, не ждём минуту.
    this.tick().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`initial tick error: ${msg}`);
    });
    this.logger.log(`ArchiveImportService running — tick interval ${TICK_INTERVAL_MS}ms`);
  }

  /**
   * Один проход планировщика: ищем готовые к запуску источники и
   * обрабатываем.
   */
  @Interval(TICK_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.log('tick skipped — previous tick still running');
      return;
    }
    this.running = true;
    try {
      const sources = await this.prisma.archiveSource.findMany({
        where: { enabled: true },
      });
      for (const source of sources) {
        if (!this.isDue(source)) continue;
        await this.runSource({
          id: source.id,
          code: source.code,
          kind: source.kind,
          enabled: source.enabled,
          schedule: source.schedule ?? null,
          cursor: source.cursor ?? null,
          lastRunAt: source.lastRunAt ?? null,
          lastSuccessAt: source.lastSuccessAt ?? null,
        });
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * One-shot вариант tick для EventBridge ECS RunTask (KS-1681, ADR-020 §0).
   *
   * Отличия от `tick()`:
   *   - не зависит от `@Interval` декоратора и `this.running` флага
   *     (short-lived процесс выполняет ровно один tick);
   *   - возвращает детальный `TickResult` с per-source результатом и
   *     длительностью — `importer-once.ts` публикует это в EMF (CloudWatch);
   *   - `LastSuccessAgeSeconds` надо публиковать и для не-due/lockHeld
   *     источников, поэтому tickOnce собирает `TickSourceResult` по всем
   *     enabled-источникам, а не только по due.
   *
   * Идемпотентность и lock-поведение — идентичны `tick()`: каждый
   * `runSource()` сам берёт Redis-lock `archive:import:lock:{code}`
   * (30 мин TTL), поэтому параллельный long-lived `importer-main` и
   * one-shot task не столкнутся.
   */
  async tickOnce(): Promise<TickResult> {
    const sources = await this.prisma.archiveSource.findMany({
      where: { enabled: true },
    });
    const runs: TickSourceResult[] = [];
    let totalGamesAdded = 0;
    for (const source of sources) {
      const row: SourceRow = {
        id: source.id,
        code: source.code,
        kind: source.kind,
        enabled: source.enabled,
        schedule: source.schedule ?? null,
        cursor: source.cursor ?? null,
        lastRunAt: source.lastRunAt ?? null,
        lastSuccessAt: source.lastSuccessAt ?? null,
      };
      const due = this.isDue(row);
      if (!due) {
        runs.push({
          sourceCode: row.code,
          due: false,
          lockHeld: false,
          result: null,
          durationSec: 0,
          lastSuccessAt: row.lastSuccessAt,
        });
        continue;
      }
      const started = process.hrtime.bigint();
      let runOutcome: { result: ImportResult | null; lockHeld: boolean; error?: string };
      try {
        runOutcome = await this.runSource(row);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        runOutcome = { result: null, lockHeld: false, error: msg };
      }
      const durationSec =
        Number(process.hrtime.bigint() - started) / 1_000_000_000;
      runs.push({
        sourceCode: row.code,
        due: true,
        lockHeld: runOutcome.lockHeld,
        result: runOutcome.result,
        durationSec,
        lastSuccessAt: row.lastSuccessAt,
        error: runOutcome.error,
      });
      if (runOutcome.result) {
        totalGamesAdded += runOutcome.result.gamesAdded;
      }
    }
    return { runs, totalGamesAdded };
  }

  /**
   * Запуск импорта одного источника: Redis-lock → импортёр → отпуск lock.
   * Повторяется безопасно — вторая копия воркера не запустит тот же импорт.
   *
   * Возвращает (KS-1681): `{ result, lockHeld, error? }`.
   *   - `result` — `ImportResult` импортёра (или null, если не стартовал
   *     из-за lock/unknown-kind);
   *   - `lockHeld=true` — другой worker держит lock (для tickOnce — это
   *     не ошибка, просто ничего не сделали);
   *   - `error` — неожиданный throw (не обёрнутый в ImportResult.failed);
   *     tickOnce попадает сюда крайне редко, т.к. TwicImporter сам ловит
   *     и оборачивает ошибки.
   */
  async runSource(
    source: SourceRow,
  ): Promise<{
    result: ImportResult | null;
    lockHeld: boolean;
    error?: string;
  }> {
    const lockKey = `${LOCK_KEY_PREFIX}:${source.code}`;
    const acquired = await this.redis
      .set(lockKey, `${process.pid}:${Date.now()}`, 'EX', LOCK_TTL_SEC, 'NX')
      .catch(() => null);
    if (acquired !== 'OK') {
      this.logger.log(`${source.code}: lock held, skipping`);
      return { result: null, lockHeld: true };
    }

    this.logger.log(
      `${source.code}: starting import (kind=${source.kind}, cursor=${source.cursor})`,
    );
    let capturedResult: ImportResult | null = null;
    let capturedError: string | undefined;
    try {
      await this.metrics.timeImport(source.code, async () => {
        if ((source.kind as SourceKind) === 'twic') {
          const importer = new TwicImporter(
            this.prisma,
            source as ArchiveSourceRow,
            this.positionWriter,
            this.indexer,
            this.metrics,
          );
          const result = await importer.run();
          capturedResult = result;
          this.logger.log(
            `${source.code}: status=${result.status} parsed=${result.gamesParsed} added=${result.gamesAdded} skipped=${result.gamesSkipped} cursor=${result.cursorBefore}→${result.cursorAfter}`,
          );
          if (result.status === 'failed' && result.error) {
            await this.prisma.archiveSource.update({
              where: { id: source.id },
              data: { lastRunAt: new Date(), lastError: result.error },
            });
          }
        } else {
          this.logger.warn(`${source.code}: unknown kind "${source.kind}"`);
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      capturedError = msg;
      this.logger.error(`${source.code}: import failed: ${msg}`);
      await this.prisma.archiveSource
        .update({
          where: { id: source.id },
          data: { lastRunAt: new Date(), lastError: msg },
        })
        .catch(() => {});
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
    return { result: capturedResult, lockHeld: false, error: capturedError };
  }

  /**
   * Проверяет, готов ли источник к следующему запуску.
   *
   * Если `schedule` пустой — минимальный интервал 60 минут от lastRunAt.
   * Иначе парсим простой cron (поддерживается `*\/N * * * *` и
   * `0 *\/N * * *`); для любых других форм — fallback 60 минут.
   * Полный cron-парсер добавится в KS-158x (отдельная задача).
   */
  private isDue(source: {
    schedule: string | null;
    lastRunAt: Date | null;
  }): boolean {
    const now = Date.now();
    const last = source.lastRunAt?.getTime() ?? 0;
    const intervalMs = intervalFromSchedule(source.schedule);
    return now - last >= intervalMs;
  }
}
