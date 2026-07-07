import { describe, it, expect } from 'vitest';
import type { BroadcastGameSummary } from '@kingside/shared';
import { mergeStreamedGames } from './BroadcastRoundPage';

/**
 * KS-4856 / ADR-159 §3.2 п.2: юнит-тесты стратегии merge server ↔ stream.
 */

function srvGame(overrides: Partial<BroadcastGameSummary> & Pick<BroadcastGameSummary, 'id' | 'lichessGameId'>): BroadcastGameSummary {
  return {
    whitePlayer: 'Alpha',
    blackPlayer: 'Beta',
    whiteElo: null,
    blackElo: null,
    result: '*',
    pgn: null,
    currentFen: 'srv-fen',
    updatedAt: '2026-07-07T05:00:00.000Z',
    bracketStage: 'quarter',
    bracketPairId: 'pair-1',
    matchScore: '1-0',
    whiteClockMs: 1000,
    blackClockMs: 2000,
    clockUpdatedAt: '2026-07-07T05:00:00.000Z',
    lastMoveAt: '2026-07-07T05:00:00.000Z',
    ...overrides,
  };
}

function streamGame(overrides: Partial<BroadcastGameSummary> & Pick<BroadcastGameSummary, 'id' | 'lichessGameId'>): BroadcastGameSummary {
  return {
    whitePlayer: 'Alpha',
    blackPlayer: 'Beta',
    whiteElo: null,
    blackElo: null,
    result: '*',
    pgn: '1. e4',
    currentFen: 'stream-fen',
    updatedAt: '2026-07-07T05:01:00.000Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
    whiteClockMs: 3000,
    blackClockMs: 4000,
    clockUpdatedAt: '2026-07-07T05:01:00.000Z',
    lastMoveAt: '2026-07-07T05:01:00.000Z',
    ...overrides,
  };
}

describe('mergeStreamedGames (KS-4856)', () => {
  it('клиентский stream перезаписывает fen/clocks/pgn/lastMoveAt', () => {
    const server = [srvGame({ id: 'uuid-1', lichessGameId: 'lg1' })];
    const stream = [streamGame({ id: '', lichessGameId: 'lg1' })];
    const [merged] = mergeStreamedGames(server, stream);
    expect(merged.currentFen).toBe('stream-fen');
    expect(merged.pgn).toBe('1. e4');
    expect(merged.whiteClockMs).toBe(3000);
    expect(merged.blackClockMs).toBe(4000);
    expect(merged.clockUpdatedAt).toBe('2026-07-07T05:01:00.000Z');
    expect(merged.lastMoveAt).toBe('2026-07-07T05:01:00.000Z');
  });

  it('серверные bracket-поля и uuid сохраняются', () => {
    const server = [srvGame({ id: 'uuid-1', lichessGameId: 'lg1' })];
    const stream = [streamGame({ id: '', lichessGameId: 'lg1' })];
    const [merged] = mergeStreamedGames(server, stream);
    expect(merged.id).toBe('uuid-1');
    expect(merged.bracketStage).toBe('quarter');
    expect(merged.bracketPairId).toBe('pair-1');
    expect(merged.matchScore).toBe('1-0');
  });

  it('партии из stream без соответствия в server добавляются в конец', () => {
    const server = [srvGame({ id: 'uuid-1', lichessGameId: 'lg1' })];
    const stream = [
      streamGame({ id: '', lichessGameId: 'lg1' }),
      streamGame({ id: '', lichessGameId: 'lg-extra', currentFen: 'x' }),
    ];
    const merged = mergeStreamedGames(server, stream);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('uuid-1');
    expect(merged[1].lichessGameId).toBe('lg-extra');
    expect(merged[1].currentFen).toBe('x');
  });

  it('серверные партии без совпадения в stream остаются без изменений', () => {
    const server = [
      srvGame({ id: 'uuid-1', lichessGameId: 'lg1' }),
      srvGame({ id: 'uuid-2', lichessGameId: 'lg2', currentFen: 'srv2' }),
    ];
    const stream = [streamGame({ id: '', lichessGameId: 'lg1' })];
    const merged = mergeStreamedGames(server, stream);
    expect(merged).toHaveLength(2);
    const g2 = merged.find((g) => g.lichessGameId === 'lg2');
    expect(g2?.currentFen).toBe('srv2');
  });

  it('stream-result "*" не затирает уже финализированный серверный результат', () => {
    const server = [srvGame({ id: 'uuid-1', lichessGameId: 'lg1', result: '1-0' })];
    const stream = [streamGame({ id: '', lichessGameId: 'lg1', result: '*' })];
    const [merged] = mergeStreamedGames(server, stream);
    expect(merged.result).toBe('1-0');
  });

  it('stream-result "1-0" перезаписывает "*" сервера', () => {
    const server = [srvGame({ id: 'uuid-1', lichessGameId: 'lg1', result: '*' })];
    const stream = [streamGame({ id: '', lichessGameId: 'lg1', result: '1-0' })];
    const [merged] = mergeStreamedGames(server, stream);
    expect(merged.result).toBe('1-0');
  });
});
