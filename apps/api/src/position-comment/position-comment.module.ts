import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PositionCommentController } from './position-comment.controller';
import { PositionCommentService } from './position-comment.service';
import { MaiaService } from './maia.service';
import { ForcedLineRollerService } from './forced-line-roller.service';
import { FactorsRebuilderService } from './factors-rebuilder.service';

@Module({
  imports: [AuthModule],
  controllers: [PositionCommentController],
  providers: [
    PositionCommentService,
    MaiaService,
    ForcedLineRollerService,
    FactorsRebuilderService,
  ],
})
export class PositionCommentModule {}
