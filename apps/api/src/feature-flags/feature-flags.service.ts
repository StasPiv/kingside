import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { FeatureFlags } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-2104 — runtime feature flags.
 *
 * Источник истины — таблица `feature_flags` (key/value). Whitelist
 * известных ключей и их дефолты — в этом файле (`KNOWN_FEATURE_FLAGS`).
 * При bootstrap'е недостающие ключи сидятся в БД (UPSERT do nothing).
 *
 * In-memory cache TTL 60s — минимизация DB-запросов на горячем
 * `GET /api/config`. Кэш единый на процесс; в production у нас один
 * api-pod, рассинхрон между репликами в окне TTL — допустим (это
 * feature-flag, не конфигурация безопасности).
 *
 * Инвалидация: явный `invalidateCache()` после PATCH'а админа. На
 * других репликах кэш протухнет естественно через 60s.
 */

/** Whitelist известных ключей и дефолтные значения. */
export const KNOWN_FEATURE_FLAGS: FeatureFlags = {
  lessonsEnabled: true,
  // KS-2217: «Задачи» по умолчанию скрыты, включаются через админку.
  puzzlesEnabled: false,
  broadcastsEnabled: true,
  tournamentsEnabled: true,
  // KS-2222: чат-ассистент по умолчанию скрыт, включается через админку.
  assistantEnabled: false,
  // KS-2231 (ADR-035 §7.2): раздел «Тренажёры» в разработке, выключен
  // по умолчанию; включится админом через PATCH.
  drillsEnabled: false,
  // KS-2815 / ADR-059 (KS-2823 T8): раздел «Студии» в разработке (MVP),
  // выключен по умолчанию; включится админом через PATCH когда фронт
  // готов.
  studiesEnabled: false,
};

/**
 * KS-2108: метаданные ключей для админ-UI (`GET /admin/feature-flags`).
 * Описания на русском (UI-язык админки), без перевода — добавится по
 * мере необходимости.
 */
export const FEATURE_FLAG_METADATA: Record<
  keyof FeatureFlags,
  { description: string }
> = {
  lessonsEnabled: {
    description:
      'Показывать раздел «Уроки» в UI и пускать на /lessons*. Аварийный rollback — выключить.',
  },
  puzzlesEnabled: {
    description:
      'Показывать раздел «Задачи» в UI и пускать на /puzzles*. По умолчанию выключен — включить через PATCH.',
  },
  broadcastsEnabled: {
    description:
      'Показывать раздел «Трансляции» в UI и пускать на /broadcasts*. Аварийный rollback — выключить.',
  },
  tournamentsEnabled: {
    description:
      'Показывать раздел «Турниры» в UI и пускать на /tournaments*. Аварийный rollback — выключить.',
  },
  assistantEnabled: {
    description:
      'Показывать чат-ассистент (иконка в правом нижнем углу). По умолчанию выключен — включить через PATCH.',
  },
  drillsEnabled: {
    description:
      'Показывать раздел «Тренажёры» в UI и пускать на /drills*. По умолчанию выключен — включить через PATCH.',
  },
  studiesEnabled: {
    description:
      'Показывать раздел «Студии» в UI и пускать на /studies*. По умолчанию выключен — включится после готовности MVP.',
  },
};

/** Имена ключей — типобезопасный массив для итерирования. */
export const FEATURE_FLAG_KEYS = Object.keys(KNOWN_FEATURE_FLAGS) as Array<
  keyof FeatureFlags
>;

const CACHE_TTL_MS = 60_000;

@Injectable()
export class FeatureFlagsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private cache: { value: FeatureFlags; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * При старте api сидим недостающие ключи дефолтами и греем кэш.
   * Не блокирующий: при ошибке БД — лог + сервис всё равно поднимется
   * (`getFlags` упадёт и вернёт дефолты — fallback ниже).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.bootstrapDefaults();
      await this.refreshCache();
      this.logger.log(
        `feature flags ready: ${JSON.stringify(this.cache?.value ?? {})}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`bootstrap failed: ${msg}`);
    }
  }

  /**
   * Возвращает текущие флаги. Кэш TTL 60s. При ошибке БД — graceful
   * fallback на дефолты из whitelist (лучше показать UI с дефолтным
   * состоянием, чем 500 на публичном endpoint).
   */
  async getFlags(): Promise<FeatureFlags> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }
    try {
      return await this.refreshCache();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`getFlags failed, using defaults: ${msg}`);
      return { ...KNOWN_FEATURE_FLAGS };
    }
  }

  /**
   * Меняет флаг. Доступ — admin-only через `AdminEmailGuard` на
   * controller-уровне. Бросает `BadRequestException` для неизвестных
   * ключей (защита от писания произвольных строк в БД).
   */
  async setFlag(
    key: keyof FeatureFlags,
    value: boolean,
  ): Promise<{ key: keyof FeatureFlags; value: boolean; updatedAt: Date }> {
    if (!FEATURE_FLAG_KEYS.includes(key)) {
      throw new BadRequestException(`unknown feature flag: ${key}`);
    }
    const row = await this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    this.invalidateCache();
    return { key: row.key as keyof FeatureFlags, value: row.value, updatedAt: row.updatedAt };
  }

  /** Сбрасывает кэш — следующий getFlags() сделает SELECT. */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * KS-2108: возвращает map ключ → updatedAt для admin-UI. Не-known
   * ключи фильтруются. Не использует кэш — админский endpoint редко
   * вызывается, хотим всегда видеть актуальный updatedAt после смены.
   */
  async listWithMetadata(): Promise<Map<keyof FeatureFlags, Date>> {
    const rows = await this.prisma.featureFlag.findMany();
    const out = new Map<keyof FeatureFlags, Date>();
    for (const row of rows) {
      if (FEATURE_FLAG_KEYS.includes(row.key as keyof FeatureFlags)) {
        out.set(row.key as keyof FeatureFlags, row.updatedAt);
      }
    }
    return out;
  }

  /** Видимость для тестов — TTL ms по умолчанию (60000). */
  static readonly CACHE_TTL_MS = CACHE_TTL_MS;

  // ─── private ─────────────────────────────────────────────────────

  /** UPSERT-сидинг недостающих ключей. Идемпотентно. */
  private async bootstrapDefaults(): Promise<void> {
    for (const key of FEATURE_FLAG_KEYS) {
      const defaultValue = KNOWN_FEATURE_FLAGS[key];
      // ON CONFLICT DO NOTHING — не перезаписываем если ключ уже есть.
      await this.prisma.featureFlag.upsert({
        where: { key },
        create: { key, value: defaultValue },
        update: {}, // ничего не меняем при наличии записи
      });
    }
  }

  private async refreshCache(): Promise<FeatureFlags> {
    const rows = await this.prisma.featureFlag.findMany();
    const flags: FeatureFlags = { ...KNOWN_FEATURE_FLAGS };
    for (const row of rows) {
      if (FEATURE_FLAG_KEYS.includes(row.key as keyof FeatureFlags)) {
        flags[row.key as keyof FeatureFlags] = row.value;
      }
      // Незнакомые ключи (исторические) игнорируем — whitelist строгий.
    }
    this.cache = { value: flags, expiresAt: Date.now() + CACHE_TTL_MS };
    return flags;
  }
}
