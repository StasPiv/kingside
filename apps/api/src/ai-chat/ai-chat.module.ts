import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { ContextCollectorService } from './context-collector.service';
import { ChatAssistantService } from './chat-assistant.service';
import { ChatController } from './chat.controller';
import { ASSISTANT_TOOLS_PROVIDER } from './assistant-tools';
import { McpExclude } from '../mcp/decorators';
import { McpModule } from '../mcp/mcp.module';
import { McpAssistantRegistry } from '../mcp/assistant-registry.service';

// KS-2954 (ADR-061 §8): AiChatModule — это и есть сам ассистент.
// Регистрация в MCP-каталоге привела бы к рекурсии (ассистент дёргает
// себя). Явный @McpExclude обязателен.
//
// KS-2962 / ADR-062: FeatureFlagsModule подключён для проброса runtime
// snapshot'а флагов в `buildSystemPrompt` (раздел availability).
//
// KS-3206 / ADR-074 §10 B2: ASSISTANT_TOOLS_PROVIDER теперь — реальный
// реестр `McpAssistantRegistry` (заменяет NoOpAssistantToolsProvider
// из B1). Список tools собирается автоматически по `@McpToolForAssistant`.
@McpExclude()
@Module({
  imports: [AuthModule, FeatureFlagsModule, McpModule],
  controllers: [ChatController],
  providers: [
    ContextCollectorService,
    ChatAssistantService,
    {
      provide: ASSISTANT_TOOLS_PROVIDER,
      useExisting: McpAssistantRegistry,
    },
  ],
  exports: [ContextCollectorService, ChatAssistantService],
})
export class AiChatModule {}
