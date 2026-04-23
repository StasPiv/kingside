import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTeamStandings } from './parse-team-standings';

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

describe('parseTeamStandings', () => {
  it('team-swiss-art0-teamrank.html → variant=team-swiss, roundCount=5', () => {
    const html = loadFixture('team-swiss-art0-teamrank.html');
    const r = parseTeamStandings(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.variant).toBe('team-swiss');
    expect(r.data.roundCount).toBe(5);
    expect(r.data.teams.length).toBeGreaterThan(5);

    // Team rank=1 — Chongqing, points = TB1 (8).
    const top = r.data.teams[0];
    expect(top.rank).toBe(1);
    expect(top.name).toBe('Chongqing');
    expect(top.points).toBe(8);
  });

  it('team-rr-art0-crosstable.html → variant=team-round-robin, roundCount=null', () => {
    const html = loadFixture('team-rr-art0-crosstable.html');
    const r = parseTeamStandings(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.variant).toBe('team-round-robin');
    expect(r.data.roundCount).toBeNull();
    expect(r.data.teams.length).toBeGreaterThan(5);
    expect(r.data.teams[0].rank).toBe(1);
    expect(r.data.teams[0].name).toBe('CAISSA Čadca');
  });

  it('h2-mismatch → ok=false', () => {
    const r = parseTeamStandings(
      '<html><body><div class="defaultDialog"><h2>Random</h2></div></body></html>',
    );
    expect(r.ok).toBe(false);
  });

  it('пустой HTML → ok=false', () => {
    expect(parseTeamStandings('').ok).toBe(false);
  });
});
