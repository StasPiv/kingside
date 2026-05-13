import { Module } from '@nestjs/common';
import { ChessResultsService } from './chess-results.service';
import { LivechesscloudService } from './livechesscloud.service';
import { McpModule as McpDiscoveryModule } from '../mcp/decorators';

/**
 * LiveTournamentModule — отдельный продуктовый домен для live-турниров
 * из `chess-results.com` / `view.livechesscloud.com`. Это **не** Lichess
 * broadcasts (у broadcasts свой сервис `broadcasts.kingside.site`,
 * см. ADR-021). Сервисы парсят внешние HTML/HTTP-источники и пишут в
 * модель `LiveTournament` (таблица `live_tournaments`, packages/db).
 *
 * Потребители:
 *   - `apps/api/src/live-tournament/scan-chess-results.ts` — CLI-скрипт
 *     для scheduled наполнения.
 *   - Читатель данных — `TournamentService.getLiveTournaments()` через
 *     `prisma.liveTournament.findMany` (без прямой DI-зависимости от
 *     этих сервисов, поэтому `exports` нужны только для будущих
 *     потребителей, включая сам CLI).
 *
 * Раньше сервисы жили в `apps/api/src/broadcast/chess-results/` вместе
 * с `BroadcastModule`. При выносе broadcasts в `apps/broadcast-service`
 * (ADR-021 §2.1, KS-1697) они остались в apps/api, так как про другой
 * домен. Перемещены в отдельный модуль чтобы `BroadcastModule` после
 * cleanup'а (M2) можно было удалить целиком без dangling-провайдеров.
 */
// KS-2954 (ADR-061 §8): MCP-секция `live_tournaments`. Сам модуль не
// имеет HTTP-контроллеров (только сервисы для парсинга внешних
// источников), но секция нужна для системного промта ассистента —
// чтобы он знал про раздел и направлял к /tournaments?live=1 в
// TournamentController.
@McpDiscoveryModule({
  section: 'live_tournaments',
  title: 'Live-турниры',
  description:
    'Live-турниры из внешних источников (chess-results.com, ' +
    'livechesscloud). HTTP-эндпоинты живут в разделе tournaments; ' +
    'этот раздел существует для системного промта ассистента.',
  defaultAuth: 'public',
})
@Module({
  providers: [ChessResultsService, LivechesscloudService],
  exports: [ChessResultsService, LivechesscloudService],
})
export class LiveTournamentModule {}
