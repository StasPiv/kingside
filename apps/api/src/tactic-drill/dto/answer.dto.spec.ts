/**
 * Unit-тесты `normalizeAnswerData` (KS-2250-fix-attempt).
 *
 * Frontend на момент фикса шлёт универсальное поле `value` для всех
 * shape (`{shape:'square', value:'d6'}` etc.). DTO принимает обе формы
 * — каноническую (square/squares/from-to) и liberal (value).
 */

import { normalizeAnswerData, type AnswerDataDto } from './answer.dto';

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
