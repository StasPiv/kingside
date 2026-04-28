import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsNotEmpty } from 'class-validator';
import type { FeatureFlags, UpdateFeatureFlagResponse } from '@kingside/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminEmailGuard } from '../auth/admin-email.guard';
import { FEATURE_FLAG_KEYS, FeatureFlagsService } from './feature-flags.service';

/** Body DTO для PATCH /api/admin/feature-flags/:key. */
class UpdateFeatureFlagDto {
  @IsBoolean()
  @IsNotEmpty()
  value!: boolean;
}

/**
 * KS-2104 — admin-эндпоинт смены runtime feature flag без redeploy.
 *
 * Защита: `JwtAuthGuard` + `AdminEmailGuard` (whitelist
 * `LESSON_ADMIN_EMAILS` env, KS-1963). Не-admin → 403; не-auth → 401.
 *
 * После UPSERT сервис инвалидирует in-memory cache; на остальных
 * репликах (если их несколько) кэш протухнет в окне 60s — это
 * допустимый компромисс для feature flag.
 */
@UseGuards(JwtAuthGuard, AdminEmailGuard)
@Controller('admin/feature-flags')
export class AdminFeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

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
