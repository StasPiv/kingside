/**
 * KS-3690 / ADR-108b §6.4. Unit-тесты parseModelOutput.
 *
 * 11 кейсов из ADR §6.4 + дополнительные граничные. Все кейсы
 * детерминированы (pure-функция, без fetch/Redis).
 */
import { parseModelOutput } from './parse-model-output';

describe('parseModelOutput (KS-3690 / ADR-108b §6)', () => {
  // 1. Чистый JSON.
  it('1. чистый JSON-объект → распарсен без фолбэка', () => {
    const raw = JSON.stringify({
      comment: 'Equal position.',
      highlights: [{ square: 'e4', color: 'red' }],
      arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
    });
    expect(parseModelOutput(raw)).toEqual({
      comment: 'Equal position.',
      highlights: [{ square: 'e4', color: 'red' }],
      arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
    });
  });

  // 2. JSON в ```json``` fences.
  it('2. JSON обёрнут в ```json …``` → fence снят и распарсен', () => {
    const raw =
      '```json\n{"comment":"Edge.","highlights":[{"square":"d5","color":"yellow"}],"arrows":[]}\n```';
    expect(parseModelOutput(raw)).toEqual({
      comment: 'Edge.',
      highlights: [{ square: 'd5', color: 'yellow' }],
      arrows: [],
    });
  });

  // 3. Не-JSON текст → фолбэк (comment = raw.trim()).
  it('3. произвольный текст без JSON → фолбэк, текст идёт в comment', () => {
    const raw = '  Это просто текст без JSON. \n';
    expect(parseModelOutput(raw)).toEqual({
      comment: 'Это просто текст без JSON.',
      highlights: [],
      arrows: [],
    });
  });

  // 4. Невалидные клетки в highlights → отфильтрованы.
  it('4. невалидные клетки в highlights → отфильтрованы, валидные остаются', () => {
    const raw = JSON.stringify({
      comment: 'X',
      highlights: [
        { square: 'z9', color: 'red' }, // вне regex
        { square: 'i1', color: 'green' }, // вне regex
        { square: 'e4', color: 'red' }, // валид
      ],
    });
    const out = parseModelOutput(raw);
    expect(out.highlights).toEqual([{ square: 'e4', color: 'red' }]);
  });

  // 5. Невалидный цвет → отфильтрован.
  it('5. невалидный цвет (не из палитры) → элемент отфильтрован', () => {
    const raw = JSON.stringify({
      comment: 'X',
      highlights: [
        { square: 'e4', color: 'orange' },
        { square: 'd5', color: 'blue' },
      ],
      arrows: [
        { from: 'e2', to: 'e4', color: 'purple' },
        { from: 'g1', to: 'f3', color: 'green' },
      ],
    });
    const out = parseModelOutput(raw);
    expect(out.highlights).toEqual([{ square: 'd5', color: 'blue' }]);
    expect(out.arrows).toEqual([{ from: 'g1', to: 'f3', color: 'green' }]);
  });

  // 6. Дубль highlight → один (последний выигрывает).
  it('6. дубль highlight по square → последний цвет выигрывает', () => {
    const raw = JSON.stringify({
      comment: 'X',
      highlights: [
        { square: 'e4', color: 'red' },
        { square: 'e4', color: 'green' },
      ],
    });
    expect(parseModelOutput(raw).highlights).toEqual([
      { square: 'e4', color: 'green' },
    ]);
  });

  // 7. 10 highlights → срез до 4.
  it('7. 10 highlights → срез до 4', () => {
    const tenSquares = [
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'a6',
      'a7',
      'a8',
      'b1',
      'b2',
    ];
    const raw = JSON.stringify({
      comment: 'many',
      highlights: tenSquares.map((sq) => ({ square: sq, color: 'red' })),
    });
    const out = parseModelOutput(raw);
    expect(out.highlights).toHaveLength(4);
    // Срез сохраняет порядок: первые 4 — a1..a4.
    expect(out.highlights.map((h) => h.square)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
    ]);
  });

  // 8. 5 arrows → срез до 2.
  it('8. 5 arrows → срез до 2', () => {
    const raw = JSON.stringify({
      comment: 'many',
      arrows: [
        { from: 'e2', to: 'e4', color: 'green' },
        { from: 'd2', to: 'd4', color: 'green' },
        { from: 'g1', to: 'f3', color: 'green' },
        { from: 'b1', to: 'c3', color: 'green' },
        { from: 'f1', to: 'c4', color: 'green' },
      ],
    });
    const out = parseModelOutput(raw);
    expect(out.arrows).toHaveLength(2);
    expect(out.arrows.map((a) => `${a.from}->${a.to}`)).toEqual([
      'e2->e4',
      'd2->d4',
    ]);
  });

  // 9. Пустой ответ → шейп с пустыми полями.
  it('9. пустая строка → шейп { comment:"", highlights:[], arrows:[] }', () => {
    expect(parseModelOutput('')).toEqual({
      comment: '',
      highlights: [],
      arrows: [],
    });
    expect(parseModelOutput('   \n  ')).toEqual({
      comment: '',
      highlights: [],
      arrows: [],
    });
  });

  // 10. Только comment без highlights/arrows → пустые массивы.
  it('10. JSON с одним comment → highlights/arrows пустые массивы', () => {
    const raw = JSON.stringify({ comment: 'Just a sentence.' });
    expect(parseModelOutput(raw)).toEqual({
      comment: 'Just a sentence.',
      highlights: [],
      arrows: [],
    });
  });

  // 11. Только highlights без comment → фолбэк (comment = raw.trim(), массивы пустые).
  it('11. JSON без comment → фолбэк: comment=raw.trim(), массивы пустые', () => {
    const raw = JSON.stringify({
      highlights: [{ square: 'e4', color: 'red' }],
    });
    expect(parseModelOutput(raw)).toEqual({
      comment: raw,
      highlights: [],
      arrows: [],
    });
  });

  // ─── Дополнительные граничные ───────────────────────────────────

  it('arrows: from === to → отбрасывается', () => {
    const raw = JSON.stringify({
      comment: 'X',
      arrows: [
        { from: 'e4', to: 'e4', color: 'green' },
        { from: 'e2', to: 'e4', color: 'green' },
      ],
    });
    expect(parseModelOutput(raw).arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'green' },
    ]);
  });

  it('дубль arrow по (from,to) → последний цвет выигрывает', () => {
    const raw = JSON.stringify({
      comment: 'X',
      arrows: [
        { from: 'e2', to: 'e4', color: 'red' },
        { from: 'e2', to: 'e4', color: 'green' },
      ],
    });
    expect(parseModelOutput(raw).arrows).toEqual([
      { from: 'e2', to: 'e4', color: 'green' },
    ]);
  });

  it('comment не строка (например число) → фолбэк', () => {
    const raw = JSON.stringify({ comment: 42, highlights: [] });
    expect(parseModelOutput(raw)).toEqual({
      comment: raw,
      highlights: [],
      arrows: [],
    });
  });

  it('JSON это массив (не объект) → фолбэк', () => {
    const raw = JSON.stringify([{ comment: 'oops' }]);
    expect(parseModelOutput(raw)).toEqual({
      comment: raw,
      highlights: [],
      arrows: [],
    });
  });
});
