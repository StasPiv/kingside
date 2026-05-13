import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { ContextCollectorService } from './context-collector.service';
import { ChatAssistantService } from './chat-assistant.service';
import { ChatController } from './chat.controller';
import { McpExclude } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): AiChatModule — это и есть сам ассистент.
// Регистрация в MCP-каталоге привела бы к рекурсии (ассистент дёргает
// себя). Явный @McpExclude обязателен.
//
// KS-2962 / ADR-062: FeatureFlagsModule подключён для проброса runtime
// snapshot'а флагов в `buildSystemPrompt` (раздел availability).
@McpExclude()
@Module({
  imports: [AuthModule, FeatureFlagsModule],
  controllers: [ChatController],
  providers: [ContextCollectorService, ChatAssistantService],
  exports: [ContextCollectorService, ChatAssistantService],
})
export class AiChatModule {}
