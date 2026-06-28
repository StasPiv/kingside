/**
 * KS-4759 / ADR-150 T1. Модуль тестового режима для e2e hints.
 *
 * Условная регистрация контроллера: при `HINTS_TEST_MODE=1` —
 * `POST /test/seed/events`, `/test/clean-actor`, `/test/refresh-matviews`
 * доступны. Без env-var модуль импортируется, но controllers пуст —
 * Nest не маршрутизирует, endpoints отвечают 404.
 *
 * Это минимизирует риск случайно «оставить test-endpoint в проде»:
 * даже если задеплоен с этим модулем, без env они невидимы.
 */
import { Module } from '@nestjs/common';
import { HintsTestController } from './hints-test.controller';
import { HintsTestService } from './hints-test.service';

const enabled = process.env.HINTS_TEST_MODE === '1';

@Module({
  controllers: enabled ? [HintsTestController] : [],
  providers: enabled ? [HintsTestService] : [],
})
export class HintsTestModule {}
