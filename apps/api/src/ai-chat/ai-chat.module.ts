import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContextCollectorService } from './context-collector.service';
import { ChatAssistantService } from './chat-assistant.service';
import { ChatController } from './chat.controller';

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [ContextCollectorService, ChatAssistantService],
  exports: [ContextCollectorService, ChatAssistantService],
})
export class AiChatModule {}
