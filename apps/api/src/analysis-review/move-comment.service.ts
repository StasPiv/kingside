/**
 * KS-3711. Сервис LLM-комментариев к одному ходу в режиме «Полный
 * разбор партии». Заменяет пакетный `ReviewCommentService`
 * (`/analyses/review/comments`) — модель теперь видит два «снимка»
 * позиции (ДО и ПОСЛЕ хода) в том же формате, что в
 * `position-comment` (`fen` + `factors` от Stockfish-trace +
 * опциональный `eval`), и комментирует именно изменение, опираясь на
 * иерархию достоверности `sf18_eval` → `sf18_pv` → статика
 * (см. KS-3697 / KS-3700 / KS-3702).
 *
 * Flow:
 *  - контроллер собирает `move + before + after + language`;
 *  - сервис строит системную инструкцию и user-message:
 *      «вот ход, вот оценка ДО, вот оценка ПОСЛЕ — прокомментируй»;
 *  - шлёт в тот же webhook (`AI_CHAT_WEBHOOK_URL`), что
 *    `position-comment` и `review-comment` (флаг `noMcp:true`);
 *  - парсит ответ моделью через переиспользуемый `parseModelOutput`
 *    (из `position-comment`) — JSON `{ comment, highlights, arrows }`;
 *  - возвращает `PositionCommentResponse`.
 *
 * Stateless. Серверного Stockfish нет — все факторы приходят с фронта
 * (фронт-форк WASM Stockfish-trace, KS-3650/KS-3648).
 *
 * Graceful degradation: webhook down, ошибка парсинга — возвращаем
 * пустой ответ `{comment: '', highlights: [], arrows: []}`.
 *
 * Rate-limit — отдельные ключи `review-move:rate:*`, увеличенные
 * лимиты под партию: 60/мин и 600/день per user, 5000/день global.
 * Партия на 30 «интересных» ходов укладывается в лимит без
 * остановки фронта.
 */
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PositionCommentResponse } from '@kingside/shared';
import { RedisService } from '../redis/redis.service';
import { SUBTERM_LABELS } from './subterm-labels';
import {
  MoveCommentDto,
  MoveCommentLanguage,
} from './dto/move-comment.dto';
import { parseModelOutput } from '../position-comment/parse-model-output';

const EMPTY_RESPONSE: PositionCommentResponse = {
  comment: '',
  highlights: [],
  arrows: [],
};

@Injectable()
export class MoveCommentService {
  private readonly logger = new Logger(MoveCommentService.name);

  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly fetchTimeoutMs: number;
  /**
   * KS-3814 (ADR-114 §3, KS-N06). Версия системной инструкции —
   * см. одноимённое поле в `PositionCommentService`. По умолчанию
   * `short` (≤80 строк); переключается на `long` через ENV
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
      this.config.get<string>('MOVE_COMMENT_FETCH_TIMEOUT_MS', '180000'),
      10,
    );
    const variant = this.config.get<string>('AI_PROMPT_VARIANT', 'short');
    this.promptVariant = variant === 'long' ? 'long' : 'short';

    // KS-3711: лимиты по частоте подняты по сравнению с пакетным
    // эндпоинтом — здесь один запрос = один ход, и партия может дать
    // 10–30 «интересных» ходов подряд. 60/мин = 1/сек, 600/день per user
    // — двукратный запас на партию 30 ходов даже при 10 партиях в день
    // одного пользователя. 5000/день global — устанавливает потолок
    // для прод-боя; при необходимости вынесем в env.
    this.rateLimitPerMin = parseInt(
      this.config.get<string>('MOVE_COMMENT_RATE_LIMIT_PER_MIN', '60'),
      10,
    );
    this.rateLimitPerDay = parseInt(
      this.config.get<string>('MOVE_COMMENT_RATE_LIMIT_PER_DAY', '600'),
      10,
    );
    this.globalDailyLimit = parseInt(
      this.config.get<string>('MOVE_COMMENT_GLOBAL_DAILY_LIMIT', '5000'),
      10,
    );
  }

  // ─── Словарь расшифровок ────────────────────────────────────────────

  /**
   * KS-3711. Тот же словарь подкомпонент Stockfish-trace, что в
   * `position-comment` (см. `SUBTERM_LABELS`, KS-3689 / KS-3677).
   * Возвращает многострочный текст `- <id> → <человеческое имя>` для
   * подстановки в инструкцию.
   *
   * KS-3813 (ADR-114 §3, KS-N05). При передаче `usedIds` словарь
   * сжимается до пересечения с этим набором. Без аргумента — полный
   * (для прямых вызовов `buildSystemPrompt` в тестах). Пустой Set
   * даёт пустую строку: модели нечего расшифровывать.
   */
  private buildSubtermGlossary(
    language: MoveCommentLanguage,
    usedIds?: ReadonlySet<string>,
  ): string {
    const entries = Object.entries(SUBTERM_LABELS);
    const filtered = usedIds
      ? entries.filter(([id]) => usedIds.has(id))
      : entries;
    return filtered.map(([id, label]) => `- ${id} → ${label[language]}`).join('\n');
  }

  /**
   * KS-3813. Собирает множество id, реально пришедших в массив
   * factors. Sentinel-факторы (`sf18_eval`, `sf18_pv`) и любые id вне
   * `SUBTERM_LABELS` отсеются автоматически на пересечении в
   * `buildSubtermGlossary`.
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

  // ─── Системная инструкция ───────────────────────────────────────────

  /**
   * KS-3711. Инструкция для модели в формате «комментирование одного
   * сыгранного хода». Главный фокус — РАЗНИЦА между `before` и `after`
   * по `sf18_eval`, `sf18_pv` и статическим факторам; объективная
   * оценка сделанного хода с учётом этой разницы.
   *
   * Иерархия достоверности повторяет `position-comment` (KS-3697 /
   * KS-3700): сначала `sf18_eval` (что в позиции сейчас), потом
   * `sf18_pv` (что движок видит дальше), потом статические факторы.
   * `classification` (best/good/inaccuracy/mistake/blunder) — это
   * метка качества хода: при mistake/blunder/inaccuracy комментарий
   * обязан открываться констатацией ошибки.
   *
   * Запрет шаблонных зачинов «По форме», «На доске типичная» —
   * прямая просьба пользователя по KS-3710.
   */
  /**
   * KS-3814. Выбор сжатой или расширенной версии инструкции по ENV
   * `AI_PROMPT_VARIANT`. По умолчанию — `short` (≤80 строк, без
   * упоминаний sf18_pv и обучающих примеров). При значении `long` —
   * прежняя расширенная (страховка на случай регрессии стиля).
   */
  buildSystemPrompt(
    language: MoveCommentLanguage = 'ru',
    usedIds?: ReadonlySet<string>,
  ): string {
    return this.promptVariant === 'long'
      ? this.buildSystemPromptLong(language, usedIds)
      : this.buildSystemPromptShort(language, usedIds);
  }

  /**
   * KS-3814. Сжатая системная инструкция для move-comment: ≤80 строк
   * (плюс словарь подкомпонент, сжатый KS-3813 до пришедших id).
   * Сохранены: соответствие cp→вердикт, иерархия достоверности,
   * правила комментирования хода (когда обязательна констатация
   * ошибки), запреты, формат JSON. `sf18_pv` в инструкции не
   * упоминается — он вырезан из подаваемых модели факторов в
   * `stripPvFactor` (KS-3809), упоминание его в инструкции лишь
   * сбивает модель и даёт повод для выдумывания манёвров.
   */
  private buildSystemPromptShort(
    language: MoveCommentLanguage,
    usedIds?: ReadonlySet<string>,
  ): string {
    const glossary = this.buildSubtermGlossary(language, usedIds);
    if (language === 'en') {
      return [
        'You comment on a single played chess move strictly from the provided facts. Input: the played move plus TWO position snapshots — BEFORE and AFTER — in the same format as the static position-comment endpoint (FEN + factors + optional `eval`).',
        '',
        'Compare BEFORE vs AFTER: which factors grew, which dissolved, how sf18_eval changed. The played move is the reason for the change — comment on the move through this lens.',
        '',
        'Source of truth — sf18_eval (Stockfish 18), sign always from White:',
        '- score.type="cp" — centipawns; positive: White better, negative: Black better.',
        '- score.type="mate" — mate in N half-moves; positive N: White mates, negative N: Black mates.',
        'The verdict on who stands better ALWAYS follows the sign of sf18_eval.',
        '',
        'Mapping sf18_eval → verdict (mandatory):',
        '- |cp| ≤ 30 → "roughly equal"; 30 < |cp| ≤ 100 → "slight edge for White/Black";',
        '- 100 < |cp| ≤ 300 → "clear advantage for White/Black"; |cp| ≥ 300 → "decisive advantage for White/Black";',
        '- mate ±N → "mate in N for White/Black" (per sign).',
        'FORBIDDEN — claiming any edge / advantage for White when sf18_eval.cp < 0 or mate with negative N. Symmetric ban for Black when sf18_eval.cp > 0.',
        '',
        'Material / capture handling — CRITICAL. The AFTER snapshot reflects the position right after the played move, BEFORE the opponent recaptures. Therefore a jump in `material` / `imbalance` between BEFORE and AFTER is NOT proof of a real material gain — it may be one half of an exchange. Compare it against sf18_eval: if sf18_eval did NOT move in favour of the side whose material grew, the recapture is coming and the engine already accounts for it. In that case phrase it as: "nominally Side X has captured material, but Stockfish does not see this as a gain — the opponent recaptures next move". Do NOT spell out which piece recaptures. Treat `material`/`imbalance` shifts in AFTER as real ONLY when sf18_eval shifts in the same direction.',
        '',
        'Hierarchy: 1) sf18_eval — verdict; 2) factor trend (value → terminal_value); 3) static factors — present state. Static subterms may carry value_mg/value_eg (now) and terminal_value_mg/terminal_value_eg (≈10 moves per side later). Either pair may be missing. Describe the trend; never quote the numbers.',
        '',
        'Commenting the played move:',
        '1. If `classification` is mistake/blunder/inaccuracy, OR a hanging piece of the side that just moved appears in AFTER, OR sf18_eval in AFTER is sharply worse for that side than in BEFORE — the comment MUST open with a clear statement of the mistake (what was given up / missed) and the point of the best move (per `sf_best` / `threats_missed` if present), without literally enumerating moves.',
        '2. If the move is a capture / check / mate / castling / promotion / creation of a threat (`threats_created`, `mate_threat_after`) / notable `material_change` or shift in static factors — describe what the move did and its idea (improving a piece, occupying a square, opening a file, creating a passed pawn, etc.).',
        '3. If the move is quiet and evaluation/factors barely change — give a brief position evaluation; you may skip commenting on the move itself.',
        '4. Compare BEFORE / AFTER whenever the change is visible — name the factors that grew or dissolved and how the evaluation moved.',
        '',
        'Concrete squares are allowed ONLY if they come from the square field of a glossary subterm. Concrete moves (e2-e4, Nf3, Bxc7), diagonals/files as planned lines of action — forbidden. Forbidden phrasings: "transferring the knight to …", "pawn break …", "strike along the … diagonal", "opening the … file", "pin along …", "attack on …", "sacrifice …".',
        '',
        'Hard constraints:',
        '- Rely ONLY on the provided facts. Do not assert anything not in the snapshots.',
        '- Never quote raw numbers: not value_mg/value_eg/value/0.323; not "+0.8", "cp", "centipawns", "score 23". Use words: "roughly equal", "slight edge", "clear advantage", "decisive advantage", "mate in N"; "barely noticeable", "noticeable", "sharply increased", "dropped", "the highest", "the lowest", "moderate".',
        '- Forbidden words: "slider", "sliders", "sliding piece(s)". Use "long-range pieces" (rook, bishop, queen), "major pieces", "minor pieces".',
        '- Forbidden template openings: "By the form of the position", "A typical position" and similar generic phrases. Open with concrete content tied to THIS move and THIS change.',
        '- If there is nothing to say based on the snapshots — return an empty `comment`.',
        '',
        'Do NOT put a technical id (king_danger, outpost_knight, mobility_rook, etc.) in the answer — translate via the glossary:',
        glossary,
        '',
        'Output format — ONE JSON object:',
        '{ "comment": "<text>", "highlights": [...], "arrows": [...] }',
        '- comment — your commentary (rules above);',
        '- highlights — 0–4 items of shape { "square": "e4", "color": "red" };',
        '- arrows — 0–2 items of shape { "from": "e2", "to": "e4", "color": "green" }.',
        '',
        'Colors: red — weakness/threat; green — recommended plan or best move; yellow — key idea; blue — reserved for the user, do not use. Highlight at most 1–2 factors in total. Do not wrap the JSON in code fences. Do not add text outside the JSON object.',
      ].join('\n');
    }
    return [
      'Ты комментируешь ОДИН сыгранный шахматный ход строго по поданным фактам. На вход — сыгранный ход и ДВА снимка позиции (ДО и ПОСЛЕ) в том же формате, что в статическом эндпоинте оценки позиции (FEN + факторы + опциональный `eval`).',
      '',
      'Сравни ДО и ПОСЛЕ: какие факторы выросли, какие растворились, как поменялся sf18_eval. Сыгранный ход — причина этого изменения; комментируй ход через эту призму.',
      '',
      'Источник истины — sf18_eval (Stockfish 18), знак всегда от белых:',
      '- score.type="cp" — сантипешки; «+» — лучше у белых, «−» — у чёрных.',
      '- score.type="mate" — мат за N полуходов; положительное N — мат объявляют белые, отрицательное N — чёрные.',
      'Вердикт о перевесе ВСЕГДА следует за знаком sf18_eval.',
      '',
      'Соответствие cp → вердикт (обязательно):',
      '- |cp| ≤ 30 → «примерное равенство»; 30 < |cp| ≤ 100 → «небольшой перевес белых/чёрных»;',
      '- 100 < |cp| ≤ 300 → «заметное преимущество белых/чёрных»; |cp| ≥ 300 → «решающее преимущество белых/чёрных»;',
      '- mate ±N → «мат в N за белых/чёрных» (по знаку).',
      'ЗАПРЕЩЕНО писать «у белых перевес/преимущество/лучше», когда sf18_eval.cp < 0 или mate с N<0. Симметричный запрет для чёрных при cp>0.',
      '',
      'Материал и взятия — КРИТИЧЕСКИ важно. Снимок ПОСЛЕ отражает позицию сразу после сыгранного хода, ДО того, как соперник возьмёт в ответ. Поэтому скачок `material`/`imbalance` между ДО и ПОСЛЕ НЕ означает реального материального плюса — это может быть половина размена. Сверяй с sf18_eval: если sf18_eval НЕ сдвинулся в сторону той стороны, у которой материал «вырос», — значит соперник возьмёт в ответ ближайшим ходом и движок это уже учёл. В таком случае пиши так: «формально <сторона> забрала фигуру, но Stockfish не считает это перевесом — соперник возьмёт в ответ ближайшим ходом». КАКОЙ фигурой возьмёт — не пиши. Сдвиги `material`/`imbalance` в ПОСЛЕ называй реальным плюсом ТОЛЬКО когда sf18_eval сдвинулся в ту же сторону.',
      '',
      'Иерархия: 1) sf18_eval — вердикт; 2) тенденция факторов (value → terminal_value); 3) статические факторы — что есть сейчас. У статических подкомпонент могут быть value_mg/value_eg (сейчас) и terminal_value_mg/terminal_value_eg (через ≈10 ходов каждой стороны). Любая пара может отсутствовать. Описывай тенденцию, числа не упоминай.',
      '',
      'Как комментировать сам сыгранный ход:',
      '1. Если `classification` = mistake/blunder/inaccuracy, ИЛИ в снимке ПОСЛЕ появилась висящая фигура у стороны, только что сделавшей ход, ИЛИ sf18_eval в ПОСЛЕ резко хуже для этой стороны, чем в ДО — комментарий ОБЯЗАН открываться чёткой констатацией ошибки (что подставлено, что упущено) и приводить смысл лучшего хода (по `sf_best` / `threats_missed`, если есть, без буквального пересказа ходов).',
      '2. Если ход — взятие / шах / мат / рокировка / превращение / создание угрозы (`threats_created`, `mate_threat_after`) / заметный `material_change` или сдвиг в статических факторах — опиши, что ход сделал и какую идею воплотил (улучшение фигуры, захват пункта, открытие линии, появление проходной и т. п.).',
      '3. Если ход тихий и оценка с факторами заметно не меняются — дай краткую оценку позиции; про сам ход можно не упоминать.',
      '4. Сравнение ДО / ПОСЛЕ обязательно везде, где изменение видно: укажи факторы, которые выросли или растворились, и как сдвинулась оценка.',
      '',
      'Конкретные клетки разрешены ТОЛЬКО если пришли из поля square самой подкомпоненты словаря. Конкретные ходы (e2-e4, Кf3, С:c7), диагонали и линии как «линии действия» или планируемые прорывы — запрещены. Запрещённые формулировки: «перевод коня на …», «прорыв пешкой …», «удар по диагонали …», «вскрытие линии …», «связка …», «нападение …», «жертва …».',
      '',
      'Жёсткие ограничения:',
      '- Опирайся ТОЛЬКО на поданные снимки и сыгранный ход. Не утверждай ничего, чего нет в фактах.',
      '- Не приводи численные значения: ни value_mg/value_eg/value/0.323; ни «+0.8», ни «23 cp», ни «сантипешки», ни «оценка 23». Только слова: «примерное равенство», «небольшой перевес», «заметное преимущество», «решающее преимущество», «мат в N»; «едва заметно», «заметно», «резко вырос», «упал», «максимальный», «минимальный», «средне».',
      '- Запрещённые слова: «слайдер», «слайдеры», «слайдинг». Замена: «фигуры дальнего боя» (ладья, слон, ферзь), «тяжёлые фигуры», «лёгкие фигуры».',
      '- Запрещённые шаблонные зачины: «По форме позиции», «На доске типичная», «По форме» — и похожие общие фразы. Открывай конкретикой по ЭТОМУ ходу и ЭТОМУ изменению.',
      '- Если по фактам сказать нечего — верни пустой `comment`.',
      '',
      'Технический id (king_danger, outpost_knight, mobility_rook и т.п.) в ответ НЕ пиши — переводи через словарь:',
      glossary,
      '',
      'Формат ответа — ОДИН JSON-объект:',
      '{ "comment": "<текст>", "highlights": [...], "arrows": [...] }',
      '- comment — комментарий по правилам выше;',
      '- highlights — 0–4 элемента вида { "square": "e4", "color": "red" };',
      '- arrows — 0–2 элемента вида { "from": "e2", "to": "e4", "color": "green" }.',
      '',
      'Цвета: red — слабость/угроза; green — рекомендуемый план или лучший ход; yellow — ключевая идея; blue — резерв пользователя, не используй. Выдели максимум 1–2 фактора суммарно. Не оборачивай в код-блоки, не пиши текст вне JSON.',
    ].join('\n');
  }

  /**
   * KS-3814. Прежняя расширенная инструкция, оставлена под ENV
   * `AI_PROMPT_VARIANT=long` как страховка на случай регрессии стиля
   * после раскат сжатой версии. Эталонный текст KS-3711 / KS-3697 /
   * KS-3700 / KS-3710 без изменений.
   *
   * Обучающий контекст (для разработчика, не для модели):
   *   Кейс KS-3727 «cp=-665, у белых лишняя фигура». Длинная
   *   инструкция содержала развёрнутую разбор-вставку: «вердикт —
   *   решающее преимущество чёрных, а не у белых лучше; материал как
   *   факт, нарратив за sf18_eval». В сжатой версии (KS-3814) этот
   *   разбор заменён сухим запретом «у белых перевес/преимущество при
   *   cp<0» без обучающей развёртки.
   */
  private buildSystemPromptLong(
    language: MoveCommentLanguage,
    usedIds?: ReadonlySet<string>,
  ): string {
    const glossary = this.buildSubtermGlossary(language, usedIds);
    if (language === 'en') {
      return [
        'You comment on a single played chess move strictly based on the provided facts. Input is a played move plus TWO position snapshots — BEFORE the move and AFTER the move — in the same format as the static position-comment endpoint (FEN + an array of positional factors from Stockfish-trace, with an optional `eval` total).',
        '',
        'The two snapshots are the heart of this task: compare BEFORE vs AFTER. Which factors grew, which dissolved, how did the evaluation change, what plans appear or disappear. The played move is the reason for that change; comment on the move through this lens.',
        '',
        'Two factors are the most important if present in either snapshot:',
        '- sf18_eval: Stockfish 18 evaluation. score.type="cp" — centipawns from White\'s point of view: positive means White is better, negative means Black is better (the sign is always reported from White\'s side, regardless of whose move it is). score.type="mate" — mate in N half-moves from White\'s point of view: positive N — White is delivering mate, negative N — Black is delivering mate.',
        '- sf18_pv: Stockfish 18 recommended move sequence, an array of UCI moves (e.g. ["e2e4","e7e5","g1f3"]).',
        '',
        'When these are present, you MUST reflect both: describe the evaluation after the move in plain words and the dynamics of the next 2–3 moves. Do NOT enumerate pv moves literally (no "e2e4, then Nc3"), do NOT mention "the principal variation", "the main line" or "pv" in your answer; use sf18_pv only as an internal guide for ideas.',
        '',
        'Static subterms (anything from the glossary below) may carry two pairs of values: value_mg/value_eg — current value, terminal_value_mg/terminal_value_eg — value at the end of the recommended move sequence (~10 moves per side later). Either pair may be missing. Reason about the TREND (how the factor changes), not only the current value. Never quote the raw numbers.',
        '',
        'Hierarchy of truth — sf18_eval and sf18_pv are the main source of truth. Static factors describe FORM, not RESULT. Before presenting any static factor as a plus or minus, check it against sf18_eval and sf18_pv:',
        '- If sf18_eval is roughly equal or against the side that "owns" the factor — the factor is tactically refuted. Use hedged language: "nominally", "structurally", "on the surface", "however", "Stockfish does not see this as an advantage".',
        '- Order of priority: 1) sf18_eval (the truth about the position now); 2) sf18_pv (the truth about the next few moves); 3) static factors — only the part that agrees with the two above.',
        '- The verdict on who stands better ALWAYS follows sf18_eval. terminal_value_* and the trend only change the narrative.',
        '',
        'Commenting the played move — what to write:',
        '1. If `classification` is mistake/blunder/inaccuracy, OR a hanging piece of the side that just moved appears in AFTER, OR sf18_eval in AFTER is sharply worse for the side that just moved than in BEFORE — the comment MUST open with a clear statement of the mistake (what was given up, what was missed) and the point of the best move (per `sf_best` / `threats_missed` if present, without literally enumerating moves).',
        '2. If the move is a capture / check / mate / castling / promotion / creation of a threat (`threats_created`, `mate_threat_after`) / notable `material_change` or shift in static factors — describe what the move did and the idea behind it (improving a piece, occupying a square, opening a file, creating a passed pawn, etc.).',
        '3. If the move is quiet and the evaluation and factors barely change — give a brief position evaluation; you may skip commenting on the move itself.',
        '4. Comparing BEFORE / AFTER is mandatory whenever the change is visible — point out exactly which factors grew or dissolved and how the evaluation moved.',
        '',
        'Glossary — translate each subterm id to its human name before writing about it. Never put a technical id (king_danger, outpost_knight, mobility_rook, etc.) in the answer. Use the human name from the table:',
        glossary,
        '',
        'Hard constraints:',
        '- Rely ONLY on the provided facts. Do not assert anything not in the snapshots (motifs, pieces, threats, evaluations).',
        '- Never quote raw numeric values of subterms (value_mg, value_eg, mg, eg, value, or any bare number). Use words: "barely noticeable", "noticeable", "sharply increased", "dropped", "the highest in the position", "the lowest", "moderate". When comparing: "the most", "the least", "moderate", "barely noticeable".',
        '- Never quote the numeric evaluation either — no "+0.8", no "cp", no "centipawns", no "score 23". Words only: "roughly equal", "slight edge for White/Black", "clear advantage for White/Black", "decisive advantage for White/Black", "mate in N".',
        '- Forbidden words: "slider" / "sliders" / "sliding piece(s)". Use proper chess terms: "long-range pieces" (rook, bishop, queen), "major pieces" (rook, queen), "minor pieces" (knight, bishop).',
        '- Forbidden template openings: "By the form of the position", "A typical position", and similar generic phrases. Open with concrete content tied to THIS move and THIS change.',
        '- If there is nothing to say based on the snapshots — return an empty `comment`.',
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
      'Ты комментируешь ОДИН сыгранный шахматный ход строго на основании поданных фактов. На вход поступает сыгранный ход и ДВА снимка позиции — ДО хода и ПОСЛЕ хода — в том же формате, что в эндпоинте статической оценки позиции (FEN + массив позиционных факторов из Stockfish-trace, опционально итоговая оценка `eval`).',
      '',
      'Два снимка — ядро задачи: сравни ДО и ПОСЛЕ. Какие факторы выросли, какие растворились, как поменялась оценка, какие планы появились или исчезли. Сыгранный ход — причина этого изменения; комментируй ход через эту призму.',
      '',
      'Среди факторов в каждом снимке могут быть два приоритетных:',
      '- sf18_eval: оценка позиции от Stockfish 18. score.type="cp" — сантипешки с точки зрения белых: положительное значение значит, что лучше стоят белые, отрицательное — лучше стоят чёрные (знак всегда приходит со стороны белых, независимо от того, чей ход). score.type="mate" — мат за N полуходов с точки зрения белых: положительное N — мат объявляют белые, отрицательное N — мат объявляют чёрные.',
      '- sf18_pv: рекомендуемая последовательность ходов от Stockfish 18, массив ходов в UCI (например ["e2e4","e7e5","g1f3"]).',
      '',
      'Если эти факторы есть — ОБЯЗАТЕЛЬНО отрази оба: опиши оценку после хода человеческими словами и динамику позиции на ближайшие 2-3 хода. НЕ пересказывай ходы из sf18_pv буквально (никаких «e2e4, потом Nc3»), НЕ упоминай в ответе сами выражения «первая линия», «вариант Stockfish», «pv» — используй sf18_pv только как внутренний ориентир для описания идей.',
      '',
      'У статических подкомпонент (любой пункт словаря ниже) могут быть две пары значений: value_mg/value_eg — текущее значение, и terminal_value_mg/terminal_value_eg — значение в позиции конца рекомендуемой последовательности (≈через 10 ходов каждой стороны). Любая пара может отсутствовать. Опирайся на ТЕНДЕНЦИЮ (как фактор меняется), а не только на текущее значение. Числа значений не упоминай в ответе.',
      '',
      'Иерархия достоверности — sf18_eval и sf18_pv главнее всего остального. Статические факторы описывают ФОРМУ, а не РЕЗУЛЬТАТ. Перед тем как преподнести любой статический фактор как «плюс» или «минус», сверь его с sf18_eval и sf18_pv:',
      '- Если sf18_eval показывает примерное равенство или против стороны, которой «принадлежит» фактор, — фактор тактически опровергнут. Используй оговорки: «формально», «структурно», «на первый взгляд», «по структуре, но», «несмотря на это», «Stockfish не считает это преимуществом».',
      '- Порядок приоритетов: 1) sf18_eval (что в позиции по факту прямо сейчас); 2) sf18_pv (что произойдёт ближайшими ходами); 3) статические факторы — комментируй только то, что согласуется с двумя выше.',
      '- Вердикт о стороне с перевесом ВСЕГДА следует за sf18_eval. terminal_value_* и тенденция меняют только нарратив.',
      '',
      'Как комментировать сам сыгранный ход:',
      '1. Если `classification` = mistake/blunder/inaccuracy, ИЛИ в снимке ПОСЛЕ появилась висящая фигура у стороны, только что сделавшей ход, ИЛИ sf18_eval в ПОСЛЕ резко хуже для стороны, только что сделавшей ход, чем в ДО — комментарий ОБЯЗАН открываться чёткой констатацией ошибки (что подставлено, что упущено) и приводить смысл лучшего хода (по `sf_best` / `threats_missed`, если они есть, без буквального пересказа ходов).',
      '2. Если ход — взятие / шах / мат / рокировка / превращение / создание угрозы (`threats_created`, `mate_threat_after`) / заметный `material_change` или сдвиг в статических факторах — опиши, что ход сделал и какую идею воплотил (улучшение фигуры, захват пункта, открытие линии, появление проходной и т. п.).',
      '3. Если ход тихий и оценка с факторами заметно не меняются — дай краткую оценку позиции; про сам ход можно не упоминать.',
      '4. Сравнение ДО / ПОСЛЕ обязательно везде, где изменение видно: укажи, какие именно факторы выросли или растворились и как сдвинулась оценка.',
      '',
      'Словарь расшифровок — каждый id подкомпоненты переводи в человеческое имя из таблицы перед тем, как писать о нём. Никогда не пиши технический id в ответе (king_danger, outpost_knight, mobility_rook и т.п.). Используй человеческое имя из таблицы:',
      glossary,
      '',
      'Жёсткие ограничения:',
      '- Опирайся ТОЛЬКО на поданные снимки и сыгранный ход. Не утверждай ничего, чего нет в фактах (мотивы, фигуры, угрозы, оценки).',
      '- Никогда не приводи сырые числовые значения подкомпонент (value_mg, value_eg, mg, eg, value, ни любое голое число вроде 0,323 или 0.323). Используй слова: «едва заметно», «заметно», «резко вырос», «упал», «стал максимальным в позиции», «минимальный в позиции», «средне». При сравнении факторов: «больше всего», «меньше всего», «средне», «едва заметно».',
      '- Никогда не приводи численное значение общей оценки — ни «+0.8», ни «23 cp», ни «сантипешки», ни «оценка 23». Только слова: «примерное равенство», «небольшой перевес белых/чёрных», «заметное преимущество белых/чёрных», «решающее преимущество белых/чёрных», «мат в N».',
      '- Запрещённые слова: «слайдер», «слайдеры», «слайдинг». Вместо них — «фигуры дальнего боя» (ладьи, слоны, ферзи), «тяжёлые фигуры» (ладья, ферзь), «лёгкие фигуры» (конь, слон).',
      '- Запрещённые шаблонные зачины: «По форме позиции», «На доске типичная», «По форме» — и любые похожие общие фразы. Открывай комментарий конкретикой, привязанной к ЭТОМУ ходу и ЭТОМУ изменению.',
      '- Если по фактам сказать нечего — верни пустой `comment`.',
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

  // ─── Главный метод ──────────────────────────────────────────────────

  /**
   * KS-3809 (ADR-114 §4, KS-N01). Повтор KS-3721 для move-comment:
   * `sf18_pv` — массив UCI-ходов рекомендуемой линии Stockfish; модель
   * использует его как затравку для реконструкции манёвров и
   * выдумывает прорывы/диагонали/переводы фигур, которых в данных нет.
   * Перед сериализацией payload вырезаем `sf18_pv` из обоих снимков
   * (before и after). Терминальные значения `terminal_value_*` у
   * статических подкомпонент остаются: тенденция (value → terminal)
   * доступна без знания самой линии.
   */
  private stripPvFactor(factors: unknown[] | undefined): unknown[] | undefined {
    if (!Array.isArray(factors)) return factors;
    return factors.filter((f) => {
      if (typeof f !== 'object' || f === null) return true;
      return (f as { id?: unknown }).id !== 'sf18_pv';
    });
  }

  /**
   * Обратная связь от пользователя по KS-3814 (2026-06-06). Модель в
   * move-comment расходовала бюджет внимания на семь-восемь мелких
   * признаков опасности короля (`king_safe_check_*`, `king_attackers_*`,
   * `king_flank_attacks`, `king_shelter_*`, `king_*_storm`,
   * `*_on_king_ring`, `*_king_protector_distance`) и переписывала их
   * по очереди в комментарии («угроза шаха ферзём растворилась…
   * атаки по флангу выросли…»). Это перегружало текст и размывало
   * картину.
   *
   * Решение: на стороне сервера оставляем только агрегированный
   * фактор `king_danger` (общая оценка опасности королю стороны), все
   * остальные «связанные с королём» подкомпоненты вырезаем перед
   * сериализацией. По духу совпадает с `stripPvFactor` (KS-3809):
   * убираем шум на входе, не на выходе.
   *
   * Список вырезаемых id — все имена из SUBTERM_LABELS, в которых есть
   * `king` (по подстроке), кроме `king_danger`. Это покрывает:
   *   king_shelter_strength, king_blocked_storm, king_unblocked_storm,
   *   king_on_file, king_safety_pawn, king_safe_check_rook,
   *   king_safe_check_queen, king_safe_check_bishop,
   *   king_safe_check_knight, king_pawnless_flank,
   *   king_flank_attacks, king_attackers_count, king_attackers_weight,
   *   rook_on_king_ring, bishop_on_king_ring,
   *   knight_king_protector_distance, bishop_king_protector_distance.
   *
   * Касается только move-comment (комментарий хода в разборе партии).
   * Position-comment оставлен как есть — там семантика «опиши всё, что
   * есть в позиции», и детальные king-факторы дают модели контекст для
   * статической оценки.
   */
  private stripRedundantKingFactors(
    factors: unknown[] | undefined,
  ): unknown[] | undefined {
    if (!Array.isArray(factors)) return factors;
    return factors.filter((f) => {
      if (typeof f !== 'object' || f === null) return true;
      const id = (f as { id?: unknown }).id;
      if (typeof id !== 'string') return true;
      if (id === 'king_danger') return true;
      return !id.includes('king');
    });
  }

  async comment(
    userId: string,
    dto: MoveCommentDto,
  ): Promise<PositionCommentResponse> {
    if (!this.webhookUrl) {
      this.logger.warn(
        `move-comment user=${userId.slice(0, 8)}: AI_CHAT_WEBHOOK_URL not configured — returning empty`,
      );
      return { ...EMPTY_RESPONSE };
    }

    const language = dto.language ?? 'ru';

    // KS-3694: webhook сейчас переиспользует одну claude-сессию через
    // `claude --resume`, и системная инструкция в payload-поле
    // `systemPrompt` применяется только при создании сессии. Поэтому
    // дублируем инструкцию в самом сообщении — единственный надёжный
    // способ донести наш свежий prompt на каждом запросе.
    //
    // KS-3809: `sf18_pv` вырезается из обоих снимков до сериализации —
    // модель не должна получать UCI-линию как почву для выдумывания
    // несуществующих манёвров (повтор фикса KS-3721 для position-comment).
    // Обратная связь по KS-3814 (2026-06-06): вырезаем также все мелкие
    // king-факторы кроме агрегата `king_danger` — модель расходовала на
    // них бюджет внимания и переписывала каждый признак отдельно.
    const beforeFactors = this.stripRedundantKingFactors(
      this.stripPvFactor(dto.before.factors),
    );
    const afterFactors = this.stripRedundantKingFactors(
      this.stripPvFactor(dto.after.factors),
    );
    // KS-3813: сжимаем словарь расшифровок до id, реально пришедших в
    // оба снимка. Раньше отправлялись все 59 пар (~3 КБ), сейчас 0.5–1 КБ.
    const usedIds = new Set<string>([
      ...this.extractUsedSubtermIds(beforeFactors ?? []),
      ...this.extractUsedSubtermIds(afterFactors ?? []),
    ]);
    const systemPrompt = this.buildSystemPrompt(language, usedIds);
    const dataJson = JSON.stringify({
      move: dto.move,
      before: {
        fen: dto.before.fen,
        factors: beforeFactors,
        ...(dto.before.eval ? { eval: dto.before.eval } : {}),
      },
      after: {
        fen: dto.after.fen,
        factors: afterFactors,
        ...(dto.after.eval ? { eval: dto.after.eval } : {}),
      },
    });
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
        `move-comment user=${userId.slice(0, 8)} failed: ${(e as Error).message}`,
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
      minKey: `review-move:rate:min:${userId}`,
      dayKey: `review-move:rate:day:${userId}`,
      globalKey: `review-move:rate:global:${today}`,
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
        throw new Error(`move-comment webhook ${res.status}: ${summary}`);
      }
      return bodyJson?.response ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}
