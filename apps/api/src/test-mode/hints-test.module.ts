/**
 * KS-4759 / ADR-150 T1. Модуль тестового режима для e2e hints.
 *
 * Условная регистрация через `forRoot()`: при `HINTS_TEST_MODE=1` —
 * `POST /test/seed/events`, `/test/clean-actor`, `/test/refresh-matviews`,
 * `/test/check-for` доступны. Без env-var controllers/providers пусты —
 * Nest не маршрутизирует, endpoints отвечают 404.
 *
 * `DynamicModule` важен для e2e: env-var выставляется в `setupFiles`
 * Jest'а ДО `Nest.compile()`. Если бы константа `enabled` читалась на
 * этапе import самого файла, она бы зафиксировалась до того как тесты
 * успели подменить env.
 *
 * Безопасность в проде: env-var не выставляется → endpoints не существуют.
 */
import { DynamicModule, Module } from '@nestjs/common';
// KS-4762: HintsModule экспортирует HintsService — нужен для
// `POST /test/check-for` proxy.
import { HintsModule } from '../hints/hints.module';
import { HintsTestController } from './hints-test.controller';
import { HintsTestService } from './hints-test.service';

@Module({})
export class HintsTestModule {
  static forRoot(): DynamicModule {
    const enabled = process.env.HINTS_TEST_MODE === '1';
    return {
      module: HintsTestModule,
      imports: enabled ? [HintsModule] : [],
      controllers: enabled ? [HintsTestController] : [],
      providers: enabled ? [HintsTestService] : [],
    };
  }
}
