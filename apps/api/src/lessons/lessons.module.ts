import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PuzzleModule } from '../puzzle/puzzle.module';
import { CoursesController } from './courses.controller';
import { LessonsController } from './lessons.controller';
import { ProgressController } from './progress.controller';
import { PuzzleResolverController } from './puzzle-resolver.controller';
import { LevelGateController } from './level-gate.controller';
import { CoursesService } from './courses.service';
import { LessonsService } from './lessons.service';
import { ProgressService } from './progress.service';
import { LessonPuzzleResolverService } from './puzzle-resolver.service';
import { LevelGateService } from './level-gate.service';

/**
 * LessonsModule — тонкий слой над существующими доменами (ADR-024 §2.5):
 *  - `PuzzleModule` импортируется, потому что `PuzzleStep` в уроках
 *    обращается к задачам и попыткам через `PuzzleService` / `PuzzleRatingService`
 *    (в L-04 ещё не вызываем напрямую, но импорт фиксирует зависимость и
 *    делает сервисы доступными для будущих шагов цикла — L-08..L-11).
 *  - `AnalysisModule`, `WorkshopModule`, `EngineModule` подключим по мере
 *    появления соответствующих типов шагов (`game_review` — итерация 3).
 */
@Module({
  imports: [PrismaModule, PuzzleModule],
  controllers: [CoursesController, LessonsController, ProgressController, PuzzleResolverController, LevelGateController],
  providers: [CoursesService, LessonsService, ProgressService, LessonPuzzleResolverService, LevelGateService],
  exports: [CoursesService, LessonsService, ProgressService, LessonPuzzleResolverService, LevelGateService],
})
export class LessonsModule {}
