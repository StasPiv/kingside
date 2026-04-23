import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSwissPairings } from './parse-swiss-pairings';

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

/**
 * KS-1730 (A05 part 2) — `parseSwissPairings` для art=2 swiss-pairings.
 *
 * Fixture `swiss-art2-pairings.html` — h2="Pairings/Results", два h3:
 *   - Round 9 on 2026/04/24 at 09:00 AM (next round, all "not paired").
 *   - Round 8 on 2026/04/23 at 02:30 PM (current round, реальные пары).
 *
 * Парсер должен извлечь оба раунда + сырые pairings.
 */
describe('parseSwissPairings', () => {
  it('happy path: вытаскивает оба раунда (8 и 9)', () => {
    const html = loadFixture('swiss-art2-pairings.html');
    const r = parseSwissPairings(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.rounds.length).toBeGreaterThanOrEqual(2);
    const roundNumbers = r.data.rounds.map((rr) => rr.roundNumber).sort();
    expect(roundNumbers).toContain(8);
    expect(roundNumbers).toContain(9);
  });

  it('Round 9 — все pairs имеют isBye=true (not paired) и black=null', () => {
    const html = loadFixture('swiss-art2-pairings.html');
    const r = parseSwissPairings(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const round9 = r.data.rounds.find((rr) => rr.roundNumber === 9);
    expect(round9).toBeDefined();
    if (!round9) return;
    expect(round9.pairs.length).toBeGreaterThan(0);
    for (const p of round9.pairs) {
      expect(p.isBye).toBe(true);
      expect(p.black).toBeNull();
      // White есть.
      expect(p.white).not.toBeNull();
    }
  });

  it('Round 8 — реальные pairs с обоими игроками, snr извлечён из href', () => {
    const html = loadFixture('swiss-art2-pairings.html');
    const r = parseSwissPairings(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const round8 = r.data.rounds.find((rr) => rr.roundNumber === 8);
    expect(round8).toBeDefined();
    if (!round8) return;
    expect(round8.pairs.length).toBeGreaterThan(5);

    // Board 1: snr=8 (Vedant) vs snr=5 (Anadkat).
    const board1 = round8.pairs.find((p) => p.board === 1);
    expect(board1).toBeDefined();
    if (!board1) return;
    expect(board1.white?.snr).toBe(8);
    expect(board1.white?.name).toBe('Vedant Rupeshbhai Varasada');
    expect(board1.white?.title).toBe('CM');
    expect(board1.white?.rating).toBe(2111);
    expect(board1.black?.snr).toBe(5);
    expect(board1.black?.name).toBe('Anadkat Kartavya');
    expect(board1.black?.rating).toBe(2234);
    expect(board1.isBye).toBe(false);
  });

  it('startsAt парсится в ISO без таймзоны', () => {
    const html = loadFixture('swiss-art2-pairings.html');
    const r = parseSwissPairings(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const round8 = r.data.rounds.find((rr) => rr.roundNumber === 8);
    // "2026/04/23 at 02:30 PM" → 14:30
    expect(round8?.startsAt).toBe('2026-04-23T14:30:00');
    const round9 = r.data.rounds.find((rr) => rr.roundNumber === 9);
    // "2026/04/24 at 09:00 AM" → 09:00
    expect(round9?.startsAt).toBe('2026-04-24T09:00:00');
  });

  it('h2-mismatch → ok=false', () => {
    const r = parseSwissPairings(
      '<html><body><div class="defaultDialog"><h2>Other</h2></div></body></html>',
    );
    expect(r.ok).toBe(false);
  });

  it('пустой HTML → ok=false', () => {
    expect(parseSwissPairings('').ok).toBe(false);
  });
});
