import { Module } from '@nestjs/common';
import { SyntheticProfileSeederService } from './synthetic-profile-seeder.service';

/**
 * KS-2162. Регистрирует `SyntheticProfileSeederService`. Этот модуль
 * включается в `AppModule` для возможности дёрнуть сервис из любого
 * controller'а (например, future admin-endpoint), либо инжектится в
 * CLI-bootstrap (`cli/seed-synthetic-profiles.ts`).
 *
 * `PrismaModule` подцепляется через `@Global()` декоратор уже
 * существующего `PrismaModule`.
 */
@Module({
  providers: [SyntheticProfileSeederService],
  exports: [SyntheticProfileSeederService],
})
export class SyntheticModule {}
