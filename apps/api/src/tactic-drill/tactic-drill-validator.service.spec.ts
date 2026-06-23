/**
 * KS-2230. Validator unit-тесты (api-contract §4 + §6 edge-cases).
 */
import { TacticDrillValidatorService } from './tactic-drill-validator.service';

describe('TacticDrillValidatorService — KS-2230', () => {
  const v = new TacticDrillValidatorService();

  describe('shape=square', () => {
    it('точное совпадение → solved', () => {
      expect(
        v.validate(
          { shape: 'square', square: 'e4' },
          { shape: 'square', square: 'e4' },
        ).solved,
      ).toBe(true);
    });
    it('case-insensitive', () => {
      expect(
        v.validate(
          { shape: 'square', square: 'E4' },
          { shape: 'square', square: 'e4' },
        ).solved,
      ).toBe(true);
    });
    it('mismatch → fail', () => {
      expect(
        v.validate(
          { shape: 'square', square: 'e4' },
          { shape: 'square', square: 'd4' },
        ).solved,
      ).toBe(false);
    });
  });

  describe('shape=number', () => {
    it.each([
      [3, 3, true],
      [3, 4, false],
      [1, 1, true],
    ])('answer=%p user=%p → solved=%p', (a, u, s) => {
      expect(
        v.validate(
          { shape: 'number', value: a },
          { shape: 'number', value: u },
        ).solved,
      ).toBe(s);
    });
  });

  describe('shape=move', () => {
    it('from+to совпадают → solved', () => {
      expect(
        v.validate(
          { shape: 'move', from: 'd1', to: 'h5' },
          { shape: 'move', from: 'd1', to: 'h5' },
        ).solved,
      ).toBe(true);
    });
    it('to отличается → fail', () => {
      expect(
        v.validate(
          { shape: 'move', from: 'd1', to: 'h5' },
          { shape: 'move', from: 'd1', to: 'h6' },
        ).solved,
      ).toBe(false);
    });
  });

  describe('shape=squares (Jaccard 0.7 IoU)', () => {
    const cases: Array<{
      desc: string;
      expected: string[];
      got: string[];
      solved: boolean;
      iou: number;
      tp: number;
      fp: number;
      fn: number;
    }> = [
      {
        desc: 'пустой ответ при N=2',
        expected: ['e4', 'f6'],
        got: [],
        solved: false,
        iou: 0,
        tp: 0,
        fp: 0,
        fn: 2,
      },
      {
        desc: 'все правильные + одна ошибка (TP=2 FP=1 FN=0) → 0.67 fail',
        expected: ['e4', 'f6'],
        got: ['e4', 'f6', 'a1'],
        solved: false,
        iou: 0.67,
        tp: 2,
        fp: 1,
        fn: 0,
      },
      {
        desc: 'большинство правильных (TP=2 FP=0 FN=1) → 0.67 fail',
        expected: ['e4', 'f6', 'g7'],
        got: ['e4', 'f6'],
        solved: false,
        iou: 0.67,
        tp: 2,
        fp: 0,
        fn: 1,
      },
      {
        desc: 'все правильные → IoU=1 pass',
        expected: ['e4', 'f6', 'g7'],
        got: ['e4', 'f6', 'g7'],
        solved: true,
        iou: 1.0,
        tp: 3,
        fp: 0,
        fn: 0,
      },
      {
        desc: 'дубли в userAnswer dedup-нутся → pass',
        expected: ['e4', 'f6'],
        got: ['e4', 'e4', 'f6'],
        solved: true,
        iou: 1.0,
        tp: 2,
        fp: 0,
        fn: 0,
      },
      {
        desc: 'оба пустых → IoU=1 (0/0=1 by convention) pass',
        expected: [],
        got: [],
        solved: true,
        iou: 1.0,
        tp: 0,
        fp: 0,
        fn: 0,
      },
      {
        desc: 'pass на N=4 c одной лишней (TP=4 FP=1 FN=0) → 0.8 pass',
        expected: ['a1', 'b2', 'c3', 'd4'],
        got: ['a1', 'b2', 'c3', 'd4', 'h8'],
        solved: true,
        iou: 0.8,
        tp: 4,
        fp: 1,
        fn: 0,
      },
    ];

    it.each(cases)('$desc', (c) => {
      const r = v.validate(
        { shape: 'squares', squares: c.expected },
        { shape: 'squares', squares: c.got },
      );
      expect(r.solved).toBe(c.solved);
      expect(r.metrics).toBeDefined();
      if (r.metrics) {
        expect(r.metrics.iou).toBeCloseTo(c.iou, 2);
        expect(r.metrics.truePositive).toBe(c.tp);
        expect(r.metrics.falsePositive).toBe(c.fp);
        expect(r.metrics.falseNegative).toBe(c.fn);
      }
    });
  });

  it('discriminator-mismatch → solved=false без метрик', () => {
    const r = v.validate(
      { shape: 'square', square: 'e4' },
      { shape: 'number', value: 3 },
    );
    expect(r.solved).toBe(false);
    expect(r.metrics).toBeUndefined();
  });

  // ── KS-4575: legacy-shape адаптер для find-fork.
  describe('KS-4575: legacy square→move адаптер (find-fork)', () => {
    it('stored=square, user=move, square === to → solved', () => {
      expect(
        v.validate(
          { shape: 'square', square: 'c6' },
          { shape: 'move', from: 'a5', to: 'c6' },
        ).solved,
      ).toBe(true);
    });
    it('stored=square, user=move, case-insensitive по клетке', () => {
      expect(
        v.validate(
          { shape: 'square', square: 'C6' },
          { shape: 'move', from: 'a5', to: 'c6' },
        ).solved,
      ).toBe(true);
    });
    it('stored=square, user=move, square !== to → fail', () => {
      expect(
        v.validate(
          { shape: 'square', square: 'c6' },
          { shape: 'move', from: 'a5', to: 'd6' },
        ).solved,
      ).toBe(false);
    });
    it('обратный mismatch (stored=move, user=square) — НЕ адаптируется → fail', () => {
      // Только legacy-направление: БД square → UI move. Обратное (UI шлёт
      // square на эталон move) — это ошибка фронта/тестов, fail-safe.
      expect(
        v.validate(
          { shape: 'move', from: 'a5', to: 'c6' },
          { shape: 'square', square: 'c6' },
        ).solved,
      ).toBe(false);
    });
  });
});
