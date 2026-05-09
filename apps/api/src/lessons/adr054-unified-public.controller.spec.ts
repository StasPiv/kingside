/**
 * KS-2646 / ADR-054 Phase D fix — тесты публичного unified-роута
 * `/lessons/courses/authors`.
 */

import { Adr054UnifiedCoursesPublicController } from './adr054-unified-public.controller';
import { UserCoursesService } from './user-courses/user-courses.service';
import type { ListCourseAuthorsQueryDto } from './user-courses/dto/user-course.dto';

describe('Adr054UnifiedCoursesPublicController — KS-2646', () => {
  let controller: Adr054UnifiedCoursesPublicController;
  let service: jest.Mocked<UserCoursesService>;

  beforeEach(() => {
    service = {
      listAuthors: jest.fn(),
    } as unknown as jest.Mocked<UserCoursesService>;
    controller = new Adr054UnifiedCoursesPublicController(service);
  });

  it('GET /lessons/courses/authors → service.listAuthors(query)', async () => {
    service.listAuthors.mockResolvedValue({ data: [], total: 0 } as any);
    const dto = {
      sort: 'recent',
      limit: 20,
      offset: 0,
    } as unknown as ListCourseAuthorsQueryDto;
    const res = await controller.listAuthors(dto);
    expect(service.listAuthors).toHaveBeenCalledWith({
      sort: 'recent',
      limit: 20,
      offset: 0,
    });
    expect(res).toEqual({ data: [], total: 0 });
  });

  it('GET /lessons/courses/authors без query → дефолты сервиса', async () => {
    service.listAuthors.mockResolvedValue({ data: [], total: 0 } as any);
    const dto = {} as unknown as ListCourseAuthorsQueryDto;
    await controller.listAuthors(dto);
    expect(service.listAuthors).toHaveBeenCalledWith({
      sort: undefined,
      limit: undefined,
      offset: undefined,
    });
  });
});
