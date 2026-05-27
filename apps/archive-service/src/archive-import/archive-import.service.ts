import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { acquireLock } from './archive-import-lock';
import { ArchivePositionWriterService } from './archive-position-writer.service';
import { PositionIndexerService } from './position-indexer.service';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';
import { PlayersEventsBackfillService } from './players-events-backfill.service';
// KS-3365: авто-триггер PVE-генерации после успешного scheduled
// TWIC-импорта. До этого фикса triggerPveGeneration вызывался только
// в ad-hoc CLI (cli/import-twic-issue.ts), и cron'ные импорты не
// запускали tactic-worker → precision-задачи не генерировались с 20.05.
import { triggerPveGeneration } from './trigger-pve-generation';
import {
  TwicImporter,
  type ArchiveSourceRow,
  type ImportResult,
} from './sources/twic.importer';
import { intervalFromSchedule } from './interval-schedule';
import {
  DEFAULT_TICK_ONCE_TIMEOUT_MS,
  resolveTickOnceTimeoutMs,
} from './importer-timeouts';

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
 * Ошибка hard-таймаута `tickOnce()` (KS-1681, ADR-020 §2.2, §4.2).
 *
 * Бросается из `tickOnce`, когда обход источников превысил
 * `TICK_ONCE_TIMEOUT_MS` (8 минут). Содержит `partial` — агрегированный
 * результат тех источников, что успели отработать до таймаута, чтобы
 * `importer-once.ts` смог опубликовать EMF-метрики для них и flush-нуть
 * в CloudWatch перед exit-ом.
 *
 * Без этого вся info (какие источники стартовали, какие сработали) была бы
 * потеряна в short-lived task.
 */
export class TickTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partial: TickResult,
  ) {
    super(message);
    this.name = 'TickTimeoutError';
  }
}

/**
 * Hard timeout одного tickOnce.
 *
 * Исторический default 8 мин (KS-1681, ADR-020 §2.2/§4.2) больше не
 * покрывает реальные TWIC weekly с 24-04-2026: парсинг ~7K партий стал
 * занимать ~17 мин (см. KS-2123, лог devops 28-04 20:01–20:18, exit 124
 * на стадии парсинга `twic1642g.zip`).
 *
 * Новый default — 30 мин (`DEFAULT_TICK_ONCE_TIMEOUT_MS` в
 * `importer-timeouts.ts`). Override через env `IMPORTER_TICK_TIMEOUT_MS`,
 * чтобы при следующем росте можно было поднять лимит правкой task
 * definition без redeploy кода.
 *
 * Экспорт оставлен для совместимости с тестами и внешним кодом — это
 * по-прежнему именно дефолтное значение (env-override не учитывается
 * здесь, его читает {@link resolveTickOnceTimeoutMs} в момент вызова
 * `tickOnce`). Не использовать как «текущий лимит» — для этого
 * вызывайте `resolveTickOnceTimeoutMs()`.
 *
 * @see DEFAULT_TICK_ONCE_TIMEOUT_MS
 * @see resolveTickOnceTimeoutMs
 */
export const TICK_ONCE_TIMEOUT_MS = DEFAULT_TICK_ONCE_TIMEOUT_MS;

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
const LOCK_KEY_PREFIX = 'archive:import:lock';

/**
 * KS-2156. Порог «висячести» для `archive_imports.status='running'`.
 * 60 минут даёт двукратный запас над реальным TWIC-импортом (12–18 мин,
 * см. KS-2123) — нормальный live-running случайно не зацепим.
 */
const STALE_RUNNING_THRESHOLD_MS = 60 * 60 * 1_000;

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
    private readonly playersEventsBackfill: PlayersEventsBackfillService,
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

    // KS-2156: чистка висячих `archive_imports.status='running'` ДО
    // первого tick'а. Если предыдущий процесс упал на середине импорта
    // (SIGKILL / unhandled exception до фикса try/finally), запись
    // оставалась `running` навсегда (видели 4 таких висяка после
    // инцидента 29.04). На старте пройтись по записям старше
    // STALE_RUNNING_THRESHOLD_MS и пометить failed.
    await this.cleanupStaleRunningImports().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Не фатально: новый импорт всё равно пойдёт, просто
      // в БД будет шум висячих record'ов. Но факт ошибки нужен.
      this.logger.warn(`cleanupStaleRunningImports failed: ${msg}`);
    });

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
   * KS-2156. Помечает все `archive_imports` со `status='running'` старше
   * {@link STALE_RUNNING_THRESHOLD_MS} как `failed` с причиной
   * `stale: process restart`.
   *
   * Threshold выбран 60 минут: реальный TWIC-импорт занимает 12–18 минут
   * (см. KS-2123, расширили tickOnce timeout до 30 мин). 60-минутный
   * порог даёт двукратный запас — нормальный импорт под этот фильтр
   * не попадёт. Если процесс упал — на старте следующего сервиса
   * (или onModuleInit при рестарте same instance) запись будет
   * корректно помечена.
   *
   * Вызывается на старте до первого tick'а — иначе мог бы пометить
   * собственный свежесозданный running (хотя 60-минутный порог почти
   * исключает такой race, отделение во времени — defence in depth).
   */
  private async cleanupStaleRunningImports(): Promise<void> {
    const staleAfter = new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS);
    const result = await this.prisma.archiveImport.updateMany({
      where: {
        status: 'running',
        startedAt: { lt: staleAfter },
      },
      data: {
        status: 'failed',
        error: 'stale: process restart',
        finishedAt: new Date(),
      },
    });
    if (result.count > 0) {
      this.logger.log(
        `cleanupStaleRunningImports: marked ${result.count} stale archive_imports as failed ` +
          `(thresholdMin=${Math.floor(STALE_RUNNING_THRESHOLD_MS / 60_000)})`,
      );
    } else {
      this.logger.log(
        `cleanupStaleRunningImports: no stale running rows (thresholdMin=${Math.floor(STALE_RUNNING_THRESHOLD_MS / 60_000)})`,
      );
    }
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
   *   - ADR-020 §2.2 + §4.2: hard timeout через `Promise.race`. Если
   *     обход превышает `TICK_ONCE_TIMEOUT_MS` (8 мин), бросается
   *     `TickTimeoutError` с `partial` — теми runs, что успели собраться.
   *     `importer-once.ts` ловит эту ошибку, публикует EMF для partial
   *     runs и flush-ит до `process.exit(124)`. Это принципиально —
   *     process-level `setTimeout(...process.exit)` на bootstrap-уровне
   *     теряет EMF, hard-таймаут внутри tickOnce — нет.
   *
   * Идемпотентность и lock-поведение — идентичны `tick()`: каждый
   * `runSource()` сам берёт Redis-lock `archive:import:lock:{code}`
   * (30 мин TTL), поэтому параллельный long-lived `importer-main` и
   * one-shot task не столкнутся.
   */
  async tickOnce(
    timeoutMs: number = resolveTickOnceTimeoutMs(),
  ): Promise<TickResult> {
    // Накопитель — доступен и из processAll(), и из timeout-ветки, чтобы
    // частичный результат попал в TickTimeoutError.partial.
    const state: TickResult = { runs: [], totalGamesAdded: 0 };
    let timedOut = false;

    const processAll = async (): Promise<TickResult> => {
      const sources = await this.prisma.archiveSource.findMany({
        where: { enabled: true },
      });
      for (const source of sources) {
        if (timedOut) break; // race проиграли, не начинаем следующий источник
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
          state.runs.push({
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
        let runOutcome: {
          result: ImportResult | null;
          lockHeld: boolean;
          error?: string;
        };
        try {
          runOutcome = await this.runSource(row);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          runOutcome = { result: null, lockHeld: false, error: msg };
        }
        const durationSec =
          Number(process.hrtime.bigint() - started) / 1_000_000_000;
        state.runs.push({
          sourceCode: row.code,
          due: true,
          lockHeld: runOutcome.lockHeld,
          result: runOutcome.result,
          durationSec,
          lastSuccessAt: row.lastSuccessAt,
          error: runOutcome.error,
        });
        if (runOutcome.result) {
          state.totalGamesAdded += runOutcome.result.gamesAdded;
        }
      }
      return state;
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(
          new TickTimeoutError(
            `tickOnce exceeded ${timeoutMs}ms; partial runs=${state.runs.length}`,
            state,
          ),
        );
      }, timeoutMs);
      // unref: если tickOnce завершится раньше, таймер не держит process alive.
      timeoutHandle.unref();
    });

    try {
      return await Promise.race([processAll(), timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
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
    // KS-1898: короткий TTL (60s) + heartbeat (30s) вместо длинного
    // TTL и надежды на cleanup. После SIGKILL в ECS ключ освобождается
    // за ≤60 сек, а не висит до старого 30-минутного TTL.
    const lock = await acquireLock({
      redis: this.redis,
      key: lockKey,
      role: 'scheduler',
      logger: this.logger,
    });
    if (!lock) {
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
          // KS-2156: lock.signal срабатывает при потере lock'а
          // (heartbeat mismatch / Redis-flap). Importer проверяет
          // signal между chunk'ами и пишет archive_imports.failed.
          const result = await importer.run({ signal: lock.signal });
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
          // KS-2064: после успешного импорта синхронизируем нормализованные
          // таблицы archive_players / archive_events и REFRESH MV
          // archive_player_stats CONCURRENTLY. Идёт ПОСЛЕ COPY партий в
          // `archive_games` / `archive_game_positions` (сама importer.run()
          // уже завершила COPY) и не блокирует основной импорт — ошибка
          // backfill'а только логируется.
          if (
            (result.status === 'ok' || result.status === 'partial') &&
            result.gamesAdded > 0 &&
            result.importId
          ) {
            await this.syncPlayersEventsAfterImport(result.importId).catch(
              (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.warn(
                  `${source.code}: players/events sync failed (non-fatal): ${msg}`,
                );
              },
            );
            // KS-3365: авто-триггер PVE-генерации после успешного
            // scheduled TWIC-импорта. До этого фикса вызов был только
            // в ad-hoc CLI (cli/import-twic-issue.ts), и cron'ные импорты
            // не запускали tactic-worker — precision-задачи не
            // генерировались с 20.05.2026. Ошибки триггера НЕ
            // фатальны для импорта (importId уже сохранён, генерацию
            // можно запустить вручную).
            await triggerPveGeneration({
              importId: result.importId,
              logger: this.logger,
            }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `${source.code}: PVE generation trigger failed (non-fatal): ${msg}`,
              );
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
      // KS-1898: release через Lua с проверкой токена — если ключ
      // уже перехватили (наш TTL истёк, кто-то взял), DEL не сделаем.
      // Heartbeat останавливается внутри release().
      await lock.release().catch(() => {});
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

  /**
   * KS-2064: вытаскивает партии текущего импорта (`importId`) и кормит
   * их в {@link PlayersEventsBackfillService.syncDelta}, который UPSERT'ит
   * новые имена/события и делает REFRESH MV CONCURRENTLY.
   *
   * Не throw'ает — вызывающий код считает ошибки backfill'а
   * non-fatal (только лог + не двигает `lastError` источника).
   */
  private async syncPlayersEventsAfterImport(importId: string): Promise<void> {
    const games = await this.prisma.archiveGame.findMany({
      where: { importId },
      select: {
        whiteName: true,
        blackName: true,
        whiteElo: true,
        blackElo: true,
        event: true,
        playedAt: true,
        date: true,
      },
    });
    if (games.length === 0) return;
    const report = await this.playersEventsBackfill.syncDelta({
      games: games.map((g) => ({
        whiteName: g.whiteName,
        blackName: g.blackName,
        whiteElo: g.whiteElo,
        blackElo: g.blackElo,
        event: g.event,
        playedAt: g.playedAt,
        date: g.date,
      })),
    });
    this.logger.log(
      `players/events sync: importId=${importId} players+=${report.upsertedPlayers} events+=${report.upsertedEvents}`,
    );
  }
}
