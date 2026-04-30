/**
 * KS-2162. Чистая функция-builder: принимает seed-параметры (count, rng, now)
 * и возвращает массив записей-кандидатов под `prisma.user.create`. Никаких
 * IO — IO делает `SyntheticProfileSeederService` (записывает в БД).
 *
 * Это позволяет проверить распределения на 200 в unit-тесте без БД.
 */

import {
  generateUniqueUsernames,
  sampleBaseRating,
  sampleCategoryRating,
  sampleCountry,
  sampleCreatedAt,
  RATING_BAND_WEIGHTS,
} from './synthetic-profile.helpers';

export interface BuiltSyntheticProfile {
  username: string;
  isSynthetic: true;
  isBot: false;
  country: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
  /**
   * Базовый рейтинг профиля (для отчётности и тестов распределения).
   * В Prisma не пишется — у `User` нет такого поля.
   */
  baseRating: number;
  createdAt: Date;
}

export interface BuildOpts {
  count: number;
  now: Date;
  rng?: () => number;
}

export function buildSyntheticProfiles(opts: BuildOpts): BuiltSyntheticProfile[] {
  const rng = opts.rng ?? Math.random;
  const usernames = generateUniqueUsernames(opts.count, rng);
  const profiles: BuiltSyntheticProfile[] = [];
  for (const username of usernames) {
    const baseRating = sampleBaseRating(rng);
    profiles.push({
      username,
      isSynthetic: true,
      isBot: false,
      country: sampleCountry(rng),
      ratingBullet: sampleCategoryRating(baseRating, rng),
      ratingBlitz: sampleCategoryRating(baseRating, rng),
      ratingRapid: sampleCategoryRating(baseRating, rng),
      ratingClassical: sampleCategoryRating(baseRating, rng),
      baseRating,
      createdAt: sampleCreatedAt(opts.now, rng),
    });
  }
  return profiles;
}

/**
 * Группирует профили по полосам Q10 — для отчёта/тестов распределения.
 */
export function groupByBaseRatingBand(
  profiles: readonly BuiltSyntheticProfile[],
): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const band of RATING_BAND_WEIGHTS) {
    groups[`${band.min}-${band.max}`] = 0;
  }
  for (const p of profiles) {
    for (const band of RATING_BAND_WEIGHTS) {
      if (p.baseRating >= band.min && p.baseRating <= band.max) {
        groups[`${band.min}-${band.max}`]++;
        break;
      }
    }
  }
  return groups;
}

/** Группирует по country для тестов распределения. */
export function groupByCountry(
  profiles: readonly BuiltSyntheticProfile[],
): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const p of profiles) {
    groups[p.country] = (groups[p.country] ?? 0) + 1;
  }
  return groups;
}
