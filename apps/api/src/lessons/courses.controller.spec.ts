import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { UserCoursesService } from './user-courses/user-courses.service';
import type { ListUserCoursesQueryDto } from './user-courses/dto/user-course.dto';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('CoursesController', () => {
  let controller: CoursesController;
  let coursesService: jest.Mocked<CoursesService>;
  let userCoursesService: jest.Mocked<UserCoursesService>;

  const req = {
    user: { id: 'user-1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  const emptyQuery = {} as ListUserCoursesQueryDto;

  beforeEach(() => {
    coursesService = {
      listCourses: jest.fn(),
      getCourseBySlug: jest.fn(),
      recommendLevel: jest.fn(),
    } as unknown as jest.Mocked<CoursesService>;
    userCoursesService = {
      list: jest.fn(),
      getBySlug: jest.fn(),
      listEnrolled: jest.fn(),
    } as unknown as jest.Mocked<UserCoursesService>;
    controller = new CoursesController(coursesService, userCoursesService);
  });

  it('GET /lessons/courses → coursesService.listCourses(userId, undefined)', async () => {
    coursesService.listCourses.mockResolvedValue({
      data: [],
      recommendedLevel: 'beginner',
    });
    const res = await controller.list(req, emptyQuery);
    // KS-4145: query `?locale=` теперь передаётся как 3-й параметр.
    // Без него — undefined; сервис фолбэкается на User.locale → 'en'.
    expect(coursesService.listCourses).toHaveBeenCalledWith('user-1', undefined);
    expect(res).toEqual({ data: [], recommendedLevel: 'beginner' });
    expect(userCoursesService.list).not.toHaveBeenCalled();
  });

  it('GET /lessons/courses?locale=en → query locale пробрасывается в сервис', async () => {
    coursesService.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(req, emptyQuery, 'en');
    expect(coursesService.listCourses).toHaveBeenCalledWith('user-1', 'en');
  });

  it('GET /lessons/courses/:slug → coursesService.getCourseBySlug(slug, userId, undefined)', async () => {
    const payload = { course: {} as any, lessons: [], progress: null };
    coursesService.getCourseBySlug.mockResolvedValue(payload as any);
    const res = await controller.getBySlug(req, 'beginner-basics');
    expect(coursesService.getCourseBySlug).toHaveBeenCalledWith(
      'beginner-basics',
      'user-1',
      undefined,
    );
    expect(res).toBe(payload);
  });

  it('GET /lessons/courses/:slug?locale=en → locale пробрасывается', async () => {
    const payload = { course: {} as any, lessons: [], progress: null };
    coursesService.getCourseBySlug.mockResolvedValue(payload as any);
    await controller.getBySlug(req, 'beginner-basics', 'en');
    expect(coursesService.getCourseBySlug).toHaveBeenCalledWith(
      'beginner-basics',
      'user-1',
      'en',
    );
  });

  it('передаёт userId=null, если пользователь анонимный', async () => {
    coursesService.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(
      { user: undefined } as unknown as AuthenticatedRequest,
      emptyQuery,
    );
    expect(coursesService.listCourses).toHaveBeenCalledWith(null, undefined);
  });

  // ─── KS-2643 / ADR-054 Phase C2 ─────────────────────────────────────

  it('GET /lessons/courses?mine=1 → userCoursesService.list({mine:true})', async () => {
    userCoursesService.list.mockResolvedValue({ data: [] } as any);
    const query: ListUserCoursesQueryDto = { mine: '1' } as ListUserCoursesQueryDto;
    await controller.list(req, query);
    expect(userCoursesService.list).toHaveBeenCalledWith('user-1', {
      mine: true,
      limit: undefined,
      offset: undefined,
    });
    expect(coursesService.listCourses).not.toHaveBeenCalled();
  });

  it('GET /lessons/courses?mine=0 → userCoursesService.list({mine:false})', async () => {
    userCoursesService.list.mockResolvedValue({ data: [] } as any);
    const query: ListUserCoursesQueryDto = { mine: '0' } as ListUserCoursesQueryDto;
    await controller.list(req, query);
    expect(userCoursesService.list).toHaveBeenCalledWith('user-1', {
      mine: false,
      limit: undefined,
      offset: undefined,
    });
  });

  it('GET /lessons/courses/:slug fallback на userCoursesService при NotFoundException', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    coursesService.getCourseBySlug.mockRejectedValue(
      new NotFoundException('not found'),
    );
    const userCoursePayload = { course: { id: 'u1' } } as any;
    userCoursesService.getBySlug.mockResolvedValue(userCoursePayload);
    const res = await controller.getBySlug(req, 'my-course');
    // userCoursesService.getBySlug сигнатура не изменилась; locale там
    // не учитывается (пользовательские курсы хранятся без lang-вариантов).
    expect(userCoursesService.getBySlug).toHaveBeenCalledWith('user-1', 'my-course');
    expect(res).toBe(userCoursePayload);
  });

  it('GET /lessons/courses/:slug — для анонима fallback не делается', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    coursesService.getCourseBySlug.mockRejectedValue(new NotFoundException('not found'));
    await expect(
      controller.getBySlug(
        { user: undefined } as unknown as AuthenticatedRequest,
        'my-course',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(userCoursesService.getBySlug).not.toHaveBeenCalled();
  });

  // ─── KS-2646 / ADR-054 Phase D fix ───────────────────────────────────

  it('GET /lessons/courses/enrolled → userCoursesService.listEnrolled(userId)', async () => {
    userCoursesService.listEnrolled.mockResolvedValue({ data: [] } as any);
    const res = await controller.listEnrolled(req);
    expect(userCoursesService.listEnrolled).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ data: [] });
    // KS-2646: не должно проходить через getBySlug или listCourses.
    expect(coursesService.getCourseBySlug).not.toHaveBeenCalled();
    expect(coursesService.listCourses).not.toHaveBeenCalled();
  });
});
