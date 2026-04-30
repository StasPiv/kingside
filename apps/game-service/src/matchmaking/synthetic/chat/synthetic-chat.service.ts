/**
 * KS-2168 (ADR-034 §7, Q6 = A). SyntheticChatService — словарь
 * триггер-фраз без LLM.
 *
 * Контракт:
 *   - `onUserMessage(gameId, fromUserId, content)` — вызывается
 *     ChatGateway/ChatService при каждом входящем сообщении живого
 *     игрока. Сервис проверяет: партия с synthetic'ом, нашёл триггер,
 *     уложился в cooldown/cap → schedule reply через setTimeout.
 *   - `onGameStarted(gameId, syntheticUserId, opponentJustMoved)` —
 *     вызывается GameService при первом ходе живого. С 10% вероятностью
 *     планирует спонтанное приветствие.
 *   - `onGameFinished(gameId, syntheticUserId)` — вызывается на mate/
 *     resign/draw. С 50% вероятностью планирует closing-фразу.
 *
 * Cooldown / cap хранятся в Redis (переживают рестарт):
 *   `synth:chat:cooldown:<gameId>:<syntheticId>` String, TTL = cooldownMs/1000.
 *   `synth:chat:count:<gameId>:<syntheticId>`    String INCR, TTL 24h.
 *
 * Pure-логика выбора фразы — в `@kingside/shared` (DEFAULT_TRIGGER_RULES,
 * matchTriggerRule, pickReplyForLang). Этот сервис добавляет IO:
 * Redis cooldown/cap + chat.send() + setTimeout.
 *
 * Опт-ин через env `SYNTHETIC_CHAT_ENABLED=true`.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  matchTriggerRule,
  pickReplyForLang,
  preferredLang,
  SPONTANEOUS_CLOSING_PHRASES,
  SPONTANEOUS_OPENING_PHRASES,
  SYNTHETIC_CHAT_DEFAULTS,
  type SyntheticChatLang,
} from '@kingside/shared';

const REDIS_COOLDOWN_PREFIX = 'synth:chat:cooldown:';
const REDIS_COUNT_PREFIX = 'synth:chat:count:';
const REDIS_COUNT_TTL_SEC = 24 * 60 * 60;

/**
 * Узкий API ChatService — ровно тот метод, который нужен synthetic'у.
 * В тестах подменяется fake'ом без поднятия БД.
 */
export interface ChatSendApi {
  sendMessage(gameId: string, userId: string, content: string): Promise<unknown>;
}

export interface SyntheticChatRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: 'EX' | 'PX',
    ttl?: number,
  ): Promise<'OK' | null>;
  incr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<number | 'OK'>;
}

export interface SyntheticChatDeps {
  chat: ChatSendApi;
  redis: SyntheticChatRedis;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Подменяемый setTimeout — для тестов. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Подменяемый now()/random — детерминированные тесты. */
  now?: () => number;
  random?: () => number;
}

export interface SyntheticContext {
  /** UUID synthetic-юзера в этой партии (нужно для send + cooldown ключа). */
  syntheticUserId: string;
  /** Country synthetic'а — для языка. */
  syntheticCountry: string | null;
  gameId: string;
}

@Injectable()
export class SyntheticChatService {
  private readonly logger = new Logger(SyntheticChatService.name);
  private deps: SyntheticChatDeps | null = null;

  configure(deps: SyntheticChatDeps): void {
    this.deps = deps;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Сообщение от живого. Возвращает 'sent' | 'cooldown' | 'cap' |
   * 'no-trigger' | 'disabled' — для тестов / метрик.
   */
  async onUserMessage(
    ctx: SyntheticContext,
    incomingText: string,
    isAfterEnd: boolean = false,
  ): Promise<'sent' | 'cooldown' | 'cap' | 'no-trigger' | 'disabled'> {
    if (!this.enabled() || !this.deps) return 'disabled';
    const rule = matchTriggerRule(incomingText, undefined, isAfterEnd);
    if (!rule) return 'no-trigger';

    const cap = await this.checkCap(ctx);
    if (cap === 'over') return 'cap';
    const cd = await this.checkCooldown(ctx);
    if (cd === 'cooldown') return 'cooldown';

    const lang: SyntheticChatLang = preferredLang(
      ctx.syntheticCountry,
      incomingText,
    );
    const reply = pickReplyForLang(rule, lang, this.random());
    const delay = this.randomBetween(rule.delayMinMs, rule.delayMaxMs);

    await this.scheduleSend(ctx, reply, delay);
    return 'sent';
  }

  /**
   * Старт партии — после первого хода живого.
   * Решение бросается монета: с вероятностью `spontaneousOpeningProb`
   * — планируется отправка одной из opening-phrases.
   */
  async onGameStarted(ctx: SyntheticContext): Promise<'sent' | 'skipped' | 'disabled'> {
    if (!this.enabled() || !this.deps) return 'disabled';
    if (this.random()() >= SYNTHETIC_CHAT_DEFAULTS.spontaneousOpeningProb) {
      return 'skipped';
    }
    const cap = await this.checkCap(ctx);
    if (cap === 'over') return 'skipped';

    const lang: SyntheticChatLang =
      ctx.syntheticCountry &&
      (ctx.syntheticCountry === 'RU' || ctx.syntheticCountry === 'UA')
        ? 'ru'
        : 'en';
    const phrase = pickFromPool(SPONTANEOUS_OPENING_PHRASES, lang, this.random());
    const delay = this.randomBetween(
      SYNTHETIC_CHAT_DEFAULTS.spontaneousOpeningDelayMinMs,
      SYNTHETIC_CHAT_DEFAULTS.spontaneousOpeningDelayMaxMs,
    );
    await this.scheduleSend(ctx, phrase, delay);
    return 'sent';
  }

  /**
   * Конец партии (mate / resign / draw / timeout). С 50% веро-
   * ятностью отправляет closing-фразу. Cooldown и cap проверяются —
   * если synthetic уже исчерпал cap (5 сообщений), spontaneous closing
   * не отправит шестую.
   */
  async onGameFinished(ctx: SyntheticContext): Promise<'sent' | 'skipped' | 'disabled'> {
    if (!this.enabled() || !this.deps) return 'disabled';
    if (this.random()() >= SYNTHETIC_CHAT_DEFAULTS.spontaneousClosingProb) {
      return 'skipped';
    }
    const cap = await this.checkCap(ctx);
    if (cap === 'over') return 'skipped';

    const lang: SyntheticChatLang =
      ctx.syntheticCountry &&
      (ctx.syntheticCountry === 'RU' || ctx.syntheticCountry === 'UA')
        ? 'ru'
        : 'en';
    const phrase = pickFromPool(SPONTANEOUS_CLOSING_PHRASES, lang, this.random());
    const delay = this.randomBetween(
      SYNTHETIC_CHAT_DEFAULTS.spontaneousClosingDelayMinMs,
      SYNTHETIC_CHAT_DEFAULTS.spontaneousClosingDelayMaxMs,
    );
    await this.scheduleSend(ctx, phrase, delay);
    return 'sent';
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private enabled(): boolean {
    return process.env.SYNTHETIC_CHAT_ENABLED === 'true';
  }

  private random(): () => number {
    return this.deps?.random ?? Math.random;
  }

  private now(): number {
    return this.deps?.now ? this.deps.now() : Date.now();
  }

  private randomBetween(minMs: number, maxMs: number): number {
    if (maxMs <= minMs) return minMs;
    const r = this.random()();
    return Math.floor(minMs + r * (maxMs - minMs));
  }

  private cooldownKey(ctx: SyntheticContext): string {
    return `${REDIS_COOLDOWN_PREFIX}${ctx.gameId}:${ctx.syntheticUserId}`;
  }
  private countKey(ctx: SyntheticContext): string {
    return `${REDIS_COUNT_PREFIX}${ctx.gameId}:${ctx.syntheticUserId}`;
  }

  /**
   * Проверка cooldown — `null` если не в cooldown'е, 'cooldown' иначе.
   */
  private async checkCooldown(
    ctx: SyntheticContext,
  ): Promise<'ok' | 'cooldown'> {
    if (!this.deps) return 'cooldown';
    try {
      const v = await this.deps.redis.get(this.cooldownKey(ctx));
      return v ? 'cooldown' : 'ok';
    } catch {
      return 'ok'; // на ошибке Redis отдаём ok, чтобы не блокировать чат
    }
  }

  private async checkCap(
    ctx: SyntheticContext,
  ): Promise<'ok' | 'over'> {
    if (!this.deps) return 'over';
    try {
      const v = await this.deps.redis.get(this.countKey(ctx));
      const n = v ? Number.parseInt(v, 10) : 0;
      return n >= SYNTHETIC_CHAT_DEFAULTS.perGameCap ? 'over' : 'ok';
    } catch {
      return 'ok';
    }
  }

  /**
   * Регистрирует cooldown + инкрементит cap-счётчик и планирует отправку
   * через setTimeout. Реальный send делается в callback'е.
   */
  private async scheduleSend(
    ctx: SyntheticContext,
    text: string,
    delayMs: number,
  ): Promise<void> {
    if (!this.deps) return;
    // Сразу заняли cooldown + cap, чтобы две одновременные триггерные
    // ветки не отправили двойной ответ.
    try {
      await this.deps.redis.set(
        this.cooldownKey(ctx),
        '1',
        'EX',
        Math.ceil(SYNTHETIC_CHAT_DEFAULTS.cooldownMs / 1000),
      );
      const newCount = await this.deps.redis.incr(this.countKey(ctx));
      if (newCount === 1) {
        await this.deps.redis.expire(this.countKey(ctx), REDIS_COUNT_TTL_SEC);
      }
    } catch (err) {
      this.warn(`scheduleSend redis failed: ${(err as Error).message}`);
    }

    const setTimeoutFn =
      this.deps.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
    setTimeoutFn(() => {
      void this.deps!.chat
        .sendMessage(ctx.gameId, ctx.syntheticUserId, text)
        .catch((err: unknown) =>
          this.warn(`chat.send failed: ${(err as Error).message}`),
        );
    }, delayMs);
  }

  private warn(msg: string): void {
    (this.deps?.logger ?? this.logger).warn(`[synth-chat] ${msg}`);
  }
}

function pickFromPool(
  pool: readonly { text: string; lang: SyntheticChatLang }[],
  lang: SyntheticChatLang,
  rng: () => number,
): string {
  const matching = pool.filter((p) => p.lang === lang);
  const eligible = matching.length > 0 ? matching : pool;
  return eligible[Math.floor(rng() * eligible.length)].text;
}
