import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { ReindexBroadcastsProxyController } from './reindex-broadcasts-proxy.controller';
import { ReindexAllController } from './reindex-all.controller';
import { McpExclude } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): AdminModule отсекается hard-exclude'ом по
// AdminApiKeyGuard и path-сегменту `admin/*`. `@McpExclude` —
// дополнительная страховка как явный сигнал намерения.
@McpExclude()
@Module({
  imports: [ConfigModule],
  controllers: [
    AdminController,
    ReindexBroadcastsProxyController,
    ReindexAllController,
  ],
  providers: [AdminService, AdminApiKeyGuard],
})
export class AdminModule {}
