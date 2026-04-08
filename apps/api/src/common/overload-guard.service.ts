import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

const CHECK_INTERVAL_MS = 30_000;

@Injectable()
export class OverloadGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OverloadGuardService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly maxConnections: number;
  private readonly shedPercent: number;

  constructor(private readonly moduleRef: ModuleRef) {
    this.maxConnections = parseInt(process.env.WS_OVERLOAD_THRESHOLD || '200', 10);
    this.shedPercent = parseFloat(process.env.WS_SHED_PERCENT || '0.3');
  }

  onModuleInit() {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.logger.log(`OverloadGuard started (threshold=${this.maxConnections}, shed=${this.shedPercent * 100}%, every ${CHECK_INTERVAL_MS / 1000}s)`);
  }

  onModuleDestroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async check() {
    try {
      // Dynamically resolve GameGateway to get the Socket.IO server
      // Using lazy import to avoid circular dependency
      const { GameGateway } = await import('../game/game.gateway');
      const gateway = this.moduleRef.get(GameGateway, { strict: false });
      if (!gateway?.server) return;

      const server = gateway.server;
      const count = server.engine?.clientsCount ?? 0;

      if (count <= this.maxConnections) return;

      const shedCount = Math.ceil(count * this.shedPercent);
      this.logger.warn(`Overload: ${count} connections (threshold=${this.maxConnections}), shedding ${shedCount}`);

      // Shed from local sockets (each instance sheds its own)
      const localSockets = Array.from(server.sockets.sockets.values());
      const toShed = localSockets.slice(0, shedCount);
      for (const sock of toShed) {
        sock.emit('reconnect_suggestion', { reason: 'server_busy' });
        sock.disconnect(true);
      }

      this.logger.log(`Shed ${toShed.length} connections, remaining: ~${count - toShed.length}`);
    } catch (e: unknown) {
      this.logger.error(`OverloadGuard check failed: ${(e as Error).message}`);
    }
  }
}
