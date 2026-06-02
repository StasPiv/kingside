/**
 * KS-3615 / ADR-102 §8 B-этап. Backend-сервис LLM-комментариев к ходам.
 *
 * Flow: контроллер собирает batch фактов от фронта → сервис строит
 * системный prompt → шлёт в тот же webhook что и AI Assistant
 * (`AI_CHAT_WEBHOOK_URL`) → парсит JSON-массив строк → возвращает.
 *
 * Graceful degradation (ADR-102 §4.2 «Дефолты»): webhook down, парсинг
 * сломался, длина не сошлась — отдаём массив пустых строк той же длины.
 * Фронт (KS-3616 C) понимает: дубль создан, комментариев нет.
 */
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { BatchCommentDto } from './dto/batch-comment.dto';

@Injectable()
export class ReviewCommentService {
  private readonly logger = new Logger(ReviewCommentService.name);

  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly model: string;
  private readonly maxTokensPerFact: number;
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
    // Дефолт совпадает с CHAT_MODEL в ChatAssistantService — тот же
    // claude, только отдельная ENV-переменная, чтобы model для review
    // можно было поменять (например haiku для дешевизны) без влияния
    // на чат-ассистента.
    this.model = this.config.get<string>(
      'REVIEW_COMMENT_MODEL',
      'claude-sonnet-4-20250514',
    );
    this.maxTokensPerFact = parseInt(
      this.config.get<string>('REVIEW_COMMENT_MAX_TOKENS_PER_FACT', '80'),
      10,
    );
    // 180c — то же что в ChatAssistantService.callWebhookOnce
    // (комментарий KS-3219/3227/3228: длинные tool-chain'ы + retry в
    // самом webhook'е могут занять до ~90c, держим 180c с запасом).
    this.fetchTimeoutMs = parseInt(
      this.config.get<string>('REVIEW_COMMENT_FETCH_TIMEOUT_MS', '180000'),
      10,
    );
    this.rateLimitPerMin = parseInt(
      this.config.get<string>('REVIEW_COMMENT_RATE_LIMIT_PER_MIN', '10'),
      10,
    );
    this.rateLimitPerDay = parseInt(
      this.config.get<string>('REVIEW_COMMENT_RATE_LIMIT_PER_DAY', '30'),
      10,
    );
    this.globalDailyLimit = parseInt(
      this.config.get<string>('REVIEW_COMMENT_GLOBAL_DAILY_LIMIT', '200'),
      10,
    );
  }

  // ─── Rate-limit (паттерн зеркалит ChatAssistantService) ────────────

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
      minKey: `review:rate:min:${userId}`,
      dayKey: `review:rate:day:${userId}`,
      globalKey: `review:rate:global:${today}`,
    };
  }

  private secondsUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
  }

  // ─── Главный метод ──────────────────────────────────────────────────

  /**
   * Возвращает массив комментариев длины `dto.facts.length`. На любую
   * нештатную ситуацию (webhook не настроен, 5xx, кривой JSON, неверная
   * длина) — массив пустых строк (graceful, см. ADR-102 §4.2 «Дефолты»).
   * Не бросает 5xx за пределами вызова — фронт получает 200 с пустыми
   * комментариями и решает что показать.
   */
  async batchComment(userId: string, dto: BatchCommentDto): Promise<string[]> {
    const n = dto.facts.length;
    if (!this.webhookUrl) {
      this.logger.warn(
        `batchComment user=${userId.slice(0, 8)} n=${n}: ` +
          `AI_CHAT_WEBHOOK_URL not configured — returning ${n} empty comments`,
      );
      return new Array(n).fill('');
    }

    const systemPrompt = this.buildSystemPrompt(dto.language, dto.userElo);
    const userMessage = JSON.stringify({ facts: dto.facts });

    try {
      const response = await this.callWebhook(
        userId,
        systemPrompt,
        userMessage,
      );
      const parsed = this.parseAndValidate(response, n);
      return parsed;
    } catch (e) {
      this.logger.error(
        `batchComment user=${userId.slice(0, 8)} n=${n} failed: ` +
          `${(e as Error).message}`,
        (e as Error).stack,
      );
      return new Array(n).fill('');
    }
  }

  // ─── Промпт ─────────────────────────────────────────────────────────

  /**
   * KS-3615 / ADR-102 §5. Жёсткий системный prompt:
   *  - язык, ELO-калибровка;
   *  - INPUT/OUTPUT-формат (батч JSON → массив строк той же длины);
   *  - CRITICAL RULES — против галлюцинаций тактических мотивов и
   *    «ты должен был сыграть».
   *
   * Метод public — чтобы spec мог проверить наличие правил.
   */
  buildSystemPrompt(language: 'en' | 'ru', userElo: number): string {
    const lexCal =
      userElo < 1500
        ? 'Use simple terms.'
        : userElo > 2000
          ? 'Use technical terms.'
          : 'Use intermediate terms.';
    return [
      'You are a chess coach commenting moves for a learning player.',
      `User language: ${language}.`,
      `User ELO: ${userElo}. ${lexCal}`,
      '',
      'Input: JSON array of facts about specific moves.',
      'For each move write ONE short sentence (max 20 words).',
      '',
      'CRITICAL RULES:',
      '- DO NOT invent tactical motifs (forks, pins, skewers) unless explicitly listed in facts.',
      '- DO NOT make subjective evaluations beyond classification field.',
      '- DO NOT add explanations or "you should" advice.',
      '- DO NOT mention engine evaluations in centipawns.',
      '- If facts contain hanging_piece — say which piece and on which square.',
      '- If facts contain maia_alternative — mention "humans often play X" only in 1 of 5 moves (variety).',
      '- Stick to plain facts. The user already sees the move and the NAG mark.',
      '',
      'OUTPUT: JSON array of strings, one per input fact, in the same order.',
      'Example: ["You captured the knight, losing your bishop.", "Sharp move winning the queen."]',
    ].join('\n');
  }

  // ─── Webhook call ───────────────────────────────────────────────────

  /**
   * Тот же контракт что ChatAssistantService.callWebhookOnce
   * (`apps/api/src/ai-chat/chat-assistant.service.ts`):
   *   POST AI_CHAT_WEBHOOK_URL { message, systemPrompt, history, userId, userToken }
   *   Authorization: Bearer <WEBHOOK_AUTH_TOKEN>
   *   timeout 180s
   * webhook-server.py распознаёт тот же payload (см. ADR-102 §4.2).
   *
   * Возвращает `response`-строку из body (JSON-массив строк в plain text).
   * На non-2xx или невалидный body — throw.
   *
   * **Не дублируем** chat-side: history НЕ ведём, conversationId НЕ нужен —
   * это stateless батч-запрос. По сравнению с чатом не нужен и user-token
   * (он использовался для tool-loop'а MCP-ассистента; здесь tools не
   * вызываются), но webhook-server.py ожидает поле — шлём пустую строку
   * чтобы не сломать contract.
   */
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
        throw new Error(`review webhook ${res.status}: ${summary}`);
      }
      return bodyJson?.response ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Парсинг ────────────────────────────────────────────────────────

  /**
   * Извлекает JSON-массив строк из ответа модели.
   *
   * LLM иногда возвращает массив в markdown-code-block (```json ... ```),
   * иногда — с префиксом «Here are the comments:». Алгоритм:
   *   1. Снять окружающий код-блок (```json...``` или ```...```).
   *   2. Найти первый `[` и последний `]` — JSON-массив.
   *   3. JSON.parse, проверить структуру.
   *
   * Throws — на любое несоответствие. Public для тестов.
   */
  parseAndValidate(rawResponse: string, expectedLen: number): string[] {
    let body = (rawResponse ?? '').trim();
    if (!body) throw new Error('empty response from webhook');

    // Снять markdown-фенс ```json ... ``` / ``` ... ```.
    const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      body = fenceMatch[1].trim();
    }

    // Извлекаем строго первое вхождение JSON-массива — на случай если
    // модель добавила объясняющий текст до/после.
    const startIdx = body.indexOf('[');
    const endIdx = body.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      throw new Error('no JSON array delimiters in response');
    }
    const jsonStr = body.slice(startIdx, endIdx + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`invalid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('parsed response is not an array');
    }
    if (parsed.length !== expectedLen) {
      throw new Error(
        `length mismatch: got ${parsed.length}, expected ${expectedLen}`,
      );
    }
    for (const item of parsed) {
      if (typeof item !== 'string') {
        throw new Error('non-string item in response array');
      }
    }
    return parsed as string[];
  }
}
