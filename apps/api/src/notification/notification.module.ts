import { Module, forwardRef } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `notifications` — уведомления.
@McpDiscoveryModule({
  section: 'notifications',
  title: 'Уведомления',
  description:
    'Системные уведомления пользователя: запросы в друзья, новые сообщения, ' +
    'результаты турниров. Сюда — за списком уведомлений и отметкой «прочитано».',
  defaultAuth: 'user',
})
@Module({
  imports: [forwardRef(() => MessageModule)],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
