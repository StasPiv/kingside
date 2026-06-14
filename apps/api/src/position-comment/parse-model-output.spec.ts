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

  // 3. Не-JSON текст в HTTP 200 → пустой шейп (state=error на фронте,
  // overlay не рисуется). KS-3693 follow-up: согласно Gherkin §9 Q1
  // сценарий 2 сырой текст модели наружу не отдаём.
  it('3. произвольный текст без JSON → пустой шейп (фронт идёт в state=error)', () => {
    const raw = '  Это просто текст без JSON. \n';
    expect(parseModelOutput(raw)).toEqual({
      comment: '',
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

  // 11. Только highlights без comment → пустой шейп (state=error на
  // фронте). KS-3693: highlights без comment — сломанный контракт,
  // overlay тоже не рисуем.
  it('11. JSON без comment → пустой шейп, никакого overlay', () => {
    const raw = JSON.stringify({
      highlights: [{ square: 'e4', color: 'red' }],
    });
    expect(parseModelOutput(raw)).toEqual({
      comment: '',
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

  it('comment не строка (например число) → пустой шейп', () => {
    const raw = JSON.stringify({ comment: 42, highlights: [] });
    expect(parseModelOutput(raw)).toEqual({
      comment: '',
      highlights: [],
      arrows: [],
    });
  });

  it('JSON это массив (не объект) → пустой шейп', () => {
    const raw = JSON.stringify([{ comment: 'oops' }]);
    expect(parseModelOutput(raw)).toEqual({
      comment: '',
      highlights: [],
      arrows: [],
    });
  });

  // ─── KS-4069: геометрическая валидация стрелок (с FEN) ─────────

  describe('KS-4069: фильтрация невалидных стрелок при наличии FEN', () => {
    it('Gherkin: фактор называет цель, недостижимую для фигуры → стрелка не рисуется', () => {
      // Реальный кейс из жалобы пользователя: слон c4 → h6 при блоке
      // собственной d5 и чужой e6.
      const fen = '7k/8/4p2n/3P4/2B5/8/8/4K3 w - - 0 1';
      const raw = JSON.stringify({
        comment: 'давление на h6',
        arrows: [{ from: 'c4', to: 'h6', color: 'red' }],
      });
      const out = parseModelOutput(raw, fen);
      expect(out.arrows).toEqual([]);
      // comment и highlights не страдают.
      expect(out.comment).toBe('давление на h6');
    });

    it('Gherkin: цель достижима → стрелка рисуется', () => {
      // Слон c4 действительно атакует пешку d5 — стрелка остаётся.
      const fen = '4k3/8/8/3p4/2B5/8/8/4K3 w - - 0 1';
      const raw = JSON.stringify({
        comment: 'давление на d5',
        arrows: [{ from: 'c4', to: 'd5', color: 'red' }],
      });
      const out = parseModelOutput(raw, fen);
      expect(out.arrows).toEqual([{ from: 'c4', to: 'd5', color: 'red' }]);
    });

    it('смешанная пачка: валидные сохраняются, невалидные отбрасываются', () => {
      const fen = '7k/8/4p2n/3P4/2B5/8/8/4K3 w - - 0 1';
      const raw = JSON.stringify({
        comment: 'x',
        arrows: [
          { from: 'c4', to: 'h6', color: 'red' }, // невалидно — отбросить
          { from: 'c4', to: 'd5', color: 'red' }, // валидно — оставить
          { from: 'd5', to: 'e6', color: 'green' }, // пешка ест по диагонали — валидно
        ],
      });
      const out = parseModelOutput(raw, fen);
      expect(out.arrows).toEqual([
        { from: 'c4', to: 'd5', color: 'red' },
        { from: 'd5', to: 'e6', color: 'green' },
      ]);
    });

    it('без FEN — геометрия не проверяется (backward-compat)', () => {
      const raw = JSON.stringify({
        comment: 'x',
        arrows: [{ from: 'c4', to: 'h6', color: 'red' }],
      });
      // Старый вызов без fen — стрелка остаётся (поведение до KS-4069).
      expect(parseModelOutput(raw).arrows).toEqual([
        { from: 'c4', to: 'h6', color: 'red' },
      ]);
    });

    it('битый FEN → все стрелки отбрасываются (geom-validator возвращает false)', () => {
      const raw = JSON.stringify({
        comment: 'x',
        arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
      });
      expect(parseModelOutput(raw, 'definitely-not-fen').arrows).toEqual([]);
    });
  });
});
