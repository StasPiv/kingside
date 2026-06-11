/**
 * KS-4071. Тесты единого источника истины для `metrics`-разбиения.
 *
 * Покрытие:
 *  - состав каждой из семи групп (точное соответствие списку из
 *    `apps/web/src/lib/review/metricBlocks.ts`);
 *  - набор `WHITE_SIGNED_IDS`;
 *  - формула `computePhaseFromFen` на ключевых позициях (стартовая,
 *    эндшпиль, ходы посередине);
 *  - формула `pickValueWithPhase` на крайних фазах и в середине;
 *  - агрегатор `buildMetricsCommentRequest`:
 *    - id вне групп игнорируется;
 *    - white-signed подкомпоненты складываются без учёта `color`;
 *    - owner-signed подкомпоненты `color='b'` вычитаются из общей суммы;
 *    - `king_safe_check_*` и `king_attackers_*`, попавшие во вход
 *      (например, из stockfish-trace eval json), НЕ влияют на
 *      `king_safety` — они вне группы;
 *    - `space` тоже не влияет ни на какую группу.
 */
import { describe, it, expect } from 'vitest';
import {
  METRIC_BLOCKS,
  WHITE_SIGNED_IDS,
  LLM_BLOCK_KEYS,
  computePhaseFromFen,
  pickValueWithPhase,
  buildMetricsCommentRequest,
} from './metrics-comment.js';

describe('KS-4071 METRIC_BLOCKS (состав групп)', () => {
  it('LLM_BLOCK_KEYS — ровно 7 ключей в фиксированном порядке', () => {
    expect([...LLM_BLOCK_KEYS]).toEqual([
      'material',
      'pawn_structure',
      'king_safety',
      'pieces',
      'mobility',
      'threats',
      'passed_pawns',
    ]);
  });

  it('material: material, imbalance', () => {
    expect([...METRIC_BLOCKS.material]).toEqual(['material', 'imbalance']);
  });

  it('pawn_structure: 7 id', () => {
    expect([...METRIC_BLOCKS.pawn_structure]).toEqual([
      'pawn_connected',
      'pawn_isolated',
      'pawn_doubled',
      'pawn_backward',
      'pawn_lever_double',
      'pawn_blocked',
      'pawn_doubled_early',
    ]);
  });

  it('king_safety: 8 id, без attackers_* и safe_check_*', () => {
    expect([...METRIC_BLOCKS.king_safety]).toEqual([
      'king_danger',
      'king_safety_pawn',
      'king_shelter_strength',
      'king_blocked_storm',
      'king_unblocked_storm',
      'king_on_file',
      'king_pawnless_flank',
      'king_flank_attacks',
    ]);
    expect(METRIC_BLOCKS.king_safety).not.toContain('king_attackers_count');
    expect(METRIC_BLOCKS.king_safety).not.toContain('king_attackers_weight');
    expect(METRIC_BLOCKS.king_safety).not.toContain('king_safe_check_rook');
    expect(METRIC_BLOCKS.king_safety).not.toContain('king_safe_check_queen');
    expect(METRIC_BLOCKS.king_safety).not.toContain('king_safe_check_bishop');
    expect(METRIC_BLOCKS.king_safety).not.toContain('king_safe_check_knight');
  });

  it('pieces: без space', () => {
    expect(METRIC_BLOCKS.pieces).not.toContain('space');
    expect([...METRIC_BLOCKS.pieces].sort()).toEqual(
      [
        'rook_on_open_file',
        'rook_on_closed_file',
        'rook_trapped',
        'rook_on_king_ring',
        'bishop_on_king_ring',
        'bishop_long_diagonal',
        'bishop_pawns',
        'bishop_xray_pawns',
        'bishop_cornered',
        'outpost_knight',
        'outpost_bishop',
        'knight_uncontested_outpost',
        'knight_reachable_outpost',
        'minor_behind_pawn',
        'knight_king_protector_distance',
        'bishop_king_protector_distance',
        'queen_weak',
      ].sort(),
    );
  });

  it('mobility: 4 id', () => {
    expect([...METRIC_BLOCKS.mobility]).toEqual([
      'mobility_knight',
      'mobility_bishop',
      'mobility_rook',
      'mobility_queen',
    ]);
  });

  it('threats: 10 id', () => {
    expect(METRIC_BLOCKS.threats.length).toBe(10);
    for (const id of [
      'threat_by_minor',
      'threat_by_rook',
      'threat_by_king',
      'threat_hanging',
      'threat_weak_queen_protection',
      'threat_restricted_piece',
      'threat_by_safe_pawn',
      'threat_by_pawn_push',
      'threat_knight_on_queen',
      'threat_slider_on_queen',
    ]) {
      expect(METRIC_BLOCKS.threats).toContain(id);
    }
  });

  it('passed_pawns: 4 id', () => {
    expect([...METRIC_BLOCKS.passed_pawns]).toEqual([
      'passed_rank',
      'passed_king_proximity',
      'passed_path_advance',
      'passed_file_edge',
    ]);
  });

  it('id не пересекаются между группами', () => {
    const seen = new Set<string>();
    for (const block of LLM_BLOCK_KEYS) {
      for (const id of METRIC_BLOCKS[block]) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });
});

describe('KS-4071 WHITE_SIGNED_IDS', () => {
  it('содержит material, imbalance и шесть psqt_*', () => {
    expect(WHITE_SIGNED_IDS.has('material')).toBe(true);
    expect(WHITE_SIGNED_IDS.has('imbalance')).toBe(true);
    for (const k of ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']) {
      expect(WHITE_SIGNED_IDS.has(`psqt_${k}`)).toBe(true);
    }
  });

  it('owner-signed id (king_danger, mobility_*, threats_*) НЕ входит', () => {
    for (const id of [
      'king_danger',
      'mobility_knight',
      'threat_hanging',
      'passed_rank',
      'rook_on_open_file',
    ]) {
      expect(WHITE_SIGNED_IDS.has(id)).toBe(false);
    }
  });
});

describe('KS-4071 computePhaseFromFen', () => {
  it('стартовая позиция → 256 (миттельшпиль)', () => {
    const startFen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(computePhaseFromFen(startFen)).toBe(256);
  });

  it('голые короли → 0 (эндшпиль)', () => {
    expect(computePhaseFromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1')).toBe(0);
  });

  it('две ладьи против двух коней + ферзь у белых: phase < 256', () => {
    // Чёрные: 2 ладьи. Белые: 2 коня + ферзь.
    // phaseValue = 2*2 + 2*1 + 1*4 = 10; phase = round(10 * 256 / 24) = 107
    const fen = '4k2r/r7/8/8/8/8/N1N1Q3/4K3 w - - 0 1';
    expect(computePhaseFromFen(fen)).toBe(107);
  });

  it('пустая строка / не-строка → 128 (defensive fallback клиентской части)', () => {
    expect(computePhaseFromFen('')).toBe(128);
    // @ts-expect-error — намеренно передаём не-строку, проверка runtime-guard
    expect(computePhaseFromFen(null)).toBe(128);
    // @ts-expect-error — то же для undefined
    expect(computePhaseFromFen(undefined)).toBe(128);
  });
});

describe('KS-4071 pickValueWithPhase', () => {
  it('phase=256 → берётся value_mg', () => {
    expect(
      pickValueWithPhase({ id: 'x', value_mg: 0.7, value_eg: 0.1 }, 256),
    ).toBe(0.7);
  });
  it('phase=0 → берётся value_eg', () => {
    expect(
      pickValueWithPhase({ id: 'x', value_mg: 0.7, value_eg: 0.1 }, 0),
    ).toBe(0.1);
  });
  it('phase=128 → среднее', () => {
    expect(
      pickValueWithPhase({ id: 'x', value_mg: 0.7, value_eg: 0.1 }, 128),
    ).toBeCloseTo(0.4, 6);
  });
  it('отсутствующие части трактуются как 0', () => {
    expect(pickValueWithPhase({ id: 'x' }, 128)).toBe(0);
    expect(pickValueWithPhase({ id: 'x', value_mg: 1 }, 256)).toBe(1);
    expect(pickValueWithPhase({ id: 'x', value_eg: 1 }, 0)).toBe(1);
  });

  it('NaN/Infinity → 0 (defensive guard клиентской части)', () => {
    expect(pickValueWithPhase({ id: 'x', value_mg: NaN, value_eg: 0 }, 128)).toBe(0);
    expect(pickValueWithPhase({ id: 'x', value_mg: 0, value_eg: NaN }, 128)).toBe(0);
    expect(
      pickValueWithPhase({ id: 'x', value_mg: Infinity, value_eg: 0 }, 128),
    ).toBe(0);
    expect(
      pickValueWithPhase({ id: 'x', value_mg: 0, value_eg: -Infinity }, 128),
    ).toBe(0);
  });
});

describe('KS-4071 buildMetricsCommentRequest — агрегация', () => {
  const startFen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('пустой вход → все семь групп = 0', () => {
    const out = buildMetricsCommentRequest([], { fen: startFen });
    expect(out.phase).toBe(256);
    for (const k of LLM_BLOCK_KEYS) {
      expect(out.metrics[k].value_cp).toBe(0);
    }
  });

  it('material как white-signed: color не учитывается', () => {
    const out = buildMetricsCommentRequest(
      [{ id: 'material', value_mg: 0.5, value_eg: 0.3 }],
      { fen: startFen },
    );
    // value_mg=0.5 на phase=256 → 0.5; round3 → 0.5
    expect(out.metrics.material.value_cp).toBe(0.5);
    // даже если color='b' указан, он игнорируется для material
    const out2 = buildMetricsCommentRequest(
      [{ id: 'material', color: 'b', value_mg: 0.5, value_eg: 0.3 }],
      { fen: startFen },
    );
    expect(out2.metrics.material.value_cp).toBe(0.5);
  });

  it('owner-signed: color=b вычитается', () => {
    const out = buildMetricsCommentRequest(
      [
        { id: 'mobility_knight', color: 'w', value_mg: 0.4, value_eg: 0 },
        { id: 'mobility_knight', color: 'b', value_mg: 0.3, value_eg: 0 },
      ],
      { fen: startFen },
    );
    // (+0.4) - (+0.3) = 0.1
    expect(out.metrics.mobility.value_cp).toBeCloseTo(0.1, 6);
  });

  it('king_safe_check_* и king_attackers_* НЕ влияют на king_safety', () => {
    const out = buildMetricsCommentRequest(
      [
        { id: 'king_attackers_count', color: 'w', value_mg: 5, value_eg: 5 },
        { id: 'king_attackers_weight', color: 'w', value_mg: 3, value_eg: 3 },
        { id: 'king_safe_check_rook', color: 'w', value_mg: 2, value_eg: 2 },
        { id: 'king_safe_check_queen', color: 'w', value_mg: 4, value_eg: 4 },
        // и одна валидная — должна сыграть
        { id: 'king_danger', color: 'w', value_mg: 0.2, value_eg: 0 },
      ],
      { fen: startFen },
    );
    expect(out.metrics.king_safety.value_cp).toBe(0.2);
  });

  it('space НЕ влияет на pieces', () => {
    const out = buildMetricsCommentRequest(
      [
        { id: 'space', color: 'w', value_mg: 0.5, value_eg: 0.5 },
        { id: 'rook_on_open_file', color: 'w', value_mg: 0.15, value_eg: 0.1 },
      ],
      { fen: startFen },
    );
    // только rook_on_open_file: tapered на phase=256 = value_mg = 0.15
    expect(out.metrics.pieces.value_cp).toBe(0.15);
  });

  it('id вне всех групп — игнорируются (не падают)', () => {
    const out = buildMetricsCommentRequest(
      [
        { id: 'sf18_eval', value_mg: 0, value_eg: 0 },
        { id: 'sf18_pv', value_mg: 0, value_eg: 0 },
        { id: 'totally_made_up_id', color: 'w', value_mg: 10, value_eg: 10 },
      ],
      { fen: startFen },
    );
    for (const k of LLM_BLOCK_KEYS) {
      expect(out.metrics[k].value_cp).toBe(0);
    }
  });

  it('phase можно задать явно (приоритет над FEN)', () => {
    const out = buildMetricsCommentRequest(
      [{ id: 'mobility_knight', color: 'w', value_mg: 1, value_eg: 0 }],
      { fen: startFen, phase: 0 },
    );
    // явная phase=0 → берётся value_eg=0
    expect(out.metrics.mobility.value_cp).toBe(0);
  });

  it('без fen и без phase — TypeError', () => {
    expect(() =>
      buildMetricsCommentRequest([{ id: 'material', value_mg: 1 }], {}),
    ).toThrow(TypeError);
  });
});

describe('KS-4071 регрессия: жалоба пользователя на ×7', () => {
  it('king_attackers_* и king_safe_check_* во входе НЕ дают вклад в king_safety', () => {
    // На реальной позиции из жалобы (`r3r1k1/1pp1qpp1/2n1bn1p/...`)
    // именно эти id давали мнимый рост king_safety с ~0.04 до ~0.28.
    const fenLike =
      'r3r1k1/1pp1qpp1/2n1bn1p/1B1pN3/3P4/B1N1P2P/5PP1/R2QR1K1 b - - 0 17';
    const buggy = buildMetricsCommentRequest(
      [
        { id: 'king_attackers_count', color: 'w', value_mg: 0.006, value_eg: 0.006 },
        { id: 'king_attackers_weight', color: 'w', value_mg: 0.372, value_eg: 0.372 },
        { id: 'king_attackers_count', color: 'b', value_mg: 0.003, value_eg: 0.003 },
        { id: 'king_attackers_weight', color: 'b', value_mg: 0.140, value_eg: 0.140 },
        // и реальный king_safety_pawn / king_flank_attacks — то, что входит в группу
        { id: 'king_safety_pawn', color: 'w', value_mg: 0.628, value_eg: -0.067 },
        { id: 'king_safety_pawn', color: 'b', value_mg: 0.628, value_eg: -0.067 },
        { id: 'king_flank_attacks', color: 'w', value_mg: -0.219, value_eg: 0 },
        { id: 'king_flank_attacks', color: 'b', value_mg: -0.244, value_eg: 0 },
      ],
      { fen: fenLike },
    );
    // attackers_* выкинуты, остаются только king_safety_pawn (взаимозачёт)
    // и king_flank_attacks: tapered((-0.219) - (-0.244)) = 0.025
    // у нас phase = 256 (lots of pieces) → берётся value_mg.
    // result ≈ +0.025
    expect(buggy.metrics.king_safety.value_cp).toBeCloseTo(0.025, 2);
    // главное: НЕ ×7 (т.е. не больше 0.1)
    expect(Math.abs(buggy.metrics.king_safety.value_cp)).toBeLessThan(0.1);
  });
});
