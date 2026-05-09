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

  it('GET /lessons/courses → coursesService.listCourses(userId)', async () => {
    coursesService.listCourses.mockResolvedValue({
      data: [],
      recommendedLevel: 'beginner',
    });
    const res = await controller.list(req, emptyQuery);
    // KS-2101: контроллер передаёт только userId, lang резолвится в сервисе
    // из User.locale (настройка профиля). Query/Accept-Language игнорируются.
    expect(coursesService.listCourses).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ data: [], recommendedLevel: 'beginner' });
    expect(userCoursesService.list).not.toHaveBeenCalled();
  });

  it('GET /lessons/courses/:slug → coursesService.getCourseBySlug(slug, userId)', async () => {
    const payload = { course: {} as any, lessons: [], progress: null };
    coursesService.getCourseBySlug.mockResolvedValue(payload as any);
    const res = await controller.getBySlug(req, 'beginner-basics');
    expect(coursesService.getCourseBySlug).toHaveBeenCalledWith(
      'beginner-basics',
      'user-1',
    );
    expect(res).toBe(payload);
  });

  it('передаёт userId=null, если пользователь анонимный', async () => {
    coursesService.listCourses.mockResolvedValue({ data: [] } as any);
    await controller.list(
      { user: undefined } as unknown as AuthenticatedRequest,
      emptyQuery,
    );
    expect(coursesService.listCourses).toHaveBeenCalledWith(null);
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
