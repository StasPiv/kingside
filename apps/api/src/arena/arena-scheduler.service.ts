import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ArenaService } from './arena.service';
import { ArenaGateway } from './arena.gateway';

const CHECK_INTERVAL_MS = 10_000; // 10 seconds

@Injectable()
export class ArenaSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArenaSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly arena: ArenaService,
    private readonly gateway: ArenaGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.logger.log('Arena scheduler started (every 10s)');
  }

  onModuleDestroy() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async check() {
    try {
      const started = await this.arena.checkAndStartTournaments();
      for (const id of started) {
        this.gateway.emitTournamentStarted(id);
      }

      const finished = await this.arena.checkAndFinishTournaments();
      for (const id of finished) {
        this.gateway.emitTournamentFinished(id);
      }
    } catch (e: unknown) {
      this.logger.error(`Arena scheduler error: ${(e as Error).message}`);
    }
  }
}
