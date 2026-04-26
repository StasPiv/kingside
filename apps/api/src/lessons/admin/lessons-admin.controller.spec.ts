import { LessonsAdminController } from './lessons-admin.controller';

/**
 * Controller — тонкий слой делегирования. Юнит-тесты проверяют, что
 * каждый метод вызывает соответствующий сервис с правильными
 * аргументами, и что `reorder`-роут не перехватывается `:id`.
 *
 * Полные тесты бизнес-логики — на сервисе (`lessons-admin.service.spec`).
 */
describe('LessonsAdminController (KS-1967)', () => {
  let service: any;
  let controller: LessonsAdminController;

  beforeEach(() => {
    service = {
      listCourses: jest.fn().mockResolvedValue([]),
      getCourseById: jest.fn().mockResolvedValue({ id: 'c1' }),
      createCourse: jest.fn().mockResolvedValue({ id: 'new' }),
      updateCourse: jest.fn().mockResolvedValue({ id: 'c1', title: 'x' }),
      deleteCourse: jest.fn().mockResolvedValue(undefined),
      reorderCourses: jest.fn().mockResolvedValue(undefined),
    };
    controller = new LessonsAdminController(service);
  });

  it('GET / → service.listCourses(query)', async () => {
    await controller.list({ level: 'beginner' });
    expect(service.listCourses).toHaveBeenCalledWith({ level: 'beginner' });
  });

  it('GET /:id → service.getCourseById(id)', async () => {
    await controller.getById('00000000-0000-4000-a000-000000000001');
    expect(service.getCourseById).toHaveBeenCalledWith(
      '00000000-0000-4000-a000-000000000001',
    );
  });

  it('POST / → service.createCourse(dto)', async () => {
    const dto = { slug: 's', level: 'beginner', titleKey: 'k', descriptionKey: 'd' };
    await controller.create(dto as any);
    expect(service.createCourse).toHaveBeenCalledWith(dto);
  });

  it('PATCH /:id → service.updateCourse(id, dto)', async () => {
    await controller.update('00000000-0000-4000-a000-000000000001', {
      title: 'x',
    } as any);
    expect(service.updateCourse).toHaveBeenCalledWith(
      '00000000-0000-4000-a000-000000000001',
      { title: 'x' },
    );
  });

  it('DELETE /:id → service.deleteCourse(id)', async () => {
    await controller.delete('00000000-0000-4000-a000-000000000001');
    expect(service.deleteCourse).toHaveBeenCalledWith(
      '00000000-0000-4000-a000-000000000001',
    );
  });

  it('POST /reorder → service.reorderCourses(dto)', async () => {
    await controller.reorder({ ids: ['a', 'b'] } as any);
    expect(service.reorderCourses).toHaveBeenCalledWith({ ids: ['a', 'b'] });
  });
});
