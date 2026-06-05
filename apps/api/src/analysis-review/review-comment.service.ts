/**
 * KS-3615 / ADR-102 §8 B-этап (MVP-1) + KS-3625 / ADR-103 rev 3
 * §7/§8 (MVP-2 B1') + KS-3678 (упрощение промта).
 *
 * Backend-сервис LLM-комментариев к позициям.
 *
 * Flow:
 *  - контроллер собирает batch фактов от фронта (вместе с готовыми
 *    позиционными ярлыками `positional_shifts` / `positional_subterms`
 *    от WASM SF 16 на клиенте — ADR-103 rev 3);
 *  - строит минимальный системный prompt: «вот FEN + поданные
 *    позиционные критерии — прокомментируй позицию строго по ним»;
 *  - шлёт в тот же webhook что и AI Assistant (`AI_CHAT_WEBHOOK_URL`);
 *  - парсит JSON-массив строк;
 *  - применяет post-валидацию (NAG-blacklist + min-length);
 *  - возвращает comments.
 *
 * KS-3678 — упрощение промта. Прошлый split на V1/V2 (CRITICAL RULES /
 * FORBIDDEN / ELO-калибровка / 14 few-shot пар / правила дедупликации
 * positional_subterms) убран — модель плохо справлялась с перегруженным
 * текстом инструкций. Контракт ответа фронта (`string[]` длины
 * `facts.length`) и post-валидация NAG-тавтологий сохранены.
 *
 * Сервис stateless: серверного Stockfish нет (отменён в rev 3 — eval
 * полностью уехал на клиент). Все факты, включая позиционные ярлыки,
 * приходят готовыми с фронта и сериализуются в prompt как есть.
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
import { BatchCommentDto, MoveFactsDto } from './dto/batch-comment.dto';
import { KNOWN_SUBTERM_IDS } from './subterm-labels';

@Injectable()
export class ReviewCommentService {
  private readonly logger = new Logger(ReviewCommentService.name);

  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly model: string;
  private readonly maxTokensPerFact: number;
  private readonly fetchTimeoutMs: number;
  private readonly minWords: number;
  private readonly minChars: number;

  readonly rateLimitPerMin: number;
  readonly rateLimitPerDay: number;
  readonly globalDailyLimit: number;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.webhookUrl = this.config.get<string>('AI_CHAT_WEBHOOK_URL', '');
    this.webhookSecret = this.config.get<string>('WEBHOOK_AUTH_TOKEN', '');
    this.model = this.config.get<string>(
      'REVIEW_COMMENT_MODEL',
      'claude-sonnet-4-20250514',
    );
    this.maxTokensPerFact = parseInt(
      this.config.get<string>('REVIEW_COMMENT_MAX_TOKENS_PER_FACT', '160'),
      10,
    );
    this.fetchTimeoutMs = parseInt(
      this.config.get<string>('REVIEW_COMMENT_FETCH_TIMEOUT_MS', '180000'),
      10,
    );
    this.minWords = Math.max(
      0,
      parseInt(this.config.get<string>('REVIEW_COMMENT_MIN_WORDS', '4'), 10),
    );
    this.minChars = Math.max(
      0,
      parseInt(this.config.get<string>('REVIEW_COMMENT_MIN_CHARS', '25'), 10),
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

  /**
   * KS-3651 / ADR-107 rev 2 §6. Отбрасывает `positional_subterms[]`
   * с неизвестными `id` (не в `KNOWN_SUBTERM_IDS`) и логирует WARN
   * с агрегатом.
   */
  pruneUnknownSubterms(facts: MoveFactsDto[]): MoveFactsDto[] {
    const unknownByPly = new Map<number, Set<string>>();
    const pruned: MoveFactsDto[] = facts.map((f) => {
      if (!f.positional_subterms || f.positional_subterms.length === 0) {
        return f;
      }
      const kept = f.positional_subterms.filter((s) => {
        if (KNOWN_SUBTERM_IDS.has(s.id)) return true;
        const set = unknownByPly.get(f.ply) ?? new Set<string>();
        set.add(s.id);
        unknownByPly.set(f.ply, set);
        return false;
      });
      if (kept.length === f.positional_subterms.length) return f;
      return { ...f, positional_subterms: kept };
    });
    if (unknownByPly.size > 0) {
      const total = Array.from(unknownByPly.values()).reduce(
        (acc, set) => acc + set.size,
        0,
      );
      const sample = Array.from(unknownByPly.entries())
        .slice(0, 5)
        .map(([ply, ids]) => `ply=${ply}:[${Array.from(ids).join(',')}]`)
        .join('; ');
      this.logger.warn(
        `pruneUnknownSubterms: dropped ${total} unknown subterm-id(s) across ` +
          `${unknownByPly.size} ply (sample: ${sample}). Update ` +
          `PositionalSubtermId in @kingside/shared and SUBTERM_LABELS ` +
          `in subterm-labels.ts if these are valid new ids.`,
      );
    }
    return pruned;
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
    const sanitizedFacts = this.pruneUnknownSubterms(dto.facts);
    const userMessage = JSON.stringify({ facts: sanitizedFacts });

    try {
      const response = await this.callWebhook(
        userId,
        systemPrompt,
        userMessage,
      );
      const parsed = this.parseAndValidate(response, n);
      return this.postValidate(parsed);
    } catch (e) {
      this.logger.error(
        `batchComment user=${userId.slice(0, 8)} n=${n} failed: ` +
          `${(e as Error).message}`,
        (e as Error).stack,
      );
      return new Array(n).fill('');
    }
  }

  // ─── Промпт (KS-3678) ───────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  buildSystemPrompt(language: 'en' | 'ru', _userElo: number): string {
    if (language === 'ru') {
      return [
        'Ты комментируешь позиции в шахматной партии строго на основании поданных фактов о каждом ходе. Главное — дать оценку позиции после сыгранного хода. Комментарий самого хода даётся только тогда, когда ход действительно что-то меняет, иначе — фокус на позиции.',
        '',
        'Вход: JSON-массив записей. В каждой записи — позиция (`fen`), сыгранный ход (`move.san`, `move.uci`, `move.capture`, `move.check`, `move.mate`, `move.castling`, `move.promotion`), его классификация (`classification` — best|good|inaccuracy|mistake|blunder), изменение оценки (`delta_e`), лучший ход движка (`sf_best` с продолжением `line`), вероятный человеческий ход (`maia_alternative`), стадия (`stage`), материальный баланс и изменение (`material_balance`, `material_change`), висящая фигура (`hanging_piece`), угроза мата после хода (`mate_threat_after`), тактические мотивы (`tactical_motifs`), что ход создаёт (`threats_created`), что упустил относительно `sf_best` (`threats_missed`), позиционные ярлыки (`positional_shifts`) и подкомпоненты оценки (`positional_subterms`).',
        '',
        'Что писать для каждой записи:',
        '1. По умолчанию — оценка позиции после сыгранного хода: кто стоит лучше, в чём дисбаланс, какие факторы доминируют, какие планы у сторон. Длина — столько, сколько нужно по фактам, без искусственного потолка.',
        '2. Комментарий хода добавляется ТОЛЬКО когда ход явно что-то меняет: взятие, размен, шах, мат, рокировка, превращение, создание/защита угрозы (`threats_created`, `hanging_piece`, `mate_threat_after`), заметный `material_change` или `positional_shifts`, либо `classification` = mistake/blunder/inaccuracy. В таком случае коротко опиши, что ход сделал или какую идею воплотил, а при ошибке — что упустил (по `sf_best` / `threats_missed`), без буквального пересказа `sf_best.line`.',
        '3. Если ход тихий и позицию заметно не меняет — про сам ход можно не упоминать, давай только оценку позиции.',
        '4. Если по фактам сказать нечего — верни пустую строку "".',
        '',
        'Ограничения:',
        '- Опирайся ТОЛЬКО на поданные факты. Не утверждай ничего, чего нет в записи (мотивы, фигуры, угрозы, оценки).',
        '- Не пересказывай `sf_best.line` буквально ходами (никаких «e2e4, потом Nc3»), используй только как ориентир для идеи.',
        '- Не пиши численные значения оценки. Только слова: «небольшой перевес», «заметное преимущество», «решающее преимущество», «примерное равенство», «мат в N».',
        '',
        'Выход: JSON-массив строк той же длины и в том же порядке, что и вход.',
      ].join('\n');
    }
    return [
      'You comment on chess positions in a game strictly based on the provided facts for each move. The primary task is to evaluate the position after the played move. A comment on the move itself is added only when the move actually changes something; otherwise focus on the position.',
      '',
      'Input: JSON array of records. Each record contains the position (`fen`), the played move (`move.san`, `move.uci`, `move.capture`, `move.check`, `move.mate`, `move.castling`, `move.promotion`), its classification (`classification` — best|good|inaccuracy|mistake|blunder), eval delta (`delta_e`), the engine\'s best move (`sf_best` with continuation `line`), the likely human move (`maia_alternative`), the stage (`stage`), material balance and change (`material_balance`, `material_change`), hanging piece (`hanging_piece`), mate threat after the move (`mate_threat_after`), tactical motifs (`tactical_motifs`), what the move creates (`threats_created`), what it missed vs `sf_best` (`threats_missed`), positional shift labels (`positional_shifts`) and evaluation subterms (`positional_subterms`).',
      '',
      'What to write for each record:',
      '1. By default — an evaluation of the position after the played move: who stands better, what the imbalance is, which factors dominate, what plans each side has. Length — as much as the facts require, with no artificial cap.',
      '2. A comment on the move is added ONLY when the move clearly changes something: capture, exchange, check, mate, castling, promotion, creating/defending a threat (`threats_created`, `hanging_piece`, `mate_threat_after`), notable `material_change` or `positional_shifts`, or `classification` = mistake/blunder/inaccuracy. In that case, briefly describe what the move did or the idea behind it; for a mistake — what was missed (per `sf_best` / `threats_missed`), without literally enumerating `sf_best.line`.',
      '3. If the move is quiet and does not noticeably change the position — you may skip commenting on the move itself and only give the position evaluation.',
      '4. If there is nothing to say based on the facts — return an empty string "".',
      '',
      'Constraints:',
      '- Rely ONLY on the provided facts. Do not assert anything not in the record (motifs, pieces, threats, evaluations).',
      '- Do not retell `sf_best.line` literally as moves (no "e2e4, then Nc3"); use it only as a guide for ideas.',
      '- Do not write numeric evaluation values. Words only: "slight edge", "clear advantage", "decisive advantage", "roughly equal", "mate in N".',
      '',
      'Output: JSON array of strings of the same length and in the same order as the input.',
    ].join('\n');
  }

  // ─── Webhook call ───────────────────────────────────────────────────

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
          noMcp: true,
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

  parseAndValidate(rawResponse: string, expectedLen: number): string[] {
    let body = (rawResponse ?? '').trim();
    if (!body) throw new Error('empty response from webhook');

    const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      body = fenceMatch[1].trim();
    }

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

  // ─── Post-валидация ────────────────────────────────────────────────

  postValidate(comments: string[]): string[] {
    return comments.map((c) => this.validateOne(c));
  }

  private validateOne(comment: string): string {
    const raw = (comment ?? '').trim();
    if (raw === '') return '';

    const norm = raw.toLowerCase().replace(/[.!?,:;"'`«»\s]+$/u, '').trim();
    if (NAG_TAUTOLOGY_RU.test(norm) || NAG_TAUTOLOGY_EN.test(norm)) {
      return '';
    }

    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    if (wordCount < this.minWords && raw.length < this.minChars) {
      return '';
    }
    return raw;
  }
}

const NAG_TAUTOLOGY_RU =
  /^(сильный\s+ход|отличный\s+ход|лучший\s+ход|хороший\s+ход|слабый\s+ход|плохой\s+ход|ошибка|грубая\s+ошибка|зевок|неточность|хорошо)$/i;

const NAG_TAUTOLOGY_EN =
  /^(strong\s+move|excellent\s+move|best\s+move|good\s+move|weak\s+move|poor\s+move|mistake|big\s+mistake|blunder|inaccuracy|good)$/i;
