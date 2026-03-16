import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserTimeControlController } from './user-time-control.controller';
import { UserTimeControlService } from './user-time-control.service';
import { EcoService } from '../game/eco.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [UserController, UserTimeControlController],
  providers: [UserService, UserTimeControlService, EcoService],
  exports: [UserService],
})
export class UserModule {}
