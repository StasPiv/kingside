import { LessonsAdminLessonsController } from './lessons-admin-lessons.controller';

describe('LessonsAdminLessonsController (KS-1968)', () => {
  let service: any;
  let controller: LessonsAdminLessonsController;
  const courseId = '00000000-0000-4000-a000-000000000001';
  const lessonId = '00000000-0000-4000-a000-000000000002';

  beforeEach(() => {
    service = {
      createLesson: jest.fn().mockResolvedValue({ id: lessonId }),
      getLessonById: jest.fn().mockResolvedValue({ id: lessonId }),
      updateLesson: jest.fn().mockResolvedValue({ id: lessonId, title: 'x' }),
      deleteLesson: jest.fn().mockResolvedValue(undefined),
      reorderLessons: jest.fn().mockResolvedValue(undefined),
    };
    controller = new LessonsAdminLessonsController(service);
  });

  it('POST /courses/:courseId/lessons → service.createLesson(courseId, dto)', async () => {
    const dto = {
      slug: 'intro',
      blockKey: 'rules',
      kind: 'theory' as const,
      titleKey: 'k',
      summaryKey: 's',
    };
    await controller.create(courseId, dto as any);
    expect(service.createLesson).toHaveBeenCalledWith(courseId, dto);
  });

  it('GET /lessons/:id → service.getLessonById(id)', async () => {
    await controller.getById(lessonId);
    expect(service.getLessonById).toHaveBeenCalledWith(lessonId);
  });

  it('PATCH /lessons/:id → service.updateLesson(id, dto)', async () => {
    await controller.update(lessonId, { title: 'x' } as any);
    expect(service.updateLesson).toHaveBeenCalledWith(lessonId, { title: 'x' });
  });

  it('DELETE /lessons/:id → service.deleteLesson(id)', async () => {
    await controller.delete(lessonId);
    expect(service.deleteLesson).toHaveBeenCalledWith(lessonId);
  });

  it('POST /courses/:courseId/lessons/reorder → service.reorderLessons(courseId, dto)', async () => {
    await controller.reorder(courseId, { ids: ['a', 'b'] } as any);
    expect(service.reorderLessons).toHaveBeenCalledWith(courseId, { ids: ['a', 'b'] });
  });
});
