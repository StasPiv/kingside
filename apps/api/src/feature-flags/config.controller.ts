import { Controller, Get } from '@nestjs/common';
import type { ConfigResponse } from '@kingside/shared';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * KS-2104 — публичный эндпоинт `GET /api/config`.
 *
 * Без авторизации (нужен анонимам тоже). Кэш на стороне сервиса (TTL
 * 60s) — публичная нагрузка не упирается в БД.
 *
 * Контракт `ConfigResponse` зафиксирован в `@kingside/shared` —
 * расширяется добавлением полей в `FeatureFlags` без миграции БД.
 */
@Controller('config')
export class ConfigController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  async getConfig(): Promise<ConfigResponse> {
    const featureFlags = await this.flags.getFlags();
    return { featureFlags };
  }
}
