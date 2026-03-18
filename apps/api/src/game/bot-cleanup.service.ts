import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { GameService } from './game.service';

/** Run cleanup every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class BotCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotCleanupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly gameService: GameService) {}

  onModuleInit() {
    this.timer = setInterval(() => this.run(), CLEANUP_INTERVAL_MS);
    this.logger.log('Bot game cleanup scheduler started (every 5 min)');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    try {
      const cleaned = await this.gameService.cleanupStaleBotGames();
      if (cleaned > 0) {
        this.logger.log(`Cleaned up ${cleaned} stale bot game(s)`);
      }
    } catch (e: any) {
      this.logger.error(`Bot cleanup failed: ${e.message}`);
    }
  }
}
