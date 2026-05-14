/**
 * KS-2885 / ADR-060 §10.2 B12. Acceptance-тесты `POST /studies/from-broadcast-round`.
 *
 * Покрытие по ТЗ:
 *  - создание зеркала (Study public + N глав, owner=mirror-user);
 *  - idempotent guard: повторный create того же roundId → 409;
 *  - permissions: контроллер защищён `InternalKeyGuard` (metadata
 *    + поведение guard'а: 401 без X-Internal-Auth, 403 при неверном,
 *    200 при верном).
 *
 * Юнит-уровень: дёргаем сервис напрямую с моками; для permissions —
 * читаем NestJS metadata `__guards__` и инстанцируем `InternalKeyGuard`
 * с ExecutionContext-стабом (без поднятия app, чтобы не тащить
 * нативные зависимости в jest).
 */
import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalKeyGuard } from '../../auth/internal-key.guard';
import { StudyBroadcastMirrorService } from './study-broadcast-mirror.service';
import {
  FromBroadcastRoundDto,
  StudyBroadcastMirrorController,
} from './study-broadcast-mirror.controller';
import { STUDY_LIMITS } from '../study-limits';
import type {
  BroadcastRoundWithGames,
  BroadcastServiceClient,
} from './broadcast-service.client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StudySlugService } from '../study-slug.service';

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

function makePrisma(): any {
  const tx: any = {
    study: { create: jest.fn(), update: jest.fn() },
    studyMember: { create: jest.fn() },
    studyChapter: { create: jest.fn(), update: jest.fn() },
  };
  const prisma: any = {
    study: { findFirst: jest.fn() },
    studyChapter: { findMany: jest.fn() },
    user: { upsert: jest.fn().mockResolvedValue({ id: mirrorUserId }) },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
  return prisma;
}

function makeSlug(): any {
  return {
    generateUnique: jest.fn().mockResolvedValue('round-1-abc123'),
  };
}

function makeBroadcastClient(
  round: BroadcastRoundWithGames = baseRound,
): BroadcastServiceClient {
  return {
    getRoundWithGames: jest.fn().mockResolvedValue(round),
  } as unknown as BroadcastServiceClient;
}

describe('KS-2885 B12 · POST /studies/from-broadcast-round', () => {
  let prisma: any;
  let slug: any;
  let broadcast: BroadcastServiceClient;
  let svc: StudyBroadcastMirrorService;
  let controller: StudyBroadcastMirrorController;

  beforeEach(() => {
    prisma = makePrisma();
    slug = makeSlug();
    broadcast = makeBroadcastClient();
    svc = new StudyBroadcastMirrorService(
      prisma as unknown as PrismaService,
      slug as unknown as StudySlugService,
      broadcast,
    );
    controller = new StudyBroadcastMirrorController(svc);

    prisma.study.findFirst.mockResolvedValue(null);
    prisma.__tx.study.create.mockResolvedValue({
      id: studyId,
      slug: 'round-1-abc123',
    });
    let counter = 0;
    prisma.__tx.studyChapter.create.mockImplementation(async () => ({
      id: `chap-${++counter}`,
    }));
  });

  // ─── Permissions: internal-auth обязателен ──────────────────────────

  describe('permissions: InternalKeyGuard', () => {
    it('контроллер декорирован `@UseGuards(InternalKeyGuard)` — metadata содержит guard', () => {
      // NestJS складывает guards в Reflect-metadata `__guards__`.
      const guards = Reflect.getMetadata(
        '__guards__',
        StudyBroadcastMirrorController,
      ) as Array<{ name: string } | Function>;
      expect(guards).toBeDefined();
      const names = (guards ?? []).map((g) =>
        typeof g === 'function' ? g.name : g.name,
      );
      expect(names).toContain('InternalKeyGuard');
    });

    it('запрос без X-Internal-Auth → 401 UnauthorizedException', () => {
      const guard = new InternalKeyGuard({
        get: (k: string) =>
          k === 'SYNTHETIC_BOT_INTERNAL_KEY' ? 'super-secret' : undefined,
      } as unknown as ConfigService);
      expect(() => guard.canActivate(makeCtx({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('запрос с неверным X-Internal-Auth → 403 ForbiddenException', () => {
      const guard = new InternalKeyGuard({
        get: (k: string) =>
          k === 'SYNTHETIC_BOT_INTERNAL_KEY' ? 'super-secret' : undefined,
      } as unknown as ConfigService);
      expect(() =>
        guard.canActivate(makeCtx({ 'x-internal-auth': 'wrong-12345' })),
      ).toThrow(ForbiddenException);
    });

    it('запрос с верным X-Internal-Auth → допускается', () => {
      const guard = new InternalKeyGuard({
        get: (k: string) =>
          k === 'SYNTHETIC_BOT_INTERNAL_KEY' ? 'super-secret' : undefined,
      } as unknown as ConfigService);
      expect(
        guard.canActivate(makeCtx({ 'x-internal-auth': 'super-secret' })),
      ).toBe(true);
    });

    it('ENV не задан → 401 (api-инстанс должен выпасть из ALB)', () => {
      const guard = new InternalKeyGuard({
        get: () => undefined,
      } as unknown as ConfigService);
      expect(() =>
        guard.canActivate(makeCtx({ 'x-internal-auth': 'super-secret' })),
      ).toThrow(UnauthorizedException);
    });
  });

  // ─── Happy path: создание зеркала ────────────────────────────────

  describe('создание зеркала', () => {
    it('Study: visibility=public, fromKind=broadcast:<roundId>, fromRefId=roundId, owner=mirror-user', async () => {
      await controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto);

      const data = prisma.__tx.study.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        ownerId: mirrorUserId,
        name: 'Round 1',
        visibility: 'public',
        isPublic: true,
        fromKind: `broadcast:${roundId}`,
        fromRefId: roundId,
        chaptersCount: 2,
      });
    });

    it('одна глава на партию, fromKind=broadcast-game:<gameId>, fromRefId=gameId', async () => {
      await controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto);

      const calls = prisma.__tx.studyChapter.create.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].data).toMatchObject({
        pgn: '1. e4 e5 *',
        fromKind: `broadcast-game:${baseRound.games[0].id}`,
        fromRefId: baseRound.games[0].id,
        mode: 'analysis',
      });
      expect(calls[1][0].data.pgn).toBe('1. d4 d5 *');
    });

    it('orderIdx глав идёт с STUDY_ORDER_STEP, по нарастающей', async () => {
      await controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto);

      const calls = prisma.__tx.studyChapter.create.mock.calls;
      const orderIdxs = calls.map((c: any) => c[0].data.orderIdx);
      // Проверяем монотонный рост; шаг = STUDY_ORDER_STEP (1000).
      expect(orderIdxs).toEqual([1000, 2000]);
      expect(orderIdxs[1] - orderIdxs[0]).toBe(1000);
    });

    it('owner-record в study_members создаётся в той же транзакции', async () => {
      await controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto);
      expect(prisma.__tx.studyMember.create).toHaveBeenCalledWith({
        data: { studyId, userId: mirrorUserId, role: 'owner' },
      });
    });

    it('response = {studyId, slug, chapterIds: string[]}', async () => {
      const r = await controller.fromBroadcastRound({
        roundId,
      } as FromBroadcastRoundDto);
      expect(r.studyId).toBe(studyId);
      expect(r.slug).toBe('round-1-abc123');
      expect(r.chapterIds).toHaveLength(2);
      r.chapterIds.forEach((id) => expect(typeof id).toBe('string'));
    });

    it('партии с пустым result → makeChapterName подставляет "vs"', async () => {
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValueOnce({
        round: { id: roundId, name: 'Round X' },
        games: [
          {
            id: 'g-1',
            pgn: '*',
            whitePlayer: 'A',
            blackPlayer: 'B',
            result: '*',
          },
        ],
      });
      await controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto);
      const chapterData =
        prisma.__tx.studyChapter.create.mock.calls[0][0].data;
      expect(chapterData.name).toBe('A vs B');
    });
  });

  // ─── Idempotent повтор ───────────────────────────────────────────

  describe('idempotent повтор', () => {
    it('повторный create того же roundId → 409 ConflictException', async () => {
      prisma.study.findFirst.mockResolvedValue({ id: studyId, slug: 'old' });
      await expect(
        controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto),
      ).rejects.toBeInstanceOf(ConflictException);
      // Транзакция и создания НЕ вызываются.
      expect(prisma.__tx.study.create).not.toHaveBeenCalled();
      expect(prisma.__tx.studyChapter.create).not.toHaveBeenCalled();
    });

    it('lookup по {fromKind, fromRefId} — точное соответствие, а не подстрока', async () => {
      prisma.study.findFirst.mockResolvedValue({ id: studyId, slug: 'old' });
      await expect(
        controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto),
      ).rejects.toBeInstanceOf(ConflictException);

      const findFirstArgs = prisma.study.findFirst.mock.calls[0][0];
      expect(findFirstArgs.where).toEqual({
        fromKind: `broadcast:${roundId}`,
        fromRefId: roundId,
      });
    });
  });

  // ─── Edge: invalid round / too many games ───────────────────────

  describe('edge', () => {
    it('round не найден (broadcast вернул round=null) → 404', async () => {
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValueOnce({
        round: null as any,
        games: [],
      });
      await expect(
        controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('игр > chaptersPerStudy → 409 (не создаём, защита от FK-каскада)', async () => {
      (broadcast.getRoundWithGames as jest.Mock).mockResolvedValueOnce({
        round: { id: roundId, name: 'Big' },
        games: Array.from({ length: STUDY_LIMITS.chaptersPerStudy + 1 }, (_, i) => ({
          id: `g-${i}`,
          pgn: '*',
          whitePlayer: 'A',
          blackPlayer: 'B',
          result: '*',
        })),
      });
      await expect(
        controller.fromBroadcastRound({ roundId } as FromBroadcastRoundDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.__tx.study.create).not.toHaveBeenCalled();
    });
  });
});

// ── helpers ───────────────────────────────────────────────────────

function makeCtx(headers: Record<string, string | undefined>): ExecutionContext {
  const req = {
    headers,
    method: 'POST',
    originalUrl: '/api/studies/from-broadcast-round',
    ip: '10.0.0.42',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
