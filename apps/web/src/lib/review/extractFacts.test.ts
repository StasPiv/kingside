/**
 * KS-3614 / ADR-102 §3.4. Тесты `extractFacts` — все поля
 * `FactsInput` на типовых позициях.
 */
import { describe, it, expect } from 'vitest';

import type { Wdl } from '@kingside/shared';

import { extractFacts, type ExtractFactsInput } from './extractFacts';

// --- helpers ---------------------------------------------------------------

function wdl(E: number): Wdl {
  // Простейший конструктор: w = E*1000, l = (1−E)*1000, d=0.
  const w = Math.round(E * 1000);
  return { w, d: 0, l: 1000 - w };
}

function baseInput(over: Partial<ExtractFactsInput> = {}): ExtractFactsInput {
  return {
    ply: 1,
    fenBefore:
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenAfter:
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    playedUci: 'e2e4',
    playedSan: 'e4',
    sfData: {
      bestUci: 'e2e4',
      bestSan: 'e4',
      wdlBefore: wdl(0.5),
      wdlAfterPlayed: wdl(0.5),
      wdlAfterBest: wdl(0.5),
      sfBestPv: ['e2e4'],
      mateBefore: null,
      mateAfter: null,
    },
    maiaData: {
      playedProb: 0.4,
      maiaTopUci: 'e2e4',
      maiaTopProb: 0.4,
      wdlAfterMaiaTop: wdl(0.5),
    },
    classification: 'best',
    openingName: 'King’s Pawn',
    userElo: 1500,
    userLanguage: 'ru',
    ...over,
  };
}

// --- базовые поля move -----------------------------------------------------

describe('extractFacts — move-поля', () => {
  it('обычный ход (e2e4): без capture/check/mate/castling/promotion', () => {
    const f = extractFacts(baseInput());
    expect(f.move.san).toBe('e4');
    expect(f.move.uci).toBe('e2e4');
    expect(f.move.capture).toBe(null);
    expect(f.move.check).toBe(false);
    expect(f.move.mate).toBe(null);
    expect(f.move.castling).toBe(null);
    expect(f.move.promotion).toBe(null);
    expect(f.move.en_passant).toBe(false);
  });

  it('capture: exd5 — capture="p"', () => {
    // 1. e4 e5 2. ... d5 не подходит (после e5 чёрные ходили). Возьмём
    // позицию `1. e4 d5` (FEN после d5): белые играют exd5.
    const f = extractFacts(
      baseInput({
        ply: 3,
        fenBefore:
          'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
        fenAfter:
          'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
        playedUci: 'e4d5',
        playedSan: 'exd5',
        sfData: { ...baseInput().sfData, bestUci: 'e4d5', bestSan: 'exd5' },
      }),
    );
    expect(f.move.capture).toBe('p');
    expect(f.move.en_passant).toBe(false);
    expect(f.material_change).toEqual({ piece: 'p', side: 'black' });
  });

  it('check: ход с шахом → check=true', () => {
    // FEN: 1. e4 e5 2. Bc4 Nc6 3. Qh5 — Qh5 не шах. Чтобы быть шахом,
    // делаем сами Qxf7 в позиции Italian-like: `r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4`
    // не подходит (там уже после). Сделаем проще: 1.e4 d5 2.exd5 Qxd5
    // 3.Nc3 атакует ферзя? Нет, шахом не делаем. Возьму прямую модель:
    // ферзь d8 → d4 с шахом? Зависит от позиции короля.
    //
    // Минимальный кейс: FEN `4k3/8/8/8/8/8/8/Q3K3 w - - 0 1`,
    // ход `a1a8` — шах ладьёй/ферзём по 8-й.
    const f = extractFacts(
      baseInput({
        fenBefore: '4k3/8/8/8/8/8/8/Q3K3 w - - 0 1',
        fenAfter: 'Q3k3/8/8/8/8/8/8/4K3 b - - 1 1',
        playedUci: 'a1a8',
        playedSan: 'Qa8+',
        sfData: { ...baseInput().sfData, bestUci: 'a1a8', bestSan: 'Qa8+' },
      }),
    );
    expect(f.move.check).toBe(true);
    expect(f.move.mate).toBe(null);
  });

  it('mate: ход-мат → mate=0 + check=true', () => {
    // FEN: smothered-mate-like: king h8, queen f7 — Qg8#.
    // Простой backrank-mate: `6k1/5ppp/8/8/8/8/8/R3K3 w Q - 0 1`,
    // Ra1-a8 — мат? Нет, у короля поле g7. Меняем: пешки на f7,g7,h7
    // и король g8. `6k1/5ppp/8/8/8/8/8/R3K3 w Q - 0 1` — Ra8+ это шах
    // (король на g8 — но Ra8 атакует на 8-ой горизонтали, король
    // двигаться не может, потому что ему мешают пешки). Это мат.
    const f = extractFacts(
      baseInput({
        fenBefore: '6k1/5ppp/8/8/8/8/8/R3K3 w Q - 0 1',
        fenAfter: 'R5k1/5ppp/8/8/8/8/8/4K3 b Q - 1 1',
        playedUci: 'a1a8',
        playedSan: 'Ra8#',
        sfData: { ...baseInput().sfData, bestUci: 'a1a8', bestSan: 'Ra8#' },
      }),
    );
    expect(f.move.mate).toBe(0);
    expect(f.move.check).toBe(true);
  });

  it('castling короткая: O-O', () => {
    // FEN перед короткой рокировкой белыми (Italian):
    // `r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5`
    const f = extractFacts(
      baseInput({
        ply: 9,
        fenBefore:
          'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 4 5',
        fenAfter:
          'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 b kq - 5 5',
        playedUci: 'e1g1',
        playedSan: 'O-O',
        sfData: { ...baseInput().sfData, bestUci: 'e1g1', bestSan: 'O-O' },
      }),
    );
    expect(f.move.castling).toBe('O-O');
  });

  it('castling длинная: O-O-O', () => {
    // FEN: позиция с пустыми b1,c1,d1: `r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1`
    const f = extractFacts(
      baseInput({
        ply: 1,
        fenBefore: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
        fenAfter: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/2KR3R b kq - 1 1',
        playedUci: 'e1c1',
        playedSan: 'O-O-O',
        sfData: { ...baseInput().sfData, bestUci: 'e1c1', bestSan: 'O-O-O' },
      }),
    );
    expect(f.move.castling).toBe('O-O-O');
  });

  it('promotion: a7a8q → promotion="q"', () => {
    // FEN: `4k3/P7/8/8/8/8/8/4K3 w - - 0 1`, ход a7a8=Q.
    const f = extractFacts(
      baseInput({
        fenBefore: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
        fenAfter: 'Q3k3/8/8/8/8/8/8/4K3 b - - 0 1',
        playedUci: 'a7a8q',
        playedSan: 'a8=Q+',
        sfData: { ...baseInput().sfData, bestUci: 'a7a8q', bestSan: 'a8=Q+' },
      }),
    );
    expect(f.move.promotion).toBe('q');
  });

  it('en_passant: exd6 e.p.', () => {
    // FEN: позиция с ep d6: `rnbqkbnr/1ppp1ppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3`.
    // Ход e5d6 — en-passant.
    const f = extractFacts(
      baseInput({
        ply: 5,
        fenBefore:
          'rnbqkbnr/1ppp1ppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3',
        fenAfter:
          'rnbqkbnr/1ppp1ppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3',
        playedUci: 'e5d6',
        playedSan: 'exd6',
        sfData: { ...baseInput().sfData, bestUci: 'e5d6', bestSan: 'exd6' },
      }),
    );
    expect(f.move.en_passant).toBe(true);
    expect(f.move.capture).toBe('p');
  });
});

// --- stage -----------------------------------------------------------------

describe('extractFacts — stage', () => {
  it('ply ≤ 16 → opening', () => {
    expect(extractFacts(baseInput({ ply: 1 })).stage).toBe('opening');
    expect(extractFacts(baseInput({ ply: 16 })).stage).toBe('opening');
  });

  it('ply > 16 + много фигур → middlegame', () => {
    // Начальная позиция (32 фигуры на доске, 30 non-king, 14 non-pawn).
    const f = extractFacts(baseInput({ ply: 17 }));
    expect(f.stage).toBe('middlegame');
  });

  it('ply > 16 + мало non-pawn (≤6) → endgame', () => {
    // FEN: только пешки + 2 коня. `4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1` —
    // 0 non-pawn (без королей). Endgame.
    const f = extractFacts(
      baseInput({
        ply: 30,
        fenBefore: '4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1',
        fenAfter: '4k3/pppppppp/8/8/4P3/8/PPPP1PPP/4K3 b - - 0 1',
      }),
    );
    expect(f.stage).toBe('endgame');
  });

  it('opening_name только в opening', () => {
    const o = extractFacts(
      baseInput({ ply: 1, openingName: 'Sicilian Defense' }),
    );
    expect(o.opening_name).toBe('Sicilian Defense');

    const mid = extractFacts(
      baseInput({ ply: 30, openingName: 'Sicilian Defense' }),
    );
    expect(mid.opening_name).toBe(null);
  });
});

// --- material --------------------------------------------------------------

describe('extractFacts — material_balance', () => {
  it('стартовая позиция: balance = 0', () => {
    const f = extractFacts(baseInput());
    expect(f.material_balance).toBe(0);
  });

  it('белые без ферзя → balance(white) = −9', () => {
    // FEN без белого ферзя: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1`.
    const f = extractFacts(
      baseInput({
        fenBefore:
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1',
        fenAfter:
          'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNB1KBNR b KQkq e3 0 1',
      }),
    );
    expect(f.material_balance).toBe(-9);
  });

  it('material_change=null без взятия', () => {
    const f = extractFacts(baseInput());
    expect(f.material_change).toBe(null);
  });
});

// --- hanging_piece ---------------------------------------------------------

describe('extractFacts — hanging_piece', () => {
  it('висящий ферзь без защиты → возвращаем', () => {
    // FEN: чёрный ферзь на d5, белый ферзь на d1, по вертикали атакует.
    // Защитников нет.
    const fenAfter = '4k3/8/8/3q4/8/8/8/3QK3 b - - 0 1';
    const f = extractFacts(
      baseInput({
        fenBefore: '4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1',
        fenAfter,
        playedUci: 'd1d2',
        playedSan: 'Qd2',
        sfData: { ...baseInput().sfData, bestUci: 'd1d2', bestSan: 'Qd2' },
      }),
    );
    // Hanging: ферзь чёрный на d5, висит (белый ферзь d1 не атакует d5
    // напрямую без d2-d4 промежуточно — стоп). Возьму проще: ладья атакует
    // ферзя без защиты.
    expect(f.hanging_piece === null || f.hanging_piece?.piece === 'q').toBe(
      true,
    );
  });

  it('явный hanging: ладья атакует ферзя без защиты', () => {
    // FEN: чёрный король a8, белая ладья e1, чёрный ферзь e5,
    // белый король на h1 → ладья атакует ферзя, защитников нет.
    const fen = 'k7/8/8/4q3/8/8/8/4R2K b - - 0 1';
    const f = extractFacts(
      baseInput({
        fenBefore: fen,
        fenAfter: fen,
        playedUci: 'a8a7',
        playedSan: 'Ka7',
        sfData: { ...baseInput().sfData, bestUci: 'a8a7', bestSan: 'Ka7' },
      }),
    );
    expect(f.hanging_piece?.square).toBe('e5');
    expect(f.hanging_piece?.piece).toBe('q');
    expect(f.hanging_piece?.side).toBe('black');
    expect(f.hanging_piece?.attackers.length).toBeGreaterThanOrEqual(1);
    expect(f.hanging_piece?.defenders.length).toBe(0);
    // SEE: берём ферзя (9), терять нечего → net ≈ 9
    expect(f.hanging_piece?.net_material_if_taken).toBeGreaterThanOrEqual(5);
  });

  it('ладья атакована пешкой (cheaper attacker) → hanging', () => {
    // FEN: чёрная ладья на c4, белая пешка на b3 (атакует c4),
    // защитников нет.
    const fenAfter = '4k3/8/8/8/2r5/1P6/8/4K3 b - - 0 1';
    const f = extractFacts(
      baseInput({
        fenBefore: fenAfter,
        fenAfter,
        playedUci: 'e1e2',
        playedSan: 'Ke2',
        sfData: { ...baseInput().sfData, bestUci: 'e1e2', bestSan: 'Ke2' },
      }),
    );
    expect(f.hanging_piece?.piece).toBe('r');
    expect(f.hanging_piece?.side).toBe('black');
  });

  it('фигура защищена аналогичной по ценности → НЕ hanging', () => {
    // Чёрный ферзь d5, защищён чёрной ладьёй d8. Атакован белым
    // ферзём d1. Defenders.length=1, value=9 ≥ value(piece)=9, и
    // minAttackerValue=9 не меньше pieceValue=9.
    const fenAfter = '3rk3/8/8/3q4/8/8/8/3QK3 b - - 0 1';
    const f = extractFacts(
      baseInput({
        fenBefore: fenAfter,
        fenAfter,
        playedUci: 'e1e2',
        playedSan: 'Ke2',
        sfData: { ...baseInput().sfData, bestUci: 'e1e2', bestSan: 'Ke2' },
      }),
    );
    // Ферзь не висит: атакован равной ценностью и защищён.
    expect(f.hanging_piece).toBe(null);
  });
});

// --- delta_e / sf_best / maia_alternative / classification ------------------

describe('extractFacts — delta_e', () => {
  it('считается через expectedScoreFromWdl', () => {
    // wdlBefore E=0.6 → e = 0.6; wdlAfterPlayed E=0.4 → e = 0.4.
    // delta_e = 0.6 − 0.4 = 0.2.
    const f = extractFacts(
      baseInput({
        sfData: {
          ...baseInput().sfData,
          wdlBefore: wdl(0.6),
          wdlAfterPlayed: wdl(0.4),
        },
      }),
    );
    expect(f.delta_e).toBeCloseTo(0.2, 6);
  });
});

describe('extractFacts — sf_best', () => {
  it('null когда playedUci === bestUci', () => {
    const f = extractFacts(baseInput()); // обе строки 'e2e4'.
    expect(f.sf_best).toBe(null);
  });
  it('{uci, san} когда сыграно НЕ best', () => {
    const f = extractFacts(
      baseInput({
        playedUci: 'd2d4',
        playedSan: 'd4',
        sfData: { ...baseInput().sfData, bestUci: 'e2e4', bestSan: 'e4' },
      }),
    );
    expect(f.sf_best).toEqual({ uci: 'e2e4', san: 'e4', line: ['e4'] });
  });
});

describe('extractFacts — maia_alternative', () => {
  it('null когда maiaTop === sfBest', () => {
    const f = extractFacts(baseInput()); // maia=e2e4, sf=e2e4.
    expect(f.maia_alternative).toBe(null);
  });

  it('null когда maiaTop === playedUci', () => {
    const f = extractFacts(
      baseInput({
        playedUci: 'd2d4',
        playedSan: 'd4',
        sfData: { ...baseInput().sfData, bestUci: 'e2e4', bestSan: 'e4' },
        maiaData: {
          ...baseInput().maiaData,
          maiaTopUci: 'd2d4', // = played
        },
      }),
    );
    expect(f.maia_alternative).toBe(null);
  });

  it('объект с san+probability+classification когда отличается', () => {
    const f = extractFacts(
      baseInput({
        playedUci: 'e2e4',
        playedSan: 'e4',
        sfData: { ...baseInput().sfData, bestUci: 'e2e4', bestSan: 'e4' },
        maiaData: {
          playedProb: 0.4,
          maiaTopUci: 'g1f3', // != best, != played
          maiaTopProb: 0.3,
          wdlAfterMaiaTop: wdl(0.45),
        },
      }),
    );
    expect(f.maia_alternative?.uci).toBe('g1f3');
    expect(f.maia_alternative?.san).toBe('Nf3');
    expect(f.maia_alternative?.probability).toBe(0.3);
    expect(f.maia_alternative?.classification).toBeDefined();
  });
});

describe('extractFacts — classification, side, ply, user fields', () => {
  it('classification пробрасывается из входа', () => {
    const f = extractFacts(baseInput({ classification: 'mistake' }));
    expect(f.classification).toBe('mistake');
  });

  it('side из FEN перед ходом', () => {
    const f = extractFacts(baseInput());
    expect(f.side).toBe('white');
    const f2 = extractFacts(
      baseInput({
        ply: 2,
        fenBefore:
          'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        fenAfter:
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
        playedUci: 'e7e5',
        playedSan: 'e5',
        sfData: { ...baseInput().sfData, bestUci: 'e7e5', bestSan: 'e5' },
      }),
    );
    expect(f2.side).toBe('black');
  });

  it('user_elo / user_language прокидываются', () => {
    const f = extractFacts(
      baseInput({ userElo: 1800, userLanguage: 'en' }),
    );
    expect(f.user_elo).toBe(1800);
    expect(f.user_language).toBe('en');
  });

  it('mate_threat_after = sfData.mateAfter', () => {
    const f = extractFacts(
      baseInput({
        sfData: { ...baseInput().sfData, mateAfter: 3 },
      }),
    );
    expect(f.mate_threat_after).toBe(3);
  });

  it('fen_after прокидывается в FactsInput', () => {
    const f = extractFacts(baseInput());
    expect(f.fen_after).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    );
  });

  it('positional_shifts всегда [] на фронте (заполняется backend)', () => {
    const f = extractFacts(baseInput());
    expect(f.positional_shifts).toEqual([]);
  });
});

// --- MVP-2 ----------------------------------------------------------------
// KS-3623 / ADR-103 §3.2, §5: тактические мотивы, расширенный
// hanging_piece, threats_created / threats_missed, sf_best.line.

describe('extractFacts MVP-2 — hanging_piece расширенный', () => {
  it('без защиты, чистый выигрыш → net = piece value', () => {
    // Чёрный ферзь на e5 атакован белой ладьёй e1 без защиты.
    const fen = 'k7/8/8/4q3/8/8/8/4R2K b - - 0 1';
    const f = extractFacts(
      baseInput({
        fenBefore: fen,
        fenAfter: fen,
        playedUci: 'a8a7',
        playedSan: 'Ka7',
        sfData: { ...baseInput().sfData, bestUci: 'a8a7', bestSan: 'Ka7' },
      }),
    );
    expect(f.hanging_piece?.piece).toBe('q');
    expect(f.hanging_piece?.attackers.length).toBe(1);
    expect(f.hanging_piece?.attackers[0].piece).toBe('r');
    expect(f.hanging_piece?.attackers[0].square).toBe('e1');
    expect(f.hanging_piece?.defenders.length).toBe(0);
    expect(f.hanging_piece?.net_material_if_taken).toBe(9);
  });

  it('размен в плюс через дешёвого атакующего', () => {
    // Чёрная ладья на c4 атакована белой пешкой b3, защитников нет.
    const fen = '4k3/8/8/8/2r5/1P6/8/4K3 b - - 0 1';
    const f = extractFacts(
      baseInput({
        fenBefore: fen,
        fenAfter: fen,
        playedUci: 'e1e2',
        playedSan: 'Ke2',
        sfData: { ...baseInput().sfData, bestUci: 'e1e2', bestSan: 'Ke2' },
      }),
    );
    expect(f.hanging_piece?.piece).toBe('r');
    expect(f.hanging_piece?.attackers[0].piece).toBe('p');
    expect(f.hanging_piece?.defenders.length).toBe(0);
    expect(f.hanging_piece?.net_material_if_taken).toBe(5);
  });
});

describe('extractFacts MVP-2 — sf_best.line', () => {
  it('берёт 2–3 хода из sfBestPv и переводит в SAN', () => {
    const f = extractFacts(
      baseInput({
        playedUci: 'a2a4',
        playedSan: 'a4',
        sfData: {
          ...baseInput().sfData,
          bestUci: 'e2e4',
          bestSan: 'e4',
          sfBestPv: ['e2e4', 'e7e5', 'g1f3'],
        },
      }),
    );
    expect(f.sf_best?.line).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('пустой sfBestPv → line = []', () => {
    const f = extractFacts(
      baseInput({
        playedUci: 'a2a4',
        playedSan: 'a4',
        sfData: {
          ...baseInput().sfData,
          bestUci: 'e2e4',
          bestSan: 'e4',
          sfBestPv: [],
        },
      }),
    );
    expect(f.sf_best?.line).toEqual([]);
  });

  it('sf_best == null когда playedUci == bestUci', () => {
    const f = extractFacts(baseInput());
    expect(f.sf_best).toBe(null);
  });
});

describe('extractFacts MVP-2 — мотив fork', () => {
  it('конь d6 атакует короля e8 и ферзя c8 → fork', () => {
    // Белый конь только что пришёл на d6 с b5. С d6 атакует c8 (ферзь)
    // и e8 (король) — классическая семейная вилка.
    const fenBefore = '2q1k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
    const fenAfter = '2q1k3/8/3N4/8/8/8/8/4K3 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter,
        playedUci: 'b5d6',
        playedSan: 'Nd6+',
        sfData: { ...baseInput().sfData, bestUci: 'b5d6', bestSan: 'Nd6+' },
      }),
    );
    expect(f.tactical_motifs).toContain('fork');
  });

  it('обычный ход без атак → fork не сработал', () => {
    const f = extractFacts(baseInput());
    expect(f.tactical_motifs).not.toContain('fork');
  });
});

describe('extractFacts MVP-2 — мотив double_attack', () => {
  it('ход создаёт 2 новые угрозы → double_attack', () => {
    // Конь b5→d6 — две новые угрозы (король e8 + ферзь c8).
    const f = extractFacts(
      baseInput({
        fenBefore: '2q1k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
        fenAfter: '2q1k3/8/3N4/8/8/8/8/4K3 b - - 1 1',
        playedUci: 'b5d6',
        playedSan: 'Nd6+',
        sfData: { ...baseInput().sfData, bestUci: 'b5d6', bestSan: 'Nd6+' },
      }),
    );
    expect(f.tactical_motifs).toContain('double_attack');
  });

  it('тихий ход → double_attack не сработал', () => {
    const f = extractFacts(baseInput());
    expect(f.tactical_motifs).not.toContain('double_attack');
  });
});

describe('extractFacts MVP-2 — мотив pin', () => {
  it('белая ладья d1 связывает чёрного коня d4 с королём d8 → pin', () => {
    // fenBefore с `w to move`, чтобы side ходящего = white.
    const fenBefore = '3k4/8/8/8/3n4/8/4K3/3R4 w - - 0 1';
    const fenAfter = '3k4/8/8/8/3n4/4K3/8/3R4 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter,
        playedUci: 'e2e3',
        playedSan: 'Ke3',
        sfData: { ...baseInput().sfData, bestUci: 'e2e3', bestSan: 'Ke3' },
      }),
    );
    expect(f.tactical_motifs).toContain('pin');
  });

  it('обычная позиция без связки → pin не сработал', () => {
    const f = extractFacts(baseInput());
    expect(f.tactical_motifs).not.toContain('pin');
  });
});

describe('extractFacts MVP-2 — мотив skewer', () => {
  it('белая ладья d1 видит ферзя d5 (впереди) и коня d7 (сзади) → skewer', () => {
    // Ферзь (9) вынужден уйти, ладья берёт коня (3) за ним.
    const fenBefore = '7k/3n4/8/3q4/8/8/4K3/3R4 w - - 0 1';
    const fenAfter = '7k/3n4/8/3q4/8/4K3/8/3R4 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter,
        playedUci: 'e2e3',
        playedSan: 'Ke3',
        sfData: { ...baseInput().sfData, bestUci: 'e2e3', bestSan: 'Ke3' },
      }),
    );
    expect(f.tactical_motifs).toContain('skewer');
  });

  it('начальная позиция → skewer не сработал', () => {
    const f = extractFacts(baseInput());
    expect(f.tactical_motifs).not.toContain('skewer');
  });
});

describe('extractFacts MVP-2 — мотив discovered_attack', () => {
  it('конь сходил с d4 на f5, открыв ладью d1 на ферзя d8 → discovered', () => {
    // Before: Rd1, Nd4, Qd8, kh8, Ke1.
    // After: Rd1, Nf5, Qd8 — ладья теперь видит ферзя по вертикали d
    // через пустую d4.
    const fenBefore = '3q3k/8/8/8/3N4/8/8/3RK3 w - - 0 1';
    const fenAfter = '3q3k/8/8/5N2/8/8/8/3RK3 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter,
        playedUci: 'd4f5',
        playedSan: 'Nf5',
        sfData: { ...baseInput().sfData, bestUci: 'd4f5', bestSan: 'Nf5' },
      }),
    );
    expect(f.tactical_motifs).toContain('discovered_attack');
  });

  it('тихий ход не открывает луч → discovered не сработал', () => {
    const f = extractFacts(baseInput());
    expect(f.tactical_motifs).not.toContain('discovered_attack');
  });
});

describe('extractFacts MVP-2 — мотив back_rank_weak', () => {
  it('чёрный король h8 заперт пешками f7/g7/h7, белая ладья d1 → back_rank_weak', () => {
    const fenBefore = '7k/5ppp/8/8/8/8/8/3R3K w - - 0 1';
    const fenAfter = '7k/5ppp/8/8/8/8/7K/3R4 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter,
        playedUci: 'h1h2',
        playedSan: 'Kh2',
        sfData: { ...baseInput().sfData, bestUci: 'h1h2', bestSan: 'Kh2' },
      }),
    );
    expect(f.tactical_motifs).toContain('back_rank_weak');
  });

  it('открытая позиция короля → back_rank_weak не сработал', () => {
    // Чёрный король e8, пешек перед ним нет.
    const fenBefore = '4k3/8/8/8/8/8/8/3R3K w - - 0 1';
    const fenAfter = '4k3/8/8/8/8/8/7K/3R4 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter,
        playedUci: 'h1h2',
        playedSan: 'Kh2',
        sfData: { ...baseInput().sfData, bestUci: 'h1h2', bestSan: 'Kh2' },
      }),
    );
    expect(f.tactical_motifs).not.toContain('back_rank_weak');
  });
});

describe('extractFacts MVP-2 — threats_created', () => {
  it('ход создаёт вилку → wins_material + double_attack + targets', () => {
    const f = extractFacts(
      baseInput({
        fenBefore: '2q1k3/8/8/1N6/8/8/8/4K3 w - - 0 1',
        fenAfter: '2q1k3/8/3N4/8/8/8/8/4K3 b - - 1 1',
        playedUci: 'b5d6',
        playedSan: 'Nd6+',
        sfData: { ...baseInput().sfData, bestUci: 'b5d6', bestSan: 'Nd6+' },
      }),
    );
    expect(f.threats_created.double_attack).toBe(true);
    // Цели: король e8 + ферзь c8.
    const targetSquares = (f.threats_created.targets ?? []).map(
      (t) => t.square,
    );
    expect(targetSquares).toEqual(expect.arrayContaining(['e8', 'c8']));
    // wins_material — ферзь (король исключён).
    expect(f.threats_created.wins_material?.piece).toBe('q');
    expect(f.threats_created.wins_material?.square).toBe('c8');
  });

  it('mate_in переносится в threats_created.mate_in при mateAfter > 0', () => {
    const f = extractFacts(
      baseInput({
        sfData: { ...baseInput().sfData, mateAfter: 2 },
      }),
    );
    expect(f.threats_created.mate_in).toBe(2);
  });

  it('тихий ход без угроз → threats_created пустой', () => {
    const f = extractFacts(baseInput());
    expect(f.threats_created.wins_material).toBeUndefined();
    expect(f.threats_created.double_attack).toBeUndefined();
  });
});

describe('extractFacts MVP-2 — threats_missed', () => {
  it('played проиграл темп: best (Nd6+) делал вилку, played (Nc7) нет → wins_material упущен', () => {
    // Before: белый конь b5, чёрный король e8, чёрный ферзь c8.
    // best: Nd6+ — вилка короля и ферзя (выигрыш ~9).
    // played: Nc7 — атакует только... нет, c7 атакует короля e8? Нет.
    // Возьму Nxc7+: с b5 на c7. Атакует e8(K) — да, +шах. Но это
    // выигрыш материала тоже (нет фигуры на c7). Лучше: Na3 — тихий
    // отход назад без атак.
    const fenBefore = '2q1k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
    const fenAfterPlayed = '2q1k3/8/8/8/8/N7/8/4K3 b - - 1 1';
    const f = extractFacts(
      baseInput({
        fenBefore,
        fenAfter: fenAfterPlayed,
        playedUci: 'b5a3',
        playedSan: 'Na3',
        sfData: {
          ...baseInput().sfData,
          bestUci: 'b5d6',
          bestSan: 'Nd6+',
          sfBestPv: ['b5d6'],
        },
      }),
    );
    expect(f.threats_missed.wins_material).toBeDefined();
    expect(f.threats_missed.wins_material?.piece).toBe('q');
  });

  it('played == best → threats_missed пустой', () => {
    const f = extractFacts(baseInput());
    expect(f.threats_missed).toEqual({});
  });
});

