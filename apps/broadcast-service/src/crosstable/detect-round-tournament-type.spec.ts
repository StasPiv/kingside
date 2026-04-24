/**
 * Unit-тесты `detectRoundTournamentType` (KS-1813).
 *
 * Покрытие по Gherkin:
 *   - playoff: Playoffs / Quarterfinal / Semifinal / Final /
 *     Winners Bracket / Losers Bracket / round of 16 / QF/SF/F;
 *   - playoff по структуре: два игрока сыграли ≥ 2 партии;
 *   - swiss: format или название раунда;
 *   - round_robin: format или название;
 *   - unknown: ничего не распозналось.
 */

import {
  countPairs,
  detectRoundTournamentType,
  hasMatchStructure,
  pairKey,
} from './detect-round-tournament-type';

function game(white: string, black: string) {
  return { whitePlayer: white, blackPlayer: black };
}

describe('detectRoundTournamentType', () => {
  // ── playoff по названию ──────────────────────────────────────────

  it('"Playoffs" → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'Playoffs', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('"Playoffs | Winners" (пример из KS-1813) → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Playoffs | Winners',
        broadcastFormat: 'Knockout',
      }),
    ).toBe('playoff');
  });

  it('"Quarterfinal" → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'Quarterfinal', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('"Semifinal" → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'Semifinal', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('"Final" → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'Final', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('"Grand Final" → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'Grand Final', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('"Winners Bracket" → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Winners Bracket',
        broadcastFormat: null,
      }),
    ).toBe('playoff');
  });

  it('"Losers Bracket" → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Losers Bracket',
        broadcastFormat: null,
      }),
    ).toBe('playoff');
  });

  it('"Round of 16" → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'Round of 16', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('аббревиатура "QF" в скобках → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Championship (QF)',
        broadcastFormat: null,
      }),
    ).toBe('playoff');
  });

  // ── playoff по структуре пар ─────────────────────────────────────

  it('две партии у одной пары → playoff, даже если название нейтральное', () => {
    const games = [
      game('Magnus Carlsen', 'Hikaru Nakamura'),
      game('Hikaru Nakamura', 'Magnus Carlsen'),
      game('Fabi', 'Ding'),
    ];
    expect(
      detectRoundTournamentType({
        roundName: 'Day 3',
        broadcastFormat: '9-round Swiss',
        games,
      }),
    ).toBe('playoff');
  });

  it('одна партия на пару — не playoff по структуре', () => {
    const games = [
      game('Magnus Carlsen', 'Hikaru Nakamura'),
      game('Fabi', 'Ding'),
    ];
    expect(
      detectRoundTournamentType({
        roundName: 'Round 5',
        broadcastFormat: '9-round Swiss',
        games,
      }),
    ).toBe('swiss');
  });

  // ── swiss / round-robin ──────────────────────────────────────────

  it('format содержит "Swiss" → swiss', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round 7',
        broadcastFormat: '11-round Swiss',
      }),
    ).toBe('swiss');
  });

  it('format содержит "round-robin" → round_robin', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round 3',
        broadcastFormat: '14-player round-robin',
      }),
    ).toBe('round_robin');
  });

  it('format "Double Round Robin" → round_robin', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round 1',
        broadcastFormat: 'Double Round Robin',
      }),
    ).toBe('round_robin');
  });

  // ── unknown ──────────────────────────────────────────────────────

  it('ничего не подходит → unknown', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Day 1',
        broadcastFormat: null,
      }),
    ).toBe('unknown');
  });

  it('пустые входы → unknown', () => {
    expect(
      detectRoundTournamentType({ roundName: '', broadcastFormat: '' }),
    ).toBe('unknown');
  });
});

describe('pairKey / countPairs / hasMatchStructure', () => {
  it('pairKey нечувствителен к порядку и регистру', () => {
    expect(pairKey('Magnus', 'Hikaru')).toBe(pairKey('Hikaru', 'Magnus'));
    expect(pairKey('magnus', 'HIKARU')).toBe(pairKey('Hikaru', 'Magnus'));
  });

  it('pairKey с null/пустым → пустая строка', () => {
    expect(pairKey(null, 'X')).toBe('');
    expect(pairKey('', 'X')).toBe('');
  });

  it('countPairs группирует белые/чёрные в одну пару', () => {
    const pairs = countPairs([
      game('A', 'B'),
      game('B', 'A'),
      game('C', 'D'),
    ]);
    expect(pairs.size).toBe(2);
  });

  it('hasMatchStructure true при ≥ 2 партий у пары', () => {
    expect(
      hasMatchStructure([game('A', 'B'), game('B', 'A'), game('C', 'D')]),
    ).toBe(true);
  });

  it('hasMatchStructure false при уникальных парах', () => {
    expect(hasMatchStructure([game('A', 'B'), game('C', 'D')])).toBe(false);
  });
});
