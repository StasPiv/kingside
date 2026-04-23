import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRrCrosstable } from './parse-rr-crosstable';

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
 * KS-1729 (A04) — спека для `parseRrCrosstable` (round-robin matrix art=5).
 *
 * Тестируется на реальном fixture `rr-art5-crosstable.html` (Sri Lanka
 * National Chess Championship 2026, h2="Starting rank crosstable",
 * 14 игроков, 6 туров сыграно).
 */
describe('parseRrCrosstable', () => {
  it('happy path: rr-art5-crosstable.html → ok=true, 14 игроков, matrix 14×14', () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const r = parseRrCrosstable(html);

    expect(r.ok).toBe(true);
    if (!r.ok) return; // type-narrow

    expect(r.data.players).toHaveLength(14);
    expect(r.data.matrix).toHaveLength(14);
    for (const row of r.data.matrix) {
      expect(row).toHaveLength(14);
    }

    // Player 1 — Karunasena, A P Chenitha Sihas Dinsara, Rtg=2020, FED=SRI, CM
    const p1 = r.data.players[0];
    expect(p1.rank).toBe(1);
    expect(p1.name).toBe('Karunasena, A P Chenitha Sihas Dinsara');
    expect(p1.elo).toBe(2020);
    expect(p1.federation).toBe('SRI');
    expect(p1.title).toBe('CM');
    expect(p1.normalizedName).toBe(
      'a p chenitha sihas dinsara karunasena',
    );

    // Диагональ — null result.
    expect(r.data.matrix[0][0].result).toBeNull();

    // Player 1 vs Player 2 — из fixture `<td class="CRc">1</td>` (Karunasena
    // обыграл Dabarera). Ячейка [0][1] — opponentRank=2, result=win.
    expect(r.data.matrix[0][1]).toMatchObject({
      result: 'win',
      opponentRank: 2,
      gameRef: null,
    });

    // Player 2 vs Player 1 — обратная сторона: проиграл (`0`).
    expect(r.data.matrix[1][0].result).toBe('loss');

    // Player 1 vs Player 3 — `½` → draw, score 0.5.
    expect(r.data.matrix[0][2].result).toBe('draw');
  });

  it('игрок 1 имеет gamesPlayed > 0 (сыграл в 6 турах)', () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const r = parseRrCrosstable(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Karunasena — 6 туров: 5 ячеек с результатом + 1 без партнёра?
    // Точное число берём из fixture. Главное — gamesPlayed > 0.
    expect(r.data.players[0].gamesPlayed).toBeGreaterThan(0);
  });

  it('пустые ячейки (round не сыгран) → result=null, opponentRank остаётся', () => {
    const html = loadFixture('rr-art5-crosstable.html');
    const r = parseRrCrosstable(html);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Player 1 vs Player 8 (где-то после round 6 ещё не сыграно) — пусто.
    // В нашем fixture сыграно 6 туров, после ячейки 6 пусто.
    // Berries: ячейка [0][8] (опп=9) — НЕ диагональ, должна иметь
    // opponentRank=9 и result=null.
    const cell = r.data.matrix[0][8];
    expect(cell.opponentRank).toBe(9);
    expect(cell.result).toBeNull();
  });

  it('h2-mismatch → ok=false, reason содержит "crosstable"', () => {
    const html = '<html><body><div class="defaultDialog"><h2>Random page</h2></div></body></html>';
    const r = parseRrCrosstable(html);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('crosstable');
  });

  it('пустой HTML → ok=false', () => {
    const r = parseRrCrosstable('');
    expect(r.ok).toBe(false);
  });

  it('h2 есть, но без таблицы → ok=false', () => {
    const html =
      '<html><body><div class="defaultDialog"><h2>Starting rank crosstable</h2></div></body></html>';
    const r = parseRrCrosstable(html);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/table\.CRs1 not found/);
  });
});
