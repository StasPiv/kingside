/**
 * KS-2856 / KS-2859 B3. Тесты `StudyMembersService` — lifecycle ролей,
 * защита от удаления owner'а, requireRole.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudyMembersService } from './study-members.service';

function makePrisma(): any {
  return {
    studyMember: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
  };
}

const studyId = 'study-1';
const userId = 'user-1';

describe('StudyMembersService — KS-2859 B3', () => {
  let prisma: any;
  let svc: StudyMembersService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new StudyMembersService(prisma);
  });

  describe('listMembers', () => {
    it('маппит rows в DTO с username', async () => {
      prisma.studyMember.findMany.mockResolvedValue([
        {
          studyId,
          userId,
          role: 'owner',
          addedAt: new Date('2026-01-01T00:00:00Z'),
          user: { username: 'alice' },
        },
        {
          studyId,
          userId: 'user-2',
          role: 'contributor',
          addedAt: new Date('2026-01-02T00:00:00Z'),
          user: { username: 'bob' },
        },
      ]);
      const r = await svc.listMembers(studyId);
      expect(r).toEqual([
        {
          studyId,
          userId,
          username: 'alice',
          role: 'owner',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          studyId,
          userId: 'user-2',
          username: 'bob',
          role: 'contributor',
          addedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('getRole', () => {
    it('owner → "owner"', async () => {
      prisma.studyMember.findUnique.mockResolvedValue({ role: 'owner' });
      expect(await svc.getRole(studyId, userId)).toBe('owner');
    });
    it('не member → null', async () => {
      prisma.studyMember.findUnique.mockResolvedValue(null);
      expect(await svc.getRole(studyId, userId)).toBeNull();
    });
  });

  describe('addContributor', () => {
    it('создаёт contributor если не member', async () => {
      prisma.studyMember.findUnique.mockResolvedValue(null);
      const created = {
        studyId,
        userId: 'u2',
        role: 'contributor',
        addedAt: new Date(),
      };
      prisma.studyMember.create.mockResolvedValue(created);
      const r = await svc.addContributor(studyId, 'u2');
      expect(prisma.studyMember.create).toHaveBeenCalledWith({
        data: { studyId, userId: 'u2', role: 'contributor' },
      });
      expect(r).toEqual(created);
    });
    it('idempotent: уже member → no-op', async () => {
      const existing = {
        studyId,
        userId,
        role: 'contributor',
        addedAt: new Date(),
      };
      prisma.studyMember.findUnique.mockResolvedValue(existing);
      const r = await svc.addContributor(studyId, userId);
      expect(prisma.studyMember.create).not.toHaveBeenCalled();
      expect(r).toEqual(existing);
    });
  });

  describe('removeMember', () => {
    it('удаляет contributor', async () => {
      prisma.studyMember.findUnique.mockResolvedValue({
        studyId,
        userId: 'u2',
        role: 'contributor',
      });
      await svc.removeMember(studyId, 'u2');
      expect(prisma.studyMember.delete).toHaveBeenCalledWith({
        where: { studyId_userId: { studyId, userId: 'u2' } },
      });
    });
    it('owner-запись не удаляется (400)', async () => {
      prisma.studyMember.findUnique.mockResolvedValue({
        studyId,
        userId,
        role: 'owner',
      });
      await expect(svc.removeMember(studyId, userId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.studyMember.delete).not.toHaveBeenCalled();
    });
    it('не member → 404', async () => {
      prisma.studyMember.findUnique.mockResolvedValue(null);
      await expect(svc.removeMember(studyId, 'u2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('requireRole', () => {
    it('owner проходит ["owner"]', async () => {
      prisma.studyMember.findUnique.mockResolvedValue({ role: 'owner' });
      await expect(
        svc.requireRole(studyId, userId, ['owner']),
      ).resolves.toBe('owner');
    });
    it('contributor не проходит ["owner"] → 404', async () => {
      prisma.studyMember.findUnique.mockResolvedValue({ role: 'contributor' });
      await expect(
        svc.requireRole(studyId, userId, ['owner']),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    it('contributor проходит ["owner", "contributor"]', async () => {
      prisma.studyMember.findUnique.mockResolvedValue({ role: 'contributor' });
      await expect(
        svc.requireRole(studyId, userId, ['owner', 'contributor']),
      ).resolves.toBe('contributor');
    });
    it('не member → 404', async () => {
      prisma.studyMember.findUnique.mockResolvedValue(null);
      await expect(svc.requireRole(studyId, userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
