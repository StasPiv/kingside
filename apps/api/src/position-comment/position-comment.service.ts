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
  private readonly debug: boolean;

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

    // KS-3700: диагностический лог метаданных входящего запроса
    // (`fen`, `factors.length`, перечень `id`, флаги наличия
    // `sf18_eval`/`sf18_pv` и счётчик `terminal_value_*`). Включается
    // только при `POSITION_COMMENT_DEBUG=true`, значения подкомпонент
    // в лог не пишутся.
    this.debug =
      this.config.get<string>('POSITION_COMMENT_DEBUG', 'false') === 'true';

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
        'Please comment on this chess position in plain language using the given positional factors. This is a STATIC evaluation: describe only what is in the position right now and how factors shift by tendency. No predictions of concrete future moves, no manoeuvres, no plans by named pieces.',
        '',
        'Main source of truth — sf18_eval (Stockfish 18 evaluation):',
        '- score.type="cp" — centipawns from White\'s point of view: positive means White is better, negative means Black is better (the sign is always reported from White\'s side, regardless of whose move it is).',
        '- score.type="mate" — mate in N half-moves from White\'s point of view: positive N means White is delivering mate, negative N means Black is delivering mate.',
        'The verdict on which side stands better ALWAYS follows sf18_eval.',
        '',
        'Static subterms (anything from the glossary below) may carry two pairs of values: value_mg/value_eg — value of the factor in the current position, and terminal_value_mg/terminal_value_eg — value of the same factor in the position roughly 10 moves per side later under reasonable play by both sides. Either pair may be missing: no initial values means the factor appears by the end; no terminal values means it disappears by the end. Reason about the TREND (how the factor changes), not only the current value: growth from value to terminal — the factor is reinforced; decay or zeroing — it dissolves or is liquidated by the opponent. Never mention the actual value/terminal_value numbers in your answer.',
        '',
        'Forbidden — inventing concrete moves, manoeuvres and plans. Do NOT write "transferring the knight to …", "pawn break …", "strike along the … diagonal", "opening the … file", "pin along …", "attack on …", "sacrifice …", "blow on …" or any other description of future actions by named pieces. Concrete squares may be mentioned ONLY if they come from the square field of a subterm in the glossary (for example, for outpost_knight you may say "knight on the outpost at e5" — because e5 came from the fact). Concrete moves (e2-e4, Nf3, Bxc7, etc.) — forbidden in any form. Diagonals and files as lines of action or planned breaks — forbidden unless they directly follow from a subterm with a square.',
        '',
        'Hierarchy:',
        '1) sf18_eval — who stands better (the verdict);',
        '2) factor trend (value → terminal_value) — which subterms drive it, which are reinforced, which dissolve;',
        '3) static factors — what is in the position right now.',
        'If sf18_eval shows a clear advantage for one side while static subterms stack up for the other — that means the opponent soon captures the piece or pawn those factors rely on, and Stockfish has already accounted for it. Describe it as: "Nominally Side X has Y, but Stockfish does not see this as an advantage — the factor dissolves soon." Do NOT spell out how exactly.',
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
        'Use arrows ONLY to highlight a concrete weakness tied to a glossary subterm (from the attacker to its target). Do not use arrows as "manoeuvre plan" or "pawn break". If there is no such pairing in the facts, return arrows as an empty array. Highlight at most 1–2 key factors in total. If there is nothing to highlight, return empty arrays. Do not wrap the JSON in code fences. Do not add any text outside the JSON object.',
      ].join('\n');
    }
    return [
      'Прокомментируй пожалуйста позицию человеческим языком на основании факторов. Это СТАТИЧЕСКАЯ оценка: только то, что есть в позиции сейчас и как факторы меняются по тенденции. Никаких прогнозов конкретных будущих ходов, манёвров и планов конкретными фигурами.',
      '',
      'Главный источник истины — sf18_eval (оценка Stockfish 18):',
      '- score.type="cp" — сантипешки с точки зрения белых: положительное значение значит, что лучше стоят белые, отрицательное — лучше стоят чёрные (знак всегда приходит со стороны белых, независимо от того, чей ход).',
      '- score.type="mate" — мат за N полуходов с точки зрения белых: положительное N — мат объявляют белые, отрицательное N — мат объявляют чёрные.',
      'Вердикт о стороне с перевесом ВСЕГДА следует за sf18_eval.',
      '',
      'У статических подкомпонент (любой пункт словаря ниже) могут быть две пары значений: value_mg/value_eg — значение фактора в текущей позиции, и terminal_value_mg/terminal_value_eg — значение того же фактора в позиции примерно через 10 ходов каждой стороны при разумной игре обеих сторон. Любая пара может отсутствовать: нет исходной — фактор появляется к концу; нет терминальной — фактор исчезает к концу. Опирайся на ТЕНДЕНЦИЮ (как фактор меняется), а не только на текущее значение: рост от value к terminal — фактор укрепляется, падение или обнуление — растворяется или ликвидируется соперником. Числа самих value/terminal_value в ответе не упоминай.',
      '',
      'Запрещено выдумывать конкретные ходы, манёвры и планы. Нельзя писать «перевод коня на …», «прорыв пешкой …», «удар по диагонали …», «вскрытие линии …», «связка по …», «нападение …», «жертва …», «удар …» и любые другие описания будущих действий конкретными фигурами. Конкретные клетки можно называть ТОЛЬКО если они пришли из поля square самой подкомпоненты словаря (например, для outpost_knight можно сказать «конь на форпосте e5» — потому что e5 пришло из факта). Конкретные ходы (e2-e4, Кf3, С:c7 и т.п.) — нельзя ни в каком виде. Диагонали и линии как «линии действия» или планируемые прорывы — нельзя, если они не следуют напрямую из подкомпоненты со square.',
      '',
      'Иерархия:',
      '1) sf18_eval — кто стоит лучше (вердикт о перевесе);',
      '2) тенденция факторов (value → terminal_value) — за счёт каких подкомпонент это происходит, какие укрепляются, какие исчезают;',
      '3) статические факторы — то, что есть в позиции прямо сейчас.',
      'Если sf18_eval показывает заметный перевес одной стороны, а статические подкомпоненты складываются в пользу другой — это значит, что соперник вскоре забирает фигуру или пешку, на которой эти факторы держатся, и Stockfish это уже учёл. Описывай это так: «формально у X есть Y, но Stockfish не считает это преимуществом — фактор скоро исчезает». КАК именно это произойдёт — не пиши.',
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
      'Стрелки используй ТОЛЬКО для указания конкретной слабости, привязанной к подкомпоненте из словаря (от атакующей фигуры к её цели). Стрелки как «план манёвра» или «прорыв» — нельзя. Если такой связки в фактах нет, верни arrows пустым массивом. Выдели не больше 1–2 факторов суммарно. Если выделять нечего — верни пустые массивы. Не оборачивай JSON в код-fences. Не добавляй текст вне JSON-объекта.',
    ].join('\n');
  }

  /**
   * KS-3721. `sf18_pv` — массив UCI-ходов рекомендуемой линии Stockfish.
   * Модель использует его как затравку для реконструкции манёвров и
   * выдумывает прорывы/диагонали/переводы фигур, которых в данных нет.
   * В новой статической инструкции `sf18_pv` не упоминается и не нужен —
   * вырезаем его из подаваемых модели факторов целиком. Терминальные
   * значения `terminal_value_*` у статических подкомпонент остаются:
   * тенденция (value → terminal) сохраняется без знания самой линии.
   */
  private stripPvFactor(
    factors: PositionCommentDto['factors'],
  ): PositionCommentDto['factors'] {
    if (!Array.isArray(factors)) return factors;
    return factors.filter((f) => {
      if (typeof f !== 'object' || f === null) return true;
      const id = (f as Record<string, unknown>).id;
      return id !== 'sf18_pv';
    });
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

    if (this.debug) {
      const meta = this.extractDebugMeta(dto);
      this.logger.log(
        `comment user=${userId.slice(0, 8)} debug: ${JSON.stringify(meta)}`,
      );
    }

    if (!this.webhookUrl) {
      this.logger.warn(
        `comment user=${userId.slice(0, 8)}: AI_CHAT_WEBHOOK_URL not configured — returning empty`,
      );
      return { ...EMPTY_RESPONSE };
    }

    const systemPrompt = this.buildSystemPrompt(dto.language);
    // KS-3721: вырезаем sf18_pv до сериализации — модель не должна
    // получать UCI-линию как почву для выдумывания манёвров.
    const factorsForModel = this.stripPvFactor(dto.factors);
    const dataJson = JSON.stringify({
      fen: dto.fen,
      factors: factorsForModel,
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

  // ─── Debug meta (KS-3700) ──────────────────────────────────────────
  /**
   * Сводка по входящему запросу для диагностического лога. Возвращает
   * только метаданные: `fen` целиком, длину массива `factors`,
   * перечень `id` его элементов, флаги наличия `sf18_eval` / `sf18_pv`,
   * количество элементов с `terminal_value_mg` или `terminal_value_eg`
   * и dto.eval (если есть). Значения подкомпонент (`value_mg`,
   * `value_eg`, `terminal_value_*`) сюда НЕ попадают — иначе бы в
   * CloudWatch улетал весь Stockfish-трейс позиции.
   */
  private extractDebugMeta(dto: PositionCommentDto): Record<string, unknown> {
    const ids: string[] = [];
    let hasSf18Eval = false;
    let hasSf18Pv = false;
    let terminalCount = 0;
    for (const f of dto.factors) {
      if (typeof f !== 'object' || f === null) continue;
      const obj = f as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      if (id) ids.push(id);
      if (id === 'sf18_eval') hasSf18Eval = true;
      if (id === 'sf18_pv') hasSf18Pv = true;
      if ('terminal_value_mg' in obj || 'terminal_value_eg' in obj) {
        terminalCount += 1;
      }
    }
    return {
      fen: dto.fen,
      factors_length: dto.factors.length,
      ids,
      has_sf18_eval: hasSf18Eval,
      has_sf18_pv: hasSf18Pv,
      terminal_count: terminalCount,
      ...(dto.eval ? { eval: dto.eval } : {}),
    };
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
        throw new Error(`position-comment webhook ${res.status}: ${summary}`);
      }
      return bodyJson?.response ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
