/**
 * KS-2162. Service-обёртка над `buildSyntheticProfiles` — пишет в БД
 * через Prisma, идемпотентен, дополняет 12 legacy MATCHMAKING_BOTS
 * (которым KS-2160 проставил `isSynthetic=true`, но country/рейтинги
 * могли остаться пустыми).
 *
 * НЕ запускается автоматически. Вызывается:
 *   - CLI-командой (см. `cli/seed-synthetic-profiles.ts`),
 *   - либо bootstrap-задачей KS-2163, которая после seed'а ещё и
 *     прогоняет N стартовых партий.
 *
 * Идемпотентность:
 *   - При запуске считаем `count(isSynthetic=true)` в БД.
 *   - Если ≥ targetCount (по умолчанию 200) — no-op + лог.
 *   - Иначе генерим разницу и создаём через `prisma.user.create`.
 *     Уникальность username — UNIQUE-индекс в БД, плюс наш собственный
 *     pre-check (на случай уже существующих ников из ручного seed'а).
 *   - Дополнение legacy-bot'ов: если у `isSynthetic=true` пользователя
 *     `country IS NULL`, проставляем country/рейтинги (sample-нормально).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSyntheticProfiles,
  type BuiltSyntheticProfile,
} from './synthetic-profile-builder';
import {
  sampleBaseRating,
  sampleCategoryRating,
  sampleCountry,
  dicebearAvatarUrl,
} from './synthetic-profile.helpers';
import { SyntheticAvatarMirrorService } from './synthetic-avatar-mirror.service';

const DEFAULT_TARGET_COUNT = 200;

export interface SeedReport {
  /** Итоговое число synthetic'ов в БД после seed'а. */
  totalAfter: number;
  /** Сколько НОВЫХ профилей создано в этом запуске. */
  created: number;
  /** Сколько legacy-bot'ов получили country/рейтинги в этом запуске. */
  legacyBotsBackfilled: number;
  /** Сколько было изначально. */
  totalBefore: number;
  /** Если уже было ≥ target — это true, ничего не создавалось. */
  noop: boolean;
}

@Injectable()
export class SyntheticProfileSeederService {
  private readonly logger = new Logger(SyntheticProfileSeederService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * KS-2178. Опциональный (DI создаст в любом случае) — сервис сам
     * умеет fallback'ать на DiceBear если флаг выключен или AWS SDK
     * не доступен. Тесты без NestJS могут не передавать (см.
     * test-сценарий «без mirror» — pass-through на DiceBear).
     */
    private readonly avatarMirror?: SyntheticAvatarMirrorService,
  ) {}

  async seed(targetCount = DEFAULT_TARGET_COUNT): Promise<SeedReport> {
    const totalBefore = await this.prisma.user.count({
      where: { isSynthetic: true },
    });
    this.logger.log(
      `seed: targetCount=${targetCount} totalBefore=${totalBefore}`,
    );

    // 1. Backfill country/рейтингов у legacy-bot'ов (KS-2160 их уже
    //    флипнул в isSynthetic=true, но country/рейтинги мог не успеть).
    const legacyBotsBackfilled = await this.backfillLegacyBots();

    // 2. Если в БД уже >= target — больше не создаём.
    if (totalBefore >= targetCount) {
      this.logger.log(
        `seed: noop, already have ${totalBefore} >= ${targetCount}`,
      );
      return {
        totalAfter: totalBefore,
        created: 0,
        legacyBotsBackfilled,
        totalBefore,
        noop: true,
      };
    }

    // 3. Создаём недостающую часть.
    const need = targetCount - totalBefore;
    const built = buildSyntheticProfiles({ count: need, now: new Date() });
    const existingUsernames = new Set(
      (
        await this.prisma.user.findMany({
          select: { username: true },
        })
      )
        .map((u) => u.username)
        .filter((u): u is string => !!u),
    );

    let created = 0;
    let mirrored = 0;
    for (const p of built) {
      if (existingUsernames.has(p.username)) {
        // Коллизия — пропускаем, при следующем запуске генератор
        // подберёт другие. Доп. retry внутри одного запуска не делаем,
        // т.к. это маркер «база уже не пустая, нужно перезапустить
        // генератор с новым sample'ом».
        this.logger.warn(
          `seed: username collision ${p.username} — skipping`,
        );
        continue;
      }
      try {
        await this.createOne(p);
        existingUsernames.add(p.username);
        created++;
      } catch (err) {
        this.logger.warn(
          `seed: create failed for ${p.username}: ${(err as Error).message}`,
        );
        continue;
      }
      // KS-2178: после успешного create — пытаемся загнать аватар
      // в S3. Mirror сам smoke-test'ит флаги и при выключенной
      // фиче возвращает null без сетевых вызовов. Падение mirror'а
      // НЕ блокирует seed (свойство контракта) — отдельный try/catch
      // здесь чтобы ошибка mirror не отменила счётчик created.
      if (this.avatarMirror) {
        try {
          const url = await this.avatarMirror.mirror(p.username);
          if (url) mirrored++;
        } catch (err) {
          this.logger.warn(
            `seed: mirror failed for ${p.username}: ${(err as Error).message}`,
          );
        }
      }
    }
    if (mirrored > 0 || (this.avatarMirror?.enabled() ?? false)) {
      this.logger.log(
        `seed: mirrored ${mirrored} avatars to S3 (of ${created} created)`,
      );
    }

    const totalAfter = totalBefore + created;
    this.logger.log(
      `seed: done created=${created} legacyBackfilled=${legacyBotsBackfilled} totalAfter=${totalAfter}`,
    );
    return {
      totalAfter,
      created,
      legacyBotsBackfilled,
      totalBefore,
      noop: false,
    };
  }

  private async createOne(p: BuiltSyntheticProfile): Promise<void> {
    await this.prisma.user.create({
      data: {
        username: p.username,
        isSynthetic: true,
        isBot: false,
        country: p.country,
        ratingBullet: p.ratingBullet,
        ratingBlitz: p.ratingBlitz,
        ratingRapid: p.ratingRapid,
        ratingClassical: p.ratingClassical,
        createdAt: p.createdAt,
        // gamesPlayed* остаются по дефолту 0 — заполнятся в KS-2163 bootstrap.
        // lastSeenAt: undefined — пусть будет default `now()` от prisma; presence-сервис
        // (KS-2164) перезапишет на следующем tick'е.
        // email/passwordHash оставляем NULL — синтет не логинится.
      },
    });
  }

  /**
   * Дополняет country/рейтинги у тех `isSynthetic=true` пользователей,
   * у которых `country IS NULL` (legacy MATCHMAKING_BOTS из KS-2160
   * data-migration). Возвращает кол-во обновлённых.
   */
  private async backfillLegacyBots(): Promise<number> {
    const candidates = await this.prisma.user.findMany({
      where: { isSynthetic: true, country: null },
      select: {
        id: true,
        ratingBullet: true,
        ratingBlitz: true,
        ratingRapid: true,
        ratingClassical: true,
      },
    });
    if (candidates.length === 0) return 0;

    let updated = 0;
    for (const u of candidates) {
      const country = sampleCountry();
      // Если у legacy-бота уже есть рейтинги (например, 1500 у всех 4х
      // как у MATCHMAKING_BOTS) — оставляем их. Если все равны 1500
      // (default Prisma) — переcидируем.
      const rates = [u.ratingBullet, u.ratingBlitz, u.ratingRapid, u.ratingClassical];
      const allDefault = rates.every((r) => r === 1500);
      const data: Record<string, unknown> = { country };
      if (allDefault) {
        const baseRating = sampleBaseRating();
        data.ratingBullet = sampleCategoryRating(baseRating);
        data.ratingBlitz = sampleCategoryRating(baseRating);
        data.ratingRapid = sampleCategoryRating(baseRating);
        data.ratingClassical = sampleCategoryRating(baseRating);
      }
      try {
        await this.prisma.user.update({ where: { id: u.id }, data });
        updated++;
      } catch (err) {
        this.logger.warn(
          `backfillLegacyBots: update failed for ${u.id.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
    }
    if (updated > 0) {
      this.logger.log(`backfillLegacyBots: ${updated} legacy synthetic users updated (country/ratings)`);
    }
    return updated;
  }

  /**
   * Возвращает avatar URL для synthetic'а. Используется клиентским
   * рендером профиля (через REST endpoint, который вернёт его рядом с
   * username'ом).
   *
   * KS-2178: если `SYNTHETIC_AVATARS_MIRRORING_ENABLED=true` И bucket
   * сконфигурирован — отдаём S3-URL по детерминированному ключу
   * `<bucket>.s3.<region>.amazonaws.com/<username>.png`. Никаких HEAD-
   * запросов в S3 на чтение — это бы добавляло network round-trip на
   * каждый профиль; если объект не существует, фронт получит 404 от
   * S3 и покажет дефолтный плейсхолдер. Случай «mirror включён, но
   * объект не успел загрузиться» — редкий corner: при следующем seed
   * mirror() закроет пробел.
   *
   * Если mirror выключен — возвращаем DiceBear-URL (исходное поведение).
   */
  resolveAvatarUrl(username: string): string {
    const expected = this.avatarMirror?.expectedUrl(username);
    return expected ?? dicebearAvatarUrl(username);
  }
}
