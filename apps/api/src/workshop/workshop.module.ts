import { Module } from '@nestjs/common';
import { WorkshopController } from './workshop.controller';
import { WorkshopService } from './workshop.service';
import { ExternalChessService } from './external-chess.service';

@Module({
  controllers: [WorkshopController],
  providers: [WorkshopService, ExternalChessService],
  exports: [ExternalChessService],
})
export class WorkshopModule {}
