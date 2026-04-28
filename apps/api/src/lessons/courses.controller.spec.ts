import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('CoursesController', () => {
  let controller: CoursesController;
  let service: jest.Mocked<CoursesService>;

  const req = {
    user: { id: 'user-1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    service = {
      listCourses: jest.fn(),
      getCourseBySlug: jest.fn(),
      recommendLevel: jest.fn(),
    } as unknown as jest.Mocked<CoursesService>;
    controller = new CoursesController(service);
  });

  it('GET /lessons/courses → service.listCourses(userId)', async () => {
    service.listCourses.mockResolvedValue({ data: [], recommendedLevel: 'beginner' });
    const res = await controller.list(req);
    // KS-2101: контроллер передаёт только userId, lang резолвится в сервисе
    // из User.locale (настройка профиля). Query/Accept-Language игнорируются.
    expect(service.listCourses).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ data: [], recommendedLevel: 'beginner' });
  });

  it('GET /lessons/courses/:slug → service.getCourseBySlug(slug, userId)', async () => {
    const payload = { course: {} as any, lessons: [], progress: null };
    service.getCourseBySlug.mockResolvedValue(payload as any);
    const res = await controller.getBySlug(req, 'beginner-basics');
    expect(service.getCourseBySlug).toHaveBeenCalledWith(
      'beginner-basics',
      'user-1',
    );
    expect(res).toBe(payload);
  });

  it('передаёт userId=null, если пользователь анонимный', async () => {
    service.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list({ user: undefined } as unknown as AuthenticatedRequest);
    expect(service.listCourses).toHaveBeenCalledWith(null);
  });
});
