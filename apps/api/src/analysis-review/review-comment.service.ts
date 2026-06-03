/**
 * KS-3615 / ADR-102 §8 B-этап (MVP-1) + KS-3625 / ADR-103 rev 3
 * §7/§8 (MVP-2 B1'). Backend-сервис LLM-комментариев к ходам.
 *
 * Flow:
 *  - контроллер собирает batch фактов от фронта (вместе с готовыми
 *    `positional_shifts` от WASM SF 16 на клиенте — ADR-103 rev 3);
 *  - строит системный prompt (V1 или V2 — по ENV `REVIEW_COMMENT_V2`);
 *  - шлёт в тот же webhook что и AI Assistant (`AI_CHAT_WEBHOOK_URL`);
 *  - парсит JSON-массив строк;
 *  - применяет post-валидацию (NAG-blacklist + min-length);
 *  - возвращает comments.
 *
 * Сервис stateless: серверного Stockfish нет (отменён в rev 3 — eval
 * полностью уехал на клиент). Все факты, включая позиционные ярлыки,
 * приходят готовыми с фронта и сериализуются в prompt как есть.
 *
 * Graceful degradation (ADR-102 §4.2 «Дефолты»): webhook down, парсинг
 * сломался, длина не сошлась — отдаём массив пустых строк той же длины.
 * Фронт (KS-3616 C) понимает: дубль создан, комментариев нет.
 *
 * Post-валидация активна в ОБЕИХ ветках (V1 и V2): даже на старом
 * prompt'е резать NAG-тавтологии в любом случае (ADR-103 §8.3).
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
  /** ADR-103 §10.1 — ENV-флаг V2. */
  private readonly v2Enabled: boolean;
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
    const v2Raw = this.config
      .get<string>('REVIEW_COMMENT_V2', 'off')
      .toLowerCase();
    this.v2Enabled = v2Raw === 'on' || v2Raw === 'true' || v2Raw === '1';
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

  isV2Enabled(): boolean {
    return this.v2Enabled;
  }

  /**
   * KS-3651 / ADR-107 rev 2 §6. Отбрасывает `positional_subterms[]`
   * с неизвестными `id` (не в `KNOWN_SUBTERM_IDS`) и логирует WARN
   * с агрегатом. Это терпимое поведение для случая когда фронт-форк
   * (KS-3650 / KS-3648) опередил бэк по списку идентификаторов
   * (новые subterm добавились в WASM SF до синхронизации с
   * `PositionalSubtermId` в shared).
   *
   * Возвращает новый массив фактов с отфильтрованными subterms;
   * остальные поля каждого факта не трогает.
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

    // ADR-103 rev 3: positional_shifts приходят готовыми с фронта
    // (WASM SF 16). Бэк ничего не дозаполняет — факты идут в prompt
    // как есть.

    if (!this.webhookUrl) {
      this.logger.warn(
        `batchComment user=${userId.slice(0, 8)} n=${n}: ` +
          `AI_CHAT_WEBHOOK_URL not configured — returning ${n} empty comments`,
      );
      return new Array(n).fill('');
    }

    const systemPrompt = this.buildSystemPrompt(dto.language, dto.userElo);
    // KS-3651 / ADR-107 rev 2: prune unknown positional_subterms перед
    // отправкой в LLM. DTO принимает любой `id` (не whitelist),
    // фронт-форк может опередить бэк по списку ID — отбрасываем
    // unknown с WARN, чтобы prompt не содержал мусорных идентификаторов.
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

  // ─── Промпт ─────────────────────────────────────────────────────────

  /**
   * Маршрутизатор V1/V2. V2 включается ENV `REVIEW_COMMENT_V2=on`
   * (ADR-103 §10.1).
   *
   * Метод public — чтобы spec мог проверить содержимое в обоих режимах.
   */
  buildSystemPrompt(language: 'en' | 'ru', userElo: number): string {
    return this.v2Enabled
      ? this.buildSystemPromptV2(language, userElo)
      : this.buildSystemPromptV1(language, userElo);
  }

  // ─── V1 prompt (MVP-1, ADR-102 §5) ──────────────────────────────────

  private buildSystemPromptV1(language: 'en' | 'ru', userElo: number): string {
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

  // ─── V2 prompt (ADR-103 rev 3 §7.1) ─────────────────────────────────

  /**
   * ADR-103 rev 3 §7.1. Системный prompt V2:
   *  - Запрет NAG-тавтологии (явный список фраз RU и EN).
   *  - Требование объяснять причину (что выигрывает / теряет / создаёт).
   *  - Лимит 15–60 слов на комментарий.
   *  - 8 few-shot пар «ПЛОХО / ХОРОШО».
   *  - Калибровка по ELO (<1500 / 1500-2000 / ≥2000).
   *
   * Few-shot блок выдаётся на обоих языках, ведущий — `language`. Это
   * мягкая подсказка — формальный язык ответа задан в верхней строке.
   */
  private buildSystemPromptV2(language: 'en' | 'ru', userElo: number): string {
    const eloHint =
      userElo < 1500
        ? language === 'ru'
          ? 'Простые слова: «теряет ферзя», «вилка на короля и ладью», «король под боем», «защищён конём, можно брать».'
          : 'Simple words: "loses the queen", "fork on king and rook", "king is exposed", "defended by knight — fine to take".'
        : userElo >= 2000
          ? language === 'ru'
            ? 'Позиционные термины: «изолированная пешка», «слабый комплекс», «активность фигур», «жертва качества», «структурный перевес».'
            : 'Positional terms: "isolated pawn", "weak square complex", "piece activity", "exchange sacrifice", "structural advantage".'
          : language === 'ru'
            ? 'Средний уровень: «инициатива», «темп», «упускает компенсацию», «связка», «открытая линия для ладьи».'
            : 'Intermediate level: "initiative", "tempo", "loses compensation", "pin", "open file for the rook".';

    const head = [
      language === 'ru'
        ? 'Ты — шахматный тренер. Комментируешь ходы конкретного учащегося.'
        : 'You are a chess coach commenting moves for a specific learner.',
      `User language: ${language}.`,
      `User ELO: ${userElo}.`,
      `${eloHint}`,
      '',
      language === 'ru'
        ? 'ВХОД: JSON-массив фактов о ходах. Каждый факт — один полуход.'
        : 'INPUT: JSON array of facts about moves. Each fact = one half-move.',
      language === 'ru'
        ? 'ВЫХОД: JSON-массив строк той же длины, в том же порядке.'
        : 'OUTPUT: JSON array of strings of the same length, in the same order.',
      '',
      language === 'ru' ? 'ТРЕБОВАНИЯ:' : 'REQUIREMENTS:',
      language === 'ru'
        ? '- 1–2 предложения, 15–60 слов на комментарий.'
        : '- 1–2 sentences, 15–60 words per comment.',
      language === 'ru'
        ? '- Объясняй ПРИЧИНУ: что выигрывает / теряет / какую угрозу создаёт / какой мотив реализован.'
        : '- Explain the REASON: what gains / loses / threat created / motif realized.',
      language === 'ru'
        ? '- Поле positional_shifts — список ярлыков сдвига позиционной оценки (king_safer, mobility_decreased, bishop_passive и т.д.). Если непуст — упомяни ярлык(и) человеческим языком, БЕЗ слова «оценка» и без цифр.'
        : '- Field positional_shifts — labels of the positional shift (king_safer, mobility_decreased, bishop_passive, etc.). If non-empty — mention them in human words, WITHOUT the word "evaluation" or numbers.',
      language === 'ru'
        ? '- Поле positional_subterms — список конкретных позиционных подкомпонент Stockfish с привязкой к квадрату/фигуре (bishop_pawns, outpost_knight, rook_on_open_file, pawn_isolated, threat_by_minor, passed_rank, king_shelter_strength и др.). Используй ИХ для глубоких структурных объяснений: например «плохой слон h2 — пешки на белых полях стоят стеной», «конь на форпосте d5», «открытая линия для ладьи e», «отсталая пешка d6». Имена subterm — внутренние, в текст КОММЕНТАРИЯ их НЕ копируй (пиши человеческими словами).'
        : '- Field positional_subterms — list of concrete Stockfish positional subterms with squares/pieces (bishop_pawns, outpost_knight, rook_on_open_file, pawn_isolated, threat_by_minor, passed_rank, king_shelter_strength etc.). Use them for deep structural explanations: e.g. "bad bishop on h2 with pawns locking the diagonal", "knight on the d5 outpost", "rook on the open e-file", "backward pawn on d6". Subterm names are internal — do NOT copy them verbatim; translate into human chess words.',
      language === 'ru'
        ? '- Дедупликация: если та же фигура/мотив уже описан через tactical_motifs (более сильный сигнал) или через positional_shifts (более грубый сдвиг) — НЕ дублируй её через positional_subterms. Subterms — фоновое уточнение, а не повтор.'
        : '- Deduplication: if the same piece/motif is already described via tactical_motifs (stronger signal) or positional_shifts (coarser shift) — do NOT duplicate via positional_subterms. Subterms are background detail, not repetition.',
      language === 'ru'
        ? '- hanging_piece: назови атакующую фигуру и есть ли защита. Если защищена — короткая оценка размена через net_material_if_taken.'
        : '- hanging_piece: name the attacker and whether it is defended. If defended — brief evaluation of the exchange via net_material_if_taken.',
      language === 'ru'
        ? '- tactical_motifs: назови мотив (вилка, связка, вскрытое нападение, задняя горизонталь, двойное нападение, связка по линии) и какие фигуры он атакует.'
        : '- tactical_motifs: name the motif (fork, pin, discovered attack, back rank, double attack, skewer) and which pieces it targets.',
      language === 'ru'
        ? '- threats_created: опиши угрозу (мат-в-N, выигрыш материала, цели атаки).'
        : '- threats_created: describe the threat (mate-in-N, material win, attack targets).',
      language === 'ru'
        ? '- threats_missed.wins_material: покажи правильный план через sf_best.line.'
        : '- threats_missed.wins_material: show the correct plan via sf_best.line.',
      '',
      language === 'ru' ? 'ЗАПРЕЩЕНО:' : 'FORBIDDEN:',
      language === 'ru'
        ? '- Дублировать NAG словами без объяснения. Фразы «сильный ход», «отличный ход», «лучший ход», «хороший ход», «слабый ход», «неточность», «ошибка», «грубая ошибка», «зевок» САМИ ПО СЕБЕ запрещены. Если не из чего собрать причину — верни пустую строку "".'
        : '- Echo the NAG without explanation. Phrases "strong move", "excellent move", "best move", "good move", "weak move", "inaccuracy", "mistake", "big mistake", "blunder" ALONE are forbidden. If there is nothing to build the reason from — return an empty string "".',
      language === 'ru'
        ? '- Выдумывать тактические мотивы, которых нет в tactical_motifs.'
        : '- Invent tactical motifs not present in tactical_motifs.',
      language === 'ru'
        ? '- Упоминать численные оценки движка, сантипешки, ELO.'
        : '- Mention numeric engine evaluations, centipawns, ELO.',
      language === 'ru'
        ? '- Давать общие советы («играй активнее», «развивай фигуры»).'
        : '- Give generic advice ("play actively", "develop pieces").',
      '',
    ].join('\n');

    const fewShotRu =
      `ПРИМЕРЫ (few-shot, ${language === 'ru' ? 'основной язык' : 'reference'}):` +
      `

Факты:
{ "move": { "san": "Nxe5", "capture": "p" }, "classification": "best",
  "tactical_motifs": ["fork"],
  "threats_created": { "targets": [{"piece":"q","square":"d7"},{"piece":"r","square":"f7"}] },
  "positional_shifts": ["threats_grew"] }
ПЛОХО: "Сильный ход."
ХОРОШО: "Конь забирает пешку и одновременно атакует ферзя и ладью — вилка с двойным выигрышем материала."

Факты:
{ "move": { "san": "Qd5" }, "classification": "blunder", "delta_e": -0.6,
  "hanging_piece": { "square":"d5","piece":"q","side":"white","attackers":[{"piece":"n","square":"f6"}],"defenders":[],"net_material_if_taken": -8 },
  "sf_best": { "san":"Qe2", "line":["Qe2","O-O","Nf3"] },
  "positional_shifts": ["material_lost"] }
ПЛОХО: "Грубая ошибка."
ХОРОШО: "Ферзь становится под удар коня f6 без защиты — теряется фигура. Спокойнее Qe2 с рокировкой."

Факты:
{ "move": { "san": "Bxf7+", "capture": "p", "check": true }, "classification": "good",
  "tactical_motifs": ["discovered_attack"],
  "threats_created": { "wins_material": {"piece":"q","square":"d8","net_value": 6} },
  "positional_shifts": ["threats_grew","king_exposed"] }
ПЛОХО: "Хороший ход."
ХОРОШО: "Жертва слона со вскрытым шахом — после взятия открывается ферзь и теряется на следующем ходу, король противника обнажён."

Факты:
{ "move": { "san": "h6" }, "classification": "inaccuracy", "delta_e": 0.15,
  "threats_missed": { "wins_material": {"piece":"p","square":"e4","net_value":1} },
  "sf_best": { "san":"Nxe4", "line":["Nxe4","Bxe4","d5"] },
  "positional_shifts": ["king_safer"] }
ПЛОХО: "Неточность."
ХОРОШО: "Профилактика короля, но пропущен Nxe4 с выигрышем центральной пешки."

Факты:
{ "move": { "san": "Rxd1" }, "classification": "good", "material_change": {"piece":"r","side":"white"},
  "tactical_motifs": [], "positional_shifts": ["mobility_decreased"] }
ПЛОХО: "Хорошо."
ХОРОШО: "Размен ладей упрощает позицию, но снижает подвижность фигур в эндшпиле."

Факты:
{ "move": { "san": "Kg1" }, "classification": "best",
  "tactical_motifs": ["back_rank_weak"], "positional_shifts": ["king_safer"] }
ПЛОХО: "Лучший ход."
ХОРОШО: "Король уходит с задней линии — иначе мат ладьёй после размена на e1."

Факты:
{ "move": { "san": "Bb5" }, "classification": "good",
  "tactical_motifs": ["pin"],
  "positional_shifts": ["bishop_more_active","mobility_increased"] }
ПЛОХО: "Хорошо."
ХОРОШО: "Слон связывает коня c6 с ферзём d8, заодно даёт белым активную фигуру и большую подвижность."

Факты:
{ "move": { "san": "Re1" }, "classification": "best",
  "tactical_motifs": [],
  "positional_shifts": ["rook_on_open_file","space_gained"] }
ПЛОХО: "Лучший ход."
ХОРОШО: "Ладья встаёт на открытую вертикаль e, белые забирают пространство в центре."

Факты:
{ "move": { "san": "Bd3" }, "classification": "inaccuracy",
  "positional_subterms": [
    {"id":"bishop_pawns","color":"w","square":"d3","value_mg":-0.07,"value_eg":-0.21},
    {"id":"bishop_king_protector_distance","color":"w","square":"d3","value_mg":-0.04,"value_eg":-0.05}
  ] }
ПЛОХО: "Неточность."
ХОРОШО: "Слон выходит на d3, но у белых много пешек на белых полях — фигура упирается в собственную структуру, в эндшпиле штраф растёт."

Факты:
{ "move": { "san": "Nd5" }, "classification": "best",
  "positional_subterms": [
    {"id":"outpost_knight","color":"w","square":"d5","value_mg":0.16,"value_eg":0.10},
    {"id":"knight_uncontested_outpost","color":"w","square":"d5","value_mg":0.06,"value_eg":0.04}
  ] }
ПЛОХО: "Сильный ход."
ХОРОШО: "Конь на d5 — неоспоримый форпост, чёрные пешки уже не смогут его прогнать."

Факты:
{ "move": { "san": "Re1" }, "classification": "best",
  "positional_subterms": [
    {"id":"rook_on_open_file","color":"w","square":"e1","value_mg":0.15,"value_eg":0.08},
    {"id":"rook_on_king_ring","color":"w","square":"e1","value_mg":0.05,"value_eg":0}
  ] }
ПЛОХО: "Лучший ход."
ХОРОШО: "Ладья встаёт на открытую e-линию, заодно направлена в сторону чёрного короля."

Факты:
{ "move": { "san": "g6" }, "classification": "inaccuracy",
  "positional_subterms": [
    {"id":"king_shelter_strength","color":"b","square":"g8","value_mg":-0.18,"value_eg":0},
    {"id":"king_flank_attacks","color":"b","square":"g8","value_mg":-0.27,"value_eg":0}
  ] }
ПЛОХО: "Неточность."
ХОРОШО: "Пешка g6 ослабляет щит короля и даёт белым давление по королевскому флангу."

Факты:
{ "move": { "san": "d5" }, "classification": "best",
  "positional_subterms": [
    {"id":"passed_rank","color":"w","square":"d5","value_mg":0.05,"value_eg":0.17},
    {"id":"passed_path_advance","color":"w","square":"d5","value_mg":0.18,"value_eg":0.18}
  ] }
ПЛОХО: "Лучший ход."
ХОРОШО: "Пешка d5 становится опасной проходной — путь к превращению пока свободен, эндшпиль будет тяжёлым для чёрных."
`;

    const fewShotEn = `EXAMPLES (few-shot):

Facts:
{ "move": { "san": "Nxe5", "capture": "p" }, "classification": "best",
  "tactical_motifs": ["fork"],
  "threats_created": { "targets": [{"piece":"q","square":"d7"},{"piece":"r","square":"f7"}] },
  "positional_shifts": ["threats_grew"] }
BAD: "Strong move."
GOOD: "The knight grabs the pawn and forks queen and rook at once, winning material on the next move."

Facts:
{ "move": { "san": "Qd5" }, "classification": "blunder", "delta_e": -0.6,
  "hanging_piece": { "square":"d5","piece":"q","side":"white","attackers":[{"piece":"n","square":"f6"}],"defenders":[],"net_material_if_taken": -8 },
  "sf_best": { "san":"Qe2", "line":["Qe2","O-O","Nf3"] },
  "positional_shifts": ["material_lost"] }
BAD: "Blunder."
GOOD: "The queen walks into Nxd5 with no defender and is lost. Quieter Qe2 followed by castling kept everything safe."

Facts:
{ "move": { "san": "Bxf7+", "capture": "p", "check": true }, "classification": "good",
  "tactical_motifs": ["discovered_attack"],
  "threats_created": { "wins_material": {"piece":"q","square":"d8","net_value": 6} },
  "positional_shifts": ["threats_grew","king_exposed"] }
BAD: "Good move."
GOOD: "Bishop sacrifice with a discovered check — once the king moves, the queen on d8 falls and the enemy king is left exposed."

Facts:
{ "move": { "san": "h6" }, "classification": "inaccuracy", "delta_e": 0.15,
  "threats_missed": { "wins_material": {"piece":"p","square":"e4","net_value":1} },
  "sf_best": { "san":"Nxe4", "line":["Nxe4","Bxe4","d5"] },
  "positional_shifts": ["king_safer"] }
BAD: "Inaccuracy."
GOOD: "A useful luft, but Nxe4 was free — Black missed a central pawn."

Facts:
{ "move": { "san": "Rxd1" }, "classification": "good", "material_change": {"piece":"r","side":"white"},
  "tactical_motifs": [], "positional_shifts": ["mobility_decreased"] }
BAD: "Good."
GOOD: "Trading rooks simplifies the game but the remaining pieces lose mobility in the endgame."

Facts:
{ "move": { "san": "Kg1" }, "classification": "best",
  "tactical_motifs": ["back_rank_weak"], "positional_shifts": ["king_safer"] }
BAD: "Best move."
GOOD: "The king steps off the back rank — otherwise Re1+ followed by mate becomes a real threat."

Facts:
{ "move": { "san": "Bb5" }, "classification": "good",
  "tactical_motifs": ["pin"],
  "positional_shifts": ["bishop_more_active","mobility_increased"] }
BAD: "Good."
GOOD: "Bishop pins the knight on c6 to the queen on d8 and at the same time becomes very active, opening lines for the rooks."

Facts:
{ "move": { "san": "Re1" }, "classification": "best",
  "tactical_motifs": [],
  "positional_shifts": ["rook_on_open_file","space_gained"] }
BAD: "Best move."
GOOD: "Rook claims the open e-file and White grabs central space, squeezing Black's pieces."

Facts:
{ "move": { "san": "Bd3" }, "classification": "inaccuracy",
  "positional_subterms": [
    {"id":"bishop_pawns","color":"w","square":"d3","value_mg":-0.07,"value_eg":-0.21},
    {"id":"bishop_king_protector_distance","color":"w","square":"d3","value_mg":-0.04,"value_eg":-0.05}
  ] }
BAD: "Inaccuracy."
GOOD: "The bishop comes to d3, but White has too many pawns on light squares — the piece bumps into its own structure, with the endgame penalty growing."

Facts:
{ "move": { "san": "Nd5" }, "classification": "best",
  "positional_subterms": [
    {"id":"outpost_knight","color":"w","square":"d5","value_mg":0.16,"value_eg":0.10},
    {"id":"knight_uncontested_outpost","color":"w","square":"d5","value_mg":0.06,"value_eg":0.04}
  ] }
BAD: "Strong move."
GOOD: "Knight lands on d5 — an uncontested outpost; Black's pawns can no longer chase it away."

Facts:
{ "move": { "san": "Re1" }, "classification": "best",
  "positional_subterms": [
    {"id":"rook_on_open_file","color":"w","square":"e1","value_mg":0.15,"value_eg":0.08},
    {"id":"rook_on_king_ring","color":"w","square":"e1","value_mg":0.05,"value_eg":0}
  ] }
BAD: "Best move."
GOOD: "The rook claims the open e-file, also aiming at the enemy king's zone."

Facts:
{ "move": { "san": "g6" }, "classification": "inaccuracy",
  "positional_subterms": [
    {"id":"king_shelter_strength","color":"b","square":"g8","value_mg":-0.18,"value_eg":0},
    {"id":"king_flank_attacks","color":"b","square":"g8","value_mg":-0.27,"value_eg":0}
  ] }
BAD: "Inaccuracy."
GOOD: "Pushing g6 weakens the king's shelter and hands White pressure along the kingside."

Facts:
{ "move": { "san": "d5" }, "classification": "best",
  "positional_subterms": [
    {"id":"passed_rank","color":"w","square":"d5","value_mg":0.05,"value_eg":0.17},
    {"id":"passed_path_advance","color":"w","square":"d5","value_mg":0.18,"value_eg":0.18}
  ] }
BAD: "Best move."
GOOD: "The d-pawn becomes a dangerous passer — the path to promotion is clear, and the endgame will be hard for Black."
`;

    // Подаём few-shot в первую очередь на языке ответа; противоположный
    // — как reference, помогает модели в смешанных ситуациях.
    const examples =
      language === 'ru' ? `${fewShotRu}\n---\n${fewShotEn}` : `${fewShotEn}\n---\n${fewShotRu}`;

    return `${head}${examples}`;
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

  // ─── Post-валидация (ADR-103 §8) ───────────────────────────────────

  /**
   * Применяется к успешно распарсенному массиву. Применяется ВСЕГДА —
   * NAG-тавтологии запрещены в любой ветке (ADR-103 §8.3).
   *
   *   1. Чёрный список NAG-тавтологий (RU + EN). Точное совпадение
   *      нормализованной строки → `''`.
   *   2. Минимум `minWords` (default 4) ИЛИ `minChars` (default 25).
   *      Иначе → `''`.
   *
   * Пустые строки на входе пропускаем как есть (валидно — модель сама
   * вернула пустоту, например на безфактовом ходу).
   *
   * Public для unit-тестов.
   */
  postValidate(comments: string[]): string[] {
    return comments.map((c) => this.validateOne(c));
  }

  private validateOne(comment: string): string {
    const raw = (comment ?? '').trim();
    if (raw === '') return '';

    // Нормализация для blacklist'а: lowercase, убрать пунктуацию края.
    const norm = raw.toLowerCase().replace(/[.!?,:;"'`«»\s]+$/u, '').trim();
    if (NAG_TAUTOLOGY_RU.test(norm) || NAG_TAUTOLOGY_EN.test(norm)) {
      return '';
    }

    // Min-length: считаем слова в исходной строке (по whitespace).
    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    if (wordCount < this.minWords && raw.length < this.minChars) {
      return '';
    }
    return raw;
  }
}

// ─── NAG-blacklist regexes (ADR-103 §8.1) ─────────────────────────────

/**
 * RU: одиночные фразы-тавтологии. Точное совпадение нормализованной
 * строки целиком.
 */
const NAG_TAUTOLOGY_RU =
  /^(сильный\s+ход|отличный\s+ход|лучший\s+ход|хороший\s+ход|слабый\s+ход|плохой\s+ход|ошибка|грубая\s+ошибка|зевок|неточность|хорошо)$/i;

const NAG_TAUTOLOGY_EN =
  /^(strong\s+move|excellent\s+move|best\s+move|good\s+move|weak\s+move|poor\s+move|mistake|big\s+mistake|blunder|inaccuracy|good)$/i;
