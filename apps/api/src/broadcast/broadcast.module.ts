import { Module, OnModuleInit } from '@nestjs/common';
import { BroadcastSyncService } from './broadcast-sync.service';
import { BroadcastGateway } from './broadcast.gateway';
import { BroadcastController } from './broadcast.controller';

@Module({
  controllers: [BroadcastController],
  providers: [BroadcastSyncService, BroadcastGateway],
  exports: [BroadcastSyncService],
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
