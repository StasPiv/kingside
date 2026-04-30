import { Module } from '@nestjs/common';
import { SyntheticProfileSeederService } from './synthetic-profile-seeder.service';
import { SyntheticAvatarMirrorService } from './synthetic-avatar-mirror.service';

/**
 * KS-2162. Регистрирует `SyntheticProfileSeederService`. Этот модуль
 * включается в `AppModule` для возможности дёрнуть сервис из любого
 * controller'а (например, future admin-endpoint), либо инжектится в
 * CLI-bootstrap (`cli/seed-synthetic-profiles.ts`).
 *
 * `PrismaModule` подцепляется через `@Global()` декоратор уже
 * существующего `PrismaModule`.
 *
 * KS-2178: добавлен `SyntheticAvatarMirrorService` — копирует
 * DiceBear аватары в S3 (`SYNTHETIC_AVATARS_S3_BUCKET`) при флаге
 * `SYNTHETIC_AVATARS_MIRRORING_ENABLED=true`, иначе no-op.
 */
@Module({
  providers: [SyntheticProfileSeederService, SyntheticAvatarMirrorService],
  exports: [SyntheticProfileSeederService, SyntheticAvatarMirrorService],
})
export class SyntheticModule {}
