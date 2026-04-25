import { Test, TestingModule } from '@nestjs/testing';
import { UserCoursesPublicController } from './user-courses-public.controller';
import { UserCoursesService } from './user-courses.service';

/**
 * Smoke-test публичного контроллера (KS-1918). Проверяет, что:
 *  - метод подключён правильно (без JWT-guard'а на классе);
 *  - query-параметры пробрасываются в сервис без потерь.
 */
describe('UserCoursesPublicController (KS-1918)', () => {
  let controller: UserCoursesPublicController;
  let service: { listAuthors: jest.Mock };

  beforeEach(async () => {
    service = {
      listAuthors: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserCoursesPublicController],
      providers: [{ provide: UserCoursesService, useValue: service }],
    }).compile();

    controller = module.get<UserCoursesPublicController>(
      UserCoursesPublicController,
    );
  });

  it('GET /authors без query — service.listAuthors вызван с дефолтами (undefined)', async () => {
    const r = await controller.listAuthors({} as never);
    expect(r).toEqual({ data: [], total: 0 });
    expect(service.listAuthors).toHaveBeenCalledWith({
      sort: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /authors?sort=recent&limit=12&offset=5 — параметры проброшены', async () => {
    await controller.listAuthors({
      sort: 'recent',
      limit: 12,
      offset: 5,
    } as never);
    expect(service.listAuthors).toHaveBeenCalledWith({
      sort: 'recent',
      limit: 12,
      offset: 5,
    });
  });

  // KS-1918: класс не имеет `@UseGuards(JwtAuthGuard)` — публичный
  // эндпоинт. Reflect-метаданные подтверждают это: ни на классе, ни
  // на методе нет guard'ов.
  it('контроллер без класс-уровневого JwtAuthGuard (публичный)', () => {
    const classGuards =
      Reflect.getMetadata('__guards__', UserCoursesPublicController) ?? [];
    expect(classGuards).toEqual([]);
    const methodGuards =
      Reflect.getMetadata(
        '__guards__',
        UserCoursesPublicController.prototype.listAuthors,
      ) ?? [];
    expect(methodGuards).toEqual([]);
  });
});
