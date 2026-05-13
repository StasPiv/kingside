import { Module } from '@nestjs/common';
import { ClientLogsController } from './client-logs.controller';
import { IpRateLimitGuard } from './ip-rate-limit.guard';
import { McpExclude } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): POST-only клиентские логи — бесполезны
// ассистенту. `@McpExclude` явный.
@McpExclude()
@Module({
  controllers: [ClientLogsController],
  providers: [IpRateLimitGuard],
})
export class ClientLogsModule {}
