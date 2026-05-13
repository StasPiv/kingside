import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { RipgrepRunner } from './ripgrep-runner';

/**
 * KS-2967 / ADR-063 Phase 2 — knowledge-tools (MCP section `knowledge`).
 *
 * `defaultAuth: 'user'` — все методы под JwtAuthGuard, чтобы рендомный
 * сканер не дёргал `/knowledge/*` без user-токена (§8.1 ADR-063).
 *
 * Discovery: попадает в `/_mcp/tools` через стандартный механизм
 * ADR-061 (McpDiscoveryService bootstrap). MCP-сервер `mcp-kingside.mjs`
 * подхватит инструменты как `mcp__kingside__knowledge__search` и
 * `mcp__kingside__knowledge__read` без правок самого MCP-сервера.
 */
@McpDiscoveryModule({
  section: 'knowledge',
  title: 'Kingside source-code knowledge',
  description:
    'Search and read Kingside source code (frontend pages, components, hooks, ' +
    'context, layouts), i18n locale strings, shared types/constants, ADRs and ' +
    'service READMEs. Use when the user asks specific questions about how a ' +
    'feature works, what fields exist on a page, or where something lives. ' +
    'These tools read application source, not chess positions.',
  defaultAuth: 'user',
})
@Module({
  imports: [AuthModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, RipgrepRunner],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
