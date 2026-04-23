import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTeamPairings } from './parse-team-pairings';

const FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'chess-results',
);
const loadFixture = (n: string): string =>
  readFileSync(join(FIXTURES_DIR, n), 'utf8');

describe('parseTeamPairings', () => {
  it('team-swiss-art2-teampairings.html → ok=true, несколько туров', () => {
    const html = loadFixture('team-swiss-art2-teampairings.html');
    const r = parseTeamPairings(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rounds.length).toBeGreaterThanOrEqual(3);

    const round1 = r.data.rounds.find((rr) => rr.roundNumber === 1);
    expect(round1).toBeDefined();
    if (!round1) return;
    expect(round1.startsAt).toBe('2026-04-19T14:30:00');
    expect(round1.pairs.length).toBeGreaterThan(5);

    // Round 1 / pair 1 — Shanghai vs Beijing 3:1.
    const p1 = round1.pairs.find((p) => p.no === 1);
    expect(p1).toEqual({
      no: 1,
      teamA: 'Shanghai',
      teamB: 'Beijing',
      scoreA: 3,
      scoreB: 1,
      isBye: false,
    });

    // Round 1 / pair 8 — Hubei vs bye.
    const p8 = round1.pairs.find((p) => p.no === 8);
    expect(p8?.isBye).toBe(true);
    expect(p8?.teamB.toLowerCase()).toBe('bye');
    expect(p8?.scoreA).toBe(2);
  });

  it('h2-mismatch → ok=false', () => {
    const r = parseTeamPairings(
      '<html><body><div class="defaultDialog"><h2>Other</h2></div></body></html>',
    );
    expect(r.ok).toBe(false);
  });

  it('пустой HTML → ok=false', () => {
    expect(parseTeamPairings('').ok).toBe(false);
  });
});
