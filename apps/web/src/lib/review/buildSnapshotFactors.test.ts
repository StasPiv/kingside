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
});
