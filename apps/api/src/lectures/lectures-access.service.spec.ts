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

import { Test, TestingModule } from '@nestjs/testing';
import {
  LecturesAccessService,
  type LectureForAccessCheck,
} from './lectures-access.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LecturesAccessService.resolveLectureAccess', () => {
  let service: LecturesAccessService;
  let prisma: {
    lectureAccessGrant: {
      findFirst: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
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
