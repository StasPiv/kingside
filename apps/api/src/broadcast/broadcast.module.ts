import { Module } from '@nestjs/common';
import { BroadcastGateway } from './broadcast.gateway';
import { BroadcastController } from './broadcast.controller';
import { ChessResultsService } from './chess-results/chess-results.service';
import { LivechesscloudService } from './chess-results/livechesscloud.service';

@Module({
  controllers: [BroadcastController],
  providers: [BroadcastGateway, ChessResultsService, LivechesscloudService],
  exports: [ChessResultsService, LivechesscloudService],
})
export class BroadcastModule {}
