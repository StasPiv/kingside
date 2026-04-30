/**
 * KS-2164. SyntheticSchedulerService — каждые 5 минут считает
 * `desired = base_curve(hour, dow, cat)`, читает `live_avg`, выводит
 * `actual_synthetic` через {@link syntheticAdaptedDesired}, синхронизирует
 * фактическое количество synthetic'ов в очереди под `actual`.
 *
 * Дополнительно — kill-switch: если **прямо сейчас** живых ≥
 * `SYNTHETIC_DISABLE_AT_LIVE_QUEUE_LEN` (default 3), для этой категории
 * `actual=0` независимо от формулы.
 *
 * Раздельные пути:
 *   - `tickPure(...)`  — чистая логика расчёта (testable, без побочек).
 *   - `tickAndApply()` — Nest-обёртка: читает Redis/Prisma, считает,
 *     вызывает Presence для add/remove.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  syntheticAdaptedDesired,
  syntheticBaseCurveAt,
  SyntheticEnvKey,
  SYNTHETIC_BASE_CURVE_DEFAULT,
  type SyntheticBaseCurve,
  type SyntheticQueueCategory,
} from '@kingside/shared';
import {
  currentLiveCount,
  liveAverageRecent,
  recordLiveSample,
  type LiveQueueCategory,
} from './live-queue-stats';

function ratingFieldForCategory(
  cat: SyntheticQueueCategory,
):
  | 'ratingBullet'
  | 'ratingBlitz'
  | 'ratingRapid'
  | 'ratingClassical' {
  switch (cat) {
    case 'bullet':
      return 'ratingBullet';
    case 'blitz':
      return 'ratingBlitz';
    case 'rapid':
      return 'ratingRapid';
    case 'classical':
      return 'ratingClassical';
  }
}
import type { SyntheticPresenceService } from './synthetic-presence.service';
import type { SyntheticDeps } from './synthetic-deps';

const DEFAULT_SCHEDULER_TICK_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_KILL_SWITCH = 3;

const ALL_CATEGORIES: LiveQueueCategory[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
];

/**
 * Чистая часть tick'а одной категории. Возвращает решение —
 * {target, killSwitchTriggered, current, liveAvg, liveNow}.
 *
 * Не делает побочных эффектов. Подменяемый `now` для тестов.
 */
export interface TickInput {
  category: SyntheticQueueCategory;
  liveNow: number;
  liveAvg: number;
  syntheticInQueue: number;
  killSwitchThreshold: number;
  curve: SyntheticBaseCurve;
  now: Date;
}

export interface TickDecision {
  category: SyntheticQueueCategory;
  desired: number;
  liveAvg: number;
  liveNow: number;
  killSwitchTriggered: boolean;
  target: number;
  current: number;
  delta: number; // target - current. >0 — надо добавить N, <0 — удалить.
}

export function tickPure(input: TickInput): TickDecision {
  const desired = syntheticBaseCurveAt(input.now, input.category, input.curve);
  const killSwitchTriggered = input.liveNow >= input.killSwitchThreshold;
  const adapted = killSwitchTriggered
    ? 0
    : syntheticAdaptedDesired(desired, input.liveAvg);
  return {
    category: input.category,
    desired,
    liveAvg: input.liveAvg,
    liveNow: input.liveNow,
    killSwitchTriggered,
    target: adapted,
    current: input.syntheticInQueue,
    delta: adapted - input.syntheticInQueue,
  };
}

@Injectable()
export class SyntheticSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyntheticSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private deps: SyntheticDeps | null = null;
  private presence: SyntheticPresenceService | null = null;
  private curve: SyntheticBaseCurve = SYNTHETIC_BASE_CURVE_DEFAULT;

  configure(
    deps: SyntheticDeps,
    presence: SyntheticPresenceService,
  ): void {
    this.deps = deps;
    this.presence = presence;
    this.loadCurveOverride();
  }

  async onModuleInit(): Promise<void> {
    if (process.env[SyntheticEnvKey.SchedulerEnabled] !== 'true') {
      this.logger.log(
        `${SyntheticEnvKey.SchedulerEnabled} != "true" — synthetic scheduler disabled`,
      );
      return;
    }
    if (!this.deps || !this.presence) {
      this.logger.warn(
        'SyntheticSchedulerService: configure() not called — module integration broken',
      );
      return;
    }

    const tickMs = this.tickIntervalMs();
    this.logger.log(
      `synthetic scheduler started: tickMs=${tickMs} killSwitch=${this.killSwitchThreshold()} curveSource=${
        process.env[SyntheticEnvKey.ScheduleOverrideJson] ? 'env' : 'default'
      }`,
    );
    this.timer = setInterval(() => void this.tickAndApply(), tickMs);
    // Первый tick — сразу, без 5-минутной паузы.
    void this.tickAndApply();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  // ─── KS-2165: allocateSynthetic ─────────────────────────────────────

  /**
   * KS-2165 (B6). Выдаёт синтета под matchmaking-fallback. Условия:
   *   - kill-switch неактивен (live в очереди < threshold);
   *   - у синтета `state=idle` (есть в idle-roster);
   *   - рейтинг близок к запрошенному (rating-диапазон ±150 cp).
   *
   * Возвращает `{ userId, rating, username }` либо `null` если нечего
   * подобрать. Не меняет state синтета — это ответственность caller'а
   * (Matchmaking создаёт партию, переводит в `in_game`).
   */
  async allocateSynthetic(
    requesterRating: number,
    category: SyntheticQueueCategory,
  ): Promise<{ userId: string; rating: number; username: string } | null> {
    if (this.stopped || !this.deps || !this.presence) return null;

    // Kill-switch: если live ≥ threshold, scheduler НЕ должен подсовывать
    // синтета — пользователю важно играть с реальным.
    const liveNow = await currentLiveCount(this.deps.redis, category);
    if (liveNow >= this.killSwitchThreshold()) {
      return null;
    }

    // Проверка фича-флага: если scheduler выключен, allocate не работает
    // (matchmaking просто не подберёт synthetic'а — продолжит ждать live).
    if (process.env[SyntheticEnvKey.SchedulerEnabled] !== 'true') {
      return null;
    }

    // Берём 50 синтетов из idle-pool (без polling-bucket) и выбираем
    // ближайшего по рейтингу. Поле рейтинга — категориальное.
    const candidates = await this.presence.sampleIdleSchedulerPool(50);
    if (candidates.length === 0) return null;

    const ratingField = ratingFieldForCategory(category);
    const rows = await (this.deps.prisma as unknown as {
      user: {
        findMany(args: {
          where: { id: { in: string[] } };
          select: Record<string, boolean>;
        }): Promise<
          Array<{
            id: string;
            username: string | null;
            ratingBullet: number;
            ratingBlitz: number;
            ratingRapid: number;
            ratingClassical: number;
          }>
        >;
      };
    }).user.findMany({
      where: { id: { in: candidates } },
      select: {
        id: true,
        username: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
      },
    });

    let best: { userId: string; rating: number; username: string } | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const u of rows) {
      const r = u[ratingField];
      const diff = Math.abs(r - requesterRating);
      // KS-2176: ±150 cp (синхронизировано с doc-комментарием выше).
      if (diff > 150) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { userId: u.id, rating: r, username: u.username ?? '' };
      }
    }
    return best;
  }

  // ─── env helpers ───────────────────────────────────────────────────

  private envInt(name: string, def: number): number {
    const raw = process.env[name];
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  private tickIntervalMs(): number {
    return this.envInt(SyntheticEnvKey.SchedulerTickMs, DEFAULT_SCHEDULER_TICK_MS);
  }

  private killSwitchThreshold(): number {
    return this.envInt(
      SyntheticEnvKey.DisableAtLiveQueueLen,
      DEFAULT_KILL_SWITCH,
    );
  }

  private loadCurveOverride(): void {
    const raw = process.env[SyntheticEnvKey.ScheduleOverrideJson];
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<SyntheticBaseCurve>;
      this.curve = mergeCurve(SYNTHETIC_BASE_CURVE_DEFAULT, parsed);
      this.logger.log('synthetic curve override loaded from env');
    } catch (err) {
      this.logger.warn(
        `Invalid ${SyntheticEnvKey.ScheduleOverrideJson} JSON, using default: ${(err as Error).message}`,
      );
    }
  }

  // ─── core tick ─────────────────────────────────────────────────────

  /**
   * Один tick. Для каждой категории:
   *   1. Снять текущие `liveNow`, `syntheticInQueue` из Redis.
   *   2. Записать sample → обновить `liveAvg` по последним 3 сэмплам.
   *   3. Выполнить `tickPure(...)` → получить `target` и `delta`.
   *   4. Если `delta > 0` — добавить delta synthetic'ов из idle-pool.
   *      Если `delta < 0` — снять |delta| из очереди.
   */
  async tickAndApply(now: Date = new Date()): Promise<TickDecision[]> {
    if (this.stopped || !this.deps || !this.presence) return [];

    const decisions: TickDecision[] = [];
    for (const cat of ALL_CATEGORIES) {
      try {
        const decision = await this.processCategory(cat, now);
        decisions.push(decision);
      } catch (err) {
        this.logger.warn(
          `[scheduler] cat=${cat} failed: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `synthetic scheduler tick: ${decisions
        .map(
          (d) =>
            `${d.category}=${d.target}(was=${d.current},desired=${d.desired},liveAvg=${d.liveAvg.toFixed(1)},liveNow=${d.liveNow}${d.killSwitchTriggered ? ',KILL' : ''})`,
        )
        .join(' ')}`,
    );
    return decisions;
  }

  private async processCategory(
    cat: LiveQueueCategory,
    now: Date,
  ): Promise<TickDecision> {
    const deps = this.deps!;
    const presence = this.presence!;

    const [liveNow, syntheticInQueue] = await Promise.all([
      currentLiveCount(deps.redis, cat),
      deps.redis.scard(`synthetic:in_queue:${cat}`),
    ]);
    await recordLiveSample(deps.redis, cat, liveNow);
    const liveAvg = await liveAverageRecent(deps.redis, cat);

    const decision = tickPure({
      category: cat,
      liveNow,
      liveAvg,
      syntheticInQueue,
      killSwitchThreshold: this.killSwitchThreshold(),
      curve: this.curve,
      now,
    });

    if (decision.delta > 0) {
      // Поднабрать synthetic'ов из idle-scheduler-pool.
      const pool = await presence.sampleIdleSchedulerPool(decision.delta);
      for (const userId of pool) {
        await presence.enqueueSynthetic(userId, cat, 'scheduler');
      }
    } else if (decision.delta < 0) {
      const inQueue = await presence.listInQueue(cat);
      const toRemove = inQueue.slice(0, -decision.delta);
      for (const userId of toRemove) {
        await presence.dequeueSynthetic(userId, cat);
      }
    }

    return decision;
  }
}

/**
 * Глубокий merge override-кривой поверх дефолтной. Любые отсутствующие
 * ключи берутся из base. Безопасно для частичной перезаписи (например,
 * только `'18-23'.weekend.bullet`).
 */
export function mergeCurve(
  base: SyntheticBaseCurve,
  override: Partial<SyntheticBaseCurve>,
): SyntheticBaseCurve {
  const result = JSON.parse(JSON.stringify(base)) as SyntheticBaseCurve;
  for (const band of Object.keys(override) as Array<keyof SyntheticBaseCurve>) {
    const o = override[band];
    if (!o) continue;
    for (const kind of Object.keys(o) as Array<keyof typeof o>) {
      const ko = o[kind];
      if (!ko) continue;
      Object.assign(result[band][kind], ko);
    }
  }
  return result;
}
