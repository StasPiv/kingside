/**
 * KS-3628 / ADR-103 rev 3 §6.5. Тесты pure-функции
 * `computePositionalShifts` на синтетических снимках classical eval.
 */
import { describe, it, expect } from 'vitest';

import {
  computePositionalShifts,
  POSITIONAL_SHIFTS_MIN_DELTA,
  POSITIONAL_SHIFTS_TOP_N,
  type ClassicalEvalBreakdown,
  type ClassicalEvalTerm,
  type TermBreakdown,
} from './positionalShifts';

// --- helpers ---------------------------------------------------------------

function termBd(totalMg: number, totalEg = totalMg): TermBreakdown {
  // Для упрощения: white = totalMg/totalEg, black = 0, total = white − black.
  return {
    white: { mg: totalMg, eg: totalEg },
    black: { mg: 0, eg: 0 },
    total: { mg: totalMg, eg: totalEg },
  };
}

const ALL_TERMS: ClassicalEvalTerm[] = [
  'material',
  'imbalance',
  'pawns',
  'knights',
  'bishops',
  'rooks',
  'queens',
  'mobility',
  'king_safety',
  'threats',
  'passed',
  'space',
  'winnable',
];

function flatBreakdown(value = 0): ClassicalEvalBreakdown {
  const terms = {} as Record<ClassicalEvalTerm, TermBreakdown>;
  for (const t of ALL_TERMS) terms[t] = termBd(value);
  return { terms, final: value };
}

function withTerm(
  base: ClassicalEvalBreakdown,
  term: ClassicalEvalTerm,
  bd: TermBreakdown,
): ClassicalEvalBreakdown {
  return { ...base, terms: { ...base.terms, [term]: bd } };
}

const NO_FACTS = { material_change: null, threats_created: {} } as const;

// --- main scenarios --------------------------------------------------------

describe('computePositionalShifts — фильтр |delta| >= 0.10', () => {
  it('delta меньше порога → ярлык не появляется', () => {
    const before = flatBreakdown();
    // King safety изменился на 0.05 — ниже порога.
    const after = withTerm(before, 'king_safety', termBd(0.05));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual([]);
  });

  it('delta ровно >= 0.10 → ярлык появляется', () => {
    const before = flatBreakdown();
    const after = withTerm(before, 'king_safety', termBd(0.1));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual(['king_safer']);
  });

  it('минимальный порог константа экспонирован', () => {
    expect(POSITIONAL_SHIFTS_MIN_DELTA).toBe(0.1);
    expect(POSITIONAL_SHIFTS_TOP_N).toBe(2);
  });
});

describe('computePositionalShifts — top-N по |delta|', () => {
  it('три кандидата → выдаём только top-2 по абсолютной дельте', () => {
    const before = flatBreakdown();
    let after = withTerm(before, 'mobility', termBd(0.5)); // +0.5
    after = withTerm(after, 'king_safety', termBd(0.3)); // +0.3
    after = withTerm(after, 'pawns', termBd(0.2)); // +0.2
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual(['mobility_increased', 'king_safer']);
  });

  it('отрицательные и положительные — топ по |delta|', () => {
    const before = flatBreakdown();
    let after = withTerm(before, 'mobility', termBd(-0.4));
    after = withTerm(after, 'king_safety', termBd(0.15));
    after = withTerm(after, 'pawns', termBd(0.6)); // самый сильный
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual([
      'pawn_structure_improved',
      'mobility_decreased',
    ]);
  });
});

describe('computePositionalShifts — POV ходящей стороны', () => {
  it('white сыграл, total MG вырос → положительный delta', () => {
    const before = flatBreakdown();
    const after = withTerm(before, 'king_safety', termBd(0.3));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual(['king_safer']);
  });

  it('black сыграл, total MG вырос → POV black: delta инвертируется → отрицательный', () => {
    const before = flatBreakdown();
    const after = withTerm(before, 'king_safety', termBd(0.3));
    // Total +0.3 в нотации SF = white лучше. Для black POV это −0.3.
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'black',
      NO_FACTS,
    );
    expect(shifts).toEqual(['king_exposed']);
  });
});

describe('computePositionalShifts — выбор колонки по stage', () => {
  it('opening → берём MG-колонку', () => {
    const before = flatBreakdown();
    const bd: TermBreakdown = {
      white: { mg: 0.4, eg: 0 },
      black: { mg: 0, eg: 0 },
      total: { mg: 0.4, eg: 0 },
    };
    const after = withTerm(before, 'pawns', bd);
    const shifts = computePositionalShifts(
      before,
      after,
      'opening',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual(['pawn_structure_improved']);
  });

  it('endgame → берём EG-колонку (MG игнорируется)', () => {
    const before = flatBreakdown();
    const bd: TermBreakdown = {
      white: { mg: 5, eg: 0.4 },
      black: { mg: 0, eg: 0 },
      total: { mg: 5, eg: 0.4 },
    };
    const after = withTerm(before, 'pawns', bd);
    const shifts = computePositionalShifts(
      before,
      after,
      'endgame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual(['pawn_structure_improved']);
  });
});

describe('computePositionalShifts — маппинг 19 категорий', () => {
  it.each([
    ['material', 0.3, 'material_gained'],
    ['material', -0.3, 'material_lost'],
    ['imbalance', 0.3, 'material_gained'],
    ['imbalance', -0.3, 'material_lost'],
    ['pawns', 0.3, 'pawn_structure_improved'],
    ['pawns', -0.3, 'pawn_structure_weakened'],
    ['bishops', 0.3, 'bishop_more_active'],
    ['bishops', -0.3, 'bishop_passive'],
    ['mobility', 0.3, 'mobility_increased'],
    ['mobility', -0.3, 'mobility_decreased'],
    ['king_safety', 0.3, 'king_safer'],
    ['king_safety', -0.3, 'king_exposed'],
    ['threats', 0.3, 'threats_grew'],
    ['threats', -0.3, 'threats_weakened'],
    ['winnable', 0.3, 'position_more_winnable'],
    ['winnable', -0.3, 'position_less_winnable'],
  ] as const)('%s delta=%s → %s', (term, delta, expectedId) => {
    const before = flatBreakdown();
    const after = withTerm(before, term, termBd(delta));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toContain(expectedId);
  });

  it.each([
    ['knights', 0.3, 'knight_more_active'],
    ['rooks', 0.3, 'rook_on_open_file'],
    ['queens', 0.3, 'queen_more_active'],
    ['passed', 0.3, 'passed_pawn_strong'],
    ['space', 0.3, 'space_gained'],
  ] as const)(
    'однонаправленный %s +delta → %s',
    (term, delta, expectedId) => {
      const before = flatBreakdown();
      const after = withTerm(before, term, termBd(delta));
      const shifts = computePositionalShifts(
        before,
        after,
        'middlegame',
        'white',
        NO_FACTS,
      );
      expect(shifts).toContain(expectedId);
    },
  );

  it.each(['knights', 'rooks', 'queens', 'passed', 'space'] as const)(
    'однонаправленный %s -delta → ярлыка нет',
    (term) => {
      const before = flatBreakdown();
      const after = withTerm(before, term, termBd(-0.3));
      const shifts = computePositionalShifts(
        before,
        after,
        'middlegame',
        'white',
        NO_FACTS,
      );
      expect(shifts).toEqual([]);
    },
  );
});

describe('computePositionalShifts — дедупликация с фактами', () => {
  it('material_change есть → material_gained подавляется, top уходит дальше', () => {
    const before = flatBreakdown();
    let after = withTerm(before, 'material', termBd(0.5));
    after = withTerm(after, 'mobility', termBd(0.2));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      {
        material_change: { piece: 'p', side: 'black' },
        threats_created: {},
      },
    );
    // material подавлен, mobility остался.
    expect(shifts).toEqual(['mobility_increased']);
  });

  it('threats_created.wins_material есть → threats_grew подавляется', () => {
    const before = flatBreakdown();
    let after = withTerm(before, 'threats', termBd(0.5));
    after = withTerm(after, 'mobility', termBd(0.2));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      {
        material_change: null,
        threats_created: {
          wins_material: { piece: 'n', square: 'f6', net_value: 3 },
        },
      },
    );
    expect(shifts).toEqual(['mobility_increased']);
  });

  it('material_lost (под боем) НЕ подавляется если material_change=null', () => {
    const before = flatBreakdown();
    const after = withTerm(before, 'material', termBd(-0.3));
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toContain('material_lost');
  });
});

describe('computePositionalShifts — total null fallback', () => {
  it('если total отсутствует — берём white − black', () => {
    const before = flatBreakdown();
    const bdMissingTotal: TermBreakdown = {
      white: { mg: 0.4, eg: 0.4 },
      black: { mg: 0.0, eg: 0.0 },
      total: null,
    };
    const after = withTerm(before, 'king_safety', bdMissingTotal);
    const shifts = computePositionalShifts(
      before,
      after,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual(['king_safer']);
  });
});

describe('computePositionalShifts — пустой результат', () => {
  it('одинаковые snapshot до и после → []', () => {
    const snap = flatBreakdown(0.05);
    const shifts = computePositionalShifts(
      snap,
      snap,
      'middlegame',
      'white',
      NO_FACTS,
    );
    expect(shifts).toEqual([]);
  });
});
