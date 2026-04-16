import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContextCollectorService } from './context-collector.service';
import { ChatAssistantService } from './chat-assistant.service';
import { ChatController } from './chat.controller';
import { ToolExecutorService } from './tool-executor.service';
import { ToolExecutorController } from './tool-executor.controller';

@Module({
  imports: [AuthModule],
  controllers: [ChatController, ToolExecutorController],
  providers: [ContextCollectorService, ChatAssistantService, ToolExecutorService],
  exports: [ContextCollectorService, ChatAssistantService],
})
export class AiChatModule {}
