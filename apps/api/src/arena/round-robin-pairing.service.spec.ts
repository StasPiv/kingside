import { RoundRobinPairingService } from './round-robin-pairing.service';

describe('RoundRobinPairingService', () => {
  let service: RoundRobinPairingService;

  beforeEach(() => {
    service = new RoundRobinPairingService();
  });

  it('should generate N-1 rounds for N players', () => {
    const rounds = service.generateAllRounds(['p1', 'p2', 'p3', 'p4']);
    expect(rounds).toHaveLength(3); // 4 players = 3 rounds
  });

  it('should create pairings for each round', () => {
    const rounds = service.generateAllRounds(['p1', 'p2', 'p3', 'p4']);
    for (const round of rounds) {
      expect(round.length).toBeGreaterThanOrEqual(1);
    }
    // Total non-bye pairings should be 6 (each pair of 4 plays once)
    const nonByePairings = rounds.flat().filter((p) => p.blackId !== null);
    expect(nonByePairings.length).toBe(6);
  });

  it('should handle bye for odd players', () => {
    const rounds = service.generateAllRounds(['p1', 'p2', 'p3']);
    expect(rounds).toHaveLength(3); // 3 players padded to 4 = 3 rounds
    // Total byes across all rounds should be 3 (each player gets one bye)
    const totalByes = rounds.flat().filter((p) => p.blackId === null).length;
    expect(totalByes).toBeGreaterThanOrEqual(3);
  });

  it('should not repeat pairings across rounds', () => {
    const rounds = service.generateAllRounds(['p1', 'p2', 'p3', 'p4']);
    const seen = new Set<string>();
    for (const round of rounds) {
      for (const p of round) {
        if (!p.blackId) continue;
        const key = [p.whiteId, p.blackId].sort().join('-');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
