/**
 * Unit-тесты `normalizeAnswerData` (KS-2250-fix-attempt).
 *
 * Frontend на момент фикса шлёт универсальное поле `value` для всех
 * shape (`{shape:'square', value:'d6'}` etc.). DTO принимает обе формы
 * — каноническую (square/squares/from-to) и liberal (value).
 */

import { normalizeAnswerData, normalizeStoredAnswer, type AnswerDataDto } from './answer.dto';

function asDto(obj: Record<string, unknown>): AnswerDataDto {
  return obj as unknown as AnswerDataDto;
}

describe('normalizeAnswerData (KS-2250-fix-attempt)', () => {
  // ─── shape=square ───────────────────────────────────────────────

  it('shape=square канон: { shape, square } → ok', () => {
    const r = normalizeAnswerData(asDto({ shape: 'square', square: 'd6' }));
    expect(r).toEqual({ ok: true, value: { shape: 'square', square: 'd6' } });
  });

  it('shape=square liberal: { shape, value:"d6" } → ok', () => {
    const r = normalizeAnswerData(asDto({ shape: 'square', value: 'd6' }));
    expect(r).toEqual({ ok: true, value: { shape: 'square', square: 'd6' } });
  });

  it('shape=square без square и value → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'square' }));
    expect(r.ok).toBe(false);
  });

  it('shape=square с невалидной клеткой ("z9") → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'square', value: 'z9' }));
    expect(r.ok).toBe(false);
  });

  // ─── shape=squares ──────────────────────────────────────────────

  it('shape=squares канон: { shape, squares:[...] } → ok', () => {
    const r = normalizeAnswerData(
      asDto({ shape: 'squares', squares: ['d6', 'f6'] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.shape).toBe('squares');
      expect((r.value as { squares: string[] }).squares.sort()).toEqual(['d6', 'f6']);
    }
  });

  it('shape=squares liberal: { shape, value:[...] } → ok', () => {
    const r = normalizeAnswerData(
      asDto({ shape: 'squares', value: ['d6', 'f6'] }),
    );
    expect(r.ok).toBe(true);
  });

  it('shape=squares: дубли свернулись в Set', () => {
    const r = normalizeAnswerData(
      asDto({ shape: 'squares', value: ['d6', 'd6', 'f6'] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { squares: string[] }).squares.sort()).toEqual(['d6', 'f6']);
    }
  });

  it('shape=squares с невалидной клеткой → error', () => {
    const r = normalizeAnswerData(
      asDto({ shape: 'squares', value: ['d6', 'zz'] }),
    );
    expect(r.ok).toBe(false);
  });

  it('shape=squares с пустым массивом → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'squares', value: [] }));
    expect(r.ok).toBe(false);
  });

  // ─── shape=number ───────────────────────────────────────────────

  it('shape=number: { shape, value:2 } → ok', () => {
    const r = normalizeAnswerData(asDto({ shape: 'number', value: 2 }));
    expect(r).toEqual({ ok: true, value: { shape: 'number', value: 2 } });
  });

  it('shape=number value=5 (вне 1..4) → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'number', value: 5 }));
    expect(r.ok).toBe(false);
  });

  it('shape=number value=0 → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'number', value: 0 }));
    expect(r.ok).toBe(false);
  });

  it('shape=number value=2.5 (не integer) → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'number', value: 2.5 }));
    expect(r.ok).toBe(false);
  });

  it('shape=number value=string → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'number', value: '2' }));
    expect(r.ok).toBe(false);
  });

  // ─── shape=move ─────────────────────────────────────────────────

  it('shape=move канон: { shape, from, to } → ok', () => {
    const r = normalizeAnswerData(
      asDto({ shape: 'move', from: 'e2', to: 'e4' }),
    );
    expect(r).toEqual({
      ok: true,
      value: { shape: 'move', from: 'e2', to: 'e4' },
    });
  });

  it('shape=move канон с promotion', () => {
    const r = normalizeAnswerData(
      asDto({ shape: 'move', from: 'e7', to: 'e8', promotion: 'q' }),
    );
    expect(r).toEqual({
      ok: true,
      value: { shape: 'move', from: 'e7', to: 'e8', promotion: 'q' },
    });
  });

  it('shape=move liberal UCI 4-char: { shape, value:"e2e4" } → ok', () => {
    const r = normalizeAnswerData(asDto({ shape: 'move', value: 'e2e4' }));
    expect(r).toEqual({
      ok: true,
      value: { shape: 'move', from: 'e2', to: 'e4' },
    });
  });

  it('shape=move liberal UCI 5-char с promotion: "e7e8q" → ok', () => {
    const r = normalizeAnswerData(asDto({ shape: 'move', value: 'e7e8q' }));
    expect(r).toEqual({
      ok: true,
      value: { shape: 'move', from: 'e7', to: 'e8', promotion: 'q' },
    });
  });

  it('shape=move без from/to/value → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'move' }));
    expect(r.ok).toBe(false);
  });

  it('shape=move с UCI < 4 chars → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'move', value: 'e2e' }));
    expect(r.ok).toBe(false);
  });

  it('shape=move с невалидной клеткой in UCI → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'move', value: 'z9z9' }));
    expect(r.ok).toBe(false);
  });

  // ─── unknown shape ──────────────────────────────────────────────

  it('shape=unknown → error', () => {
    const r = normalizeAnswerData(asDto({ shape: 'invalid', value: 'x' }));
    expect(r.ok).toBe(false);
  });
});

describe('normalizeStoredAnswer (KS-2246-fix, liberal → канон в БД)', () => {
  // ─── square ─────────────────────────────────────────────────────

  it('liberal {shape:"square", value:"c6"} → канон {square:"c6"}', () => {
    expect(normalizeStoredAnswer({ shape: 'square', value: 'c6' })).toEqual({
      shape: 'square',
      square: 'c6',
    });
  });

  it('канон {shape:"square", square:"c6"} → как есть', () => {
    expect(normalizeStoredAnswer({ shape: 'square', square: 'c6' })).toEqual({
      shape: 'square',
      square: 'c6',
    });
  });

  // ─── squares (с []) ─────────────────────────────────────────────

  it('liberal {shape:"squares[]", value:[...]} → канон {shape:"squares", squares:[...]}', () => {
    const r = normalizeStoredAnswer({
      shape: 'squares[]',
      value: ['c7', 'f6'],
    });
    expect(r?.shape).toBe('squares');
    expect((r as { squares: string[] }).squares.sort()).toEqual(['c7', 'f6']);
  });

  it('канон {shape:"squares", squares:[...]}', () => {
    const r = normalizeStoredAnswer({
      shape: 'squares',
      squares: ['c7', 'f6'],
    });
    expect(r?.shape).toBe('squares');
  });

  // ─── number ─────────────────────────────────────────────────────

  it('канон {shape:"number", value:2} → как есть (без 1..4 ограничения)', () => {
    expect(normalizeStoredAnswer({ shape: 'number', value: 2 })).toEqual({
      shape: 'number',
      value: 2,
    });
  });

  it('number value=5 → ok (на чтении не ограничиваем — может быть legacy)', () => {
    expect(normalizeStoredAnswer({ shape: 'number', value: 5 })).toEqual({
      shape: 'number',
      value: 5,
    });
  });

  // ─── move ──────────────────────────────────────────────────────

  it('liberal {shape:"move", value:"c2b3"} → канон {from:"c2", to:"b3"}', () => {
    expect(normalizeStoredAnswer({ shape: 'move', value: 'c2b3' })).toEqual({
      shape: 'move',
      from: 'c2',
      to: 'b3',
    });
  });

  it('liberal UCI 5-char "e7e8q" → канон с promotion', () => {
    expect(normalizeStoredAnswer({ shape: 'move', value: 'e7e8q' })).toEqual({
      shape: 'move',
      from: 'e7',
      to: 'e8',
      promotion: 'q',
    });
  });

  it('канон {shape:"move", from, to}', () => {
    expect(
      normalizeStoredAnswer({ shape: 'move', from: 'e2', to: 'e4' }),
    ).toEqual({ shape: 'move', from: 'e2', to: 'e4' });
  });

  // ─── malformed ─────────────────────────────────────────────────

  it('null → null', () => {
    expect(normalizeStoredAnswer(null)).toBeNull();
  });

  it('пустой объект → null', () => {
    expect(normalizeStoredAnswer({})).toBeNull();
  });

  it('square с невалидной клеткой → null', () => {
    expect(
      normalizeStoredAnswer({ shape: 'square', value: 'z9' }),
    ).toBeNull();
  });

  it('squares с одной невалидной клеткой → null', () => {
    expect(
      normalizeStoredAnswer({ shape: 'squares[]', value: ['c7', 'zz'] }),
    ).toBeNull();
  });

  it('move без from/to и без value → null', () => {
    expect(normalizeStoredAnswer({ shape: 'move' })).toBeNull();
  });

  it('unknown shape → null', () => {
    expect(
      normalizeStoredAnswer({ shape: 'invalid', value: 'x' }),
    ).toBeNull();
  });
});
