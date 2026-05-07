/**
 * Unit-тесты `extractTournamentFormatFromTitle` (KS-2474).
 */

import { extractTournamentFormatFromTitle } from './extract-tournament-format';

describe('extractTournamentFormatFromTitle', () => {
  it('Sardinia: "… | Open A | 9-round Swiss" → "9-round Swiss"', () => {
    expect(
      extractTournamentFormatFromTitle(
        'Sardinia World Chess Festival 2026 | Open A | 9-round Swiss',
      ),
    ).toBe('9-round Swiss');
  });

  it('Открытая швейцарка с разделителем "—" → format', () => {
    expect(
      extractTournamentFormatFromTitle('Sigeman 2026 — 11-round Swiss'),
    ).toBe('11-round Swiss');
  });

  it('Round-robin в хвосте → возвращает', () => {
    expect(
      extractTournamentFormatFromTitle('Norway Chess 2026 | 10-player round-robin'),
    ).toBe('10-player round-robin');
  });

  it('Knockout в хвосте → возвращает', () => {
    expect(
      extractTournamentFormatFromTitle('Champions Chess Tour | Knockout'),
    ).toBe('Knockout');
  });

  it('Single-elimination в хвосте', () => {
    expect(
      extractTournamentFormatFromTitle('FIDE World Cup 2026 | Single-elimination'),
    ).toBe('Single-elimination');
  });

  it('Если хвост — не format, ищет format в более ранних сегментах', () => {
    expect(
      extractTournamentFormatFromTitle('Tata Steel | 9-round Swiss | A-group'),
    ).toBe('9-round Swiss');
  });

  it('Без разделителей, но format в самом title → возвращает весь title', () => {
    expect(
      extractTournamentFormatFromTitle('9-round Swiss Sardinia 2026'),
    ).toBe('9-round Swiss Sardinia 2026');
  });

  it('Format не найден → null', () => {
    expect(
      extractTournamentFormatFromTitle('Sardinia World Chess Festival 2026 | Open A'),
    ).toBeNull();
  });

  it('Пустая строка → null', () => {
    expect(extractTournamentFormatFromTitle('')).toBeNull();
    expect(extractTournamentFormatFromTitle(null)).toBeNull();
    expect(extractTournamentFormatFromTitle(undefined)).toBeNull();
  });

  it('Match (например "Magnus vs Hikaru | Match") → "Match"', () => {
    expect(
      extractTournamentFormatFromTitle('Magnus vs Hikaru | Match'),
    ).toBe('Match');
  });
});
