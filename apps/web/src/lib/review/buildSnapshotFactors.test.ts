/**
 * KS-3712. Тесты `buildSnapshotFactors` — сборка пары `{fen, factors}`
 * для запроса `move-comment`. Проверяем формат и нормализацию sf18_eval
 * со стороны белых.
 */
import { describe, it, expect } from 'vitest';

import { buildSnapshotFactors } from './buildSnapshotFactors';

const FEN_WHITE_TO_MOVE =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_BLACK_TO_MOVE =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('buildSnapshotFactors', () => {
  it('engine=null → factors только из позиционных подкомпонент', () => {
    const out = buildSnapshotFactors({
      fen: FEN_WHITE_TO_MOVE,
      subterms: [{ id: 'space', value_mg: 0.1, value_eg: 0 }],
      engine: null,
    });
    expect(out.fen).toBe(FEN_WHITE_TO_MOVE);
    expect(out.factors).toHaveLength(1);
    expect((out.factors[0] as { id: string }).id).toBe('space');
  });

  it('ход белых: знак sf18_eval не инвертируется', () => {
    const out = buildSnapshotFactors({
      fen: FEN_WHITE_TO_MOVE,
      subterms: [],
      engine: {
        score: { type: 'cp', value: 35 },
        depth: 22,
        pv: ['e2e4', 'e7e5'],
      },
    });
    // sf18_eval + sf18_pv
    expect(out.factors).toHaveLength(2);
    expect(out.factors[0]).toMatchObject({
      id: 'sf18_eval',
      score: { type: 'cp', value: 35 },
      side_to_move: 'w',
      depth: 22,
      multipv: 1,
    });
    expect(out.factors[1]).toMatchObject({
      id: 'sf18_pv',
      pv: ['e2e4', 'e7e5'],
      depth: 22,
      multipv: 1,
    });
  });

  it('ход чёрных: знак sf18_eval инвертируется (cp)', () => {
    const out = buildSnapshotFactors({
      fen: FEN_BLACK_TO_MOVE,
      subterms: [],
      engine: {
        score: { type: 'cp', value: -120 },
        depth: 22,
        pv: ['e7e5'],
      },
    });
    expect(out.factors[0]).toMatchObject({
      id: 'sf18_eval',
      score: { type: 'cp', value: 120 },
      side_to_move: 'b',
    });
  });

  it('ход чёрных: знак sf18_eval инвертируется (mate)', () => {
    const out = buildSnapshotFactors({
      fen: FEN_BLACK_TO_MOVE,
      subterms: [],
      engine: {
        score: { type: 'mate', value: 3 },
        depth: 18,
        pv: [],
      },
    });
    expect(out.factors).toHaveLength(1);
    expect(out.factors[0]).toMatchObject({
      id: 'sf18_eval',
      score: { type: 'mate', value: -3 },
    });
  });

  it('engine без pv → только sf18_eval (без sf18_pv)', () => {
    const out = buildSnapshotFactors({
      fen: FEN_WHITE_TO_MOVE,
      subterms: [],
      engine: {
        score: { type: 'cp', value: 10 },
        depth: 20,
        pv: [],
      },
    });
    expect(out.factors).toHaveLength(1);
    expect((out.factors[0] as { id: string }).id).toBe('sf18_eval');
  });

  it('подкомпоненты сохраняются в начале массива, sf18-записи — в конце', () => {
    const out = buildSnapshotFactors({
      fen: FEN_WHITE_TO_MOVE,
      subterms: [
        { id: 'space', value_mg: 0.1, value_eg: 0 },
        { id: 'king_danger', value_mg: 0.05, value_eg: 0 },
      ],
      engine: {
        score: { type: 'cp', value: 30 },
        depth: 20,
        pv: ['e2e4'],
      },
    });
    expect(out.factors).toHaveLength(4);
    expect((out.factors[0] as { id: string }).id).toBe('space');
    expect((out.factors[1] as { id: string }).id).toBe('king_danger');
    expect((out.factors[2] as { id: string }).id).toBe('sf18_eval');
    expect((out.factors[3] as { id: string }).id).toBe('sf18_pv');
  });

  // KS-3815: пре-фильтр позиционных подкомпонент под feature-flag.

  describe('KS-3815 prefilter', () => {
    it('по умолчанию (флаг выключен) ничего не фильтрует — порядок сохраняется', () => {
      const out = buildSnapshotFactors({
        fen: FEN_WHITE_TO_MOVE,
        subterms: [
          { id: 'space', value_mg: 0.01, value_eg: 0.02 },
          { id: 'king_danger', value_mg: 0.05, value_eg: 0.03 },
          { id: 'pawn_isolated', value_mg: 1.2, value_eg: 0.4 },
        ],
        engine: null,
      });
      expect(out.factors).toHaveLength(3);
      expect((out.factors[0] as { id: string }).id).toBe('space');
      expect((out.factors[1] as { id: string }).id).toBe('king_danger');
      expect((out.factors[2] as { id: string }).id).toBe('pawn_isolated');
    });

    it('флаг включён: отбрасывает шумные subterms (обе |value| < minAbs)', () => {
      const out = buildSnapshotFactors(
        {
          fen: FEN_WHITE_TO_MOVE,
          subterms: [
            { id: 'space', value_mg: 0.01, value_eg: 0.02 }, // шум → drop
            { id: 'king_danger', value_mg: 0.05, value_eg: 0.05 }, // шум → drop
            { id: 'pawn_isolated', value_mg: 1.2, value_eg: 0.4 }, // оставить
            { id: 'pawn_doubled', value_mg: 0.5, value_eg: 0.01 }, // оставить
          ],
          engine: null,
        },
        { prefilter: { enabled: true, minAbs: 0.1, topN: 8 } },
      );
      expect(out.factors).toHaveLength(2);
      const ids = out.factors.map((f) => (f as { id: string }).id);
      expect(ids).toEqual(['pawn_isolated', 'pawn_doubled']);
    });

    it('флаг включён: сортирует по max(|mg|, |eg|) убыванию и обрезает top-N', () => {
      const out = buildSnapshotFactors(
        {
          fen: FEN_WHITE_TO_MOVE,
          subterms: [
            { id: 'space', value_mg: 0.2, value_eg: 0.1 }, // max=0.2
            { id: 'king_danger', value_mg: 0.4, value_eg: 0.1 }, // max=0.4
            { id: 'pawn_isolated', value_mg: 1.0, value_eg: 0.4 }, // max=1.0
            { id: 'pawn_doubled', value_mg: 0.6, value_eg: 0.6 }, // max=0.6
            { id: 'pawn_backward', value_mg: 0.3, value_eg: 0.8 }, // max=0.8
          ],
          engine: null,
        },
        { prefilter: { enabled: true, minAbs: 0.1, topN: 3 } },
      );
      expect(out.factors).toHaveLength(3);
      const ids = out.factors.map((f) => (f as { id: string }).id);
      expect(ids).toEqual(['pawn_isolated', 'pawn_backward', 'pawn_doubled']);
    });

    it('hardIncludeIds: всегда сохраняет и не расходует лимит top-N', () => {
      const out = buildSnapshotFactors(
        {
          fen: FEN_WHITE_TO_MOVE,
          subterms: [
            { id: 'space', value_mg: 0.01, value_eg: 0.01 }, // шум, но hard
            { id: 'king_danger', value_mg: 0.05, value_eg: 0.05 }, // шум
            { id: 'pawn_isolated', value_mg: 1.0, value_eg: 0.4 },
            { id: 'pawn_doubled', value_mg: 0.6, value_eg: 0.6 },
            { id: 'pawn_backward', value_mg: 0.3, value_eg: 0.8 },
          ],
          engine: null,
        },
        {
          prefilter: {
            enabled: true,
            minAbs: 0.1,
            topN: 2,
            hardIncludeIds: ['space'],
          },
        },
      );
      // hard-include `space` + top-2 из soft по убыванию max(|mg|,|eg|):
      // pawn_isolated (1.0), pawn_backward (0.8) — pawn_doubled (0.6)
      // обрезается лимитом topN=2.
      expect(out.factors).toHaveLength(3);
      const ids = out.factors.map((f) => (f as { id: string }).id);
      expect(ids).toEqual(['space', 'pawn_isolated', 'pawn_backward']);
    });

    it('включённый флаг не трогает sf18_eval / sf18_pv', () => {
      const out = buildSnapshotFactors(
        {
          fen: FEN_WHITE_TO_MOVE,
          subterms: [{ id: 'space', value_mg: 0.01, value_eg: 0.01 }],
          engine: {
            score: { type: 'cp', value: 30 },
            depth: 20,
            pv: ['e2e4'],
          },
        },
        { prefilter: { enabled: true, minAbs: 0.1, topN: 8 } },
      );
      // space отброшен; остались sf18_eval + sf18_pv
      expect(out.factors).toHaveLength(2);
      expect((out.factors[0] as { id: string }).id).toBe('sf18_eval');
      expect((out.factors[1] as { id: string }).id).toBe('sf18_pv');
    });
  });
});
