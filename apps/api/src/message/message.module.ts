import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { UserModule } from '../user/user.module';
import { NotificationModule } from '../notification/notification.module';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { MessageGateway } from './message.gateway';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `messages` — личные сообщения.
// MessageGateway (WebSocket) не попадает в каталог — у него нет HTTP-роутов.
@McpDiscoveryModule({
  section: 'messages',
  title: 'Личные сообщения',
  description:
    'Личные сообщения пользователя: список диалогов, история, отправка. ' +
    'Сюда — если пользователь хочет посмотреть переписку или ответить.',
  defaultAuth: 'user',
})
@Module({
  imports: [AuthModule, forwardRef(() => GameModule), UserModule, forwardRef(() => NotificationModule)],
  controllers: [MessageController],
  providers: [MessageService, MessageGateway],
  exports: [MessageService, MessageGateway],
})
export class MessageModule {}
