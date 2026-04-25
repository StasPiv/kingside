import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MistakesController } from './mistakes.controller';
import { MistakesService } from './mistakes.service';

/**
 * MistakesModule — дневник ошибок пользователя (KS-1802 / L-31).
 *
 * KS-1927 / ADR-032 §4: модуль перенесён в `puzzle/` namespace,
 * URL-префикс изменён с `/lessons/mistakes/*` на `/puzzle/mistakes/*`.
 * Логика, схема (`UserMistake`) и shape API остались прежними.
 *
 * Импортируется из `app.module.ts`. `PuzzleModule` тоже импортирует
 * этот модуль, чтобы получить `MistakesService` для хука
 * `recordPuzzleMistake` в `PuzzleService`. Цикла зависимостей нет:
 * `MistakesModule` не зависит от `PuzzleModule`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MistakesController],
  providers: [MistakesService],
  exports: [MistakesService],
})
export class MistakesModule {}
