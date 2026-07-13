/**
 * KS-4941 / ADR-164 rev3 (+решение пользователя: модель — агент с
 * инструментами). Конвейер серверного преразбора позиций.
 *
 * Поток: источники (пазл дня, админ-очередь) кладут (fen, language)
 * в `ai_position_reviews` со status=queued → обработчик берёт записи
 * по одной (строго последовательно), шлёт модели prompt аналитика —
 * модель сама прогоняет Maia/Stockfish своими инструментами и
 * возвращает финальный JSON — сервер валидирует, помечает нелегальные
 * линии в probe_trace и публикует (status=done). Готовые разборы
 * раздаются всем через GET /analyses/position/review (без квот).
 *
 * Лимиты: AI_REVIEW_DAILY_LIMIT разборов в день (Redis-счётчик по
 * дате), один webhook-вызов + один re-ask на запись, wall-clock
 * вызова AI_REVIEW_FETCH_TIMEOUT_MS (10 мин default).
 *
 * Повторный разбор той же (позиции, языка) не выполняется: unique
 * (fen_normalized, language) — enqueue с skipDuplicates.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@kingside/db';
import { ConfigService } from '@nestjs/config';
import type {
  AiHighlight,
  AiArrow,
  AiPositionReviewDto,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { parseModelOutput } from '../position-comment/parse-model-output';
import {
  buildAnalystPrompt,
  buildReaskMessage,
  type AnalystLanguage,
} from './analyst-prompt';
import { isLineLegal } from './validate-line-legality';

export const AI_REVIEW_LANGUAGES: AnalystLanguage[] = ['ru', 'en'];

/** Запись лога прогонов из ответа модели + серверная пометка. */
export interface ProbeTraceEntry {
  tool: 'maia' | 'sf';
  line: string[];
  summary: string;
  /** KS-4941: линия нелегальна от корневого FEN (аудит качества). */
  illegal?: boolean;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Нормализация FEN: поля 1-4 (как в кэше фронта ADR-108). */
export function normalizeFen(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

@Injectable()
export class AiReviewService {
  private readonly logger = new Logger(AiReviewService.name);

  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly fetchTimeoutMs: number;
  readonly dailyLimit: number;
  private readonly movetimeCapMs: number;
  private readonly defaultMaiaElo: number;
  private readonly maiaRunner: string;
  private readonly stockfishBin: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.webhookUrl = this.config.get<string>('AI_CHAT_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('WEBHOOK_AUTH_TOKEN', '');
    this.fetchTimeoutMs = parseInt(
      this.config.get<string>('AI_REVIEW_FETCH_TIMEOUT_MS', '600000'),
      10,
    );
    this.dailyLimit = parseInt(
      this.config.get<string>('AI_REVIEW_DAILY_LIMIT', '20'),
      10,
    );
    this.movetimeCapMs = parseInt(
      this.config.get<string>('AI_REVIEW_SF_MOVETIME_CAP_MS', '5000'),
      10,
    );
    this.defaultMaiaElo = parseInt(
      this.config.get<string>('AI_REVIEW_DEFAULT_MAIA_ELO', '1500'),
      10,
    );
    // KS-4941: движки запечены в образ kingside-agent (изоляция, не
    // монтируются из репо). maia — врапер /usr/local/bin/maia над
    // самодостаточным бандлом /opt/maia/maia.cjs; stockfish — SF18.
    this.maiaRunner = this.config.get<string>('AI_REVIEW_MAIA_RUNNER', 'maia');
    this.stockfishBin = this.config.get<string>(
      'AI_REVIEW_STOCKFISH_BIN',
      '/usr/games/stockfish',
    );
  }

  // ─── Очередь ────────────────────────────────────────────────────────

  /**
   * Поставить позицию в очередь (обе локали по умолчанию). Дубликаты
   * (unique fen_normalized+language) молча пропускаются — повторный
   * разбор той же позиции не выполняется.
   * Возвращает число реально созданных записей.
   */
  async enqueue(
    fen: string,
    source: 'daily_puzzle' | 'manual',
    languages: AnalystLanguage[] = AI_REVIEW_LANGUAGES,
  ): Promise<number> {
    const fenNormalized = normalizeFen(fen);
    const result = await this.prisma.aiPositionReview.createMany({
      data: languages.map((language) => ({
        fen,
        fenNormalized,
        language,
        source,
      })),
      skipDuplicates: true,
    });
    if (result.count > 0) {
      this.logger.log(
        `ai-review enqueue: ${result.count} record(s) for fen="${fenNormalized}" source=${source}`,
      );
    }
    return result.count;
  }

  /**
   * Обработать очередь: строго последовательно, по одной записи, пока
   * есть queued и не исчерпан дневной лимит. Возвращает число
   * завершённых (done|failed) записей за прогон.
   */
  async processQueue(): Promise<number> {
    let processed = 0;
    for (;;) {
      const next = await this.prisma.aiPositionReview.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
      });
      if (!next) break;
      const allowed = await this.tryConsumeDailyQuota();
      if (!allowed) {
        this.logger.log(
          `ai-review: daily limit ${this.dailyLimit} reached, stopping (queued remain)`,
        );
        break;
      }
      await this.processOne(next.id);
      processed++;
    }
    return processed;
  }

  /** INCR дневного счётчика; false — лимит исчерпан (декремент назад). */
  private async tryConsumeDailyQuota(): Promise<boolean> {
    const key = `ai-review:daily:${new Date().toISOString().slice(0, 10)}`;
    const used = await this.redis.incr(key);
    await this.redis.expire(key, 172_800);
    if (used > this.dailyLimit) {
      await this.redis.decr(key);
      return false;
    }
    return true;
  }

  // ─── Разбор одной записи ────────────────────────────────────────────

  async processOne(id: string): Promise<void> {
    const review = await this.prisma.aiPositionReview.findUnique({
      where: { id },
    });
    if (!review || review.status === 'done') return;
    await this.prisma.aiPositionReview.update({
      where: { id },
      data: { status: 'processing', error: null },
    });

    const language: AnalystLanguage = review.language === 'en' ? 'en' : 'ru';
    const prompt = buildAnalystPrompt({
      fen: review.fen,
      language,
      movetimeCapMs: this.movetimeCapMs,
      defaultMaiaElo: this.defaultMaiaElo,
      maiaRunner: this.maiaRunner,
      stockfishBin: this.stockfishBin,
    });

    let webhookCalls = 0;
    try {
      let raw: string;
      try {
        raw = await this.callWebhook(prompt, [], id);
        webhookCalls++;
      } catch (e) {
        // KS-4941: канал до webhook рвётся на ~300 с (замерено:
        // fetch failed ровно на 300.5 c), но сессия модели на той
        // стороне ПРОДОЛЖАЕТ работать и резюмируется по userId —
        // follow-up «выдай финальный JSON» возвращает результат
        // (проверено вживую). До FOLLOW_UP_ATTEMPTS повторов с паузой.
        webhookCalls++;
        raw = await this.followUpAfterDrop(id, review.fen, language, e as Error);
        webhookCalls += this.lastFollowUps;
      }
      let parsed = this.parseFinal(raw, review.fen);
      if (!parsed) {
        // §2.3: один re-ask при невалидном ответе, затем failed.
        raw = await this.callWebhook(buildReaskMessage(language), [
          { role: 'user', content: prompt },
          { role: 'assistant', content: raw },
        ], id);
        webhookCalls++;
        parsed = this.parseFinal(raw, review.fen);
      }
      if (!parsed) {
        await this.markFailed(id, webhookCalls, 'model output not recognized');
        return;
      }
      await this.prisma.aiPositionReview.update({
        where: { id },
        data: {
          status: 'done',
          comment: parsed.comment,
          highlightsArrows: {
            highlights: parsed.highlights,
            arrows: parsed.arrows,
          } as unknown as Prisma.InputJsonValue,
          probeTrace: parsed.probeTrace as unknown as Prisma.InputJsonValue,
          webhookCalls,
          publishedAt: new Date(),
          error: null,
        },
      });
      this.logger.log(
        `ai-review done id=${id} lang=${language} calls=${webhookCalls} probes=${parsed.probeTrace.length} illegal=${parsed.probeTrace.filter((p) => p.illegal).length}`,
      );
    } catch (e) {
      await this.markFailed(id, webhookCalls, (e as Error).message);
    }
  }

  /** Число follow-up вызовов последнего followUpAfterDrop (для webhookCalls). */
  private lastFollowUps = 0;

  /**
   * KS-4941. Обрыв канала: сессия webhook живёт и работает — забираем
   * результат follow-up-запросами (сессия резюмируется по userId).
   * Пауза между попытками даёт модели дорешать. Все попытки упали —
   * пробрасываем исходную ошибку.
   */
  private async followUpAfterDrop(
    reviewId: string,
    fen: string,
    language: AnalystLanguage,
    original: Error,
  ): Promise<string> {
    this.lastFollowUps = 0;
    const message =
      language === 'en'
        ? `You were analyzing position ${fen}. If the review is finished — output the final JSON {"comment","highlights","arrows","probe_log"} and nothing else. If not finished — finish it and output the JSON.`
        : `Ты разбирал позицию ${fen}. Если разбор завершён — выдай финальный JSON {"comment","highlights","arrows","probe_log"} и ничего кроме него. Если не завершён — доведи и выдай JSON.`;
    let lastError: Error = original;
    for (let attempt = 0; attempt < AiReviewService.FOLLOW_UP_ATTEMPTS; attempt++) {
      await this.sleep(AiReviewService.FOLLOW_UP_PAUSE_MS);
      try {
        const raw = await this.callWebhook(message, [], reviewId);
        this.lastFollowUps++;
        return raw;
      } catch (e) {
        this.lastFollowUps++;
        lastError = e as Error;
        this.logger.warn(
          `ai-review follow-up ${attempt + 1}/${AiReviewService.FOLLOW_UP_ATTEMPTS} failed: ${lastError.message}`,
        );
      }
    }
    throw lastError;
  }

  private static readonly FOLLOW_UP_ATTEMPTS = 3;
  private static readonly FOLLOW_UP_PAUSE_MS = 120_000;

  /** Вынесен для подмены в тестах. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async markFailed(
    id: string,
    webhookCalls: number,
    error: string,
  ): Promise<void> {
    this.logger.warn(`ai-review failed id=${id}: ${error.slice(0, 200)}`);
    await this.prisma.aiPositionReview.update({
      where: { id },
      data: { status: 'failed', webhookCalls, error: error.slice(0, 500) },
    });
  }

  /**
   * Парс финального ответа модели: comment/highlights/arrows — через
   * существующий `parseModelOutput` (ADR-108, включая геометрию
   * стрелок), `probe_log` — вручную + легальность линий chess.js
   * (нелегальная линия помечается `illegal:true` в trace — Then
   * «нелегальные линии отбрасываются» для аудита качества).
   * null — ответ не распознан (пустой comment).
   */
  parseFinal(
    raw: string,
    rootFen: string,
  ): {
    comment: string;
    highlights: AiHighlight[];
    arrows: AiArrow[];
    probeTrace: ProbeTraceEntry[];
  } | null {
    const base = parseModelOutput(raw ?? '', rootFen);
    if (!base.comment) return null;
    return {
      comment: base.comment,
      highlights: base.highlights,
      arrows: base.arrows,
      probeTrace: this.parseProbeLog(raw, rootFen),
    };
  }

  private parseProbeLog(raw: string, rootFen: string): ProbeTraceEntry[] {
    let parsed: unknown;
    try {
      const trimmed = raw.trim();
      const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      parsed = JSON.parse(m ? m[1].trim() : trimmed);
    } catch {
      return [];
    }
    const log = (parsed as { probe_log?: unknown }).probe_log;
    if (!Array.isArray(log)) return [];
    const out: ProbeTraceEntry[] = [];
    for (const item of log.slice(0, 64)) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      if (o.tool !== 'maia' && o.tool !== 'sf') continue;
      const line: string[] = [];
      let lineValid = Array.isArray(o.line);
      if (lineValid) {
        for (const mv of o.line as unknown[]) {
          if (typeof mv !== 'string' || !UCI_RE.test(mv)) {
            lineValid = false;
            break;
          }
          line.push(mv);
        }
      }
      const entry: ProbeTraceEntry = {
        tool: o.tool,
        line: lineValid ? line : [],
        summary:
          typeof o.summary === 'string' ? o.summary.slice(0, 500) : '',
      };
      if (!lineValid || !isLineLegal(rootFen, entry.line)) {
        entry.illegal = true;
      }
      out.push(entry);
    }
    return out;
  }

  // ─── Выдача ─────────────────────────────────────────────────────────

  async getReview(
    fen: string,
    language: AnalystLanguage,
  ): Promise<AiPositionReviewDto | null> {
    const row = await this.prisma.aiPositionReview.findUnique({
      where: {
        fenNormalized_language: {
          fenNormalized: normalizeFen(fen),
          language,
        },
      },
    });
    if (!row || row.status !== 'done' || !row.comment) return null;
    const ha = (row.highlightsArrows ?? {}) as {
      highlights?: AiHighlight[];
      arrows?: AiArrow[];
    };
    return {
      fen: row.fenNormalized,
      language,
      comment: row.comment,
      highlights: ha.highlights ?? [],
      arrows: ha.arrows ?? [],
      publishedAt: (row.publishedAt ?? row.updatedAt).toISOString(),
    };
  }

  // ─── Webhook ────────────────────────────────────────────────────────

  /**
   * Вызов модели-агента. В отличие от position-comment здесь
   * `noMcp:false` — модели НУЖНЫ инструменты (Maia/Stockfish в её
   * окружении, решение пользователя 13.07). Таймаут — wall-clock
   * разбора (default 10 мин): модель делает десятки прогонов.
   */
  /**
   * KS-4941: sessionKey = id записи разбора. Webhook держит Claude-сессию
   * per userId (resume) — константный userId склеивал ВСЕ разборы в одну
   * сессию, модель видела прошлые прогоны. Уникальный userId на разбор =
   * чистая сессия; re-ask и follow-up того же разбора остаются в ней.
   */
  private async callWebhook(
    message: string,
    history: Array<{ role: string; content: string }>,
    sessionKey: string,
  ): Promise<string> {
    if (!this.webhookUrl) {
      throw new Error('AI_CHAT_WEBHOOK_URL is not configured');
    }
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
          message,
          systemPrompt: '',
          history,
          userId: `ai-review-${sessionKey}`,
          userToken: '',
          noMcp: false,
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
        throw new Error(`ai-review webhook ${res.status}: ${summary}`);
      }
      return bodyJson?.response ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
