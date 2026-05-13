import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MistakesController } from './mistakes.controller';
import { MistakesService } from './mistakes.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

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
 *
 * KS-2954 (ADR-061 §8): MCP — тот же section `puzzles` что и у
 * PuzzleModule. Логически часть раздела «задачи», но модуль исторически
 * отдельный (см. ADR-032 §4). DiscoveryService дедуплицирует section
 * при сборке каталога.
 */
@McpDiscoveryModule({
  section: 'puzzles',
  title: 'Шахматные задачи',
  description:
    'Дневник ошибок пользователя — задачи, в которых пользователь ' +
    'ошибся, для повторного решения. Часть раздела «puzzles».',
  defaultAuth: 'user',
})
@Module({
  imports: [PrismaModule],
  controllers: [MistakesController],
  providers: [MistakesService],
  exports: [MistakesService],
})
export class MistakesModule {}
