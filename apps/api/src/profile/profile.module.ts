import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileController } from './profile.controller';

/** KS-2108 — модуль профиля. Сейчас только `/profile/me/admin-status`. */
@Module({
  imports: [AuthModule],
  controllers: [ProfileController],
})
export class ProfileModule {}
