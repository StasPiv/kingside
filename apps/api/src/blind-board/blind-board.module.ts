import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BlindBoardController } from './blind-board.controller';
import { BlindBoardService } from './blind-board.service';

/**
 * KS-3441 / ADR-088 §11 B2. Модуль blind-board:
 * /blind-board/sessions, /blind-board/sessions/:id/answer,
 * /blind-board/leaderboard. Позиция держится только на сервере.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [BlindBoardController],
  providers: [BlindBoardService],
  exports: [BlindBoardService],
})
export class BlindBoardModule {}
