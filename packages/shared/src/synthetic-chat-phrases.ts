/**
 * KS-2168 (ADR-034 §7, Q6 = A). Словарь триггер-фраз для
 * `SyntheticChatService`. Без LLM, простые правила.
 *
 * Импортируется в `apps/game-service/src/chat/synthetic-chat.service.ts`.
 * Можно перебить через env `SYNTHETIC_CHAT_PHRASES_OVERRIDE_JSON`,
 * но дефолты ниже — стартовый конфиг.
 */

export type SyntheticChatLang = 'en' | 'ru';

export interface TriggerRule {
  /**
   * Входные ключевые слова. Match — case-insensitive,
   * `text.toLowerCase().includes(trigger.toLowerCase())`. Достаточно одного
   * совпадения чтобы правило сработало.
   */
  triggers: readonly string[];
  /**
   * Возможные ответы. Случайно выбирается один.
   */
  replies: readonly { text: string; lang: SyntheticChatLang }[];
  /**
   * Правило применимо ТОЛЬКО до конца партии. По умолчанию `true`
   * (применимо в любой момент). Установить `false` для триггеров
   * вроде «oops» — они не имеют смысла после результата.
   */
  applicableAfterEnd?: boolean;
  /**
   * Min/max задержка перед отправкой ответа в мс (см. ADR §7).
   * Обычные триггеры: 200–800 мс.
   */
  delayMinMs: number;
  delayMaxMs: number;
}

/**
 * Дефолтные правила. Триггеры — лоуэркейс, без знаков препинания
 * (matcher тоже нормализует).
 */
export const DEFAULT_TRIGGER_RULES: readonly TriggerRule[] = [
  // Greetings
  {
    triggers: ['hi', 'hello', 'hey', 'привет'],
    replies: [
      { text: 'hi', lang: 'en' },
      { text: 'hello', lang: 'en' },
      { text: 'hey there', lang: 'en' },
      { text: 'привет', lang: 'ru' },
    ],
    delayMinMs: 200,
    delayMaxMs: 800,
  },
  // gl/hf
  {
    triggers: ['glhf', 'hf', 'gl '],
    replies: [
      { text: 'glhf', lang: 'en' },
      { text: 'gl', lang: 'en' },
      { text: 'hf', lang: 'en' },
    ],
    delayMinMs: 200,
    delayMaxMs: 800,
  },
  // gg/wp/nice
  {
    triggers: ['gg', 'wp', 'nice'],
    replies: [
      { text: 'gg', lang: 'en' },
      { text: 'wp', lang: 'en' },
      { text: 'thx', lang: 'en' },
    ],
    delayMinMs: 200,
    delayMaxMs: 800,
  },
  // thanks
  {
    triggers: ['thanks', 'thx', 'спасибо'],
    replies: [
      { text: 'np', lang: 'en' },
      { text: 'welcome', lang: 'en' },
      { text: 'пожалуйста', lang: 'ru' },
    ],
    delayMinMs: 200,
    delayMaxMs: 800,
  },
  // oops/blunder/noo — только в активной партии
  {
    triggers: ['oops', 'blunder', 'noo'],
    replies: [
      { text: ':(', lang: 'en' },
      { text: 'lol', lang: 'en' },
      { text: 'oof', lang: 'en' },
    ],
    applicableAfterEnd: false,
    delayMinMs: 200,
    delayMaxMs: 800,
  },
];

/**
 * Спонтанные фразы в начале партии (после хода 1 от живого).
 */
export const SPONTANEOUS_OPENING_PHRASES: readonly { text: string; lang: SyntheticChatLang }[] = [
  { text: 'glhf', lang: 'en' },
  { text: 'gl', lang: 'en' },
  { text: 'hf', lang: 'en' },
  { text: 'hi', lang: 'en' },
  { text: 'привет', lang: 'ru' },
];

/**
 * Спонтанные фразы в конце партии (после результата).
 */
export const SPONTANEOUS_CLOSING_PHRASES: readonly { text: string; lang: SyntheticChatLang }[] = [
  { text: 'gg', lang: 'en' },
  { text: 'wp', lang: 'en' },
  { text: 'thx', lang: 'en' },
  { text: 'спасибо', lang: 'ru' },
  { text: 'хорошая партия', lang: 'ru' },
];

/**
 * Параметры по умолчанию.
 */
export const SYNTHETIC_CHAT_DEFAULTS = {
  /** Cooldown между двумя сообщениями synthetic'а в одной партии. */
  cooldownMs: 60_000,
  /** Cap сообщений synthetic'а за партию. */
  perGameCap: 5,
  /** Спонтанная фраза в начале — вероятность. */
  spontaneousOpeningProb: 0.1,
  /** Задержка спонтанной opening-фразы. */
  spontaneousOpeningDelayMinMs: 500,
  spontaneousOpeningDelayMaxMs: 2_000,
  /** Спонтанная фраза в конце — вероятность. */
  spontaneousClosingProb: 0.5,
  spontaneousClosingDelayMinMs: 1_000,
  spontaneousClosingDelayMaxMs: 3_000,
} as const;

/**
 * Country-коды, на которые включается русский приоритет.
 */
export const RUSSIAN_COUNTRY_CODES: ReadonlySet<string> = new Set(['RU', 'UA']);

const CYRILLIC_RE = /[Ѐ-ӿ]/;

export function looksLikeRussianText(text: string): boolean {
  return CYRILLIC_RE.test(text);
}

/**
 * Определяет какой язык ответа предпочтителен.
 *   - Если synthetic country ∈ RUSSIAN_COUNTRY_CODES И входящее сообщение
 *     содержит кириллицу → 'ru'.
 *   - Иначе → 'en'.
 */
export function preferredLang(
  syntheticCountry: string | null | undefined,
  incomingText: string,
): SyntheticChatLang {
  if (
    syntheticCountry &&
    RUSSIAN_COUNTRY_CODES.has(syntheticCountry.toUpperCase()) &&
    looksLikeRussianText(incomingText)
  ) {
    return 'ru';
  }
  return 'en';
}

/**
 * Pure: ищет применимое правило по тексту. Возвращает первое подходящее
 * (в порядке `DEFAULT_TRIGGER_RULES`).
 */
export function matchTriggerRule(
  text: string,
  rules: readonly TriggerRule[] = DEFAULT_TRIGGER_RULES,
  isAfterEnd: boolean = false,
): TriggerRule | null {
  const normalized = text.toLowerCase();
  for (const rule of rules) {
    if (isAfterEnd && rule.applicableAfterEnd === false) continue;
    for (const trigger of rule.triggers) {
      if (normalized.includes(trigger.toLowerCase())) return rule;
    }
  }
  return null;
}

/**
 * Pure: выбирает один из replies, отдавая предпочтение нужному языку.
 * Если в нужном языке ответов нет — fallback на любой.
 */
export function pickReplyForLang(
  rule: TriggerRule,
  lang: SyntheticChatLang,
  rng: () => number = Math.random,
): string {
  const matching = rule.replies.filter((r) => r.lang === lang);
  const pool = matching.length > 0 ? matching : rule.replies;
  return pool[Math.floor(rng() * pool.length)].text;
}
