import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `feedback` — обратная связь.
@McpDiscoveryModule({
  section: 'feedback',
  title: 'Обратная связь',
  description:
    'Отправка обратной связи / жалоб / предложений администрации. ' +
    'Сюда — если пользователь хочет пожаловаться на что-то или ' +
    'предложить улучшение платформы.',
  defaultAuth: 'optional',
})
@Module({
  imports: [AuthModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
