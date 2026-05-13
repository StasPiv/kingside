import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MessageModule } from '../message/message.module';
import { NotificationModule } from '../notification/notification.module';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `friends` — список друзей и запросы.
@McpDiscoveryModule({
  section: 'friends',
  title: 'Друзья',
  description:
    'Список друзей пользователя, входящие/исходящие запросы в друзья, ' +
    'управление дружбой. Сюда — за списком друзей или ответом на запрос.',
  defaultAuth: 'user',
})
@Module({
  imports: [AuthModule, MessageModule, NotificationModule],
  controllers: [FriendController],
  providers: [FriendService],
  exports: [FriendService],
})
export class FriendModule {}
