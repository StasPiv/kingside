import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserTimeControlController } from './user-time-control.controller';
import { UserTimeControlService } from './user-time-control.service';

@Module({
  controllers: [UserController, UserTimeControlController],
  providers: [UserService, UserTimeControlService],
  exports: [UserService],
})
export class UserModule {}
