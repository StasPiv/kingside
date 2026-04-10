import { Module } from '@nestjs/common';
import { MatchmakerWorkerService } from './matchmaker-worker.service';

@Module({
  providers: [MatchmakerWorkerService],
  exports: [MatchmakerWorkerService],
})
export class MatchmakerWorkerModule {}
