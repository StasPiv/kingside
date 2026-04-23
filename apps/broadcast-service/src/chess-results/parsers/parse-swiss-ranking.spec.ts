import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSwissRanking,
  extractRoundCountFromH2,
} from './parse-swiss-ranking';

const FIXTURES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'chess-results',
);

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/**
 * KS-1730 (A05 part 1) — `parseSwissRanking` для art=1 swiss-ranking.
 *
 * Fixture `swiss-art1-ranking.html` — h2="Rank after Round 7", полный
 * swiss с tiebreak'ами TB1..TB6.
 *
 * Edge fixture `pre-start-art1.html` — h2="Rank after Round 0" (турнир
 * ещё не стартовал, только starting rank). Должен распарситься,
 * `roundCount=0`.
 */
describe('parseSwissRanking', () => {
  it('happy path: swiss-art1-ranking.html → ok=true, roundCount=7', () => {
    const html = loadFixture('swiss-art1-ranking.html');
    const r = parseSwissRanking(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.roundCount).toBe(7);
    expect(r.data.players.length).toBeGreaterThan(0);

    // Player 1 — Rk=1, Anadkat Kartavya, Rtg=2234, FED=IND, 6,5 pts.
    const p1 = r.data.players[0];
    expect(p1.rank).toBe(1);
    expect(p1.name).toBe('Anadkat Kartavya');
    expect(p1.elo).toBe(2234);
    expect(p1.federation).toBe('IND');
    expect(p1.points).toBe(6.5);
    expect(p1.normalizedName).toBe('anadkat kartavya');

    // Tiebreaks: TB1=32,5 → tb1=32.5
    expect(p1.tiebreaks).toBeDefined();
    expect(p1.tiebreaks?.tb1).toBe(32.5);
    expect(p1.tiebreaks?.tb2).toBe(35);
    expect(p1.tiebreaks?.tb3).toBe(32.25);

    expect(r.data.tiebreakLabels).toEqual([
      'tb1',
      'tb2',
      'tb3',
      'tb4',
      'tb5',
      'tb6',
    ]);
  });

  it('player 2 имеет title=CM (правильно мапится колонка Title)', () => {
    const html = loadFixture('swiss-art1-ranking.html');
    const r = parseSwissRanking(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p2 = r.data.players[1];
    expect(p2.rank).toBe(2);
    expect(p2.name).toBe('Vedant Rupeshbhai Varasada');
    expect(p2.title).toBe('CM');
  });

  it('pre-start-art1.html (Round 0) → ok=true, roundCount=0', () => {
    const html = loadFixture('pre-start-art1.html');
    const r = parseSwissRanking(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.roundCount).toBe(0);
    // У всех points=0 — никто не играл.
    for (const p of r.data.players) {
      expect(p.points).toBe(0);
    }
  });

  it('h2-mismatch ("Pairings/Results") → ok=false', () => {
    const html =
      '<html><body><div class="defaultDialog"><h2>Pairings/Results</h2></div></body></html>';
    const r = parseSwissRanking(html);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Rank after Round/);
  });

  it('пустой HTML → ok=false', () => {
    expect(parseSwissRanking('').ok).toBe(false);
  });
});

describe('extractRoundCountFromH2', () => {
  it('"Rank after Round 7" → 7', () => {
    expect(extractRoundCountFromH2('Rank after Round 7')).toBe(7);
  });

  it('"Rank after Round 0" → 0', () => {
    expect(extractRoundCountFromH2('Rank after Round 0')).toBe(0);
  });

  it('"Random" → null', () => {
    expect(extractRoundCountFromH2('Random')).toBeNull();
  });

  it('"  Rank after Round  12  " (whitespace) → 12', () => {
    expect(extractRoundCountFromH2('  Rank after Round  12  ')).toBe(12);
  });
});
