import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsNotEmpty } from 'class-validator';
import type {
  AdminFeatureFlagItem,
  FeatureFlags,
  UpdateFeatureFlagResponse,
} from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminUserGuard } from '../auth/admin-user.guard';
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_METADATA,
  FeatureFlagsService,
  KNOWN_FEATURE_FLAGS,
} from './feature-flags.service';

/** Body DTO для PATCH /api/admin/feature-flags/:key. */
class UpdateFeatureFlagDto {
  @IsBoolean()
  @IsNotEmpty()
  value!: boolean;
}

/**
 * KS-2104/KS-2108 — admin-эндпоинты feature flags.
 *
 * Защита: `JwtAuthGuard` + `AdminUserGuard` (whitelist
 * `KS_ADMIN_USERS` env, KS-2108). Не-admin → 403; не-auth → 401.
 *
 * GET `/admin/feature-flags` — список всех known-флагов с метаданными
 * (для UI админки).
 * PATCH `/admin/feature-flags/:key` — смена значения. После UPSERT
 * сервис инвалидирует in-memory cache; на остальных репликах кэш
 * протухнет в окне 60s — допустимый компромисс для feature flag.
 */
@UseGuards(JwtAuthGuard, AdminUserGuard)
@Controller('admin/feature-flags')
export class AdminFeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  async list(): Promise<AdminFeatureFlagItem[]> {
    const current = await this.flags.getFlags();
    const meta = await this.flags.listWithMetadata();
    return FEATURE_FLAG_KEYS.map((key) => ({
      key,
      value: current[key],
      defaultValue: KNOWN_FEATURE_FLAGS[key],
      description: FEATURE_FLAG_METADATA[key]?.description ?? null,
      updatedAt: meta.get(key)?.toISOString() ?? null,
    }));
  }

  @Patch(':key')
  async update(
    @Param('key') key: string,
    @Body() body: UpdateFeatureFlagDto,
  ): Promise<UpdateFeatureFlagResponse> {
    if (!FEATURE_FLAG_KEYS.includes(key as keyof FeatureFlags)) {
      throw new BadRequestException(`unknown feature flag: ${key}`);
    }
    const updated = await this.flags.setFlag(
      key as keyof FeatureFlags,
      body.value,
    );
    return {
      key: updated.key,
      value: updated.value,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}
