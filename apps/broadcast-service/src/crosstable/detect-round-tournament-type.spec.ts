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

  // ── KS-1819: Armageddon + R16/R32/R8 сокращения ──────────────────

  it('"Round of 16 | Armageddon" → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round of 16 | Armageddon',
        broadcastFormat: null,
      }),
    ).toBe('playoff');
  });

  it('"R16 Armageddon" → playoff (Chess.com сокращение)', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'R16 Armageddon',
        broadcastFormat: null,
      }),
    ).toBe('playoff');
  });

  it('"R8" сам по себе → playoff', () => {
    expect(
      detectRoundTournamentType({ roundName: 'R8', broadcastFormat: null }),
    ).toBe('playoff');
  });

  it('"Armageddon" сам по себе → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Armageddon',
        broadcastFormat: 'Knockout',
      }),
    ).toBe('playoff');
  });

  it('"Tiebreak" → playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Tiebreak 1',
        broadcastFormat: null,
      }),
    ).toBe('playoff');
  });

  it('"Round 16" (без "of") — НЕ матчит R16-сокращение (это Round 16 швейцарки)', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round 16',
        broadcastFormat: '11-round Swiss',
      }),
    ).toBe('swiss');
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

  // ── KS-1847: командные турниры (`isTeamTournament=true`) ─────────
  //
  // Для team-форматов слова `final/championship/winners/losers/grand
  // final/tie-break` штатно встречаются как часть регламента и не
  // должны детектиться как knockout. Строгий whitelist видит только
  // однозначные knockout-маркеры.

  describe('isTeamTournament=true (KS-1847)', () => {
    it('"Championship Round 5" НЕ playoff (team-регламент)', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Championship Round 5',
          broadcastFormat: 'Team round-robin',
          isTeamTournament: true,
        }),
      ).toBe('round_robin');
    });

    it('"Final Match Day 1" НЕ playoff (team-финальный день)', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Final Match Day 1',
          broadcastFormat: 'Team Swiss',
          isTeamTournament: true,
        }),
      ).toBe('swiss');
    });

    it('"Winners Group" НЕ playoff (групповая стадия team)', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Winners Group',
          broadcastFormat: '8-team round-robin',
          isTeamTournament: true,
        }),
      ).toBe('round_robin');
    });

    it('"Grand Final" в team-формате НЕ playoff', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Grand Final',
          broadcastFormat: 'Team round-robin',
          isTeamTournament: true,
        }),
      ).toBe('round_robin');
    });

    it('"Tiebreak" в team НЕ playoff (был ложный триггер)', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Tiebreak 1',
          broadcastFormat: 'Team Swiss',
          isTeamTournament: true,
        }),
      ).toBe('swiss');
    });

    it('регрессия: "Quarterfinals" в team ВСЁ РАВНО playoff (жёсткий маркер)', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Quarterfinals',
          broadcastFormat: 'Team Knockout',
          isTeamTournament: true,
        }),
      ).toBe('playoff');
    });

    it('регрессия: "Semifinal" в team → playoff', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Semifinal',
          broadcastFormat: null,
          isTeamTournament: true,
        }),
      ).toBe('playoff');
    });

    it('регрессия: "Round of 16" в team → playoff', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Round of 16',
          broadcastFormat: null,
          isTeamTournament: true,
        }),
      ).toBe('playoff');
    });

    it('регрессия: "Playoffs | Winners" даже в team → playoff', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Playoffs | Winners',
          broadcastFormat: 'Team Knockout',
          isTeamTournament: true,
        }),
      ).toBe('playoff');
    });

    it('регрессия: "R16 Armageddon" в team → playoff', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'R16 Armageddon',
          broadcastFormat: null,
          isTeamTournament: true,
        }),
      ).toBe('playoff');
    });

    it('структурный сигнал (две партии одной пары) в team НЕ даёт playoff', () => {
      // Двухкруговка team-round-robin: команда A и команда B сыграли
      // две встречи — на первой доске те же игроки поменялись цветом.
      const games = [
        game('Magnus Carlsen', 'Hikaru Nakamura'),
        game('Hikaru Nakamura', 'Magnus Carlsen'),
        game('Fabi', 'Ding'),
      ];
      expect(
        detectRoundTournamentType({
          roundName: 'Round 5',
          broadcastFormat: 'Team round-robin',
          isTeamTournament: true,
          games,
        }),
      ).toBe('round_robin');
    });
  });

  // ── KS-1847: контроль — одиночные турниры не затронуты ───────────

  describe('регрессия одиночных турниров (isTeamTournament=false/undefined)', () => {
    it('"Playoffs | Winners" без флага (одиночный) → playoff, как раньше', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Playoffs | Winners',
          broadcastFormat: 'Knockout',
        }),
      ).toBe('playoff');
    });

    it('"Championship" в одиночном → playoff (старый whitelist)', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Championship',
          broadcastFormat: null,
          isTeamTournament: false,
        }),
      ).toBe('playoff');
    });

    it('"Winners Bracket" в одиночном → playoff', () => {
      expect(
        detectRoundTournamentType({
          roundName: 'Winners Bracket',
          broadcastFormat: null,
          isTeamTournament: false,
        }),
      ).toBe('playoff');
    });

    it('структурный сигнал в одиночном → playoff (сохранено)', () => {
      const games = [
        game('A', 'B'),
        game('B', 'A'),
        game('C', 'D'),
      ];
      expect(
        detectRoundTournamentType({
          roundName: 'Day 3',
          broadcastFormat: '9-round Swiss',
          isTeamTournament: false,
          games,
        }),
      ).toBe('playoff');
    });
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

describe('KS-2212: round-robin format отключает structureSaysMatch', () => {
  // Lichess создаёт placeholder-игры за день до тура, затем новые lichessGameId
  // для реальных партий. Одна пара встречается ≥ 2 раз в broadcast_games —
  // без фикса это ложно триггерило 'playoff' для round-robin туров.

  const sigeman2Pairs = [
    // Placeholder (вчера, result=*)
    game('Grandelius, Nils', 'Carlsen, Magnus'),
    game('Erdogmus, Yagiz Kaan', 'Erigaisi Arjun'),
    game('Van Foreest, Jorden', 'Zhu, Jiner'),
    game('Abdusattorov, Nodirbek', 'Woodward, Andy'),
    // Реальные (сегодня)
    game('Grandelius, Nils', 'Carlsen, Magnus'),
    game('Erdogmus, Yagiz Kaan', 'Erigaisi Arjun'),
    game('Van Foreest, Jorden', 'Zhu, Jiner'),
    game('Abdusattorov, Nodirbek', 'Woodward, Andy'),
  ];

  it('Round 2 Sigeman-like → round_robin, не playoff', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round 2',
        broadcastFormat: '8-player round-robin',
        games: sigeman2Pairs,
      }),
    ).toBe('round_robin');
  });

  it('тот же набор без явного формата → playoff (старое поведение)', () => {
    // Без formаt структурный сигнал по-прежнему работает.
    expect(
      detectRoundTournamentType({
        roundName: 'Round 2',
        broadcastFormat: null,
        games: sigeman2Pairs,
      }),
    ).toBe('playoff');
  });

  it('«round robin» (с пробелом) тоже отключает structureSaysMatch', () => {
    expect(
      detectRoundTournamentType({
        roundName: 'Round 3',
        broadcastFormat: '10-player round robin',
        games: sigeman2Pairs,
      }),
    ).toBe('round_robin');
  });

  it('явный playoff-name перекрывает даже round-robin формат', () => {
    // «Playoffs» в названии раунда → однозначный knockout-маркер,
    // даже если broadcast format = round-robin.
    expect(
      detectRoundTournamentType({
        roundName: 'Playoffs | Final',
        broadcastFormat: '8-player round-robin',
        games: [],
      }),
    ).toBe('playoff');
  });
});
