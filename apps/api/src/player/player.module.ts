import { Module } from '@nestjs/common';
import { PlayerController } from './player.controller';
import { PlayerService } from './player.service';
import { UserCoursesModule } from '../lessons/user-courses/user-courses.module';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `players` — публичные профили игроков.
@McpDiscoveryModule({
  section: 'players',
  title: 'Игроки',
  description:
    'Публичные профили других игроков платформы: статистика, рейтинги, ' +
    'сыгранные партии, публичные курсы пользователя. Сюда — если ' +
    'пользователь хочет посмотреть чужой профиль или найти соперника.',
  defaultAuth: 'public',
})
@Module({
  // KS-1914: импортируем `UserCoursesModule` ради
  // `UserCoursesService.listPublicByOwner` — `PlayerService` делегирует
  // в него для эндпоинта `GET /players/:username/courses`.
  imports: [UserCoursesModule],
  controllers: [PlayerController],
  providers: [PlayerService],
})
export class PlayerModule {}
