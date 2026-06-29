/**
 * KS-4699 / ADR-147 §5.2. Конфигурируемые лимиты HintsEngine.
 *
 * **Архитектурное решение по источнику конфига.** ADR-147 §5.2 говорит
 * «через существующий `feature-flags`-модуль». В реальности
 * `FeatureFlagsService` (KS-2104) поддерживает только boolean-флаги
 * фиксированного whitelist'а (см. `KNOWN_FEATURE_FLAGS` в shared).
 * Hints требуют numeric (throttle_seconds, session_max_shows,
 * smart_dismiss_window_hours). Расширение FeatureFlags до Json-values
 * означает: правка shared-типа + миграция БД + правка админ-UI
 * (apps/web/src/pages/admin/FeatureFlags*) — это отдельная задача.
 *
 * До неё используем env через `ConfigService` (значения задаются в
 * task-def, переменные читаются с дефолтом). Перенастройка lim'ов
 * требует ECS rolling restart — приемлемо: лимиты не меняются часто,
 * а каждый деплой и так перезапускает task'и. Local-cache 60с
 * сохранён (как просит §5.2) — даёт защиту от частых ConfigService
 * вызовов в hot-path.
 *
 * Когда появится Json-flags в FeatureFlagsService — переключим
 * `read()` на него, контракт `getLimits()` не изменится.
 *
 * Redis-лимиты (`hints:throttle:<actor_id>`, `hints:session:<actor_id>:
 * <date>`) — единый namespace для user/guest, как требует §5.2.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import {
  HINTS_DEFAULTS,
  sessionCounterKey,
  throttleKey,
  todayUtc,
} from './hints.types';
import type { Actor } from '../events/events.types';

export interface HintsLimits {
  enabled: boolean;
  globalThrottleSec: number;
  sessionMaxShows: number;
  smartDismissWindowH: number;
  /** KS-4788 / ADR-151. Окно replay на WS-handshake, секунды. 0 — replay выключен. */
  replayWindowSec: number;
}

const CACHE_TTL_MS = 60_000;

@Injectable()
export class HintsLimitsService {
  private readonly logger = new Logger(HintsLimitsService.name);
  private cache: { value: HintsLimits; expiresAt: number } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** Читать актуальные лимиты с 60с кэшем. */
  getLimits(now: number = Date.now()): HintsLimits {
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;
    const v: HintsLimits = {
      enabled: this.boolEnv('HINTS_ENABLED', HINTS_DEFAULTS.enabled),
      globalThrottleSec: this.intEnv(
        'HINTS_GLOBAL_THROTTLE_SEC',
        HINTS_DEFAULTS.globalThrottleSec,
      ),
      sessionMaxShows: this.intEnv(
        'HINTS_SESSION_MAX_SHOWS',
        HINTS_DEFAULTS.sessionMaxShows,
      ),
      smartDismissWindowH: this.intEnv(
        'HINTS_SMART_DISMISS_WINDOW_H',
        HINTS_DEFAULTS.smartDismissWindowH,
      ),
      // KS-4788. Допускаем 0 (replay выключен) — поэтому intEnv (>0) не подходит.
      replayWindowSec: this.intEnvAllowZero(
        'HINTS_REPLAY_WINDOW_SEC',
        HINTS_DEFAULTS.replayWindowSec,
      ),
    };
    // KS-4785: при `HINTS_TEST_MODE=1` (test-hints стек, e2e) глобальный
    // throttle и session-лимит мешают повторному checkFor после reload
    // страницы — первый матч ставит throttle на 600с, второй вызов в
    // том же тест-прогоне получает canShow=false → no-match. Подменяем
    // лимиты на e2e-значения. На проде HINTS_TEST_MODE не выставляется,
    // прод-семантика не меняется. Приоритет внутри test-mode: явный
    // HINTS_DEFAULTS_OVERRIDE_JSON > эти подмены > отдельные env.
    if (this.config.get<string>('HINTS_TEST_MODE') === '1') {
      v.globalThrottleSec = 0;
      v.sessionMaxShows = 10_000;
    }
    // KS-4760 / ADR-150 T2: `HINTS_DEFAULTS_OVERRIDE_JSON` — JSON-объект
    // с любыми полями HintsLimits, который merge'ится поверх env-чтения.
    // Используется e2e test-окружением (docker-compose.test-hints.yml),
    // чтобы за один env-var разом поставить throttle=0, session_max_shows
    // в тысячу и т.д. без правки кода и без перечисления 4 отдельных
    // переменных. Приоритет: JSON-override > отдельные env > defaults.
    const override = this.readOverrideJson();
    if (override) Object.assign(v, override);
    this.cache = { value: v, expiresAt: now + CACHE_TTL_MS };
    return v;
  }

  /**
   * Читает env `HINTS_DEFAULTS_OVERRIDE_JSON`, парсит JSON, отдаёт
   * только белый список ключей HintsLimits. Невалидный JSON → warn + null
   * (не падаем — defaults применятся). Без env → null.
   */
  private readOverrideJson(): Partial<HintsLimits> | null {
    const raw = this.config.get<string>('HINTS_DEFAULTS_OVERRIDE_JSON');
    if (!raw || raw.trim() === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `HINTS_DEFAULTS_OVERRIDE_JSON invalid JSON: ${(err as Error).message}`,
      );
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const src = parsed as Record<string, unknown>;
    const out: Partial<HintsLimits> = {};
    if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
    if (typeof src.globalThrottleSec === 'number' && src.globalThrottleSec >= 0) {
      out.globalThrottleSec = src.globalThrottleSec;
    }
    if (typeof src.sessionMaxShows === 'number' && src.sessionMaxShows >= 0) {
      out.sessionMaxShows = src.sessionMaxShows;
    }
    if (typeof src.smartDismissWindowH === 'number' && src.smartDismissWindowH >= 0) {
      out.smartDismissWindowH = src.smartDismissWindowH;
    }
    // KS-4788 / ADR-151 §2.3. Принимаем replayWindowSec через JSON-override
    // (e2e может выставить большое окно или 0 для negative-test'ов).
    if (typeof src.replayWindowSec === 'number' && src.replayWindowSec >= 0) {
      out.replayWindowSec = src.replayWindowSec;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * Можно ли показать ещё одну подсказку этому actor'у прямо сейчас?
   * Проверяет два Redis-лимита (throttle + session/day).
   * Если Redis недоступен — fail-closed (false), чтобы не спамить.
   */
  async canShow(actor: Actor): Promise<boolean> {
    const { globalThrottleSec, sessionMaxShows, enabled } = this.getLimits();
    if (!enabled) return false;
    try {
      const tKey = throttleKey(actor.id);
      const sKey = sessionCounterKey(actor.id, todayUtc());
      const [throttleExists, sessionCount] = await Promise.all([
        this.redis.exists(tKey),
        this.redis.get(sKey),
      ]);
      if (throttleExists === 1) return false;
      const n = sessionCount ? Number.parseInt(sessionCount, 10) : 0;
      if (Number.isFinite(n) && n >= sessionMaxShows) return false;
      // Превентивно ставим throttle сразу же — это «pessimistic lock»,
      // защита от параллельных HintsService.checkFor для одного actor'а
      // (например, реактивный check + cron-tick одновременно).
      // KS-4785: при `globalThrottleSec=0` (test-mode) Redis `SET … EX 0`
      // отвечает `ERR invalid expire time in 'set' command` — Redis
      // отвергает нулевой TTL. В этом режиме throttle отключён по
      // определению, SET не нужен.
      if (globalThrottleSec > 0) {
        await this.redis.set(tKey, '1', 'EX', globalThrottleSec, 'NX');
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`canShow: Redis error for ${actor.type}:${actor.id}, fail-closed: ${msg}`);
      return false;
    }
  }

  /** Инкрементировать счётчик сессии за сегодня (вызывается после успешного show). */
  async markShown(actor: Actor): Promise<void> {
    try {
      const key = sessionCounterKey(actor.id, todayUtc());
      // INCR + EXPIRE до конца суток (макс 24ч; короче — если день уже
      // прошёл, ничего не успеет накопиться).
      await this.redis.incr(key);
      await this.redis.expire(key, 24 * 60 * 60);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`markShown: Redis error for ${actor.type}:${actor.id}: ${msg}`);
    }
  }

  /** Сброс throttle (для тестов / manual admin). */
  async resetThrottle(actor: Actor): Promise<void> {
    try {
      await this.redis.del(throttleKey(actor.id));
    } catch { /* no-op */ }
  }

  private boolEnv(key: string, def: boolean): boolean {
    const v = this.config.get<string>(key);
    if (v === undefined) return def;
    return /^(1|true|yes|on)$/i.test(v);
  }

  private intEnv(key: string, def: number): number {
    const v = this.config.get<string>(key);
    if (v === undefined) return def;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  /** Как intEnv, но принимает 0 как валидное значение (например, выключить replay). */
  private intEnvAllowZero(key: string, def: number): number {
    const v = this.config.get<string>(key);
    if (v === undefined) return def;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }
}
