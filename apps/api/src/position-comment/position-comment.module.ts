import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PositionCommentController } from './position-comment.controller';
import { PositionCommentService } from './position-comment.service';

@Module({
  imports: [AuthModule],
  controllers: [PositionCommentController],
  providers: [PositionCommentService],
})
export class PositionCommentModule {}
