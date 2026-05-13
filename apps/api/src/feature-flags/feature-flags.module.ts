import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsService } from './feature-flags.service';
import { ConfigController } from './config.controller';
import { AdminFeatureFlagsController } from './admin-feature-flags.controller';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

/**
 * KS-2104 — runtime feature flags.
 * Public read: `GET /api/config`. Admin write: `PATCH /api/admin/feature-flags/:key`.
 *
 * KS-2954 (ADR-061 §8): MCP-секция `config`. `ConfigController` (public
 * read) попадает в каталог; `AdminFeatureFlagsController` отсекается
 * автоматически по `AdminUserGuard` + path `admin/*`.
 */
@McpDiscoveryModule({
  section: 'config',
  title: 'Конфигурация',
  description:
    'Публичные runtime-флаги платформы (feature flags). Сюда — если ' +
    'нужно проверить включён ли тот или иной режим/раздел в текущем ' +
    'окружении (без секретов).',
  defaultAuth: 'public',
})
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ConfigController, AdminFeatureFlagsController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
