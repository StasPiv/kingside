/**
 * KS-4044. Тесты сборки payload для LLM-трактовки метрик.
 */
import { describe, it, expect } from 'vitest';
import type { PositionalSubterm } from '@kingside/shared';
import {
  buildMetricsCommentRequest,
  computePhaseFromFen,
} from './metricsCommentPayload';

function sub(
  id: string,
  color: 'w' | 'b' | undefined,
  value_mg: number,
  value_eg: number,
): PositionalSubterm {
  return {
    id: id as PositionalSubterm['id'],
    color,
    square: undefined,
    value_mg,
    value_eg,
  } as PositionalSubterm;
}

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KK_ENDGAME_FEN = '8/8/8/4k3/8/8/8/4K3 w - - 0 1';

describe('computePhaseFromFen (KS-4044)', () => {
  it('стартовая позиция → 256 (миттельшпиль)', () => {
    expect(computePhaseFromFen(STARTING_FEN)).toBe(256);
  });

  it('голые короли → 0 (эндшпиль)', () => {
    expect(computePhaseFromFen(KK_ENDGAME_FEN)).toBe(0);
  });

  it('одна пара лёгких фигур (бутерброд: 2 коня) → пропорционально', () => {
    // 2 коня по 1 единице, total = 24 → phase = 2*256/24 ≈ 21.
    const fen = '4k3/8/8/8/8/8/n6N/4K3 w - - 0 1';
    expect(computePhaseFromFen(fen)).toBe(21);
  });

  it('невалидный fen → fallback 128 (середина)', () => {
    expect(computePhaseFromFen('')).toBe(128);
  });
});

describe('buildMetricsCommentRequest (KS-4044)', () => {
  it('возвращает 7 ключей по контракту LLM (без space)', () => {
    const req = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms: [],
    });
    expect(Object.keys(req.metrics).sort()).toEqual([
      'king_safety',
      'material',
      'mobility',
      'passed_pawns',
      'pawn_structure',
      'pieces',
      'threats',
    ]);
  });

  it('phase считается по FEN если не передан явно', () => {
    const req = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms: [],
    });
    expect(req.phase).toBe(256);
  });

  it('phase override уважается и зажимается в [0,256]', () => {
    const a = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms: [],
      phase: 128,
    });
    expect(a.phase).toBe(128);
    const b = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms: [],
      phase: -100,
    });
    expect(b.phase).toBe(0);
    const c = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms: [],
      phase: 999,
    });
    expect(c.phase).toBe(256);
  });

  it('value_cp использует тappered (mg·phase + eg·(256−phase))/256', () => {
    // mobility_knight color=w, mg=100, eg=0 → при phase=256: 100, при phase=0: 0.
    const subterms = [sub('mobility_knight', 'w', 100, 0)];
    const reqMg = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms,
      phase: 256,
    });
    expect(reqMg.metrics.mobility.value_cp).toBe(100);
    const reqEg = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms,
      phase: 0,
    });
    expect(reqEg.metrics.mobility.value_cp).toBe(0);
  });

  it('owner-signed: value_cp = white_sum − black_sum', () => {
    const subterms = [
      sub('mobility_knight', 'w', 60, 60),
      sub('mobility_knight', 'b', 20, 20),
    ];
    const req = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms,
      phase: 256,
    });
    expect(req.metrics.mobility.value_cp).toBe(40);
  });

  it('white-signed: material идёт суммой без вычитания', () => {
    const subterms = [sub('material', undefined, -200, -200)];
    const req = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms,
      phase: 256,
    });
    expect(req.metrics.material.value_cp).toBe(-200);
  });

  it('sf18_eval включается только если передан валидный объект', () => {
    const subterms: PositionalSubterm[] = [];
    expect(
      buildMetricsCommentRequest({ fen: STARTING_FEN, subterms })
        .sf18_eval,
    ).toBeUndefined();
    const withEval = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms,
      sf18Eval: { type: 'cp', value: 35 },
    });
    expect(withEval.sf18_eval).toEqual({ type: 'cp', value: 35 });
  });

  it('подкомпоненты вне 7 блоков (space, psqt_*, king_safe_check_*) не влияют', () => {
    const subterms = [
      sub('space', 'w', 1000, 1000),
      sub('psqt_pawn', 'w', 1000, 1000),
      sub('king_safe_check_rook', 'b', 1000, 1000),
    ];
    const req = buildMetricsCommentRequest({
      fen: STARTING_FEN,
      subterms,
    });
    for (const v of Object.values(req.metrics)) {
      expect(v.value_cp).toBe(0);
    }
  });
});
