import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PuzzleRushController } from './puzzle-rush.controller';
import { PuzzleRushService } from './puzzle-rush.service';

@Module({
  imports: [AuthModule],
  controllers: [PuzzleRushController],
  providers: [PuzzleRushService],
  exports: [PuzzleRushService],
})
export class PuzzleRushModule {}
