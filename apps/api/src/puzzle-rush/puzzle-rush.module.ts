import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PuzzleRushController } from './puzzle-rush.controller';
import { PuzzleRushService } from './puzzle-rush.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `puzzle_rush` — режим с таймером,
// рекорды, история, лидерборды.
@McpDiscoveryModule({
  section: 'puzzle_rush',
  title: 'Puzzle Rush',
  description:
    'Режим решения задач на скорость с таймером (3/5 минут). ' +
    'Рекорды пользователя, история сессий, публичные лидерборды.',
  defaultAuth: 'optional',
})
@Module({
  imports: [AuthModule],
  controllers: [PuzzleRushController],
  providers: [PuzzleRushService],
  exports: [PuzzleRushService],
})
export class PuzzleRushModule {}
