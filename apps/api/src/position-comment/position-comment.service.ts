import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PositionCommentResponse } from '@kingside/shared';
import { RedisService } from '../redis/redis.service';
import { SUBTERM_LABELS } from '../analysis-review/subterm-labels';
import {
  PositionCommentDto,
  PositionCommentLanguage,
} from './dto/position-comment.dto';
import { parseModelOutput } from './parse-model-output';

const EMPTY_RESPONSE: PositionCommentResponse = {
  comment: '',
  highlights: [],
  arrows: [],
};

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
   * KS-3681 / ADR-108 §8.2 + KS-3686. Две короткие версии инструкции —
   * RU и EN. Симметричный перевод; стиль продолжает упрощённую
   * инструкцию из KS-3678 (без калибровок, без обучающих примеров,
   * без запретов).
   *
   * KS-3686: добавлен явный акцент на двух факторах от фронта —
   * `sf18_eval` (оценка Stockfish 18) и `sf18_pv` (его первая линия).
   * Модель должна перевести оценку в человеческие слова и упомянуть
   * план из первых ходов pv, если они есть. Если этих факторов нет —
   * комментирует только по остальным (backward-compat).
   *
   * Дефолт — `'ru'` (старые клиенты без поля `language` получают
   * русский комментарий, как до KS-3681).
   */
  /**
   * KS-3689: словарь расшифровок id позиционных подкомпонент. Берём
   * `SUBTERM_LABELS` из analysis-review — там 59 ID синхронизированы
   * с `PositionalSubtermId` в shared. Возвращает многострочный текст
   * `- <id> → <человеческое имя>` для подстановки в инструкцию.
   */
  private buildSubtermGlossary(language: PositionCommentLanguage): string {
    return Object.entries(SUBTERM_LABELS)
      .map(([id, label]) => `- ${id} → ${label[language]}`)
      .join('\n');
  }

  buildSystemPrompt(language: PositionCommentLanguage = 'ru'): string {
    const glossary = this.buildSubtermGlossary(language);
    if (language === 'en') {
      return [
        'Please comment on this chess position in plain language using the given positional factors.',
        '',
        'Two factors are the most important if present:',
        '- sf18_eval: Stockfish 18 evaluation. score.type="cp" — centipawns from the side-to-move point of view (side_to_move): positive means the side to move is better. score.type="mate" — mate in N half-moves: positive N means the side to move is delivering mate, negative means the opponent is.',
        '- sf18_pv: Stockfish 18 principal variation, an array of UCI moves (e.g. ["e2e4","e7e5","g1f3"]).',
        '',
        'When these factors are present, you MUST reflect both: describe the evaluation in plain words and mention the first two or three moves of pv as the recommended plan. When they are absent, comment using the remaining factors only.',
        '',
        'Glossary — translate each subterm id to its human name before writing about it. Never put a technical id in the answer (king_danger, outpost_knight, mobility_rook, etc.). Use the human name from the table:',
        glossary,
        '',
        'Never quote raw numeric values of subterms (value_mg, value_eg, mg, eg, value, or any bare number like 0.323). Instead use words: "barely noticeable", "noticeable", "sharply increased", "dropped", "the highest in the position", "the lowest", "moderate". When comparing factors use: "the most", "the least", "moderate", "barely noticeable".',
        '',
        'Never quote the numeric evaluation in your answer either — no "+0.8", no "cp", no "centipawns", no "score 23". Use words only: "roughly equal", "slight edge for White/Black", "clear advantage for White/Black", "decisive advantage for White/Black", "mate in N".',
        '',
        'Forbidden word: "slider" / "sliders" / "sliding piece(s)". Use proper chess terms instead: "long-range pieces" (rook, bishop, queen), "major pieces" (rook, queen), "minor pieces" (knight, bishop).',
        '',
        'Output format — ONE JSON object:',
        '{ "comment": "<text>", "highlights": [...], "arrows": [...] }',
        '',
        '- comment — your commentary in plain words (as above).',
        '- highlights — 0–4 items of shape { "square": "e4", "color": "red" }.',
        '- arrows — 0–2 items of shape { "from": "e2", "to": "e4", "color": "green" }.',
        '',
        'Color convention:',
        '- red — weakness / threat / piece in danger;',
        '- green — recommended plan or best move;',
        '- yellow — key idea / focal point;',
        '- blue — reserved for the user, do not use.',
        '',
        'Highlight at most 1–2 key factors in total. If there is nothing to highlight, return empty arrays. Do not wrap the JSON in code fences. Do not add any text outside the JSON object.',
      ].join('\n');
    }
    return [
      'Прокомментируй пожалуйста позицию человеческим языком на основании факторов.',
      '',
      'Среди факторов могут быть два приоритетных:',
      '- sf18_eval: оценка позиции от Stockfish 18. score.type="cp" — сантипешки с точки зрения стороны, чей ход (side_to_move): положительное значение значит, что эта сторона стоит лучше. score.type="mate" — мат за N полуходов: положительное N — сторона, чей ход, объявляет мат, отрицательное — соперник.',
      '- sf18_pv: первая линия Stockfish 18, массив ходов в UCI (например ["e2e4","e7e5","g1f3"]).',
      '',
      'Если эти факторы есть — ОБЯЗАТЕЛЬНО отрази оба: опиши оценку человеческими словами и упомяни первые два-три хода pv как рекомендованный план. Если их нет — комментируй только по остальным факторам.',
      '',
      'Словарь расшифровок — каждый id подкомпоненты переводи в человеческое имя из таблицы перед тем, как писать о нём. Никогда не пиши технический id в ответе (king_danger, outpost_knight, mobility_rook и т.п.). Используй человеческое имя из таблицы:',
      glossary,
      '',
      'Никогда не приводи сырые числовые значения подкомпонент (value_mg, value_eg, mg, eg, value, ни любое голое число вроде 0,323 или 0.323). Используй слова: «едва заметно», «заметно», «резко вырос», «упал», «стал максимальным в позиции», «минимальный в позиции», «средне». При сравнении факторов: «больше всего», «меньше всего», «средне», «едва заметно».',
      '',
      'Также никогда не приводи численное значение общей оценки — ни «+0.8», ни «23 cp», ни «сантипешки», ни «оценка 23». Только слова: «примерное равенство», «небольшой перевес белых/чёрных», «заметное преимущество белых/чёрных», «решающее преимущество белых/чёрных», «мат в N».',
      '',
      'Запрещённые слова: «слайдер», «слайдеры», «слайдинг», «sliding piece(s)». Вместо них — «фигуры дальнего боя» (ладьи, слоны, ферзи), «тяжёлые фигуры» (ладья, ферзь), «лёгкие фигуры» (конь, слон).',
      '',
      'Формат ответа — ОДИН JSON-объект:',
      '{ "comment": "<текст>", "highlights": [...], "arrows": [...] }',
      '',
      '- comment — текстовый комментарий человеческими словами (как выше).',
      '- highlights — 0–4 элемента вида { "square": "e4", "color": "red" }.',
      '- arrows — 0–2 элемента вида { "from": "e2", "to": "e4", "color": "green" }.',
      '',
      'Цветовая конвенция:',
      '- red — слабость / угроза / опасная фигура;',
      '- green — рекомендуемый план или лучший ход;',
      '- yellow — ключевая идея / точка внимания;',
      '- blue — резерв пользователя, не используй.',
      '',
      'Выдели не больше 1–2 факторов суммарно. Если выделять нечего — верни пустые массивы. Не оборачивай JSON в код-fences. Не добавляй текст вне JSON-объекта.',
    ].join('\n');
  }

  async comment(
    userId: string,
    dto: PositionCommentDto,
  ): Promise<PositionCommentResponse> {
    // KS-3681 / ADR-108 §11 B1: пустой `factors` — мгновенный пустой
    // ответ, без обращения к webhook'у. Экономит квоту Pro/Max и
    // время пользователя (фронт всё равно отрисует state `empty`).
    //
    // KS-3690 / ADR-108b §6.3: возвращаем новый шейп всегда — с
    // пустыми массивами highlights/arrows.
    if (!dto.factors || dto.factors.length === 0) {
      return { ...EMPTY_RESPONSE };
    }

    if (!this.webhookUrl) {
      this.logger.warn(
        `comment user=${userId.slice(0, 8)}: AI_CHAT_WEBHOOK_URL not configured — returning empty`,
      );
      return { ...EMPTY_RESPONSE };
    }

    const systemPrompt = this.buildSystemPrompt(dto.language);
    const userMessage = JSON.stringify({
      fen: dto.fen,
      factors: dto.factors,
      ...(dto.eval ? { eval: dto.eval } : {}),
    });

    // KS-3694: временная диагностика регрессии. На скриншоте пользователя
    // в проде модель снова выдаёт `king_safe_check_knight -2,45` —
    // словарь и запреты KS-3689 не доходят. Логируем длину prompt'а,
    // его начало и конец (где должен быть блок про запреты), а также
    // первый и последний 200 символов ответа webhook. После
    // подтверждения причины — лог снять.
    this.logger.log(
      `KS-3694 systemPrompt lang=${dto.language ?? 'ru'} ` +
        `len=${systemPrompt.length} ` +
        `head=${JSON.stringify(systemPrompt.slice(0, 200))} ` +
        `tail=${JSON.stringify(systemPrompt.slice(-200))} ` +
        `hasGlossary=${systemPrompt.includes('king_danger →')} ` +
        `hasNumericBan=${
          systemPrompt.includes('сырые числовые') ||
          systemPrompt.includes('raw numeric values')
        }`,
    );

    try {
      const response = await this.callWebhook(
        userId,
        systemPrompt,
        userMessage,
      );
      const rawForLog = response ?? '';
      this.logger.log(
        `KS-3694 webhook response len=${rawForLog.length} ` +
          `head=${JSON.stringify(rawForLog.slice(0, 200))}`,
      );
      // KS-3690: парсер pure-функция, фолбэк внутри. На пустую строку
      // ответа отдаём шейп с пустым comment и пустыми массивами.
      return parseModelOutput(rawForLog);
    } catch (e) {
      this.logger.error(
        `comment user=${userId.slice(0, 8)} failed: ${(e as Error).message}`,
        (e as Error).stack,
      );
      return { ...EMPTY_RESPONSE };
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
