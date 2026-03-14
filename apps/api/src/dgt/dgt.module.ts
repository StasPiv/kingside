import { Module } from '@nestjs/common';
import { DgtController } from './dgt.controller';
import { DgtService } from './dgt.service';

@Module({
  controllers: [DgtController],
  providers: [DgtService],
  exports: [DgtService],
})
export class DgtModule {}
