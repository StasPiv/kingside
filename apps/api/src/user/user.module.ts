import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { BlockService } from './block.service';
import { UserTimeControlController } from './user-time-control.controller';
import { UserTimeControlService } from './user-time-control.service';
import { EcoService } from '../game/eco.service';
import { AuthModule } from '../auth/auth.module';
import { WorkshopModule } from '../workshop/workshop.module';

@Module({
  imports: [AuthModule, WorkshopModule],
  controllers: [UserController, UserTimeControlController],
  providers: [UserService, BlockService, UserTimeControlService, EcoService],
  exports: [UserService, BlockService],
})
export class UserModule {}
