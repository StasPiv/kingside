import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MistakesController } from './mistakes.controller';

/**
 * Регрессионный гард на URL-префикс mistakes-эндпоинтов после
 * переноса (KS-1927 / ADR-032 §4):
 *   `/lessons/mistakes/*` → `/puzzle/mistakes/*`.
 *
 * Старый префикс — пользовательская поверхность, его смена ломает
 * клиентов; этот тест ловит регрессию декоратора до прода. Метод-уровень
 * `@Get('aggregates')` / `@Get('recommendations')` тоже запинен.
 */
describe('MistakesController — URL prefix (KS-1927)', () => {
  it('класс-уровень `@Controller` смонтирован на `puzzle/mistakes`', () => {
    const path = Reflect.getMetadata(PATH_METADATA, MistakesController);
    expect(path).toBe('puzzle/mistakes');
  });

  it('методы — `aggregates` и `recommendations`', () => {
    const aggregatesPath = Reflect.getMetadata(
      PATH_METADATA,
      MistakesController.prototype.getAggregates,
    );
    const recommendationsPath = Reflect.getMetadata(
      PATH_METADATA,
      MistakesController.prototype.getRecommendations,
    );
    // В Nest path-метаданные на handler'е лежат в виде массива
    // (поддержка нескольких path'ов на один method).
    expect(([] as string[]).concat(aggregatesPath)).toContain('aggregates');
    expect(([] as string[]).concat(recommendationsPath)).toContain(
      'recommendations',
    );
  });

  // Старый префикс `lessons/mistakes` НЕ должен оставаться в декораторе:
  // если кто-то скопипастил controller обратно в `lessons/`, этот тест
  // загорится. ADR-032 явно требует, чтобы старый URL отдавал 404 (не
  // редирект на бэке) — это обеспечивается отсутствием декоратора с
  // этим path в любом контроллере.
  it('класс-уровень `@Controller` НЕ смонтирован на старом `lessons/mistakes`', () => {
    const path = Reflect.getMetadata(PATH_METADATA, MistakesController);
    expect(path).not.toBe('lessons/mistakes');
  });
});
