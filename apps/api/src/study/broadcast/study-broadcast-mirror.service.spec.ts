/**
 * KS-2884 / ADR-060 §3.7 B11. Юнит-тесты broadcast-зеркала.
 *
 * Покрытие (Acceptance):
 *  - создание зеркала: новый Study + N глав, owner=mirror-user;
 *  - повторное создание → 409 (idempotent guard);
 *  - sync: pgn обновлён только у изменённых глав, дубликаты не создаются;
 *  - sync: новые партии в раунде добавляются как новые главы;
 *  - sync: 404 если зеркала ещё нет;
 *  - ensureMirrorUser: upsert одной записи `username='broadcast-mirror'`.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StudySlugService } from '../study-slug.service';
import { StudyBroadcastMirrorService } from './study-broadcast-mirror.service';
import type {
  BroadcastRoundWithGames,
  BroadcastServiceClient,
} from './broadcast-service.client';

function makePrisma(): any {
  const txContext: any = {
    study: { create: jest.fn(), update: jest.fn() },
    studyMember: { create: jest.fn() },
    studyChapter: { create: jest.fn(), update: jest.fn() },
  };
  const prisma: any = {
    study: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    studyChapter: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    studyMember: {
      create: jest.fn(),
    },
    user: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
      cb(txContext),
    ),
  };
  prisma.__tx = txContext;
  return prisma;
}

function makeSlug(): any {
  return {
    generateUnique: jest.fn().mockResolvedValue('round-slug-abc123'),
  };
}

function makeBroadcastClient(round: BroadcastRoundWithGames): any {
  return {
    getRoundWithGames: jest.fn().mockResolvedValue(round),
  };
}

const mirrorUserId = '00000000-0000-4000-a000-000000000001';
const roundId = '11111111-1111-4111-a111-111111111111';
const studyId = '22222222-2222-4222-a222-222222222222';

const baseRound: BroadcastRoundWithGames = {
  round: { id: roundId, name: 'Round 1' },
  games: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
      pgn: '1. e4 e5 *',
      whitePlayer: 'Carlsen',
      blackPlayer: 'Nepo',
      result: '*',
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
      pgn: '1. d4 d5 *',
      whitePlayer: 'Caruana',
      blackPlayer: 'Ding',
      result: '*',
    },
  ],
};

describe('StudyBroadcastMirrorService (KS-2884)', () => {
  let prisma: any;
  let slug: any;
  let broadcast: BroadcastServiceClient;
  let svc: StudyBroadcastMirrorService;

  beforeEach(() => {
    prisma = makePrisma();
    slug = makeSlug();
    broadcast = makeBroadcastClient(baseRound);
    prisma.user.upsert.mockResolvedValue({ id: mirrorUserId });
    svc = new StudyBroadcastMirrorService(
      prisma as unknown as PrismaService,
      slug as unknown as StudySlugService,
      broadcast,
    );
  });

  describe('ensureMirrorUser', () => {
    it('upsert по username=broadcast-mirror', async () => {
      const id = await svc.ensureMirrorUser();
      expect(id).toBe(mirrorUserId);
      expect(prisma.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { username: 'broadcast-mirror' },
          create: expect.objectContaining({
            username: 'broadcast-mirror',
            email: 'broadcast-mirror@kingside.internal',
            isHidden: true,
          }),
        }),
      );
    });

    it('кэширует mirrorUserId — второй вызов не дёргает БД', async () => {
      await svc.ensureMirrorUser();
      await svc.ensureMirrorUser();
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('createMirror', () => {
    beforeEach(() => {
      prisma.study.findFirst.mockResolvedValue(null); // зеркала ещё нет
      prisma.__tx.study.create.mockResolvedValue({
        id: studyId,
        slug: 'round-slug-abc123',
      });
      let counter = 0;
      prisma.__tx.studyChapter.create.mockImplementation(async () => ({
        id: `chap-${++counter}`,
      }));
    });

    it('создаёт Study с visibility=public, fromKind=broadcast:<roundId>', async () => {
      await svc.createMirror(roundId);
      const data = prisma.__tx.study.create.mock.calls[0][0].data;
      expect(data.visibility).toBe('public');
      expect(data.isPublic).toBe(true);
      expect(data.fromKind).toBe(`broadcast:${roundId}`);
      expect(data.fromRefId).toBe(roundId);
      expect(data.ownerId).toBe(mirrorUserId);
      expect(data.name).toBe('Round 1');
      expect(data.chaptersCount).toBe(2);
    });

    it('создаёт N глав с PGN из broadcast-service', async () => {
      await svc.createMirror(roundId);
      const calls = prisma.__tx.studyChapter.create.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].data.pgn).toBe('1. e4 e5 *');
      expect(calls[0][0].data.fromRefId).toBe(baseRound.games[0].id);
      expect(calls[0][0].data.fromKind).toBe(
        `broadcast-game:${baseRound.games[0].id}`,
      );
      expect(calls[1][0].data.pgn).toBe('1. d4 d5 *');
    });

    it('owner-запись в study_members создаётся', async () => {
      await svc.createMirror(roundId);
      expect(prisma.__tx.studyMember.create).toHaveBeenCalledWith({
        data: { studyId, userId: mirrorUserId, role: 'owner' },
      });
    });

    it('response {studyId, slug, chapterIds}', async () => {
      const r = await svc.createMirror(roundId);
      expect(r.studyId).toBe(studyId);
      expect(r.slug).toBe('round-slug-abc123');
      expect(r.chapterIds).toHaveLength(2);
    });

    it('409 если зеркало для этого roundId уже существует', async () => {
      prisma.study.findFirst.mockResolvedValue({
        id: studyId,
        slug: 'old-slug',
      });
      await expect(svc.createMirror(roundId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.__tx.study.create).not.toHaveBeenCalled();
    });

    it('409 если игр больше chaptersPerStudy=64', async () => {
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValue({
        round: { id: roundId, name: 'Big' },
        games: Array.from({ length: 65 }, (_, i) => ({
          id: `g-${i}`,
          pgn: '*',
          whitePlayer: 'A',
          blackPlayer: 'B',
          result: '*',
        })),
      });
      await expect(svc.createMirror(roundId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('syncMirror — повторный sync без дубликатов', () => {
    const existingChapters = [
      {
        id: 'chap-1',
        studyId,
        pgn: '1. e4 e5 *', // совпадает с baseRound.games[0]
        orderIdx: 1000,
        fromRefId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
        fromKind: 'broadcast-game:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
      },
      {
        id: 'chap-2',
        studyId,
        pgn: 'OLD PGN', // отличается от baseRound.games[1]
        orderIdx: 2000,
        fromRefId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
        fromKind: 'broadcast-game:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
      },
    ];

    beforeEach(() => {
      prisma.study.findFirst.mockResolvedValue({
        id: studyId,
        slug: 'r-slug',
      });
      prisma.studyChapter.findMany.mockResolvedValue(existingChapters);
    });

    it('обновляет pgn только у изменённых глав, дубликатов не создаёт', async () => {
      const r = await svc.syncMirror(roundId);
      expect(r.updatedChapters).toBe(1); // chap-2
      expect(r.createdChapters).toBe(0);
      // create НЕ вызвался (главы уже есть)
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
      // update вызвался ровно один раз для chap-2
      expect(prisma.__tx.studyChapter.update).toHaveBeenCalledWith({
        where: { id: 'chap-2' },
        data: { pgn: '1. d4 d5 *' },
      });
    });

    it('повторный sync (без изменений PGN) — нулевой update', async () => {
      // обе главы совпадают с broadcast-данными
      prisma.studyChapter.findMany.mockResolvedValue([
        { ...existingChapters[0] },
        { ...existingChapters[1], pgn: '1. d4 d5 *' },
      ]);
      const r = await svc.syncMirror(roundId);
      expect(r.updatedChapters).toBe(0);
      expect(r.createdChapters).toBe(0);
      expect(prisma.__tx.studyChapter.update).not.toHaveBeenCalled();
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('новая партия в раунде → создаётся новая глава', async () => {
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValue({
        round: { id: roundId, name: 'Round 1' },
        games: [
          ...baseRound.games,
          {
            id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
            pgn: '1. c4 *',
            whitePlayer: 'Firouzja',
            blackPlayer: 'Nakamura',
            result: '*',
          },
        ],
      });
      const r = await svc.syncMirror(roundId);
      expect(r.createdChapters).toBe(1);
      expect(r.updatedChapters).toBe(1); // chap-2 (старый OLD PGN заменён)
      // study.chaptersCount инкрементируется
      expect(prisma.__tx.study.update).toHaveBeenCalledWith({
        where: { id: studyId },
        data: { chaptersCount: { increment: 1 } },
      });
      // orderIdx новой главы = max(2000) + STUDY_ORDER_STEP(1000) = 3000
      const created = prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(created.orderIdx).toBe(3000);
      expect(created.fromRefId).toBe(
        'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
      );
    });

    it('404 если зеркала ещё нет', async () => {
      prisma.study.findFirst.mockResolvedValue(null);
      await expect(svc.syncMirror(roundId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('удалённая партия в broadcast — глава не удаляется (non-destructive)', async () => {
      // broadcast вернул только одну партию (вторая «исчезла»)
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValue({
        round: { id: roundId, name: 'Round 1' },
        games: [baseRound.games[0]],
      });
      const r = await svc.syncMirror(roundId);
      expect(r.updatedChapters).toBe(0);
      expect(r.createdChapters).toBe(0);
      // chap-2 НЕ удалён
      expect(prisma.__tx.studyChapter.update).not.toHaveBeenCalled();
    });
  });
});
