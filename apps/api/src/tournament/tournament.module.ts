import { Module } from '@nestjs/common';
import { TournamentController } from './tournament.controller';
import { TournamentService } from './tournament.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

// KS-2954 (ADR-061 §8): MCP-секция `tournaments` — список турниров,
// регистрация, расписание. Live-турниры читаются здесь же через
// TournamentService.getLiveTournaments (см. LiveTournamentModule).
@McpDiscoveryModule({
  section: 'tournaments',
  title: 'Турниры',
  description:
    'Список турниров платформы и live-турниров с внешних источников, ' +
    'регистрация пользователя, расписание и таблицы. Сюда — если ' +
    'пользователь хочет участвовать или смотреть текущие турниры.',
  defaultAuth: 'optional',
})
@Module({
  controllers: [TournamentController],
  providers: [TournamentService],
})
export class TournamentModule {}
