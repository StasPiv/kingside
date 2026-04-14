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
    this.maxConnections = parseInt(process.env.WS_OVERLOAD_THRESHOLD || '500', 10);
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
    // No-op: WS gateways moved to game-service. Overload guard only applies there.
  }
}
