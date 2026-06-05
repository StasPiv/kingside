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
        '- sf18_pv: Stockfish 18 recommended move sequence, an array of UCI moves (e.g. ["e2e4","e7e5","g1f3"]).',
        '',
        'When these factors are present, you MUST reflect both: describe the evaluation in plain words and the dynamics of the next 2–3 moves (what threats and plans arise, where targets shift, what the opponent can try). Do NOT enumerate pv moves literally (no "e2e4, then Nc3"), do NOT mention "the principal variation", "the main line" or "pv" in your answer; use sf18_pv only as an internal guide for ideas. When they are absent, comment using the remaining factors only.',
        '',
        'Static subterms (anything from the glossary below) may carry two pairs of values: value_mg/value_eg — value of the factor in the current position, and terminal_value_mg/terminal_value_eg — value of the same factor at the end of the recommended move sequence (≈10 moves per side later). Either pair may be missing: no initial values means the factor appeared during the line; no terminal values means it disappears by the end. Reason about the TREND (how the factor changes through the fight), not only the current value: growth from value to terminal — the factor is reinforced; decay or zeroing — it dissolves or is liquidated by the opponent. Never mention the actual value/terminal_value numbers in your answer.',
        '',
        'Hierarchy of truth — sf18_eval and sf18_pv are the main source of truth. Static factors (anything from the glossary below) describe FORM, not RESULT. Before presenting any static factor as a plus or minus, check it against sf18_eval and sf18_pv:',
        '- If sf18_eval is roughly equal or against the side that "owns" the factor — the factor is tactically refuted. Use hedged language: "nominally", "structurally", "on the surface", "however", "Stockfish does not see this as an advantage". Do NOT conclude that the side has an advantage from this factor alone.',
        '- Check sf18_pv: if within the next few moves the opponent captures the piece or pawn the factor relies on, the factor is unreliable — say so. If within the next few moves the factor is pushed, defended or activated, the factor is real.',
        '- Order of priority: 1) sf18_eval (the truth about the position now); 2) sf18_pv (the truth about the next few moves); 3) static factors — only the part that agrees with the two above.',
        'Example: "Nominally White has a passed pawn, but Stockfish sees the position as equal — Black takes that pawn next move, so the passed pawn is not a real advantage."',
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
      '- sf18_pv: рекомендуемая последовательность ходов от Stockfish 18, массив ходов в UCI (например ["e2e4","e7e5","g1f3"]).',
      '',
      'Если эти факторы есть — ОБЯЗАТЕЛЬНО отрази оба: опиши оценку человеческими словами и динамику позиции на ближайшие 2-3 хода (какие угрозы и планы возникают, куда смещаются цели, что соперник может предпринять). НЕ пересказывай ходы из sf18_pv буквально (никаких "e2e4, потом Nc3"), НЕ упоминай в ответе сами выражения «первая линия», «вариант Stockfish», «pv» — используй sf18_pv только как внутренний ориентир для описания идей. Если их нет — комментируй только по остальным факторам.',
      '',
      'У статических подкомпонент (любой пункт словаря ниже) могут быть две пары значений: value_mg/value_eg — значение фактора в текущей позиции, и terminal_value_mg/terminal_value_eg — значение того же фактора в позиции конца рекомендуемой последовательности (≈через 10 ходов каждой стороны). Любая пара может отсутствовать: нет исходной — фактор появился по ходу борьбы; нет терминальной — фактор исчезает к концу. Опирайся на ТЕНДЕНЦИЮ (как фактор меняется по ходу борьбы), а не только на текущее значение: рост от value к terminal — фактор укрепляется, падение или обнуление — растворяется или ликвидируется соперником. Числа самих value/terminal_value не упоминай в ответе.',
      '',
      'Иерархия достоверности — sf18_eval и sf18_pv главнее всего остального. Статические факторы (любой пункт словаря ниже) описывают ФОРМУ, а не РЕЗУЛЬТАТ. Перед тем как преподнести любой статический фактор как «плюс» или «минус», сверь его с sf18_eval и sf18_pv:',
      '- Если sf18_eval показывает примерное равенство или против стороны, которой «принадлежит» фактор, — фактор тактически опровергнут. Используй оговорки: «формально», «структурно», «на первый взгляд», «по структуре, но», «несмотря на это», «Stockfish не считает это преимуществом». НЕ делай вывод о преимуществе только на основании такого статического фактора.',
      '- Сверка с sf18_pv: если ближайшими ходами соперник забирает фигуру или пешку, на которой держится фактор, — фактор недостоверен, скажи это прямо. Если ближайшими ходами фактор продвигается, защищается или усиливается — фактор реальный.',
      '- Порядок приоритетов: 1) sf18_eval (что в позиции по факту прямо сейчас); 2) sf18_pv (что произойдёт ближайшими ходами); 3) статические факторы — комментируй только то, что согласуется с двумя выше.',
      'Пример: «Формально у белых есть проходная пешка, но Stockfish оценивает позицию как равную — ближайшим ходом чёрные её забирают, так что проходная не даёт реального преимущества».',
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
    const dataJson = JSON.stringify({
      fen: dto.fen,
      factors: dto.factors,
      ...(dto.eval ? { eval: dto.eval } : {}),
    });

    // KS-3694: обработчик внешнего вызова за AI_CHAT_WEBHOOK_URL
    // переиспользует одну и ту же claude-сессию через
    // `claude --resume <sessionId>`. Системная инструкция, переданная
    // отдельным полем `systemPrompt`, в Claude-CLI применяется только
    // при создании сессии — на последующих запросах игнорируется.
    // Поэтому встроенная инструкция в самом `message` — это
    // единственный надёжный путь донести наш свежий prompt до модели
    // на каждом запросе. `systemPrompt` в payload оставляем для
    // совместимости со старым контрактом и для случаев, когда внешний
    // обработчик начнёт создавать новые сессии под position-comment'ы
    // (тогда наш prompt будет учтён дважды — дубль безвреден).
    const userMessage = [
      systemPrompt,
      '',
      'Исходные данные (JSON):',
      dataJson,
    ].join('\n');

    try {
      const response = await this.callWebhook(
        userId,
        systemPrompt,
        userMessage,
      );
      return parseModelOutput(response ?? '');
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
