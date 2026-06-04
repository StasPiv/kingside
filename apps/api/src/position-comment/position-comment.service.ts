import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import {
  PositionCommentDto,
  PositionCommentLanguage,
} from './dto/position-comment.dto';

@Injectable()
export class PositionCommentService {
  private readonly logger = new Logger(PositionCommentService.name);

  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly fetchTimeoutMs: number;

  readonly rateLimitPerMin: number;
  readonly rateLimitPerDay: number;
  readonly globalDailyLimit: number;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.webhookUrl = this.config.get<string>('AI_CHAT_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('WEBHOOK_AUTH_TOKEN', '');
    this.fetchTimeoutMs = parseInt(
      this.config.get<string>('POSITION_COMMENT_FETCH_TIMEOUT_MS', '180000'),
      10,
    );

    this.rateLimitPerMin = parseInt(
      this.config.get<string>('POSITION_COMMENT_RATE_LIMIT_PER_MIN', '20'),
      10,
    );
    this.rateLimitPerDay = parseInt(
      this.config.get<string>('POSITION_COMMENT_RATE_LIMIT_PER_DAY', '200'),
      10,
    );
    this.globalDailyLimit = parseInt(
      this.config.get<string>('POSITION_COMMENT_GLOBAL_DAILY_LIMIT', '2000'),
      10,
    );
  }

  /**
   * KS-3681 / ADR-108 §8.2. Две короткие версии инструкции — RU и EN.
   * Симметричный перевод; стиль продолжает упрощённую инструкцию
   * из KS-3678 (без калибровок, без обучающих примеров, без запретов).
   *
   * Дефолт — `'ru'` (старые клиенты без поля `language` получают
   * русский комментарий, как до KS-3681).
   */
  buildSystemPrompt(language: PositionCommentLanguage = 'ru'): string {
    if (language === 'en') {
      return 'Please comment on this chess position in plain language using the given positional factors';
    }
    return 'Прокомментируй пожалуйста позицию человеческим языком на основании факторов';
  }

  async comment(userId: string, dto: PositionCommentDto): Promise<string> {
    // KS-3681 / ADR-108 §11 B1: пустой `factors` — мгновенный пустой
    // ответ, без обращения к webhook'у. Экономит квоту Pro/Max и
    // время пользователя (фронт всё равно отрисует state `empty`).
    if (!dto.factors || dto.factors.length === 0) {
      return '';
    }

    if (!this.webhookUrl) {
      this.logger.warn(
        `comment user=${userId.slice(0, 8)}: AI_CHAT_WEBHOOK_URL not configured — returning empty`,
      );
      return '';
    }

    const systemPrompt = this.buildSystemPrompt(dto.language);
    const userMessage = JSON.stringify({
      fen: dto.fen,
      factors: dto.factors,
      ...(dto.eval ? { eval: dto.eval } : {}),
    });

    try {
      const response = await this.callWebhook(
        userId,
        systemPrompt,
        userMessage,
      );
      return (response ?? '').trim();
    } catch (e) {
      this.logger.error(
        `comment user=${userId.slice(0, 8)} failed: ${(e as Error).message}`,
        (e as Error).stack,
      );
      return '';
    }
  }

  // ─── Rate-limit ────────────────────────────────────────────────────

  async checkRateLimit(userId: string): Promise<void> {
    const { minKey, dayKey, globalKey } = this.rateKeys(userId);
    const [minCount, dayCount, globalCount] = await Promise.all([
      this.redis.get(minKey),
      this.redis.get(dayKey),
      this.redis.get(globalKey),
    ]);
    const minUsed = parseInt(minCount ?? '0', 10);
    const dayUsed = parseInt(dayCount ?? '0', 10);
    const globalUsed = parseInt(globalCount ?? '0', 10);

    if (minUsed >= this.rateLimitPerMin) {
      throw new HttpException(
        {
          error: 'rate_limit',
          retryAfter: 60,
          limits: {
            perMinute: { used: minUsed, max: this.rateLimitPerMin },
            perDay: { used: dayUsed, max: this.rateLimitPerDay },
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (dayUsed >= this.rateLimitPerDay) {
      throw new HttpException(
        {
          error: 'rate_limit',
          retryAfter: this.secondsUntilMidnight(),
          limits: {
            perMinute: { used: minUsed, max: this.rateLimitPerMin },
            perDay: { used: dayUsed, max: this.rateLimitPerDay },
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (globalUsed >= this.globalDailyLimit) {
      throw new HttpException(
        {
          error: 'rate_limit',
          retryAfter: this.secondsUntilMidnight(),
          limits: {
            perMinute: { used: minUsed, max: this.rateLimitPerMin },
            perDay: { used: dayUsed, max: this.rateLimitPerDay },
            globalDaily: {
              used: globalUsed,
              max: this.globalDailyLimit,
            },
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async incrementRateLimit(userId: string): Promise<void> {
    const { minKey, dayKey, globalKey } = this.rateKeys(userId);
    const pipe = this.redis.pipeline();
    pipe.incr(minKey);
    pipe.expire(minKey, 60);
    pipe.incr(dayKey);
    pipe.expire(dayKey, 86400);
    pipe.incr(globalKey);
    pipe.expire(globalKey, 86400);
    await pipe.exec();
  }

  private rateKeys(userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      minKey: `position-comment:rate:min:${userId}`,
      dayKey: `position-comment:rate:day:${userId}`,
      globalKey: `position-comment:rate:global:${today}`,
    };
  }

  private secondsUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
  }

  // ─── Webhook ───────────────────────────────────────────────────────

  private async callWebhook(
    userId: string,
    systemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.webhookSecret) {
        headers['Authorization'] = `Bearer ${this.webhookSecret}`;
      }
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          message: userMessage,
          systemPrompt,
          history: [],
          userId,
          userToken: '',
        }),
      });
      const ct = res.headers.get('content-type') || '';
      const bodyText = ct.includes('json')
        ? ''
        : await res.text().catch(() => '<no-body>');
      const bodyJson = ct.includes('json')
        ? ((await res.json().catch(() => null)) as {
            response?: string;
          } | null)
        : null;
      if (res.status >= 400 || (!bodyJson && bodyText)) {
        const summary = bodyJson
          ? JSON.stringify(bodyJson).slice(0, 200)
          : bodyText.slice(0, 200);
        throw new Error(`position-comment webhook ${res.status}: ${summary}`);
      }
      return bodyJson?.response ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
