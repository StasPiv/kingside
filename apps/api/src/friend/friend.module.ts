import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessageModule } from '../message/message.module';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';

@Module({
  imports: [AuthModule, MessageModule],
  controllers: [FriendController],
  providers: [FriendService],
  exports: [FriendService],
})
export class FriendModule {}
