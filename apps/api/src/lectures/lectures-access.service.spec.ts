/**
 * KS-3931 / ADR-118 §2.3. Unit-тесты резолвера доступа `LecturesAccessService`.
 * Покрытие всех веток ADR-логики:
 *   1. owner — независимо от visibility.
 *   2. visibility=public — любой зритель (anon + auth).
 *   3. visibility=unlisted — любой зритель (anon + auth).
 *   4. visibility=restricted:
 *      4a. анонимный → denied (auth_required).
 *      4b. авторизованный, есть grant → allowed (allowlisted).
 *      4c. авторизованный, нет grant'а → denied (not_in_allowlist).
 *   5. SQL-уровень: запрос идёт по индексу (lectureId, subjectType='user', subjectId).
 *   6. Защитная ветка: неизвестный visibility → denied.
 */

import { HttpException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  LecturesAccessService,
  type LectureForAccessCheck,
} from './lectures-access.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LecturesAccessService.resolveLectureAccess', () => {
  let service: LecturesAccessService;
  let prisma: {
    lecture: {
      findUnique: jest.Mock;
    };
    lectureAccessGrant: {
      findFirst: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      lecture: {
        findUnique: jest.fn(),
      },
      lectureAccessGrant: {
        findFirst: jest.fn(),
      },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        LecturesAccessService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(LecturesAccessService);
  });

  /** Helper: лекция-заглушка для конкретного visibility. */
  function lec(
    overrides: Partial<LectureForAccessCheck> = {},
  ): LectureForAccessCheck {
    return {
      id: 'lec-1',
      ownerId: 'owner-1',
      visibility: 'public',
      ...overrides,
    };
  }

  // ─── 1. owner ─────────────────────────────────────────────────────

  it('owner: visibility=public → allowed (owner)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'public' }),
      'owner-1',
    );
    expect(r).toEqual({ allowed: true, reason: 'owner' });
    expect(prisma.lectureAccessGrant.findFirst).not.toHaveBeenCalled();
  });

  it('owner: visibility=unlisted → allowed (owner)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'unlisted' }),
      'owner-1',
    );
    expect(r).toEqual({ allowed: true, reason: 'owner' });
  });

  it('owner: visibility=restricted → allowed (owner) без запроса в allowlist', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'restricted' }),
      'owner-1',
    );
    expect(r).toEqual({ allowed: true, reason: 'owner' });
    expect(prisma.lectureAccessGrant.findFirst).not.toHaveBeenCalled();
  });

  // ─── 2. public ────────────────────────────────────────────────────

  it('public: анонимный → allowed (public)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'public' }),
      null,
    );
    expect(r).toEqual({ allowed: true, reason: 'public' });
    expect(prisma.lectureAccessGrant.findFirst).not.toHaveBeenCalled();
  });

  it('public: авторизованный не-владелец → allowed (public)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'public' }),
      'other-user',
    );
    expect(r).toEqual({ allowed: true, reason: 'public' });
  });

  // ─── 3. unlisted ──────────────────────────────────────────────────

  it('unlisted: анонимный → allowed (unlisted)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'unlisted' }),
      null,
    );
    expect(r).toEqual({ allowed: true, reason: 'unlisted' });
  });

  it('unlisted: авторизованный не-владелец → allowed (unlisted)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'unlisted' }),
      'other-user',
    );
    expect(r).toEqual({ allowed: true, reason: 'unlisted' });
  });

  // ─── 4. restricted ────────────────────────────────────────────────

  it('restricted: анонимный → denied (auth_required)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'restricted' }),
      null,
    );
    expect(r).toEqual({ allowed: false, reason: 'auth_required' });
    expect(prisma.lectureAccessGrant.findFirst).not.toHaveBeenCalled();
  });

  it('restricted: авторизованный, есть grant → allowed (allowlisted)', async () => {
    prisma.lectureAccessGrant.findFirst.mockResolvedValueOnce({ id: 'g-1' });
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'restricted' }),
      'student-1',
    );
    expect(r).toEqual({ allowed: true, reason: 'allowlisted' });
    expect(prisma.lectureAccessGrant.findFirst).toHaveBeenCalledTimes(1);
  });

  it('restricted: авторизованный, нет grant → denied (not_in_allowlist)', async () => {
    prisma.lectureAccessGrant.findFirst.mockResolvedValueOnce(null);
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'restricted' }),
      'student-2',
    );
    expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' });
    expect(prisma.lectureAccessGrant.findFirst).toHaveBeenCalledTimes(1);
  });

  // ─── 5. SQL-уровень ──────────────────────────────────────────────

  it('restricted: SQL фильтр идёт по lectureId + subjectType=user + subjectId', async () => {
    prisma.lectureAccessGrant.findFirst.mockResolvedValueOnce({ id: 'g-2' });
    await service.resolveLectureAccess(
      lec({ id: 'lec-42', visibility: 'restricted' }),
      'student-3',
    );
    const args = prisma.lectureAccessGrant.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({
      lectureId: 'lec-42',
      subjectType: 'user',
      subjectId: 'student-3',
    });
    // select: { id: true } — не тащим лишних полей.
    expect(args.select).toEqual({ id: true });
  });

  // ─── 6. защитная ветка ─────────────────────────────────────────────

  it('защитная ветка: неизвестное visibility + анонимный → denied (auth_required)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'unknown' as never }),
      null,
    );
    expect(r).toEqual({ allowed: false, reason: 'auth_required' });
  });

  it('защитная ветка: неизвестное visibility + авторизованный → denied (not_in_allowlist)', async () => {
    const r = await service.resolveLectureAccess(
      lec({ visibility: 'unknown' as never }),
      'student-x',
    );
    expect(r).toEqual({ allowed: false, reason: 'not_in_allowlist' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// KS-3932 / ADR-118 §2.4.1. Высокоуровневая обёртка `assertAccess` —
// fetch lecture + резолвер + HttpException в формате ADR.
// ─────────────────────────────────────────────────────────────────────

describe('LecturesAccessService.assertAccess', () => {
  let service: LecturesAccessService;
  let prisma: {
    lecture: { findUnique: jest.Mock };
    lectureAccessGrant: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      lecture: { findUnique: jest.fn() },
      lectureAccessGrant: { findFirst: jest.fn() },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        LecturesAccessService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(LecturesAccessService);
  });

  it('404 если лекции нет', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.assertAccess('missing-lec', 'student-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('public: anon → возвращает lecture (без allowlist-запроса)', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-1',
      ownerId: 'owner-1',
      visibility: 'public',
    });
    const r = await service.assertAccess('lec-1', null);
    expect(r).toEqual({
      id: 'lec-1',
      ownerId: 'owner-1',
      visibility: 'public',
    });
    expect(prisma.lectureAccessGrant.findFirst).not.toHaveBeenCalled();
  });

  it('owner: restricted → возвращает lecture (без allowlist-запроса)', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-2',
      ownerId: 'owner-x',
      visibility: 'restricted',
    });
    const r = await service.assertAccess('lec-2', 'owner-x');
    expect(r.id).toBe('lec-2');
    expect(prisma.lectureAccessGrant.findFirst).not.toHaveBeenCalled();
  });

  it('restricted + anon → 401 {error:auth_required}', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-3',
      ownerId: 'owner-1',
      visibility: 'restricted',
    });
    let captured: HttpException | null = null;
    try {
      await service.assertAccess('lec-3', null);
    } catch (e) {
      captured = e as HttpException;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect(captured!.getStatus()).toBe(401);
    expect(captured!.getResponse()).toEqual({ error: 'auth_required' });
  });

  it('restricted + нет grant → 403 {error:lecture_access_revoked}', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-4',
      ownerId: 'owner-1',
      visibility: 'restricted',
    });
    prisma.lectureAccessGrant.findFirst.mockResolvedValueOnce(null);
    let captured: HttpException | null = null;
    try {
      await service.assertAccess('lec-4', 'student-y');
    } catch (e) {
      captured = e as HttpException;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect(captured!.getStatus()).toBe(403);
    expect(captured!.getResponse()).toEqual({
      error: 'lecture_access_revoked',
    });
  });

  it('restricted + есть grant → возвращает lecture', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-5',
      ownerId: 'owner-1',
      visibility: 'restricted',
    });
    prisma.lectureAccessGrant.findFirst.mockResolvedValueOnce({ id: 'g-1' });
    const r = await service.assertAccess('lec-5', 'student-allow');
    expect(r.id).toBe('lec-5');
  });

  it('findUnique идёт по узкому select { id, ownerId, visibility }', async () => {
    prisma.lecture.findUnique.mockResolvedValueOnce({
      id: 'lec-6',
      ownerId: 'owner-1',
      visibility: 'public',
    });
    await service.assertAccess('lec-6', null);
    const args = prisma.lecture.findUnique.mock.calls[0][0];
    expect(args).toEqual({
      where: { id: 'lec-6' },
      select: { id: true, ownerId: true, visibility: true },
    });
  });
});
