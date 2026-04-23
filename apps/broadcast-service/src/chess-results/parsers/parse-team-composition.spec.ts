import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTeamComposition } from './parse-team-composition';

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

describe('parseTeamComposition', () => {
  it('team-swiss-art1-composition.html → ok=true, teams и players', () => {
    const html = loadFixture('team-swiss-art1-composition.html');
    const r = parseTeamComposition(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.teams.length).toBeGreaterThan(5);
    expect(r.data.players.length).toBeGreaterThan(20);

    // Команда 1 — Chongqing, RtgAvg=2569, TB1=8.
    const t1 = r.data.teams[0];
    expect(t1.rank).toBe(1);
    expect(t1.name).toBe('Chongqing');
    expect(t1.ratingAvg).toBe(2569);
    expect(t1.points).toBe(8);

    // Player с board=1 в Chongqing — Bu, Xiangzhi, GM, 2666, FideID 8601445.
    const buX = r.data.players.find(
      (p) => p.team === 'Chongqing' && p.rank === 1,
    );
    expect(buX).toBeDefined();
    expect(buX?.name).toBe('Bu, Xiangzhi');
    expect(buX?.title).toBe('GM');
    expect(buX?.elo).toBe(2666);
    expect(buX?.fideId).toBe('8601445');
    expect(buX?.federation).toBe('CHN');
  });

  it('team-rr-art1-composition.html (Slovak Extraliga) → ok=true', () => {
    const html = loadFixture('team-rr-art1-composition.html');
    const r = parseTeamComposition(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.teams.length).toBeGreaterThan(5);
    expect(r.data.players.length).toBeGreaterThan(40);
    // Все players должны иметь team-поле.
    for (const p of r.data.players) {
      expect(p.team).toBeTruthy();
    }
  });

  it('h2-mismatch → ok=false', () => {
    const r = parseTeamComposition(
      '<html><body><div class="defaultDialog"><h2>Other</h2></div></body></html>',
    );
    expect(r.ok).toBe(false);
  });

  it('пустой HTML → ok=false', () => {
    expect(parseTeamComposition('').ok).toBe(false);
  });
});
