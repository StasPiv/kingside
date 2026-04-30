/**
 * KS-2163. SyntheticBootstrapService — фоновый job, запускающий
 * synthetic-vs-synthetic партии до тех пор, пока у каждого synthetic'а
 * не накопится `SYNTHETIC_BOOTSTRAP_TARGET_GAMES` партий.
 *
 * Это РЕАЛЬНЫЕ партии: создаются записи `Game` / `Move` через
 * `BootstrapGameLauncher`, обе стороны — synthetic users (KS-2162),
 * ходы — через `BotGameRunner` (KS-2161), результат пишется как
 * любая другая партия.
 *
 * Resume: каждый scheduler-tick перечитывает счётчики из БД (count(*)
 * FROM games WHERE whiteId=? OR blackId=?) — никакого in-memory state,
 * рестарт не теряет прогресса.
 *
 * Этот файл реализует **тиковый цикл и pure-логику**. Реальный
 * `BootstrapGameLauncher` (создание Game + spin-up двух runner'ов +
 * ожидание завершения) интегрируется в follow-up'е, когда GameService
 * получит метод `startSyntheticGame(white, black, tc)`. Здесь —
 * интерфейс-seam, тестируется через подменяемый launcher.
 *
 * Опт-ин через env `SYNTHETIC_BOOTSTRAP_ENABLED=true`.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SyntheticEnvKey, type TimeControlCategory } from '@kingside/shared';
import {
  computeBootstrapProgress,
  parseTcDistribution,
  pickTcCategory,
  selectBootstrapPair,
  type BootstrapProgress,
  type SyntheticCandidate,
} from './bootstrap-helpers';

const DEFAULT_TARGET_GAMES = 30;
const DEFAULT_PARALLELISM = 30;
const DEFAULT_TICK_MS = 30_000; // 30 сек между tick'ами
const DEFAULT_PROGRESS_LOG_MS = 5 * 60_000; // 5 мин

/**
 * Узкий API доступа к Prisma (или иному источнику счётчиков). В тестах
 * подменяется fake-стораджем.
 */
export interface BootstrapPrisma {
  user: {
    findMany(args: {
      where: { isSynthetic: boolean };
      select: Record<string, boolean>;
    }): Promise<
      Array<{
        id: string;
        ratingBullet: number;
        ratingBlitz: number;
        ratingRapid: number;
        ratingClassical: number;
      }>
    >;
  };
  /**
   * Сколько партий сыграл synthetic с каждым из своих партнёров — нужно
   * для PAIR_MAX_REPEAT_PARTNER. Реализация: один SQL c COUNT GROUP BY.
   */
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...args: unknown[]
  ): Promise<T>;
}

/**
 * Запускает одну bootstrap-партию между двумя synthetic-юзерами и ждёт
 * её завершения. Реализация подключается отдельно (см. описание сверху).
 */
export interface BootstrapGameLauncher {
  start(opts: {
    whiteId: string;
    blackId: string;
    category: TimeControlCategory;
  }): Promise<{ gameId: string }>;
}

/**
 * Хранит in-memory счётчик «партий в полёте» (запущенных, но ещё не
 * завершённых) — нужен для лимита параллелизма. Реальное состояние
 * партий — в БД (`Game.status='active'`), in-memory счётчик нужен
 * только для немедленных решений в одном tick'е, переживать рестарт
 * ему не нужно.
 */
interface InFlightSlot {
  gameId: string;
  startedAt: number;
}

@Injectable()
export class SyntheticBootstrapService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SyntheticBootstrapService.name);
  private prisma: BootstrapPrisma | null = null;
  private launcher: BootstrapGameLauncher | null = null;
  private inFlight: InFlightSlot[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastProgressLogAt = 0;
  private rateGamesPerHour: number | null = null;
  private gamesAtTickStart = 0;
  private firstTickAt = 0;

  configure(prisma: BootstrapPrisma, launcher: BootstrapGameLauncher): void {
    this.prisma = prisma;
    this.launcher = launcher;
  }

  async onModuleInit(): Promise<void> {
    if (process.env.SYNTHETIC_BOOTSTRAP_ENABLED !== 'true') {
      this.logger.log(
        'SYNTHETIC_BOOTSTRAP_ENABLED != "true" — bootstrap disabled',
      );
      return;
    }
    if (!this.prisma || !this.launcher) {
      this.logger.warn(
        'SyntheticBootstrapService: configure() not called — module integration broken',
      );
      return;
    }
    const tickMs = this.envInt('SYNTHETIC_BOOTSTRAP_TICK_MS', DEFAULT_TICK_MS);
    this.logger.log(
      `bootstrap started: target=${this.targetGames()} parallel=${this.parallelism()} tickMs=${tickMs}`,
    );
    this.timer = setInterval(() => void this.tickSafe(), tickMs);
    void this.tickSafe();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Env helpers ──────────────────────────────────────────────────

  private envInt(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }
  targetGames(): number {
    return this.envInt(
      SyntheticEnvKey.BootstrapTargetGames,
      DEFAULT_TARGET_GAMES,
    );
  }
  parallelism(): number {
    // Особый случай: 0 — валидный override (полностью отключить запуск
    // новых партий, оставив только мониторинг прогресса). Поэтому
    // используем кастомный parser с >=0 вместо envInt (>0).
    const raw = process.env.SYNTHETIC_BOOTSTRAP_PARALLELISM;
    if (raw === undefined) return DEFAULT_PARALLELISM;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PARALLELISM;
  }

  // ─── Tick ─────────────────────────────────────────────────────────

  private async tickSafe(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tickOnce();
    } catch (err) {
      this.logger.error(`bootstrap tick failed: ${(err as Error).message}`);
    }
  }

  /**
   * Один tick (public — для тестов). Возвращает решения tick'а.
   */
  async tickOnce(now: number = Date.now()): Promise<{
    progress: BootstrapProgress;
    pairsLaunched: number;
  }> {
    if (!this.prisma || !this.launcher) {
      return {
        progress: emptyProgress(),
        pairsLaunched: 0,
      };
    }
    if (!this.firstTickAt) this.firstTickAt = now;

    const counts = await this.fetchSyntheticCounts();
    if (counts.size === 0) {
      this.logger.warn('bootstrap: 0 synthetic users in DB — nothing to do');
      return {
        progress: emptyProgress(),
        pairsLaunched: 0,
      };
    }

    // Прогресс / ETA.
    const target = this.targetGames();
    this.updateRate(counts, now);
    const progress = computeBootstrapProgress(
      mapCounts(counts),
      target,
      this.rateGamesPerHour,
    );

    if (progress.done) {
      const durationHours = (now - this.firstTickAt) / 3600_000;
      this.logger.log(
        `bootstrap COMPLETE: completed=${progress.completed}/${progress.totalSynthetics} ` +
          `gamesTotal=${progress.gamesPlayedTotal} duration=${durationHours.toFixed(1)}h`,
      );
      return { progress, pairsLaunched: 0 };
    }

    if (now - this.lastProgressLogAt >= DEFAULT_PROGRESS_LOG_MS) {
      this.logger.log(
        `synthetic bootstrap progress: completed=${progress.completed}/${progress.totalSynthetics} ` +
          `games=${progress.gamesPlayedTotal} remaining=${progress.gamesRemainingTotal} ` +
          `parallel=${this.inFlight.length} ` +
          `eta=${progress.etaHours == null ? '?' : `${progress.etaHours.toFixed(1)}h`}`,
      );
      this.lastProgressLogAt = now;
    }

    // Snapshot для следующего расчёта rate.
    this.gamesAtTickStart = progress.gamesPlayedTotal;

    // Заполняем parallelism до cap'а.
    const cap = this.parallelism();
    this.cleanupCompletedSlots();
    let launched = 0;
    while (this.inFlight.length < cap) {
      const candidates = this.buildCandidates(counts, target);
      const pair = selectBootstrapPair(candidates);
      if (!pair) break;
      const tc = pickTcCategory(
        parseTcDistribution(
          process.env.SYNTHETIC_BOOTSTRAP_TC_DISTRIBUTION,
        ),
      );
      try {
        const { gameId } = await this.launcher.start({
          whiteId: pair.white.userId,
          blackId: pair.black.userId,
          category: tc,
        });
        this.inFlight.push({ gameId, startedAt: now });
        launched++;
        // Учитываем партию заранее в локальных counts, чтобы следующий
        // подбор пары в этом же tick'е видел свежие числа.
        counts.set(
          pair.white.userId,
          this.bumpCount(counts, pair.white.userId),
        );
        counts.set(
          pair.black.userId,
          this.bumpCount(counts, pair.black.userId),
        );
      } catch (err) {
        this.logger.warn(
          `launcher.start failed: ${(err as Error).message}`,
        );
        break;
      }
    }

    return { progress, pairsLaunched: launched };
  }

  /**
   * Считает «партий в час» по дельте `gamesPlayedTotal` между двумя
   * tick'ами. Рассчитывается только если tick'и разделены >0 ms.
   */
  private updateRate(
    counts: ReadonlyMap<string, SyntheticState>,
    now: number,
  ): void {
    if (!this.gamesAtTickStart) return;
    const sumNow = sumGames(counts);
    const delta = sumNow - this.gamesAtTickStart;
    const hoursDelta = (now - this.firstTickAt) / 3600_000;
    if (hoursDelta > 0 && delta >= 0) {
      // Простой кумулятивный rate с момента первого tick'а — стабильнее
      // moving-average, не дёргается на единичных tick'ах.
      this.rateGamesPerHour = sumNow > 0 ? sumNow / Math.max(0.01, hoursDelta) : null;
    }
  }

  private bumpCount(
    counts: ReadonlyMap<string, SyntheticState>,
    userId: string,
  ): SyntheticState {
    const existing = counts.get(userId);
    if (!existing) throw new Error(`bumpCount: unknown user ${userId}`);
    return {
      ...existing,
      gamesPlayed: existing.gamesPlayed + 1,
    };
  }

  private cleanupCompletedSlots(): void {
    // Реальная проверка завершения — через DB (Game.status='finished').
    // На текущей итерации этой интеграции нет (см. komment в шапке файла);
    // оставляем `inFlight` накопительным до запуска follow-up'а. На
    // длинном горизонте launcher должен сам resolve'ить promise после
    // завершения партии и уведомлять сервис; либо tickOnce делает SELECT
    // count WHERE id IN (gameIds) AND status='finished'.
  }

  private buildCandidates(
    counts: ReadonlyMap<string, SyntheticState>,
    _target: number,
  ): SyntheticCandidate[] {
    const arr: SyntheticCandidate[] = [];
    for (const [userId, state] of counts) {
      arr.push({
        userId,
        rating: state.rating,
        gamesPlayed: state.gamesPlayed,
        partnerCounts: state.partnerCounts,
      });
    }
    return arr;
  }

  /**
   * Достаёт текущее состояние synthetic'ов из БД.
   * Возвращает `Map<userId, SyntheticState>` — rating + gamesPlayed +
   * partner counts.
   *
   * Один запрос для users + один для partner-counts — total 2 round-trip'а
   * на tick. На пуле 200 это копейки.
   */
  private async fetchSyntheticCounts(): Promise<Map<string, SyntheticState>> {
    if (!this.prisma) return new Map();
    const users = await this.prisma.user.findMany({
      where: { isSynthetic: true },
      select: {
        id: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
      },
    });
    if (users.length === 0) return new Map();

    // Counts: для каждой пары synthetic-userId — сколько партий между
    // ними (в любую сторону). Источник — таблица `games`. Один SQL.
    const ids = users.map((u) => u.id);
    type Row = {
      a: string;
      b: string;
      cnt: bigint | number | string;
    };
    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `
        SELECT
          LEAST(white_id::text, black_id::text) AS a,
          GREATEST(white_id::text, black_id::text) AS b,
          COUNT(*)::int AS cnt
        FROM games
        WHERE white_id::text = ANY($1::text[])
          AND black_id::text = ANY($1::text[])
          AND is_synthetic_opponent = true
        GROUP BY 1, 2
      `,
      ids,
    );

    // Per-user totals — сколько ВСЕГО игр сыграл synthetic vs другие
    // synthetic'и.
    const totals = new Map<string, number>();
    const partner = new Map<string, Map<string, number>>();
    for (const id of ids) {
      totals.set(id, 0);
      partner.set(id, new Map());
    }
    for (const r of rows) {
      const c = Number(r.cnt);
      totals.set(r.a, (totals.get(r.a) ?? 0) + c);
      totals.set(r.b, (totals.get(r.b) ?? 0) + c);
      partner.get(r.a)!.set(r.b, c);
      partner.get(r.b)!.set(r.a, c);
    }

    const out = new Map<string, SyntheticState>();
    for (const u of users) {
      out.set(u.id, {
        rating: averageOf4(u),
        gamesPlayed: totals.get(u.id) ?? 0,
        partnerCounts: partner.get(u.id) ?? new Map(),
      });
    }
    return out;
  }
}

interface SyntheticState {
  rating: number;
  gamesPlayed: number;
  partnerCounts: Map<string, number>;
}

function averageOf4(u: {
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
}): number {
  return Math.round(
    (u.ratingBullet + u.ratingBlitz + u.ratingRapid + u.ratingClassical) / 4,
  );
}

function mapCounts(
  counts: ReadonlyMap<string, SyntheticState>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of counts) out.set(k, v.gamesPlayed);
  return out;
}

function sumGames(counts: ReadonlyMap<string, SyntheticState>): number {
  let s = 0;
  for (const v of counts.values()) s += v.gamesPlayed;
  return s;
}

function emptyProgress(): BootstrapProgress {
  return {
    completed: 0,
    totalSynthetics: 0,
    gamesPlayedTotal: 0,
    gamesRemainingTotal: 0,
    done: false,
    etaHours: null,
  };
}
