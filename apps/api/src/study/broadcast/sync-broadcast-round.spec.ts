/**
 * KS-2885 / ADR-060 §10.2 B12. Acceptance-тесты `POST /studies/sync-broadcast-round`.
 *
 * Покрытие по ТЗ:
 *  - идемпотентность: повторный sync без изменений → 0 update/create;
 *  - **id глав не меняется**: для существующих fromRefId (broadcastGameId)
 *    вызывается `update` по тому же chapter.id, без delete+create.
 *    Это инвариант ADR-060 §3.7 (stable chapter ids ⇒ deep-link'и из
 *    публикаций остаются валидны).
 *  - частичный апдейт: pgn меняется только у глав с отличающимся payload;
 *  - новая партия в раунде → добавляется как новая глава;
 *  - non-destructive: удалённая в broadcast партия НЕ удаляет главу
 *    зеркала;
 *  - 404 если зеркала ещё нет;
 *  - permissions: контроллер защищён `InternalKeyGuard`.
 */
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalKeyGuard } from '../../auth/internal-key.guard';
import { StudyBroadcastMirrorService } from './study-broadcast-mirror.service';
import {
  StudyBroadcastMirrorController,
  SyncBroadcastRoundDto,
} from './study-broadcast-mirror.controller';
import type {
  BroadcastRoundWithGames,
  BroadcastServiceClient,
} from './broadcast-service.client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StudySlugService } from '../study-slug.service';

const mirrorUserId = '00000000-0000-4000-a000-000000000001';
const roundId = '11111111-1111-4111-a111-111111111111';
const studyId = '22222222-2222-4222-a222-222222222222';
const gameId1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
const gameId2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2';
const gameId3 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
const chapterId1 = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const chapterId2 = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';

const broadcastRound: BroadcastRoundWithGames = {
  round: { id: roundId, name: 'Round 1' },
  games: [
    {
      id: gameId1,
      pgn: '1. e4 e5 2. Nf3 *', // изменился по сравнению со stored
      whitePlayer: 'Carlsen',
      blackPlayer: 'Nepo',
      result: '*',
    },
    {
      id: gameId2,
      pgn: '1. d4 d5 *', // совпадает со stored
      whitePlayer: 'Caruana',
      blackPlayer: 'Ding',
      result: '*',
    },
  ],
};

const existingChapters = [
  {
    id: chapterId1,
    studyId,
    pgn: '1. e4 e5 *', // отличается от broadcast pgn → должен update'нуться
    orderIdx: 1000,
    fromRefId: gameId1,
    fromKind: `broadcast-game:${gameId1}`,
  },
  {
    id: chapterId2,
    studyId,
    pgn: '1. d4 d5 *', // совпадает → НЕ должен update'нуться
    orderIdx: 2000,
    fromRefId: gameId2,
    fromKind: `broadcast-game:${gameId2}`,
  },
];

function makePrisma(): any {
  const tx: any = {
    study: { create: jest.fn(), update: jest.fn() },
    studyMember: { create: jest.fn() },
    studyChapter: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  };
  const prisma: any = {
    study: {
      findFirst: jest.fn().mockResolvedValue({ id: studyId, slug: 'r-slug' }),
    },
    studyChapter: {
      findMany: jest.fn().mockResolvedValue(existingChapters),
    },
    user: { upsert: jest.fn().mockResolvedValue({ id: mirrorUserId }) },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
  return prisma;
}

function makeSlug(): any {
  return { generateUnique: jest.fn() };
}

function makeBroadcastClient(
  round: BroadcastRoundWithGames = broadcastRound,
): BroadcastServiceClient {
  return {
    getRoundWithGames: jest.fn().mockResolvedValue(round),
  } as unknown as BroadcastServiceClient;
}

describe('KS-2885 B12 · POST /studies/sync-broadcast-round', () => {
  let prisma: any;
  let broadcast: BroadcastServiceClient;
  let svc: StudyBroadcastMirrorService;
  let controller: StudyBroadcastMirrorController;

  beforeEach(() => {
    prisma = makePrisma();
    broadcast = makeBroadcastClient();
    svc = new StudyBroadcastMirrorService(
      prisma as unknown as PrismaService,
      makeSlug() as unknown as StudySlugService,
      broadcast,
    );
    controller = new StudyBroadcastMirrorController(svc);
  });

  // ─── Permissions ─────────────────────────────────────────────────

  describe('permissions: InternalKeyGuard', () => {
    it('контроллер декорирован `@UseGuards(InternalKeyGuard)`', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        StudyBroadcastMirrorController,
      ) as Array<{ name: string } | Function>;
      const names = (guards ?? []).map((g) =>
        typeof g === 'function' ? g.name : g.name,
      );
      expect(names).toContain('InternalKeyGuard');
    });

    it('запрос без X-Internal-Auth → 401', () => {
      const guard = new InternalKeyGuard({
        get: (k: string) =>
          k === 'SYNTHETIC_BOT_INTERNAL_KEY' ? 'super-secret' : undefined,
      } as unknown as ConfigService);
      expect(() => guard.canActivate(makeCtx({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('запрос с неверным X-Internal-Auth → 403', () => {
      const guard = new InternalKeyGuard({
        get: (k: string) =>
          k === 'SYNTHETIC_BOT_INTERNAL_KEY' ? 'super-secret' : undefined,
      } as unknown as ConfigService);
      expect(() =>
        guard.canActivate(makeCtx({ 'x-internal-auth': 'bad-key' })),
      ).toThrow(ForbiddenException);
    });

    it('верный X-Internal-Auth → допускается', () => {
      const guard = new InternalKeyGuard({
        get: (k: string) =>
          k === 'SYNTHETIC_BOT_INTERNAL_KEY' ? 'super-secret' : undefined,
      } as unknown as ConfigService);
      expect(
        guard.canActivate(makeCtx({ 'x-internal-auth': 'super-secret' })),
      ).toBe(true);
    });
  });

  // ─── Идемпотентность: id глав не меняются ──────────────────────

  describe('идемпотентный sync (KS-2884 §3.7)', () => {
    it('повторный sync без изменений pgn → 0 update, 0 create', async () => {
      // stored pgn совпадает с broadcast pgn для обеих партий.
      prisma.studyChapter.findMany.mockResolvedValueOnce([
        { ...existingChapters[0], pgn: '1. e4 e5 2. Nf3 *' },
        { ...existingChapters[1] },
      ]);

      const r = await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      expect(r.updatedChapters).toBe(0);
      expect(r.createdChapters).toBe(0);
      expect(prisma.__tx.studyChapter.update).not.toHaveBeenCalled();
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('обновление pgn НЕ меняет chapter.id — update по существующему id', async () => {
      const r = await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      expect(r.updatedChapters).toBe(1); // chap-1 (pgn разный)
      expect(r.createdChapters).toBe(0);

      // **Ключевой инвариант KS-2885**: update вызвался ровно на тот же id,
      // что лежал в `existingChapters` — chapter не пересоздавался.
      expect(prisma.__tx.studyChapter.update).toHaveBeenCalledTimes(1);
      expect(prisma.__tx.studyChapter.update).toHaveBeenCalledWith({
        where: { id: chapterId1 },
        data: { pgn: '1. e4 e5 2. Nf3 *' },
      });
      // delete и create для existing chapter НЕ вызывались.
      expect(prisma.__tx.studyChapter.delete).not.toHaveBeenCalled();
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('двойной вызов sync — id глав остаются стабильными', async () => {
      // Первый вызов — частичный update.
      await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      // Готовим состояние «после первого sync'а» — pgn в БД уже свежий.
      prisma.studyChapter.findMany.mockResolvedValueOnce([
        { ...existingChapters[0], pgn: '1. e4 e5 2. Nf3 *' },
        { ...existingChapters[1] },
      ]);
      // Сбрасываем счётчики моков.
      (prisma.__tx.studyChapter.update as jest.Mock).mockClear();
      (prisma.__tx.studyChapter.create as jest.Mock).mockClear();

      // Второй вызов — ничего не должно меняться.
      const r2 = await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      expect(r2.updatedChapters).toBe(0);
      expect(r2.createdChapters).toBe(0);
      expect(prisma.__tx.studyChapter.update).not.toHaveBeenCalled();
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('matching глав по fromRefId (broadcastGameId), не по позиции', async () => {
      // Перевернём порядок stored глав — sync должен матчить по fromRefId.
      prisma.studyChapter.findMany.mockResolvedValueOnce([
        { ...existingChapters[1] }, // gameId2 на первом месте
        { ...existingChapters[0] }, // gameId1 на втором
      ]);

      await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      // Всё равно: только chap-1 (gameId1) должна update'нуться.
      expect(prisma.__tx.studyChapter.update).toHaveBeenCalledTimes(1);
      expect(prisma.__tx.studyChapter.update).toHaveBeenCalledWith({
        where: { id: chapterId1 },
        data: expect.any(Object),
      });
    });
  });

  // ─── Новая партия в раунде → новая глава ─────────────────────────

  describe('новая партия в раунде', () => {
    it('добавляется как новая глава, orderIdx = max(existing) + STUDY_ORDER_STEP', async () => {
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValueOnce({
        round: { id: roundId, name: 'Round 1' },
        games: [
          ...broadcastRound.games,
          {
            id: gameId3,
            pgn: '1. c4 c5 *',
            whitePlayer: 'Firouzja',
            blackPlayer: 'Nakamura',
            result: '*',
          },
        ],
      });

      const r = await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      expect(r.createdChapters).toBe(1);
      // chap-1 всё ещё update — pgn отличается.
      expect(r.updatedChapters).toBe(1);

      // Новая глава: orderIdx = max(2000) + STUDY_ORDER_STEP(1000) = 3000.
      const created = prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(created.orderIdx).toBe(3000);
      expect(created.fromRefId).toBe(gameId3);
      expect(created.fromKind).toBe(`broadcast-game:${gameId3}`);

      // chaptersCount у студии инкрементируется.
      expect(prisma.__tx.study.update).toHaveBeenCalledWith({
        where: { id: studyId },
        data: { chaptersCount: { increment: 1 } },
      });
    });

    it('если новых партий нет → study.update НЕ вызывается', async () => {
      await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);
      expect(prisma.__tx.study.update).not.toHaveBeenCalled();
    });
  });

  // ─── Non-destructive: удалённая партия не удаляет главу ─────────

  describe('non-destructive', () => {
    it('удалённая в broadcast партия → глава остаётся, delete не вызывается', async () => {
      // broadcast вернул только одну партию — gameId2 «исчез».
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValueOnce({
        round: { id: roundId, name: 'Round 1' },
        games: [broadcastRound.games[0]], // только gameId1
      });

      const r = await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);

      // chap-1 (gameId1) — update (pgn отличается).
      expect(r.updatedChapters).toBe(1);
      // chap-2 (gameId2) — НЕ тронут.
      expect(prisma.__tx.studyChapter.delete).not.toHaveBeenCalled();
      expect(r.createdChapters).toBe(0);

      // Среди update-вызовов нет того, что трогает chap-2.
      const updateCalls = (prisma.__tx.studyChapter.update as jest.Mock).mock
        .calls;
      const touchedIds = updateCalls.map((c: any) => c[0].where.id);
      expect(touchedIds).not.toContain(chapterId2);
    });
  });

  // ─── 404 если зеркала ещё нет ─────────────────────────────────

  describe('lifecycle', () => {
    it('404 если зеркало для roundId не существует', async () => {
      prisma.study.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.syncBroadcastRound({
          roundId,
        } as SyncBroadcastRoundDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lookup зеркала идёт по {fromKind, fromRefId} — точный матч', async () => {
      await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);
      const findFirstArgs = prisma.study.findFirst.mock.calls[0][0];
      expect(findFirstArgs.where).toEqual({
        fromKind: `broadcast:${roundId}`,
        fromRefId: roundId,
      });
    });

    it('response = {studyId, slug, updatedChapters, createdChapters}', async () => {
      const r = await controller.syncBroadcastRound({
        roundId,
      } as SyncBroadcastRoundDto);
      expect(r).toEqual({
        studyId,
        slug: 'r-slug',
        updatedChapters: 1,
        createdChapters: 0,
      });
    });
  });
});

// ── helpers ───────────────────────────────────────────────────────

function makeCtx(headers: Record<string, string | undefined>): ExecutionContext {
  const req = {
    headers,
    method: 'POST',
    originalUrl: '/api/studies/sync-broadcast-round',
    ip: '10.0.0.42',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
