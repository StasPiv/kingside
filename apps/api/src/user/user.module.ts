import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { BlockService } from './block.service';
import { UserTimeControlController } from './user-time-control.controller';
import { UserTimeControlService } from './user-time-control.service';
import { InternalUsersController } from './internal-users.controller';
import { UserPreferencesController } from './user-preferences.controller';
import { UserPreferencesService } from './user-preferences.service';
import { EcoService } from '../game/eco.service';
import { AuthModule } from '../auth/auth.module';
import { WorkshopModule } from '../workshop/workshop.module';

@Module({
  imports: [AuthModule, WorkshopModule],
  controllers: [
    UserController,
    UserTimeControlController,
    // KS-2182: internal endpoints для synthetic-bot-service
    // (за InternalKeyGuard, регистрируется в AuthModule).
    InternalUsersController,
    // KS-2210: сохранение пользовательских предпочтений.
    UserPreferencesController,
  ],
  providers: [
    UserService,
    BlockService,
    UserTimeControlService,
    EcoService,
    UserPreferencesService,
  ],
  exports: [UserService, BlockService],
})
export class UserModule {}
