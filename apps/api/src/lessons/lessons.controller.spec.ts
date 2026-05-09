import { NotFoundException } from '@nestjs/common';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { UserLessonsService } from './user-courses/user-lessons.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../common/authenticated-request';

describe('LessonsController', () => {
  let controller: LessonsController;
  let lessonsService: jest.Mocked<LessonsService>;
  let userLessonsService: jest.Mocked<UserLessonsService>;
  let prisma: { userLesson: { findUnique: jest.Mock } };

  const req = {
    user: { id: 'user-1', username: 'u1' },
  } as unknown as AuthenticatedRequest;

  beforeEach(() => {
    lessonsService = {
      getLessonWithSteps: jest.fn(),
    } as unknown as jest.Mocked<LessonsService>;
    userLessonsService = {
      getWithSteps: jest.fn(),
    } as unknown as jest.Mocked<UserLessonsService>;
    prisma = { userLesson: { findUnique: jest.fn() } };
    controller = new LessonsController(
      lessonsService,
      userLessonsService,
      prisma as unknown as PrismaService,
    );
  });

  it('GET /lessons/lessons/:id → lessonsService.getLessonWithSteps(id, userId)', async () => {
    const payload = { lesson: {} as any, steps: [], progress: null };
    lessonsService.getLessonWithSteps.mockResolvedValue(payload as any);
    const res = await controller.getOne(req, '00000000-0000-0000-0000-000000000001');
    expect(lessonsService.getLessonWithSteps).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'user-1',
    );
    expect(res).toBe(payload);
    expect(userLessonsService.getWithSteps).not.toHaveBeenCalled();
  });

  // ─── KS-2646 / ADR-054 Phase D fix — fallback на пользовательский урок ─

  it('fallback: системный NotFound → пользовательский, owner=true → 200', async () => {
    lessonsService.getLessonWithSteps.mockRejectedValue(
      new NotFoundException('not found'),
    );
    prisma.userLesson.findUnique.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000002',
      course: { ownerId: 'user-1', isPublic: false },
    });
    const expected = { lesson: { id: 'L1' } as any };
    userLessonsService.getWithSteps.mockResolvedValue(expected as any);

    const res = await controller.getOne(
      req,
      '00000000-0000-0000-0000-000000000002',
    );
    expect(res).toBe(expected);
    expect(userLessonsService.getWithSteps).toHaveBeenCalledWith(
      'user-1',
      '00000000-0000-0000-0000-000000000002',
    );
  });

  it('fallback: пользовательский урок публичного курса другого автора → 200', async () => {
    lessonsService.getLessonWithSteps.mockRejectedValue(
      new NotFoundException('not found'),
    );
    prisma.userLesson.findUnique.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000003',
      course: { ownerId: 'other-user', isPublic: true },
    });
    userLessonsService.getWithSteps.mockResolvedValue({} as any);

    await controller.getOne(req, '00000000-0000-0000-0000-000000000003');
    expect(userLessonsService.getWithSteps).toHaveBeenCalled();
  });

  it('fallback: чужой приватный урок → 404 (не раскрываем существование)', async () => {
    lessonsService.getLessonWithSteps.mockRejectedValue(
      new NotFoundException('not found'),
    );
    prisma.userLesson.findUnique.mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000004',
      course: { ownerId: 'other-user', isPublic: false },
    });

    await expect(
      controller.getOne(req, '00000000-0000-0000-0000-000000000004'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(userLessonsService.getWithSteps).not.toHaveBeenCalled();
  });

  it('fallback: пользовательского урока тоже нет → 404', async () => {
    lessonsService.getLessonWithSteps.mockRejectedValue(
      new NotFoundException('not found'),
    );
    prisma.userLesson.findUnique.mockResolvedValue(null);

    await expect(
      controller.getOne(req, '00000000-0000-0000-0000-000000000005'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(userLessonsService.getWithSteps).not.toHaveBeenCalled();
  });

  it('fallback не делается для анонима', async () => {
    lessonsService.getLessonWithSteps.mockRejectedValue(
      new NotFoundException('not found'),
    );
    const anonReq = { user: undefined } as unknown as AuthenticatedRequest;
    await expect(
      controller.getOne(anonReq, '00000000-0000-0000-0000-000000000006'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.userLesson.findUnique).not.toHaveBeenCalled();
    expect(userLessonsService.getWithSteps).not.toHaveBeenCalled();
  });

  it('не-NotFound ошибки от системного пробрасываются как есть (без fallback)', async () => {
    lessonsService.getLessonWithSteps.mockRejectedValue(
      new Error('database down'),
    );
    await expect(
      controller.getOne(req, '00000000-0000-0000-0000-000000000007'),
    ).rejects.toThrow('database down');
    expect(prisma.userLesson.findUnique).not.toHaveBeenCalled();
  });
});
