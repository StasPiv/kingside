import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileController } from './profile.controller';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): ProfileModule использует тот же section `users`,
// что и UserModule — логически часть «пользователя». Section
// дедуплицируется DiscoveryService при сборке каталога.
/** KS-2108 — модуль профиля. Сейчас только `/profile/me/admin-status`. */
@McpDiscoveryModule({
  section: 'users',
  title: 'Пользователь',
  description:
    'Профиль текущего пользователя: статус админа, метаданные. ' +
    'Логически часть раздела «users».',
  defaultAuth: 'user',
})
@Module({
  imports: [AuthModule],
  controllers: [ProfileController],
})
export class ProfileModule {}
