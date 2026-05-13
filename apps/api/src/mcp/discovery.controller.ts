/**
 * KS-2952 / ADR-061 §6. Endpoint `GET /_mcp/tools`.
 *
 * Защищён `McpDiscoveryKeyGuard` (X-Mcp-Discovery-Key + `MCP_DISCOVERY_KEY`).
 * Возвращает машинно-читаемый каталог разделов и тулов в формате
 * `schemaVersion: 1`.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { McpDiscoveryService, McpCatalog } from './discovery.service';
import { McpDiscoveryKeyGuard } from './mcp-discovery-key.guard';

@Controller('_mcp')
@UseGuards(McpDiscoveryKeyGuard)
export class McpDiscoveryController {
  constructor(private readonly discovery: McpDiscoveryService) {}

  @Get('tools')
  getTools(): McpCatalog {
    return this.discovery.getCatalog();
  }
}
