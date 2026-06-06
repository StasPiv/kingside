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
  /**
   * KS-3814 (ADR-114 §3, KS-N06). Версия системной инструкции,
   * подаваемой модели. `short` — компактная (≤80 строк), активная по
   * умолчанию: содержит mapping cp→вердикт, иерархию достоверности,
   * запреты, формат JSON. `long` — прежняя расширенная (с обучающими
   * примерами и подробными формулировками), оставлена как страховка
   * на случай регрессии стиля; переключается через ENV
   * `AI_PROMPT_VARIANT=long`.
   */
  private readonly promptVariant: 'short' | 'long';

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
    const variant = this.config.get<string>('AI_PROMPT_VARIANT', 'short');
    this.promptVariant = variant === 'long' ? 'long' : 'short';
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
   *
   * KS-3813 (ADR-114 §3, KS-N05). Если передан `usedIds` — словарь
   * сжимается до пересечения с этим набором. Без аргумента (или при
   * `undefined`) возвращается полный словарь — это нужно для прямых
   * вызовов `buildSystemPrompt` в тестах и для обратной совместимости.
   * При пустом `usedIds` (Set без элементов) — возвращается пустая
   * строка: в фактах нет ни одной стат-подкомпоненты, модели нечего
   * расшифровывать.
   */
  private buildSubtermGlossary(
    language: PositionCommentLanguage,
    usedIds?: ReadonlySet<string>,
  ): string {
    const entries = Object.entries(SUBTERM_LABELS);
    const filtered = usedIds
      ? entries.filter(([id]) => usedIds.has(id))
      : entries;
    return filtered.map(([id, label]) => `- ${id} → ${label[language]}`).join('\n');
  }

  /**
   * KS-3813 (ADR-114 §3, KS-N05). Извлекает из массива `factors`
   * множество id, реально присутствующих в запросе. Используется для
   * сжатия словаря расшифровок до тех id, которые модель действительно
   * увидит. Sentinel-факторы (`sf18_eval`, `sf18_pv`) и любые id вне
   * `SUBTERM_LABELS` отсекаются автоматически на этапе пересечения в
   * `buildSubtermGlossary`, поэтому здесь набираем все строковые id
   * подряд — лишние не навредят.
   */
  private extractUsedSubtermIds(factors: unknown[]): Set<string> {
    const out = new Set<string>();
    if (!Array.isArray(factors)) return out;
    for (const f of factors) {
      if (typeof f !== 'object' || f === null) continue;
      const id = (f as { id?: unknown }).id;
      if (typeof id === 'string') out.add(id);
    }
    return out;
  }

  /**
   * KS-3814. Выбор сжатой или расширенной версии инструкции по ENV
   * `AI_PROMPT_VARIANT`. По умолчанию — `short` (компактная, ≤80
   * строк, без обучающих примеров). При значении `long` — прежняя
   * расширенная (страховка на случай регрессии стиля после раскат).
   */
  buildSystemPrompt(
    language: PositionCommentLanguage = 'ru',
    usedIds?: ReadonlySet<string>,
  ): string {
    return this.promptVariant === 'long'
      ? this.buildSystemPromptLong(language, usedIds)
      : this.buildSystemPromptShort(language, usedIds);
  }

  /**
   * KS-3814. Сжатая системная инструкция: ≤80 строк (плюс словарь
   * подкомпонент, сжатый KS-3813 до пришедших id). Сохранены все
   * обязательные блоки: соответствие cp→вердикт, иерархия
   * достоверности, запреты (числа, конкретные ходы, шаблонные
   * формулировки), словарь, формат JSON. Длинные обучающие примеры
   * (кейс cp=-665) вынесены в JSDoc к `buildSystemPromptLong`.
   */
  private buildSystemPromptShort(
    language: PositionCommentLanguage,
    usedIds?: ReadonlySet<string>,
  ): string {
    const glossary = this.buildSubtermGlossary(language, usedIds);
    if (language === 'en') {
      return [
        'Comment on this chess position from the given facts. This is a STATIC evaluation: describe what is on the board now and how factors shift by tendency. No predictions of concrete future moves, manoeuvres or plans by named pieces.',
        '',
        'Source of truth — sf18_eval (Stockfish 18), sign always from White:',
        '- score.type="cp" — centipawns; positive: White better, negative: Black better.',
        '- score.type="mate" — mate in N half-moves; positive N: White mates, negative N: Black mates.',
        'The verdict on who stands better ALWAYS follows the sign of sf18_eval.',
        '',
        'Mapping sf18_eval → verdict (mandatory):',
        '- |cp| ≤ 30 → "roughly equal";',
        '- 30 < |cp| ≤ 100 → "slight edge for White/Black" (per sign);',
        '- 100 < |cp| ≤ 300 → "clear advantage for White/Black" (per sign);',
        '- |cp| ≥ 300 → "decisive advantage for White/Black" (per sign);',
        '- mate ±N → "mate in N for White/Black" (per sign).',
        'FORBIDDEN — claiming any edge / advantage for White when sf18_eval.cp < 0 or mate with negative N. Symmetric ban for Black when sf18_eval.cp > 0. Extra material, a strong knight, a passed pawn, an open file — facts, NOT a reason to override the sign of sf18_eval.',
        '',
        'Hierarchy:',
        '1) sf18_eval — who stands better (the verdict);',
        '2) factor trend (value → terminal_value) — which subterms are reinforced, which dissolve;',
        '3) static factors — what is there right now.',
        'If sf18_eval points one way and static factors stack up the other — the static factor dissolves soon, Stockfish already accounts for it. Phrase it: "Nominally Side X has Y, but Stockfish does not see this as an advantage — the factor dissolves soon." Do NOT spell out HOW.',
        '',
        'Trend: subterms may carry value_mg/value_eg (now) and terminal_value_mg/terminal_value_eg (≈10 moves per side later). Either pair may be missing: no initial — appears by the end; no terminal — dissolves. Describe the trend, never the numbers.',
        '',
        'Concrete squares are allowed ONLY if they come from the square field of a glossary subterm (e.g. outpost_knight → "knight on the outpost at e5"). Concrete moves (e2-e4, Nf3, Bxc7), diagonals/files as planned lines of action — forbidden. Forbidden phrasings: "transferring the knight to …", "pawn break …", "strike along the … diagonal", "opening the … file", "pin along …", "attack on …", "sacrifice …".',
        '',
        'Never quote raw numbers: not "+0.8", "cp", "centipawns", "score 23"; not value_mg/value_eg/value/0.323. Use words only: "roughly equal", "slight edge for White/Black", "clear advantage for White/Black", "decisive advantage for White/Black", "mate in N"; "barely noticeable", "noticeable", "sharply increased", "dropped", "the highest", "the lowest", "moderate".',
        '',
        'Forbidden words: "slider", "sliders", "sliding piece(s)". Use "long-range pieces" (rook, bishop, queen), "major pieces" (rook, queen), "minor pieces" (knight, bishop).',
        '',
        'Do NOT put a technical id in the answer — translate via the glossary:',
        glossary,
        '',
        'Output format — ONE JSON object:',
        '{ "comment": "<text>", "highlights": [...], "arrows": [...] }',
        '- comment — your commentary (rules above);',
        '- highlights — 0–4 items of shape { "square": "e4", "color": "red" };',
        '- arrows — 0–2 items of shape { "from": "e2", "to": "e4", "color": "green" }.',
        '',
        'Colors: red — weakness/threat; green — recommended plan or best move; yellow — key idea; blue — reserved for the user, do not use.',
        '',
        'Arrows — ONLY from an attacker to its target tied to a glossary subterm. Arrows as "manoeuvre plan" or "pawn break" — forbidden. If no such pairing exists in the facts — arrows is empty. Highlight at most 1–2 factors in total. Do not wrap the JSON in code fences. Do not add text outside the JSON object.',
      ].join('\n');
    }
    return [
      'Прокомментируй позицию по фактам. Это СТАТИЧЕСКАЯ оценка: только то, что сейчас на доске и как факторы меняются по тенденции. Запрещены прогнозы конкретных ходов, манёвров и планов конкретными фигурами.',
      '',
      'Источник истины — sf18_eval (Stockfish 18), знак всегда от белых:',
      '- score.type="cp" — сантипешки; «+» — лучше у белых, «−» — у чёрных.',
      '- score.type="mate" — мат за N полуходов; положительное N — мат объявляют белые, отрицательное N — чёрные.',
      'Вердикт о перевесе ВСЕГДА следует за знаком sf18_eval.',
      '',
      'Соответствие cp → вердикт (обязательно):',
      '- |cp| ≤ 30 → «примерное равенство»;',
      '- 30 < |cp| ≤ 100 → «небольшой перевес белых/чёрных» (по знаку);',
      '- 100 < |cp| ≤ 300 → «заметное преимущество белых/чёрных» (по знаку);',
      '- |cp| ≥ 300 → «решающее преимущество белых/чёрных» (по знаку);',
      '- mate ±N → «мат в N за белых/чёрных» (по знаку).',
      'ЗАПРЕЩЕНО писать «у белых перевес/преимущество/лучше», когда sf18_eval.cp < 0 или mate с N<0. Симметричный запрет для чёрных при cp>0. Лишний материал, сильный конь, проходная, открытая линия — это факты, они НЕ отменяют знак sf18_eval.',
      '',
      'Иерархия достоверности:',
      '1) sf18_eval — кто стоит лучше (вердикт);',
      '2) тенденция факторов value → terminal_value — что усиливается, что растворяется;',
      '3) статические факторы — что есть прямо сейчас.',
      'Если sf18_eval за одну сторону, а статика за другую — статика ликвидируется ближайшими ходами, Stockfish это уже учёл. Описывай так: «формально у X есть Y, но Stockfish не считает это преимуществом — фактор скоро исчезает». КАК именно — не пиши.',
      '',
      'Тенденция: у подкомпонент могут быть value_mg/value_eg (сейчас) и terminal_value_mg/terminal_value_eg (через ≈10 ходов каждой стороны). Любая пара может отсутствовать: нет исходной — фактор появляется к концу; нет терминальной — растворяется. Описывай тенденцию, числа не упоминай.',
      '',
      'Конкретные клетки разрешены ТОЛЬКО если пришли из поля square самой подкомпоненты словаря (например, outpost_knight → «конь на форпосте e5»). Конкретные ходы (e2-e4, Кf3, С:c7), диагонали и линии как «линии действия» или планируемые прорывы — запрещены. Запрещённые формулировки: «перевод коня на …», «прорыв пешкой …», «удар по диагонали …», «вскрытие линии …», «связка …», «нападение …», «жертва …».',
      '',
      'Не приводи численные значения: ни «+0.8», ни «23 cp», ни «сантипешки», ни «оценка 23»; не пиши value_mg/value_eg/value/0.323. Только слова: «примерное равенство», «небольшой перевес», «заметное преимущество», «решающее преимущество», «мат в N»; «едва заметно», «заметно», «резко вырос», «упал», «максимальный», «минимальный», «средне», «больше/меньше всего».',
      '',
      'Запрещённые слова: «слайдер», «слайдеры», «слайдинг». Замена: «фигуры дальнего боя» (ладья, слон, ферзь), «тяжёлые фигуры» (ладья, ферзь), «лёгкие фигуры» (конь, слон).',
      '',
      'Технический id в ответ НЕ пиши — переводи через словарь:',
      glossary,
      '',
      'Формат ответа — ОДИН JSON-объект:',
      '{ "comment": "<текст>", "highlights": [...], "arrows": [...] }',
      '- comment — комментарий по правилам выше;',
      '- highlights — 0–4 элемента вида { "square": "e4", "color": "red" };',
      '- arrows — 0–2 элемента вида { "from": "e2", "to": "e4", "color": "green" }.',
      '',
      'Цвета: red — слабость/угроза; green — рекомендуемый план или лучший ход; yellow — ключевая идея; blue — резерв пользователя, не используй.',
      '',
      'Стрелки — ТОЛЬКО от атакующей фигуры к её цели на основе подкомпоненты из словаря. Стрелки как «план манёвра» или «прорыв» — нельзя. Если связки в фактах нет — arrows пустой. Выдели максимум 1–2 фактора суммарно. Не оборачивай в код-блоки, не пиши текст вне JSON.',
    ].join('\n');
  }

  /**
   * KS-3814. Прежняя расширенная инструкция, оставлена под ENV
   * `AI_PROMPT_VARIANT=long` как страховка на случай регрессии стиля
   * после раскат сжатой версии. Длинные блоки переносов от прежних
   * правок KS-3686 / KS-3697 / KS-3700 / KS-3721 / KS-3727 сохранены
   * дословно — это эталонный текст, на котором калибровался стиль
   * комментариев модели до KS-3814.
   *
   * Обучающий пример (для разработчика, не для модели):
   *   Кейс KS-3727 «cp=-665, у белых лишняя фигура». Вердикт —
   *   «решающее преимущество чёрных», а не «у белых перевес». Материал
   *   упоминается как факт («формально у белых лишняя фигура»), но
   *   вердикт и нарратив следуют за sf18_eval — продвинутые пешки или
   *   атака чёрных реализуют позицию. КАК именно — не пишется.
   *
   * Этот пример раньше был внутри инструкции для модели; в сжатой
   * версии (KS-3814) он заменён жёстким запретом «у белых
   * перевес/преимущество/лучше при cp<0» без обучающей развёртки.
   */
  private buildSystemPromptLong(
    language: PositionCommentLanguage,
    usedIds?: ReadonlySet<string>,
  ): string {
    const glossary = this.buildSubtermGlossary(language, usedIds);
    if (language === 'en') {
      return [
        'Please comment on this chess position in plain language using the given positional factors. This is a STATIC evaluation: describe only what is in the position right now and how factors shift by tendency. No predictions of concrete future moves, no manoeuvres, no plans by named pieces.',
        '',
        'Main source of truth — sf18_eval (Stockfish 18 evaluation):',
        '- score.type="cp" — centipawns from White\'s point of view: positive means White is better, negative means Black is better (the sign is always reported from White\'s side, regardless of whose move it is).',
        '- score.type="mate" — mate in N half-moves from White\'s point of view: positive N means White is delivering mate, negative N means Black is delivering mate.',
        'The verdict on which side stands better ALWAYS follows sf18_eval. Before writing anything, read the sign of sf18_eval first.',
        '',
        'Mapping sf18_eval → verdict (KS-3727, mandatory):',
        '- cp from -30 to +30 → "roughly equal";',
        '- cp from +30 to +100 → "slight edge for White"; cp from -30 to -100 → "slight edge for Black";',
        '- cp from +100 to +300 → "clear advantage for White"; cp from -100 to -300 → "clear advantage for Black";',
        '- cp ≥ +300 → "decisive advantage for White"; cp ≤ -300 → "decisive advantage for Black";',
        '- score.type="mate" with positive N → "mate in N for White"; negative N → "mate in N for Black".',
        'FORBIDDEN — writing "White is better", "clear advantage for White", "decisive advantage for White", "edge for White" when sf18_eval.cp < 0 or sf18_eval.type="mate" with negative N. Symmetric ban for Black when sf18_eval.cp > 0. Material being up for one side, having a strong knight, advanced pawns, an open file, a passed pawn — NONE of these override the sign of sf18_eval. They are described as facts, the verdict stays with sf18_eval.',
        'Example: sf18_eval cp=-665, White has an extra piece. The verdict is "decisive advantage for Black", not "White is better". Material is mentioned as a fact ("nominally White has an extra piece"), but the verdict and the narrative follow sf18_eval — Black\'s advanced pawns or attack convert the position. Do NOT describe how — just state the fact and the verdict.',
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
      'Вердикт о стороне с перевесом ВСЕГДА следует за sf18_eval. Перед тем как писать что-либо, прочитай знак sf18_eval.',
      '',
      'Соответствие sf18_eval → вердикт (KS-3727, обязательно):',
      '- cp от -30 до +30 → «примерное равенство»;',
      '- cp от +30 до +100 → «небольшой перевес белых»; cp от -30 до -100 → «небольшой перевес чёрных»;',
      '- cp от +100 до +300 → «заметное преимущество белых»; cp от -100 до -300 → «заметное преимущество чёрных»;',
      '- cp ≥ +300 → «решающее преимущество белых»; cp ≤ -300 → «решающее преимущество чёрных»;',
      '- score.type="mate" с положительным N → «мат в N за белых»; отрицательным N → «мат в N за чёрных».',
      'ЗАПРЕЩЕНО писать «у белых перевес», «у белых преимущество», «заметное преимущество белых», «решающее преимущество белых», «небольшой перевес белых», «у белых лучше», «белые стоят лучше», когда sf18_eval.cp < 0 или sf18_eval.type="mate" с отрицательным N. Симметричный запрет для чёрных, когда sf18_eval.cp > 0. Материальный перевес одной стороны, сильный конь, продвинутые пешки, открытая линия, проходная — НИЧЕГО из этого не отменяет знак sf18_eval. Они упоминаются как факты, но вердикт остаётся за sf18_eval.',
      'Пример: sf18_eval cp=-665, у белых лишняя фигура. Вердикт — «решающее преимущество чёрных», а не «у белых перевес». Материал упоминается как факт («формально у белых лишняя фигура»), но вердикт и нарратив следуют за sf18_eval — продвинутые пешки чёрных или их атака реализуют позицию. КАК именно — не пиши, просто зафиксируй факт и вердикт.',
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

    // KS-3721: вырезаем sf18_pv до сериализации — модель не должна
    // получать UCI-линию как почву для выдумывания манёвров.
    const factorsForModel = this.stripPvFactor(dto.factors);
    // KS-3813: сжимаем словарь расшифровок до id, реально пришедших в
    // factors. Раньше отправлялись все 59 пар (~3 КБ), сейчас 0.5–1 КБ.
    const usedIds = this.extractUsedSubtermIds(factorsForModel);
    const systemPrompt = this.buildSystemPrompt(dto.language, usedIds);
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
