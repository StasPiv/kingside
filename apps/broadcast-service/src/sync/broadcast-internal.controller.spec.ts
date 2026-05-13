/**
 * KS-2883 / ADR-060 §3.7 B10. Тесты BroadcastInternalController —
 * контракт с api (KS-2884).
 *
 * Покрытие:
 *  - 200: round найден → shape { round: {id, name}, games: [...] };
 *    null pgn нормализуется в пустую строку;
 *  - 404: round не найден.
 *
 * Guard (`InternalKeyGuard`) тестируется отдельно (см.
 * `internal-key.guard.spec.ts`); здесь его обходим прямой инстанциацией
 * контроллера.
 */
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { BroadcastInternalController } from './broadcast-internal.controller';

function makePrisma(): any {
  return {
    broadcastRound: {
      findUnique: jest.fn(),
    },
    broadcastGame: {
      findMany: jest.fn(),
    },
  };
}

const ROUND_ID = '11111111-1111-4111-a111-111111111111';

describe('BroadcastInternalController (KS-2883)', () => {
  let prisma: any;
  let ctl: BroadcastInternalController;

  beforeEach(() => {
    prisma = makePrisma();
    ctl = new BroadcastInternalController(prisma as unknown as PrismaService);
  });

  it('200: round + games в контрактной форме', async () => {
    prisma.broadcastRound.findUnique.mockResolvedValue({
      id: ROUND_ID,
      name: 'Round 1',
    });
    prisma.broadcastGame.findMany.mockResolvedValue([
      {
        id: 'g1',
        pgn: '1. e4 e5 *',
        whitePlayer: 'Carlsen',
        blackPlayer: 'Nepo',
        result: '*',
      },
      {
        id: 'g2',
        pgn: null,
        whitePlayer: 'Caruana',
        blackPlayer: 'Ding',
        result: null,
      },
    ]);

    const r = await ctl.getRoundWithGames(ROUND_ID);

    expect(r.round).toEqual({ id: ROUND_ID, name: 'Round 1' });
    expect(r.games).toHaveLength(2);
    expect(r.games[0]).toEqual({
      id: 'g1',
      pgn: '1. e4 e5 *',
      whitePlayer: 'Carlsen',
      blackPlayer: 'Nepo',
      result: '*',
    });
    // null pgn → пустая строка (контракт с api: pgn всегда string)
    expect(r.games[1].pgn).toBe('');
  });

  it('404 если round не найден', async () => {
    prisma.broadcastRound.findUnique.mockResolvedValue(null);
    await expect(ctl.getRoundWithGames(ROUND_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
