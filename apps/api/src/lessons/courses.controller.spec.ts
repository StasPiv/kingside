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

  it('GET /lessons/courses → service.listCourses(userId, lang) (KS-2095)', async () => {
    service.listCourses.mockResolvedValue({ data: [], recommendedLevel: 'beginner' });
    const res = await controller.list(req);
    // default lang='ru' (нет query, нет Accept-Language)
    expect(service.listCourses).toHaveBeenCalledWith('user-1', 'ru');
    expect(res).toEqual({ data: [], recommendedLevel: 'beginner' });
  });

  it('GET /lessons/courses?lang=en → передаёт lang=en', async () => {
    service.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(req, 'en');
    expect(service.listCourses).toHaveBeenCalledWith('user-1', 'en');
  });

  it('Accept-Language=en-US → lang=en (KS-2095 fallback)', async () => {
    service.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(req, undefined, 'en-US,en;q=0.9,ru;q=0.8');
    expect(service.listCourses).toHaveBeenCalledWith('user-1', 'en');
  });

  it('query lang приоритетнее Accept-Language', async () => {
    service.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(req, 'ru', 'en-US');
    expect(service.listCourses).toHaveBeenCalledWith('user-1', 'ru');
  });

  it('неизвестный lang → fallback ru', async () => {
    service.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(req, 'fr' as any);
    expect(service.listCourses).toHaveBeenCalledWith('user-1', 'ru');
  });

  it('GET /lessons/courses/:slug → service.getCourseBySlug(slug, userId, lang)', async () => {
    const payload = { course: {} as any, lessons: [], progress: null };
    service.getCourseBySlug.mockResolvedValue(payload as any);
    const res = await controller.getBySlug(req, 'beginner-basics', 'en');
    expect(service.getCourseBySlug).toHaveBeenCalledWith(
      'beginner-basics',
      'user-1',
      'en',
    );
    expect(res).toBe(payload);
  });

  it('передаёт userId=null, если пользователь анонимный', async () => {
    service.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list({ user: undefined } as unknown as AuthenticatedRequest);
    expect(service.listCourses).toHaveBeenCalledWith(null, 'ru');
  });
});
