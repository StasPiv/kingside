/**
 * KS-4759 / ADR-150 T1. HTTP-эндпоинты тестового режима.
 *
 * Безопасность: модуль регистрируется в AppModule условно
 * (`HINTS_TEST_MODE === '1'`). Без env-var контроллер не маршрутизируется
 * и эндпоинты отвечают 404. На проде env-var не выставляется.
 */
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { HintsTestService } from './hints-test.service';
import {
  TestCleanActorBodyDto,
  TestSeedEventsBodyDto,
} from './dto/test-seed-events.dto';

@Controller('test')
export class HintsTestController {
  constructor(private readonly svc: HintsTestService) {}

  @Post('seed/events')
  @HttpCode(200)
  seed(@Body() body: TestSeedEventsBodyDto): Promise<{ inserted: number }> {
    return this.svc.seedEvents(body.actor, body.events);
  }

  @Post('clean-actor')
  @HttpCode(200)
  clean(@Body() body: TestCleanActorBodyDto): Promise<{
    eventsDeleted: number;
    statesDeleted: number;
    redisKeysDeleted: number;
  }> {
    return this.svc.cleanActor(body.actor);
  }

  @Post('refresh-matviews')
  @HttpCode(200)
  refresh(): Promise<{ refreshed: string[] }> {
    return this.svc.refreshMatviews();
  }
}
