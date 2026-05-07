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

  it('KS-2564: "Tiebreaks" в Round-Robin турнире → playoff (перебивает RR-формат)', () => {
    // Norway Chess / Champions Chess Tour: основной этап — round-robin
    // (`tour.format = "Round-Robin"`), плюс отдельный раунд «Tiebreaks»
    // для разрешения ничьей. Раньше strict-маркер не содержал tiebreak,
    // и tiebreak-раунд возвращал `round_robin` — партии тайбрейка
    // попадали в круговую таблицу.
    expect(
      detectRoundTournamentType({
        roundName: 'Tiebreaks',
        broadcastFormat: '8-player round-robin',
      }),
    ).toBe('playoff');
  });

  it('KS-2564: "Tiebreak" в Swiss турнире → playoff (перебивает Swiss-формат)', () => {
    // На практике швейцарки разрешают ничью через тайбрейки в стандингах
    // (Бухгольц), а не отдельным раундом. Но если организатор всё-таки
    // создаёт раунд «Tiebreak» — это playoff-стадия по семантике.
    expect(
      detectRoundTournamentType({
        roundName: 'Tiebreak',
        broadcastFormat: '9-round Swiss',
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

  it('две партии у одной пары при пустом формате → playoff', () => {
    // Без явного формата структурный сигнал работает (одиночные
    // турниры, knockout без указания tour.info.format).
    const games = [
      game('Magnus Carlsen', 'Hikaru Nakamura'),
      game('Hikaru Nakamura', 'Magnus Carlsen'),
      game('Fabi', 'Ding'),
    ];
    expect(
      detectRoundTournamentType({
        roundName: 'Day 3',
        broadcastFormat: null,
        games,
      }),
    ).toBe('playoff');
  });

  it('KS-2474: две партии у одной пары на 9-round Swiss → swiss (placeholder Lichess)', () => {
    // Lichess создаёт placeholder-игры за день до раунда — одна пара
    // встречается ≥ 2 раз в broadcast_games без реального match-формата.
    // При явном Swiss/RR формате доверяем формату и игнорируем
    // структурный сигнал. Knockout-стадии Swiss-турниров (Chess.com
    // Open) ловятся strict-маркерами в имени раунда (Playoffs/Bracket/
    // Round of N), а не структурой.
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
    ).toBe('swiss');
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

    it('KS-2564: "Tiebreak" в team → playoff (tiebreak-раунд = отдельная стадия)', () => {
      // Раньше тест ожидал 'swiss': страх ложного срабатывания на team-
      // регламенте. На практике team-турниры не используют слово
      // «Tiebreak» в нейтральных контекстах (тайбрейки в team-стандингах
      // — Бухгольц/match-points, не отдельный раунд). Если организатор
      // явно назвал раунд «Tiebreak» — это всегда playoff-стадия.
      expect(
        detectRoundTournamentType({
          roundName: 'Tiebreak 1',
          broadcastFormat: 'Team Swiss',
          isTeamTournament: true,
        }),
      ).toBe('playoff');
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

    it('структурный сигнал в одиночном при пустом формате → playoff', () => {
      const games = [
        game('A', 'B'),
        game('B', 'A'),
        game('C', 'D'),
      ];
      expect(
        detectRoundTournamentType({
          roundName: 'Day 3',
          broadcastFormat: null,
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

describe('KS-2474: явный tournamentFormat — сигнал высшего приоритета', () => {
  // Регрессия: трансляция «Sardinia World Chess Festival 2026 | Open A»
  // с форматом «9-round Swiss» классифицировалась как playoff из-за
  // совпадения слова «Final» в имени раунда. Явный формат должен
  // перебивать мягкие маркеры в имени.

  it('"9-round Swiss" + "Round 9 | Final" → swiss (Sardinia regression)', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: '9-round Swiss',
        roundName: 'Round 9 | Final',
      }),
    ).toBe('swiss');
  });

  it('"11-round Swiss" + "Final Round" → swiss', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: '11-round Swiss',
        roundName: 'Final Round',
      }),
    ).toBe('swiss');
  });

  it('"Single Round Robin" + любое имя → round_robin', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: 'Single Round Robin',
        roundName: 'Round 3',
      }),
    ).toBe('round_robin');
  });

  it('"Knockout" + "Quarterfinals" → playoff (формат и эвристика согласованы)', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: 'Knockout',
        roundName: 'Quarterfinals',
      }),
    ).toBe('playoff');
  });

  it('tournamentFormat=undefined + "Quarterfinals" → playoff (старая эвристика работает)', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: undefined,
        roundName: 'Quarterfinals',
      }),
    ).toBe('playoff');
  });

  // ── Strict-маркеры в имени всё ещё перебивают Swiss-формат ─────────

  it('"Swiss" + "Playoffs | Final" → playoff (strict-маркер сильнее)', () => {
    // Смешанные турниры: Swiss-фаза + knockout-финал (Chess.com Open).
    // Явный «Playoffs» в имени → playoff даже при Swiss-формате.
    expect(
      detectRoundTournamentType({
        tournamentFormat: '9-round Swiss',
        roundName: 'Playoffs | Final',
      }),
    ).toBe('playoff');
  });

  it('"Swiss" + "R16 Armageddon" → playoff (R16 — strict knockout)', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: '9-round Swiss',
        roundName: 'R16 Armageddon',
      }),
    ).toBe('playoff');
  });

  it('"Swiss" + "Round of 16" → playoff (round of N — strict)', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: '9-round Swiss',
        roundName: 'Round of 16',
      }),
    ).toBe('playoff');
  });

  // ── Knockout-форматы (явный сигнал высшего приоритета) ─────────────

  it('"Single-elimination" + любое имя → playoff', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: 'Single-elimination',
        roundName: 'Round 1',
      }),
    ).toBe('playoff');
  });

  it('"Double Elimination" + "Round 5" → playoff', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: 'Double Elimination',
        roundName: 'Round 5',
      }),
    ).toBe('playoff');
  });

  // ── tournamentFormat имеет приоритет над broadcastFormat ───────────

  it('tournamentFormat="Swiss" перебивает broadcastFormat="Knockout"', () => {
    // На случай рассинхрона полей: явное tournamentFormat имеет
    // приоритет.
    expect(
      detectRoundTournamentType({
        tournamentFormat: 'Swiss',
        broadcastFormat: 'Knockout',
        roundName: 'Round 5',
      }),
    ).toBe('swiss');
  });

  // ── Структурный сигнал по-прежнему перебивает Swiss-формат ─────────

  it('Swiss-формат + структура match (две партии пары) → swiss (KS-2474 hotfix)', () => {
    // Lichess placeholder-партии давали ложный structureSaysMatch=true
    // на швейцарках (Sardinia Open A). При явном Swiss формате
    // доверяем формату — knockout-стадии Swiss-турниров ловятся
    // strict-маркерами в имени, а не структурой пар.
    const games = [
      { whitePlayer: 'A', blackPlayer: 'B' },
      { whitePlayer: 'B', blackPlayer: 'A' },
      { whitePlayer: 'C', blackPlayer: 'D' },
    ];
    expect(
      detectRoundTournamentType({
        tournamentFormat: '9-round Swiss',
        roundName: 'Day 3',
        games,
      }),
    ).toBe('swiss');
  });

  // ── isTeamTournament + tournamentFormat ────────────────────────────

  it('team Swiss + "Final Match Day 1" → swiss (KS-2474 + KS-1847)', () => {
    expect(
      detectRoundTournamentType({
        tournamentFormat: 'Team Swiss',
        roundName: 'Final Match Day 1',
        isTeamTournament: true,
      }),
    ).toBe('swiss');
  });

  it('Sardinia full regression: Round 1 + 9-round Swiss + placeholder pairs → swiss', () => {
    // Полный сценарий поломки: Round 1 ещё не сыгран, Lichess создал
    // placeholder-партии за сутки + реальные → две партии у одной пары.
    // Без KS-2474-fix классифицировался как playoff (структура), хотя
    // tournamentFormat явно 9-round Swiss.
    const games = [
      { whitePlayer: 'Aronian', blackPlayer: 'Caruana' },
      { whitePlayer: 'Caruana', blackPlayer: 'Aronian' }, // placeholder
      { whitePlayer: 'Vidit', blackPlayer: 'Giri' },
      { whitePlayer: 'Giri', blackPlayer: 'Vidit' }, // placeholder
    ];
    expect(
      detectRoundTournamentType({
        tournamentFormat: '9-round Swiss',
        roundName: 'Round 1',
        games,
      }),
    ).toBe('swiss');
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
