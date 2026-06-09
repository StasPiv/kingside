/**
 * KS-4023 / ADR-122. Unit-тесты сервиса позиционной трассы.
 *
 * Покрытие:
 *   - upsert: счастливый путь (create), повторный upsert (update),
 *     `sf_version_mismatch`, не-монотонный `ply`, превышение размера,
 *     отсутствие партии (404).
 *   - getOrThrow: счастливый путь, 404 «нет записи», 404 «версия не совпала».
 *   - deleteByGame: владелец может, не-владелец — 403 (если не админ),
 *     админ может, идемпотентно при отсутствии записи / партии.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { POSITIONAL_TRACE_VERSION } from '@kingside/shared';
import { PositionalTraceService } from './positional-trace.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AdminUserService } from '../../auth/admin-user.guard';
import type { PositionalTraceUpsertDto } from './dto/positional-trace.dto';

// ─── helpers ────────────────────────────────────────────────────────

function makePrisma(overrides: Partial<{
  trace: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    delete: jest.Mock;
  };
  game: { findUnique: jest.Mock };
}> = {}) {
  return {
    gamePositionalTrace: overrides.trace ?? {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    game: overrides.game ?? { findUnique: jest.fn() },
  } as unknown as PrismaService;
}

function makeAdmin(isAdmin = false) {
  return {
    isAdmin: jest.fn().mockResolvedValue(isAdmin),
  } as unknown as AdminUserService;
}

function makePayload(overrides: Partial<PositionalTraceUpsertDto> = {}): PositionalTraceUpsertDto {
  return {
    sfVersion: POSITIONAL_TRACE_VERSION,
    plies: [
      {
        ply: 0,
        subterms: [
          { id: 'space', color: 'w', value_mg: 0.1, value_eg: 0.0 },
        ],
      },
      {
        ply: 1,
        subterms: [
          { id: 'space', color: 'b', value_mg: 0.2, value_eg: 0.0 },
        ],
      },
    ],
    durationMs: 1234,
    ...overrides,
  };
}

const GAME = '00000000-0000-0000-0000-000000004023';
const OWNER = '00000000-0000-0000-0000-000000000001';
const OTHER = '00000000-0000-0000-0000-000000000002';
const ADMIN = '00000000-0000-0000-0000-000000000099';

// ─── upsert ─────────────────────────────────────────────────────────

describe('PositionalTraceService.upsert', () => {
  it('создаёт новую запись, возвращает wasCreated=true', async () => {
    const upsert = jest.fn().mockResolvedValue({
      gameId: GAME,
      sfVersion: POSITIONAL_TRACE_VERSION,
      plies: [],
      durationMs: 1234,
      createdAt: new Date('2026-06-09T00:00:00Z'),
      updatedAt: new Date('2026-06-09T00:00:00Z'),
    });
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert,
        delete: jest.fn(),
      },
      game: { findUnique: jest.fn().mockResolvedValue({ id: GAME }) },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    const { wasCreated } = await svc.upsert(GAME, OWNER, makePayload());
    expect(wasCreated).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId: GAME },
        create: expect.objectContaining({
          gameId: GAME,
          sfVersion: POSITIONAL_TRACE_VERSION,
          durationMs: 1234,
          createdById: OWNER,
        }),
      }),
    );
  });

  it('обновляет существующую запись, возвращает wasCreated=false', async () => {
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn().mockResolvedValue({ id: 'r-1' }),
        upsert: jest.fn().mockResolvedValue({
          gameId: GAME,
          sfVersion: POSITIONAL_TRACE_VERSION,
          plies: [],
          durationMs: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        delete: jest.fn(),
      },
      game: { findUnique: jest.fn().mockResolvedValue({ id: GAME }) },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    const { wasCreated } = await svc.upsert(GAME, OWNER, makePayload());
    expect(wasCreated).toBe(false);
  });

  it('sf_version_mismatch → BadRequest', async () => {
    const prisma = makePrisma({
      game: { findUnique: jest.fn().mockResolvedValue({ id: GAME }) },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await expect(
      svc.upsert(GAME, OWNER, makePayload({ sfVersion: 'sf17-old' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('не-монотонный ply → BadRequest invalid', async () => {
    const prisma = makePrisma({
      game: { findUnique: jest.fn().mockResolvedValue({ id: GAME }) },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await expect(
      svc.upsert(
        GAME,
        OWNER,
        makePayload({
          plies: [
            { ply: 0, subterms: [] },
            { ply: 2, subterms: [] }, // должно было быть 1
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('превышение размера → PayloadTooLarge', async () => {
    // Сгенерируем достаточно большое тело: 300 КБ через много plies.
    const bigPlies = [];
    for (let i = 0; i < 600; i++) {
      const subs = [];
      for (let j = 0; j < 40; j++) {
        subs.push({
          id: 'pawn_connected_xxx',
          color: 'w' as const,
          square: 'e4',
          value_mg: 0.0182927,
          value_eg: 0.0182927,
        });
      }
      bigPlies.push({ ply: i, subterms: subs });
    }
    const svc = new PositionalTraceService(makePrisma(), makeAdmin());
    await expect(
      svc.upsert(GAME, OWNER, makePayload({ plies: bigPlies })),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('партии не существует → NotFound game_not_found', async () => {
    const prisma = makePrisma({
      game: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await expect(svc.upsert(GAME, OWNER, makePayload())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ─── getOrThrow ─────────────────────────────────────────────────────

describe('PositionalTraceService.getOrThrow', () => {
  it('версия совпала → DTO', async () => {
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn().mockResolvedValue({
          gameId: GAME,
          sfVersion: POSITIONAL_TRACE_VERSION,
          plies: [{ ply: 0, subterms: [] }],
          durationMs: 500,
          createdAt: new Date('2026-06-09T01:00:00Z'),
          updatedAt: new Date('2026-06-09T02:00:00Z'),
        }),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    const dto = await svc.getOrThrow(GAME, POSITIONAL_TRACE_VERSION);
    expect(dto.gameId).toBe(GAME);
    expect(dto.sfVersion).toBe(POSITIONAL_TRACE_VERSION);
    expect(dto.plies).toEqual([{ ply: 0, subterms: [] }]);
    expect(dto.durationMs).toBe(500);
    expect(dto.createdAt).toBe('2026-06-09T01:00:00.000Z');
  });

  it('записи нет → NotFound positional_trace_not_found', async () => {
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await expect(
      svc.getOrThrow(GAME, POSITIONAL_TRACE_VERSION),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('версия в БД не совпала → NotFound (клиент пересчитает)', async () => {
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn().mockResolvedValue({
          gameId: GAME,
          sfVersion: 'sf17-old',
          plies: [],
          durationMs: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await expect(
      svc.getOrThrow(GAME, POSITIONAL_TRACE_VERSION),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── deleteByGame ───────────────────────────────────────────────────

describe('PositionalTraceService.deleteByGame', () => {
  it('владелец-белый может удалить', async () => {
    const del = jest.fn().mockResolvedValue({});
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: del,
      },
      game: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ whiteId: OWNER, blackId: OTHER }),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await svc.deleteByGame(GAME, OWNER);
    expect(del).toHaveBeenCalledWith({ where: { gameId: GAME } });
  });

  it('владелец-чёрный может удалить', async () => {
    const del = jest.fn().mockResolvedValue({});
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: del,
      },
      game: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ whiteId: OTHER, blackId: OWNER }),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await svc.deleteByGame(GAME, OWNER);
    expect(del).toHaveBeenCalled();
  });

  it('не-владелец и не админ → Forbidden', async () => {
    const del = jest.fn();
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: del,
      },
      game: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ whiteId: OTHER, blackId: OTHER }),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin(false));
    await expect(svc.deleteByGame(GAME, OWNER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('админ может удалить даже без владения', async () => {
    const del = jest.fn().mockResolvedValue({});
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: del,
      },
      game: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ whiteId: OTHER, blackId: OTHER }),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin(true));
    await svc.deleteByGame(GAME, ADMIN);
    expect(del).toHaveBeenCalled();
  });

  it('партии нет → no-op (204 без бросания)', async () => {
    const del = jest.fn();
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: del,
      },
      game: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await svc.deleteByGame(GAME, OWNER);
    expect(del).not.toHaveBeenCalled();
  });

  it('записи нет (P2025 от Prisma) → идемпотентно, без ошибки', async () => {
    const del = jest.fn().mockRejectedValue({ code: 'P2025' });
    const prisma = makePrisma({
      trace: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: del,
      },
      game: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ whiteId: OWNER, blackId: OTHER }),
      },
    });
    const svc = new PositionalTraceService(prisma, makeAdmin());
    await expect(svc.deleteByGame(GAME, OWNER)).resolves.toBeUndefined();
  });
});
