/**
 * KS-4759 / ADR-150 T1. HTTP-эндпоинты тестового режима.
 *
 * Безопасность: модуль регистрируется в AppModule условно
 * (`HINTS_TEST_MODE === '1'`). Без env-var контроллер не маршрутизируется
 * и эндпоинты отвечают 404. На проде env-var не выставляется.
 */
import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
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

class TestEmitHintBodyDto {
  @ValidateNested()
  @Type(() => TestActorDto)
  actor!: TestActorDto;

  @IsOptional()
  @IsString()
  page?: string;
}

class TestIssueGuestCookiesBodyDto {
  @IsOptional()
  @IsUUID()
  guest_id?: string;
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

  /**
   * KS-4763 / T6. Триггер reactive-цепи через прямой вызов
   * `HintsService.checkFor`. Аналогичен check-for, но семантически
   * подчёркивает «эмитни ws hint:show если matched». Под капотом
   * checkFor уже эмитит для user-actor через MessageGateway, поэтому
   * метод не дублирует emit, а лишь возвращает факт ({ key, emitted }).
   */
  @Post('emit-hint')
  @HttpCode(200)
  emitHint(@Body() body: TestEmitHintBodyDto): Promise<{ key: string | null; emitted: boolean }> {
    return this.svc.emitHint(body.actor, { page: body.page });
  }

  /**
   * KS-4763 / T6. Выпуск подписанных guest cookies (analytics_consent
   * + signature + guest_id). Без этого e2e гостевые сценарии не
   * проходят: `GuestIdMiddleware` без валидной подписи `req.guestId=null`.
   * Логика идентична `GuestPublicController.consent({analytics:true})`.
   */
  @Post('issue-guest-cookies')
  @HttpCode(200)
  issueGuestCookies(
    @Body() body: TestIssueGuestCookiesBodyDto,
    @Res({ passthrough: true }) res: Response,
  ): { guest_id: string; expires_in_sec: number } {
    return this.svc.issueGuestCookies(res, body.guest_id);
  }
}
