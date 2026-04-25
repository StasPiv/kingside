import { Module } from '@nestjs/common';
import { PlayerController } from './player.controller';
import { PlayerService } from './player.service';
import { UserCoursesModule } from '../lessons/user-courses/user-courses.module';

@Module({
  // KS-1914: импортируем `UserCoursesModule` ради
  // `UserCoursesService.listPublicByOwner` — `PlayerService` делегирует
  // в него для эндпоинта `GET /players/:username/courses`.
  imports: [UserCoursesModule],
  controllers: [PlayerController],
  providers: [PlayerService],
})
export class PlayerModule {}
