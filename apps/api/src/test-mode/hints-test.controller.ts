/**
 * KS-4759 / ADR-150 T1. HTTP-эндпоинты тестового режима.
 *
 * Безопасность: модуль регистрируется в AppModule условно
 * (`HINTS_TEST_MODE === '1'`). Без env-var контроллер не маршрутизируется
 * и эндпоинты отвечают 404. На проде env-var не выставляется.
 */
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { HintsTestService } from './hints-test.service';
import {
  TestActorDto,
  TestCleanActorBodyDto,
  TestSeedEventsBodyDto,
} from './dto/test-seed-events.dto';

class TestCheckForBodyDto {
  @ValidateNested()
  @Type(() => TestActorDto)
  actor!: TestActorDto;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  triggerEventType?: string;
}

class TestEvaluateRuleBodyDto {
  @ValidateNested()
  @Type(() => TestActorDto)
  actor!: TestActorDto;

  @IsOptional()
  @IsString()
  page?: string;

  @IsString()
  key!: string;
}

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

  /**
   * KS-4762 / ADR-150 T4. Proxy к `HintsService.checkFor` —
   * возвращает ключ выбранного hint'а или null. Только для e2e suite.
   */
  @Post('check-for')
  @HttpCode(200)
  checkFor(@Body() body: TestCheckForBodyDto): Promise<{ key: string | null }> {
    return this.svc.checkFor(body.actor, {
      page: body.page,
      triggerEventType: body.triggerEventType,
    });
  }

  /**
   * KS-4762 / ADR-150 T4. Эвалюация одного правила по key,
   * минуя приоритезацию и per-hint лимиты HintsService.checkFor.
   */
  @Post('evaluate-rule')
  @HttpCode(200)
  evaluateRule(@Body() body: TestEvaluateRuleBodyDto): Promise<{ matched: boolean }> {
    return this.svc.evaluateRuleByKey(body.actor, { page: body.page }, body.key);
  }
}
