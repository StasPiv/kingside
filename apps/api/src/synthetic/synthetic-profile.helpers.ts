/**
 * KS-2162. Чистые helpers генерации synthetic-профилей. Все случайные
 * источники инжектируются (`rng()`), чтобы тесты могли детерминированно
 * проверить распределения и форматы.
 *
 * НЕ зависит от Prisma / S3 / fetch. Импортируется в `SyntheticProfileSeederService`
 * (который добавляет IO).
 */

import type { CountryCodeISO } from '@kingside/shared';

// ─── Distributions (Q9 / Q10) ─────────────────────────────────────────

/**
 * Распределение стран synthetic'ов (Q9). Сумма ровно 100.
 * `'others'` весит 32 — внутри него отдельный sub-mix Германия/Франция
 * /Польша/Украина/Турция + хвост ≤2%.
 */
export const COUNTRY_WEIGHTS: ReadonlyArray<{ code: string; weight: number }> = [
  { code: 'RU', weight: 30 },
  { code: 'US', weight: 20 },
  { code: 'IN', weight: 10 },
  { code: 'BR', weight: 8 },
  // others (сумма = 32):
  { code: 'DE', weight: 5 },
  { code: 'FR', weight: 4 },
  { code: 'PL', weight: 4 },
  { code: 'UA', weight: 4 },
  { code: 'TR', weight: 3 },
  // хвост — ровно 12 = 6 стран по 2.
  { code: 'ES', weight: 2 },
  { code: 'GB', weight: 2 },
  { code: 'CN', weight: 2 },
  { code: 'AR', weight: 2 },
  { code: 'IT', weight: 2 },
  { code: 'CA', weight: 2 },
];

export const COUNTRY_TOTAL_WEIGHT = COUNTRY_WEIGHTS.reduce(
  (s, c) => s + c.weight,
  0,
);

/**
 * Распределение base-рейтинга (Q10). Сумма = 100.
 * 600..2499, плотнее в 1000..1800.
 */
export const RATING_BAND_WEIGHTS: ReadonlyArray<{
  min: number;
  max: number;
  weight: number;
}> = [
  { min: 600, max: 999, weight: 8 },
  { min: 1000, max: 1299, weight: 22 },
  { min: 1300, max: 1599, weight: 28 },
  { min: 1600, max: 1899, weight: 25 },
  { min: 1900, max: 2199, weight: 12 },
  { min: 2200, max: 2499, weight: 5 },
];

// ─── Username dictionaries ────────────────────────────────────────────

/**
 * 50 английских прилагательных + 50 существительных. На 200 синтетов
 * с 2-значным суффиксом 50×50×100 = 250 000 комбинаций — коллизий не
 * будет.
 */
export const EN_ADJECTIVES = [
  'Silent', 'Bold', 'Swift', 'Calm', 'Wild', 'Sharp', 'Brave', 'Witty',
  'Lucky', 'Iron', 'Steel', 'Rapid', 'Cosmic', 'Lunar', 'Solar', 'Stormy',
  'Misty', 'Bright', 'Dark', 'Royal', 'Noble', 'Quiet', 'Quick', 'Mighty',
  'Stout', 'Clever', 'Mystic', 'Steady', 'Fearless', 'Tactical', 'Strategic',
  'Grand', 'Epic', 'Vivid', 'Stoic', 'Nimble', 'Hidden', 'Frosty', 'Burning',
  'Eager', 'Ancient', 'Modern', 'Crafty', 'Polished', 'Sturdy', 'Fierce',
  'Lone', 'Stellar', 'Raging', 'Patient',
];

export const EN_NOUNS = [
  'Knight', 'Bishop', 'Rook', 'Pawn', 'Queen', 'King', 'Castle', 'Tower',
  'Dragon', 'Falcon', 'Wolf', 'Tiger', 'Lion', 'Eagle', 'Hawk', 'Bear',
  'Phoenix', 'Sage', 'Oracle', 'Master', 'Champion', 'Warrior', 'Tactician',
  'Strategist', 'Pilot', 'Captain', 'Pirate', 'Voyager', 'Wanderer', 'Hunter',
  'Archer', 'Mage', 'Wizard', 'Patriot', 'Guardian', 'Sentinel', 'Ranger',
  'Champ', 'Adept', 'Cipher', 'Vector', 'Shadow', 'Comet', 'Storm', 'Echo',
  'Pulse', 'Drift', 'Flame', 'Forge', 'Spark',
];

/**
 * 12 русских прилагательных + 12 существительных, для 15% русскоязычных
 * ников вида `Конь42`, `Ладья_2024`. 12×12×100 = 14400 — для 30 ников
 * с запасом.
 */
export const RU_ADJECTIVES = [
  'Тёмный', 'Быстрый', 'Тихий', 'Смелый', 'Лютый', 'Стальной',
  'Ясный', 'Ловкий', 'Холодный', 'Жаркий', 'Древний', 'Новый',
];

export const RU_NOUNS = [
  'Конь', 'Слон', 'Ладья', 'Пешка', 'Король', 'Ферзь',
  'Дракон', 'Сокол', 'Волк', 'Тигр', 'Лев', 'Орёл',
];

// ─── Utility: weighted pick ───────────────────────────────────────────

/**
 * Возвращает индекс из массива весов по `rng()`. Подменяемый rng для
 * тестов. Веса > 0; если всё равно нулевые — возвращает 0.
 */
export function weightedPickIndex(
  weights: readonly number[],
  rng: () => number = Math.random,
): number {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// ─── Country / rating samplers ────────────────────────────────────────

export function sampleCountry(rng: () => number = Math.random): CountryCodeISO {
  const idx = weightedPickIndex(
    COUNTRY_WEIGHTS.map((c) => c.weight),
    rng,
  );
  return COUNTRY_WEIGHTS[idx].code as CountryCodeISO;
}

export function sampleBaseRating(rng: () => number = Math.random): number {
  const idx = weightedPickIndex(
    RATING_BAND_WEIGHTS.map((b) => b.weight),
    rng,
  );
  const band = RATING_BAND_WEIGHTS[idx];
  return band.min + Math.floor(rng() * (band.max - band.min + 1));
}

/**
 * Box-Muller normal (mean=0, std=1). Для шума по категориям рейтинга.
 */
function normal(rng: () => number): number {
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Рейтинг конкретной категории = base + N(0, 80). Округляется и
 * клампится в [600, 2700], чтобы случайный «хвост» не выкинул профиль
 * за пределы Glicko-вилок.
 */
export function sampleCategoryRating(
  base: number,
  rng: () => number = Math.random,
  sigma = 80,
): number {
  const noise = normal(rng) * sigma;
  return Math.max(600, Math.min(2700, Math.round(base + noise)));
}

// ─── createdAt: equal-spread в окне 6..18 мес назад ───────────────────

/**
 * Генерирует `createdAt` для одного профиля случайно равномерно в окне
 * `[now − 18mo, now − 6mo]`. Уникальность не гарантирует — caller
 * может повторно вызвать; для 200 профилей при разрешении в миллисекундах
 * коллизий практически нет (вероятность ≈ 200²/(31_104_000_000) ≈ 1.3e-6).
 */
export function sampleCreatedAt(
  now: Date,
  rng: () => number = Math.random,
): Date {
  const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
  const eighteenMonthsMs = 18 * 30 * 24 * 60 * 60 * 1000;
  const upperBound = now.getTime() - sixMonthsMs;
  const lowerBound = now.getTime() - eighteenMonthsMs;
  const t = lowerBound + Math.floor(rng() * (upperBound - lowerBound));
  return new Date(t);
}

// ─── Username generation ──────────────────────────────────────────────

const RU_LANGUAGE_RATIO = 0.15;

/**
 * Генерирует ник вида `{Adj}{Noun}{NN}` (английский) либо `{Прил}{Сущ}_NNNN`
 * (русский, 15% случаев). NN — 2-значный, NNNN — 4-значный (год-стиль).
 */
export function generateUsername(rng: () => number = Math.random): string {
  const isRu = rng() < RU_LANGUAGE_RATIO;
  if (isRu) {
    const adj = RU_ADJECTIVES[Math.floor(rng() * RU_ADJECTIVES.length)];
    const noun = RU_NOUNS[Math.floor(rng() * RU_NOUNS.length)];
    const year = 2000 + Math.floor(rng() * 26); // 2000..2025
    return `${adj}${noun}_${year}`;
  }
  const adj = EN_ADJECTIVES[Math.floor(rng() * EN_ADJECTIVES.length)];
  const noun = EN_NOUNS[Math.floor(rng() * EN_NOUNS.length)];
  const num = Math.floor(rng() * 100); // 0..99
  return `${adj}${noun}${num.toString().padStart(2, '0')}`;
}

/**
 * Генерирует N уникальных ников. На дубликат (вероятно при коротком
 * словаре) — повторяет до `maxAttempts` (default 100). Бросает если
 * не удалось.
 */
export function generateUniqueUsernames(
  count: number,
  rng: () => number = Math.random,
  maxAttempts = 100,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let attempts = 0;
  while (out.length < count) {
    if (++attempts > count * maxAttempts) {
      throw new Error(
        `generateUniqueUsernames: failed to generate ${count} unique names after ${attempts} attempts`,
      );
    }
    const u = generateUsername(rng);
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

// ─── Avatar URL (DiceBear, deterministic-by-seed) ─────────────────────

/**
 * KS-2162. Аватар синтета — детерминированный URL DiceBear по seed=username.
 * Никаких полей в БД (`User.avatarUrl` в schema нет — KS-2160 specific
 * fields only). Фронт строит аватар по username при рендере профиля.
 *
 * Если позже потребуется S3-кэш (CDN, оффлайн-доступность) — добавится
 * прокладка в `SyntheticAvatarStore` (см. `synthetic-profile-seeder.ts`),
 * а это helper останется как fallback / source-of-truth для seed'а.
 */
export const DICEBEAR_DEFAULT_STYLE = 'avataaars';

export function dicebearAvatarUrl(
  seed: string,
  style: string = DICEBEAR_DEFAULT_STYLE,
): string {
  return `https://api.dicebear.com/8.x/${style}/png?seed=${encodeURIComponent(seed)}`;
}
