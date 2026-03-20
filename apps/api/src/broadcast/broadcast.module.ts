import { Module, OnModuleInit } from '@nestjs/common';
import { BroadcastSyncService } from './broadcast-sync.service';
import { BroadcastGateway } from './broadcast.gateway';
import { BroadcastController } from './broadcast.controller';
import { ChessResultsService } from './chess-results/chess-results.service';
import { LivechesscloudService } from './chess-results/livechesscloud.service';

@Module({
  controllers: [BroadcastController],
  providers: [BroadcastSyncService, BroadcastGateway, ChessResultsService, LivechesscloudService],
  exports: [BroadcastSyncService, ChessResultsService, LivechesscloudService],
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
