/**
 * KS-2952 / ADR-061 §7. MCP auto-discovery NestJS-модуль.
 *
 * Регистрирует:
 *  - `McpDiscoveryService` — обход модулей на `OnApplicationBootstrap`;
 *  - `McpDiscoveryKeyGuard` — DI-провайдер для @UseGuards в контроллере;
 *  - `McpDiscoveryController` — `GET /_mcp/tools`.
 *
 * Модуль НЕ помечен `@McpModule()` сам себя — иначе бы попал в каталог
 * (он не должен).
 */
import { Module } from '@nestjs/common';
import { McpDiscoveryService } from './discovery.service';
import { McpDiscoveryController } from './discovery.controller';
import { McpDiscoveryKeyGuard } from './mcp-discovery-key.guard';
import { McpAssistantRegistry } from './assistant-registry.service';

@Module({
  controllers: [McpDiscoveryController],
  providers: [
    McpDiscoveryService,
    McpDiscoveryKeyGuard,
    // KS-3206 / ADR-074 §10 B2: реестр assistant-tools для
    // `ChatAssistantService` (in-process Anthropic loop).
    McpAssistantRegistry,
  ],
  exports: [McpDiscoveryService, McpAssistantRegistry],
})
export class McpModule {}
