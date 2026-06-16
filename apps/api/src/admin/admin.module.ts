import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrecisionModule } from '../precision/precision.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { ReindexBroadcastsProxyController } from './reindex-broadcasts-proxy.controller';
import { ReindexAllController } from './reindex-all.controller';
import { SitemapBroadcastsProxyController } from './sitemap-broadcasts-proxy.controller';
import { PrecisionDiagnosticController } from './precision-diagnostic.controller';
import { McpExclude } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): AdminModule отсекается hard-exclude'ом по
// AdminApiKeyGuard и path-сегменту `admin/*`. `@McpExclude` —
// дополнительная страховка как явный сигнал намерения.
@McpExclude()
@Module({
  imports: [ConfigModule, PrecisionModule],
  controllers: [
    AdminController,
    ReindexBroadcastsProxyController,
    ReindexAllController,
    SitemapBroadcastsProxyController,
    PrecisionDiagnosticController,
  ],
  providers: [AdminService, AdminApiKeyGuard],
})
export class AdminModule {}
