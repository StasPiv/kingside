import { Module, OnModuleInit } from '@nestjs/common';
import { BroadcastSyncService } from './broadcast-sync.service';
import { BroadcastGateway } from './broadcast.gateway';
import { BroadcastController } from './broadcast.controller';
import { ChessResultsService } from './chess-results/chess-results.service';
import { ChessResultsController } from './chess-results/chess-results.controller';

@Module({
  controllers: [BroadcastController, ChessResultsController],
  providers: [BroadcastSyncService, BroadcastGateway, ChessResultsService],
  exports: [BroadcastSyncService, ChessResultsService],
})
export class BroadcastModule implements OnModuleInit {
  constructor(
    private readonly syncService: BroadcastSyncService,
    private readonly gateway: BroadcastGateway,
  ) {}

  onModuleInit(): void {
    this.syncService.setGateway(this.gateway);
  }
}
