/**
 * KS-2856 / KS-2859 B3. Тесты `StudyInvitesService` — TTL,
 * однократность приёма, добавление contributor.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudyInvitesService } from './study-invites.service';

function makePrisma() {
  const txContext: any = {
    studyMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    studyInvite: {
      update: jest.fn(),
    },
  };
  const prisma: any = {
    studyInvite: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
      cb(txContext),
    ),
  };
  return { prisma, tx: txContext };
}

const study: any = {
  id: 'study-1',
  ownerId: 'owner-1',
  slug: 'abc-x',
  name: 'X',
};
const ownerId = 'owner-1';
const inviteeId = 'invitee-1';

describe('StudyInvitesService — KS-2859 B3', () => {
  let prisma: any;
  let tx: any;
  let svc: StudyInvitesService;
  const members = { /* unused for these specs */ } as any;

  beforeEach(() => {
    const made = makePrisma();
    prisma = made.prisma;
    tx = made.tx;
    svc = new StudyInvitesService(prisma, members);
  });

  describe('createInvite', () => {
    it('генерирует токен 32 символа и TTL ≈ 7 дней', async () => {
      prisma.studyInvite.create.mockResolvedValue({});
      const before = Date.now();
      const r = await svc.createInvite(study, ownerId);
      expect(r.token).toHaveLength(StudyInvitesService.TOKEN_LENGTH);
      const diff = r.expiresAt.getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(
        StudyInvitesService.TTL_MS - 1000,
      );
      expect(diff).toBeLessThanOrEqual(StudyInvitesService.TTL_MS + 1000);
      expect(prisma.studyInvite.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          token: r.token,
          studyId: study.id,
          createdById: ownerId,
        }),
      });
    });
  });

  describe('accept', () => {
    const validInvite = {
      token: 'a'.repeat(32),
      studyId: study.id,
      createdById: ownerId,
      expiresAt: new Date(Date.now() + 1000 * 60),
      acceptedAt: null,
      study,
    };

    it('добавляет contributor и помечает acceptedAt', async () => {
      prisma.studyInvite.findUnique.mockResolvedValue(validInvite);
      tx.studyMember.findUnique.mockResolvedValue(null);
      tx.studyMember.create.mockResolvedValue({});
      tx.studyInvite.update.mockResolvedValue({});
      const r = await svc.accept(validInvite.token, inviteeId);
      expect(tx.studyMember.create).toHaveBeenCalledWith({
        data: { studyId: study.id, userId: inviteeId, role: 'contributor' },
      });
      expect(tx.studyInvite.update).toHaveBeenCalledWith({
        where: { token: validInvite.token },
        data: expect.objectContaining({ acceptedById: inviteeId }),
      });
      expect(r).toEqual({ study, role: 'contributor' });
    });

    it('повторный accept → BadRequest', async () => {
      prisma.studyInvite.findUnique.mockResolvedValue({
        ...validInvite,
        acceptedAt: new Date(),
      });
      await expect(svc.accept(validInvite.token, inviteeId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('истёкший → BadRequest', async () => {
      prisma.studyInvite.findUnique.mockResolvedValue({
        ...validInvite,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(svc.accept(validInvite.token, inviteeId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('несуществующий → 404', async () => {
      prisma.studyInvite.findUnique.mockResolvedValue(null);
      await expect(svc.accept('missing', inviteeId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('уже member → не создаётся дубль', async () => {
      prisma.studyInvite.findUnique.mockResolvedValue(validInvite);
      tx.studyMember.findUnique.mockResolvedValue({
        studyId: study.id,
        userId: inviteeId,
        role: 'contributor',
      });
      tx.studyInvite.update.mockResolvedValue({});
      await svc.accept(validInvite.token, inviteeId);
      expect(tx.studyMember.create).not.toHaveBeenCalled();
      expect(tx.studyInvite.update).toHaveBeenCalled();
    });
  });
});
