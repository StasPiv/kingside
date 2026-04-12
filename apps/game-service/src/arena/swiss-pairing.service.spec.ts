import { SwissPairingService } from './swiss-pairing.service';

describe('SwissPairingService', () => {
  let service: SwissPairingService;

  beforeEach(() => {
    service = new SwissPairingService();
  });

  it('should pair top-half vs bottom-half in round 1', () => {
    const players = [
      { userId: 'p1', score: 0, rating: 2000, opponents: [], colorHistory: [] },
      { userId: 'p2', score: 0, rating: 1800, opponents: [], colorHistory: [] },
      { userId: 'p3', score: 0, rating: 1600, opponents: [], colorHistory: [] },
      { userId: 'p4', score: 0, rating: 1400, opponents: [], colorHistory: [] },
    ];

    const pairings = service.pair(players, 1);

    expect(pairings).toHaveLength(2);
    // #1 vs #3, #2 vs #4
    expect(pairings[0].whiteId).toBe('p1');
    expect(pairings[0].blackId).toBe('p3');
    expect(pairings[1].whiteId).toBe('p2');
    expect(pairings[1].blackId).toBe('p4');
  });

  it('should give bye for odd number of players', () => {
    const players = [
      { userId: 'p1', score: 0, rating: 2000, opponents: [], colorHistory: [] },
      { userId: 'p2', score: 0, rating: 1800, opponents: [], colorHistory: [] },
      { userId: 'p3', score: 0, rating: 1600, opponents: [], colorHistory: [] },
    ];

    const pairings = service.pair(players, 1);

    expect(pairings).toHaveLength(2);
    const bye = pairings.find((p) => p.blackId === null);
    expect(bye).toBeDefined();
  });

  it('should not give bye to player who already had bye', () => {
    const players = [
      { userId: 'p1', score: 1, rating: 2000, opponents: ['p2'], colorHistory: ['w' as const], hadBye: false },
      { userId: 'p2', score: 0, rating: 1800, opponents: ['p1'], colorHistory: ['b' as const], hadBye: false },
      { userId: 'p3', score: 1, rating: 1600, opponents: [], colorHistory: [], hadBye: true },
    ];

    const pairings = service.pair(players, 2);
    const bye = pairings.find((p) => p.blackId === null);
    expect(bye).toBeDefined();
    // p3 already had bye — bye should go to p1 or p2
    expect(bye!.whiteId).not.toBe('p3');
  });

  it('should avoid repeats in later rounds', () => {
    const players = [
      { userId: 'p1', score: 1, rating: 2000, opponents: ['p2'], colorHistory: ['w' as const] },
      { userId: 'p2', score: 0, rating: 1800, opponents: ['p1'], colorHistory: ['b' as const] },
      { userId: 'p3', score: 1, rating: 1600, opponents: ['p4'], colorHistory: ['w' as const] },
      { userId: 'p4', score: 0, rating: 1400, opponents: ['p3'], colorHistory: ['b' as const] },
    ];

    const pairings = service.pair(players, 2);

    // p1 (1pt) should not play p2 again (already faced)
    const p1Pairing = pairings.find((p) => p.whiteId === 'p1' || p.blackId === 'p1');
    expect(p1Pairing?.blackId).not.toBe('p2');
    expect(p1Pairing?.whiteId).not.toBe('p2');
  });
});
