import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MistakesController } from './mistakes.controller';
import { MistakesService } from './mistakes.service';

/**
 * MistakesModule — вынесен из `LessonsModule`, чтобы его мог импортировать
 * `PuzzleModule` для хука `recordPuzzleMistake` без циклических зависимостей
 * (LessonsModule сам уже импортирует PuzzleModule).
 */
@Module({
  imports: [PrismaModule],
  controllers: [MistakesController],
  providers: [MistakesService],
  exports: [MistakesService],
})
export class MistakesModule {}
