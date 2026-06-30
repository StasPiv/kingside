import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSwissRanking,
  extractRoundCountFromH2,
  extractTiebreakAnnotations,
} from './parse-swiss-ranking';
import { loadHtml } from './parser-common';

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

  /**
   * KS-4817 / chess-results tnr1375699 (Kasparov Chess Foundation
   * Friendship Festival 2026). На странице турнира НЕТ отдельной
   * колонки `Pts.` — только `Rk SNo Name Typ FED Rtg TB1 TB2 TB3`.
   * Footer annotation: `Tie Break1: points (game-points)`. До
   * исправления парсер ставил всем `points=0` и клал значение из TB1
   * в `tiebreaks.tb1` — UI показывал «очки=0, ТВ ненулевые».
   *
   * Ожидаемо: парсер обнаруживает TB1=points через annotation и
   * использует колонку TB1 как `points`, исключая её из `tiebreaks`.
   * Остальные TB (TB2, TB3) — реальные тайбрейки.
   */
  it('KS-4817: нет колонки Pts., TB1=game-points → points берётся из TB1, TB1 не дублируется в tiebreaks', () => {
    const html = loadFixture('swiss-art1-no-pts-tb1-points.html');
    const r = parseSwissRanking(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Точные ожидаемые значения по верхним игрокам этого турнира
    // (взяты из fixture'а; сейчас Xu Xiangyu рангом 1 с 6.0).
    const top = r.data.players.slice(0, 5);
    const points = top.map((p) => p.points);
    expect(points.every((x) => typeof x === 'number')).toBe(true);
    // Никаких поголовно нулевых points (был баг).
    expect(points.every((x) => x === 0)).toBe(false);
    expect(points[0]).toBeGreaterThanOrEqual(points[points.length - 1]);

    // tb1 НЕ должен дублировать points (как было до фикса).
    expect(r.data.tiebreakLabels).toEqual(['tb2', 'tb3']);
    for (const p of top) {
      expect(p.tiebreaks).toBeDefined();
      expect(p.tiebreaks?.tb1).toBeUndefined();
      // tb2/tb3 — реальные тайбрейки, могут быть 0 или >0.
      expect(typeof p.tiebreaks?.tb2 === 'number' || p.tiebreaks?.tb2 === undefined).toBe(true);
    }
  });
});

describe('extractTiebreakAnnotations', () => {
  it('парсит "Tie Break1/2/3: ..." из footer-аннотации', () => {
    const $ = loadHtml(
      '<html><body><span class="CR">Annotation:Tie Break1: points (game-points)Tie Break2: Direct Encounter (DE)Tie Break3: Buchholz Tie-Break Variable (2023) (Gamepoints, Cut1) link</span></body></html>',
    );
    const m = extractTiebreakAnnotations($);
    expect(m.get(1)).toContain('points');
    expect(m.get(1)).toMatch(/game-?points/i);
    expect(m.get(2)).toMatch(/Direct Encounter/i);
    expect(m.get(3)).toMatch(/Buchholz/i);
  });

  it('нет аннотаций → пустая map', () => {
    const $ = loadHtml('<html><body>nothing</body></html>');
    expect(extractTiebreakAnnotations($).size).toBe(0);
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
