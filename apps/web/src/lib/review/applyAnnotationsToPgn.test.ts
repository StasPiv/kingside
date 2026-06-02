/**
 * KS-3603. Тесты `applyAnnotationsToPgn` — NAG-символы и variations
 * правильно встраиваются в PGN. Структурное сравнение через парсинг
 * результата chess.js.
 */
import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';

import {
  applyAnnotationsToPgn,
  PGN_COMMENT_MAX_LENGTH,
} from './applyAnnotationsToPgn';
import {
  NAG_BLUNDER,
  NAG_GOOD,
  NAG_MISTAKE,
  type Annotation,
} from './buildAnnotations';

const PGN_E4_E5_NF3 =
  '[Event "Test"]\n[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n';

describe('applyAnnotationsToPgn', () => {
  it('NAG `?` приклеивается к SAN сыгранного хода', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      { ply: 2, nag: [NAG_MISTAKE], variations: [] },
    ]);
    expect(out).toContain('e5?');
  });

  it('NAG `??` приклеивается без поломки парсинга', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      { ply: 2, nag: [NAG_BLUNDER], variations: [] },
    ]);
    expect(out).toContain('e5??');
    // chess.js перепарсит результат:
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).length).toBe(3);
  });

  it('NAG `!` приклеивается на сыгранном best-ходе', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      { ply: 1, nag: [NAG_GOOD], variations: [] },
    ]);
    expect(out).toContain('e4!');
  });

  it('green-variation добавляется в скобках с [%cvc green] и subline', () => {
    // На 2-м ходу чёрные сыграли e5 — пусть «надо было» c5 c2c4 g1f3
    // (на демо-данных; нелегальность не страшна если первый ход
    // легален в позиции перед e5; здесь после 1. e4 это c7c5).
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [NAG_MISTAKE],
        variations: [
          { uci: 'c7c5', color: 'green', subline: ['g1f3', 'b8c6'] },
        ],
      },
    ]);
    expect(out).toContain('[%cvc green]');
    expect(out).toContain('c5');
    expect(out).toContain('Nf3');
    expect(out).toContain('Nc6');
    // chess.js парсит и main-line остаётся валидным.
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).length).toBe(3);
  });

  it('red-variation с NAG ? приклеивается к первому ходу + [%cvc red]', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [],
        variations: [
          { uci: 'd7d5', color: 'red', nag: [NAG_MISTAKE] },
        ],
      },
    ]);
    expect(out).toContain('[%cvc red]');
    expect(out).toMatch(/d5\?/);
  });

  it('обе variations одновременно — главная линия без потерь', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [NAG_MISTAKE],
        variations: [
          { uci: 'c7c5', color: 'green', subline: ['g1f3'] },
          { uci: 'd7d5', color: 'red', nag: [NAG_MISTAKE] },
        ],
      },
    ]);
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).map((m) => m.san)).toEqual([
      'e4',
      'e5',
      'Nf3',
    ]);
    expect(out).toContain('[%cvc green]');
    expect(out).toContain('[%cvc red]');
  });

  it('сохраняет PGN-headers (Event/White/Black/Result)', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      { ply: 1, nag: [NAG_GOOD], variations: [] },
    ]);
    expect(out).toContain('[Event "Test"]');
    expect(out).toContain('[White "A"]');
    expect(out).toContain('[Black "B"]');
    expect(out).toContain('[Result "*"]');
  });

  it('пустой массив annotations → main-line без изменений (валидный PGN)', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, []);
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).map((m) => m.san)).toEqual([
      'e4',
      'e5',
      'Nf3',
    ]);
  });

  it('некорректный PGN → возвращает исходный (defensive)', () => {
    const broken = 'this is not a pgn at all $$$';
    const out = applyAnnotationsToPgn(broken, [], {
      onError: () => {},
    });
    expect(out).toBe(broken);
  });

  it('KS-3616: commentByPly={} → поведение как раньше (без `{}`)', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      { ply: 2, nag: [NAG_MISTAKE], variations: [] },
    ]);
    expect(out).not.toContain('{');
    expect(out).toContain('e5?');
  });

  it('KS-3616: commentByPly с текстом → `{...}` после SAN+NAG', () => {
    const out = applyAnnotationsToPgn(
      PGN_E4_E5_NF3,
      [{ ply: 2, nag: [NAG_MISTAKE], variations: [] }],
      { commentByPly: { 2: 'Лучше было c5' } },
    );
    expect(out).toContain('e5? {Лучше было c5}');
    // chess.js может перепарсить main-line.
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).length).toBe(3);
  });

  it('KS-3616: длинный комментарий обрезается до PGN_COMMENT_MAX_LENGTH', () => {
    const long = 'A'.repeat(500);
    const out = applyAnnotationsToPgn(
      PGN_E4_E5_NF3,
      [{ ply: 1, nag: [], variations: [] }],
      { commentByPly: { 1: long } },
    );
    const m = out.match(/\{([^}]*)\}/);
    expect(m).toBeTruthy();
    const body = m![1];
    expect(body.length).toBeLessThanOrEqual(PGN_COMMENT_MAX_LENGTH);
    expect(body.endsWith('...')).toBe(true);
  });

  it('KS-3616: фигурные скобки внутри комментария экранируются', () => {
    const out = applyAnnotationsToPgn(
      PGN_E4_E5_NF3,
      [{ ply: 1, nag: [], variations: [] }],
      { commentByPly: { 1: 'Foo {bar} baz' } },
    );
    // Внутренние `{`/`}` заменены — иначе PGN не распарсится.
    const inner = out.match(/\{([^}]*)\}/)?.[1] ?? '';
    expect(inner).not.toContain('{');
    expect(inner).toContain('Foo');
    expect(inner).toContain('baz');
    // round-trip:
    const c = new Chess();
    expect(() => c.loadPgn(out)).not.toThrow();
  });

  it('KS-3616: commentByPly не применяется внутри variations (только main-line)', () => {
    const out = applyAnnotationsToPgn(
      PGN_E4_E5_NF3,
      [
        {
          ply: 2,
          nag: [NAG_MISTAKE],
          variations: [{ uci: 'c7c5', color: 'green' }],
        },
      ],
      { commentByPly: { 2: 'main comment' } },
    );
    // Комментарий main-line есть.
    expect(out).toContain('{main comment}');
    // А в variation никакого `{main comment}` дублироваться не должно.
    expect((out.match(/\{main comment\}/g) ?? []).length).toBe(1);
  });

  it('KS-3619: finalEvalNag → $N в конце ветки (chess.js-совместимо)', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [NAG_MISTAKE],
        variations: [
          { uci: 'c7c5', color: 'green', subline: ['g1f3'], finalEvalNag: 16 },
        ],
      },
    ]);
    expect(out).toMatch(/\$16\s*\{\[%cvc green\]\}/);
    // Round-trip: chess.js должен прочитать PGN без потерь.
    const c = new Chess();
    expect(() => c.loadPgn(out)).not.toThrow();
  });

  it('KS-3619: без finalEvalNag — $N не добавляется', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [NAG_MISTAKE],
        variations: [{ uci: 'c7c5', color: 'green', subline: ['g1f3'] }],
      },
    ]);
    expect(out).not.toContain('$16');
    expect(out).not.toContain('$18');
  });

  it('KS-3616: пустая строка / только пробелы в commentByPly → не вставляем', () => {
    const out = applyAnnotationsToPgn(
      PGN_E4_E5_NF3,
      [{ ply: 1, nag: [], variations: [] }],
      { commentByPly: { 1: '   ' } },
    );
    expect(out).not.toMatch(/\{\s*\}/);
  });

  it('KS-3610: nested-variations рендерятся как вложенные скобки PGN', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [NAG_MISTAKE],
        variations: [
          {
            uci: 'c7c5',
            color: 'green',
            subline: ['g1f3'],
            // На первом ходу зелёной (c7c5) — вложенная red-альтернатива.
            nestedVariations: [
              [
                {
                  uci: 'd7d5',
                  color: 'red',
                  nag: [NAG_MISTAKE],
                },
              ],
              [], // на 2-м ходе (g1f3) — пусто
            ],
          },
        ],
      },
    ]);
    // Должны увидеть две скобки: внешнюю (зелёная) и вложенную (red).
    expect(out).toContain('[%cvc green]');
    expect(out).toContain('[%cvc red]');
    // Round-trip через chess.js — main-line всё ещё валидна.
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).length).toBe(3);
  });

  it('KS-3610: nested до 3-го уровня — все скобки сохраняются', () => {
    const out = applyAnnotationsToPgn(PGN_E4_E5_NF3, [
      {
        ply: 2,
        nag: [NAG_MISTAKE],
        variations: [
          {
            uci: 'c7c5',
            color: 'green',
            subline: ['g1f3'],
            nestedVariations: [
              [
                {
                  uci: 'd7d5',
                  color: 'red',
                  subline: ['e4d5'],
                  nestedVariations: [
                    [
                      {
                        uci: 'b8c6',
                        color: 'red',
                      },
                    ],
                    [],
                  ],
                },
              ],
              [],
            ],
          },
        ],
      },
    ]);
    // 3 уровня cvc: зелёный + 2 red.
    expect(
      (out.match(/\[%cvc (green|red)\]/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    const c = new Chess();
    c.loadPgn(out);
    expect(c.history({ verbose: true }).length).toBe(3);
  });
});
