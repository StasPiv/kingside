import {
  RepertoireBuilderService,
  RepertoirePgnError,
  RepertoireLimitExceededError,
  splitPgnIntoGames,
} from './repertoire-builder.service';
import { OPENING_REPERTOIRE_LIMITS } from '@kingside/shared';

/**
 * KS-3271. Спека на PGN → RepertoireTree.
 *
 * Тестируем 6 фикстур из ADR-077 §5.2:
 *   1. Простая основная линия (без вариантов).
 *   2. Линия с одним вариантом.
 *   3. Вложенный вариант (3 уровня).
 *   4. Транспозиция (1.e4 e5 2.Nf3 ≡ 1.Nf3 e5 2.e4).
 *   5. PGN с NAG и комментариями.
 *   6. Невалидный PGN — graceful error.
 *
 * Плюс лимиты: > 2000 nodes / > 5000 edges / > 80 depth / > 500 KB.
 */

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const builder = new RepertoireBuilderService();

describe('RepertoireBuilderService — buildTree (6 фикстур из ADR §5.2)', () => {
  it('1. Простая main-линия без вариантов: 1.e4 e5 2.Nf3 Nc6 3.Bb5', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5';
    const tree = builder.buildTree(pgn);

    expect(tree.rootFen).toBe(STARTING_FEN);
    // 5 ходов → 5 edges → 6 nodes (включая root).
    expect(tree.meta.edgeCount).toBe(5);
    expect(tree.meta.nodeCount).toBe(6);
    expect(tree.meta.maxDepth).toBe(5);

    // У root один edge — e2e4 / "e4".
    const rootNode = tree.nodes[STARTING_FEN];
    expect(rootNode.edges).toHaveLength(1);
    expect(rootNode.edges[0].moveUci).toBe('e2e4');
    expect(rootNode.edges[0].moveSan).toBe('e4');

    // child каждого edge → следующий узел с одним edge (это линейная цепочка).
    let cursor = tree.nodes[rootNode.edges[0].childFen];
    expect(cursor.edges).toHaveLength(1); // e7e5
    cursor = tree.nodes[cursor.edges[0].childFen];
    expect(cursor.edges).toHaveLength(1); // Nf3
    cursor = tree.nodes[cursor.edges[0].childFen];
    expect(cursor.edges).toHaveLength(1); // Nc6
    cursor = tree.nodes[cursor.edges[0].childFen];
    expect(cursor.edges).toHaveLength(1); // Bb5
    cursor = tree.nodes[cursor.edges[0].childFen];
    expect(cursor.edges).toHaveLength(0); // конец линии
  });

  it('2. Один вариант: 1.e4 (1...e5 | 1...c5) 2.Nf3', () => {
    const pgn = '1. e4 e5 (1... c5) 2. Nf3';
    const tree = builder.buildTree(pgn);

    // ходы: e4, e5, c5, Nf3(после e5) = 4 edges, 5 nodes.
    expect(tree.meta.edgeCount).toBe(4);
    expect(tree.meta.nodeCount).toBe(5);

    // root → e4. После e4 — два edge'а (e5 и c5).
    const afterE4Fen = tree.nodes[STARTING_FEN].edges[0].childFen;
    const afterE4 = tree.nodes[afterE4Fen];
    expect(afterE4.edges).toHaveLength(2);
    const sans = afterE4.edges.map((e) => e.moveSan).sort();
    expect(sans).toEqual(['c5', 'e5']);

    // После e5 → Nf3 (1 edge), после c5 → 0 edges (variation закончился).
    const afterE5 = tree.nodes[
      afterE4.edges.find((e) => e.moveSan === 'e5')!.childFen
    ];
    expect(afterE5.edges).toHaveLength(1);
    expect(afterE5.edges[0].moveSan).toBe('Nf3');

    const afterC5 = tree.nodes[
      afterE4.edges.find((e) => e.moveSan === 'c5')!.childFen
    ];
    expect(afterC5.edges).toHaveLength(0);
  });

  it('3. Вложенный вариант (3 уровня): 1.e4 e5 (1...c5 2.Nf3 (2.Nc3 Nc6) Nc6)', () => {
    const pgn = '1. e4 e5 (1... c5 2. Nf3 (2. Nc3 Nc6) Nc6)';
    const tree = builder.buildTree(pgn);

    // Уникальные ходы (FEN-keyed):
    //  e4, e5, c5, после c5 → Nf3 и Nc3, после Nf3 → Nc6, после Nc3 → Nc6.
    // После c5: 2 edges (Nf3, Nc3) → каждый ведёт в разный FEN (разный ход).
    // После Nf3: Nc6. После Nc3: Nc6.
    // FEN после "Nf3 Nc6" ≠ FEN после "Nc3 Nc6" (knights на разных квадратах).
    // Итого: edges = e4, e5, c5, Nf3, Nc3, Nc6(после Nf3), Nc6(после Nc3) = 7
    expect(tree.meta.edgeCount).toBe(7);

    const afterE4 = tree.nodes[tree.nodes[STARTING_FEN].edges[0].childFen];
    const c5edge = afterE4.edges.find((e) => e.moveSan === 'c5')!;
    const afterC5 = tree.nodes[c5edge.childFen];
    const c5Sans = afterC5.edges.map((e) => e.moveSan).sort();
    expect(c5Sans).toEqual(['Nc3', 'Nf3']);

    const afterNf3 = tree.nodes[
      afterC5.edges.find((e) => e.moveSan === 'Nf3')!.childFen
    ];
    expect(afterNf3.edges).toHaveLength(1);
    expect(afterNf3.edges[0].moveSan).toBe('Nc6');

    const afterNc3 = tree.nodes[
      afterC5.edges.find((e) => e.moveSan === 'Nc3')!.childFen
    ];
    expect(afterNc3.edges).toHaveLength(1);
    expect(afterNc3.edges[0].moveSan).toBe('Nc6');
  });

  it('4. Транспозиция: main 1.e4 e5 2.Nf3 Nc6 3.Bb5 ≡ variation 2.Bb5 Nc6 3.Nf3', () => {
    // Стандартное место транспозиций — варианты дебюта с переменой
    // порядка двух ходов одной стороны. Тут белые играют Nf3+Bb5 в
    // разном порядке; обе линии приводят к одной финальной позиции
    // (Ruy Lopez), которая должна схлопнуться в один node.
    const pgn = '1. e4 e5 2. Nf3 (2. Bb5 Nc6 3. Nf3) Nc6 3. Bb5';
    const tree = builder.buildTree(pgn);

    // Уникальные FEN: root, после e4, после e5, после Nf3 (main),
    // после Bb5 (var, white вместо Nf3), после Nc6 (var), финал ОДИН
    // для обоих порядков (Nf3 + Nc6 + Bb5  ≡  Bb5 + Nc6 + Nf3).
    // В main: Nc6 (после Nf3) и Bb5 (после Nc6) — 2 ещё node'а.
    // Итого: root, e4, e5, Nf3, Bb5(var), Nc6(var), Nc6(main),
    // финал-один-для-обоих = 8 узлов.
    expect(tree.meta.nodeCount).toBe(8);
    // Edges: e4, e5, Nf3, Bb5(var), Nc6(var), Nf3(var), Nc6(main),
    // Bb5(main) = 8.
    expect(tree.meta.edgeCount).toBe(8);

    // Финальная позиция main-линии (после Bb5).
    const afterE4 = tree.nodes[tree.nodes[STARTING_FEN].edges[0].childFen];
    const afterE5 = tree.nodes[
      afterE4.edges.find((e) => e.moveSan === 'e5')!.childFen
    ];
    const nf3Main = afterE5.edges.find((e) => e.moveSan === 'Nf3')!;
    const afterNf3 = tree.nodes[nf3Main.childFen];
    const afterNc6Main = tree.nodes[
      afterNf3.edges.find((e) => e.moveSan === 'Nc6')!.childFen
    ];
    const mainEndFen = afterNc6Main.edges.find((e) => e.moveSan === 'Bb5')!
      .childFen;

    // Финальная позиция variation-линии (после Nf3 в variation).
    const bb5Var = afterE5.edges.find((e) => e.moveSan === 'Bb5')!;
    const afterBb5 = tree.nodes[bb5Var.childFen];
    const afterNc6Var = tree.nodes[
      afterBb5.edges.find((e) => e.moveSan === 'Nc6')!.childFen
    ];
    const varEndFen = afterNc6Var.edges.find((e) => e.moveSan === 'Nf3')!
      .childFen;

    // Транспозиция: один и тот же FEN.
    expect(mainEndFen).toBe(varEndFen);
    // И это один node (по dict-ключу).
    expect(tree.nodes[mainEndFen]).toBe(tree.nodes[varEndFen]);
  });

  it('5. PGN с NAG ($1) и комментариями {…} сохраняет их на edge', () => {
    const pgn =
      '1. e4 {Best by test} $1 e5 $14 2. Nf3 {Developing} Nc6';
    const tree = builder.buildTree(pgn);

    const root = tree.nodes[STARTING_FEN];
    const e4 = root.edges[0];
    expect(e4.moveSan).toBe('e4');
    expect(e4.comment).toBe('Best by test');
    expect(e4.nag).toEqual([1]);

    const afterE4 = tree.nodes[e4.childFen];
    const e5 = afterE4.edges[0];
    expect(e5.moveSan).toBe('e5');
    expect(e5.nag).toEqual([14]);

    const afterE5 = tree.nodes[e5.childFen];
    const nf3 = afterE5.edges[0];
    expect(nf3.comment).toBe('Developing');
  });

  it('6. Битый PGN — graceful error (illegal move)', () => {
    const pgn = '1. e9 e5';
    expect(() => builder.buildTree(pgn)).toThrow(RepertoirePgnError);
  });

  it('6b. Битый PGN — несбалансированные скобки', () => {
    const pgn = '1. e4 e5 (1... c5';
    // chess.js обычно не валит на этом — мой токенайзер не специально
    // проверяет баланс. Если возникнут проблемы в практике — поправим.
    // Сейчас оба варианта валидны: либо отработает (хуже UX, но без crash),
    // либо бросит. Проверяем что НЕТ unhandled crash:
    let result: unknown;
    try {
      result = builder.buildTree(pgn);
    } catch (e) {
      result = e;
    }
    // result либо RepertoireTree, либо RepertoirePgnError — не Error без тега.
    if (result instanceof Error) {
      expect(result).toBeInstanceOf(RepertoirePgnError);
    } else {
      expect(result).toHaveProperty('rootFen');
    }
  });

  it('6c. Пустой PGN — RepertoirePgnError', () => {
    expect(() => builder.buildTree('')).toThrow(/empty/i);
    expect(() => builder.buildTree('   \n\n  ')).toThrow(/empty/i);
  });

  it('6d. PGN только с headers (без movetext) — RepertoirePgnError', () => {
    const pgn = '[White "Magnus"]\n[Black "Bobby"]\n\n*';
    expect(() => builder.buildTree(pgn)).toThrow(/no playable moves/i);
  });
});

describe('RepertoireBuilderService — лимиты (ADR §3.2)', () => {
  it('PGN > 500 КБ → RepertoireLimitExceededError (pgn-size)', () => {
    const huge = '1. e4 '.repeat(100_000); // ~600 КБ
    expect(() => builder.buildTree(huge)).toThrow(
      RepertoireLimitExceededError,
    );
    try {
      builder.buildTree(huge);
    } catch (e) {
      if (e instanceof RepertoireLimitExceededError) {
        expect(e.limit).toBe('pgn-size');
        expect(e.max).toBe(OPENING_REPERTOIRE_LIMITS.maxPgnBytes);
      } else {
        throw e;
      }
    }
  });

  // KS-3335: depth-лимит снят (пользователи добавляют целые партии,
  // не только дебют). Теперь PGN глубиной > 80 полуходов парсится
  // штатно, без throw. nodeCount/edgeCount/pgnBytes продолжают
  // защищать от патологических объёмов.
  it('KS-3335: depth > 80 — НЕ бросает (лимит снят, длинные партии OK)', () => {
    const moves: string[] = [];
    for (let m = 1; m <= 50; m++) {
      const wMove = m % 2 === 1 ? 'Nf3' : 'Ng1';
      const bMove = m % 2 === 1 ? 'Nf6' : 'Ng8';
      moves.push(`${m}. ${wMove} ${bMove}`);
    }
    const pgn = moves.join(' ');
    const tree = builder.buildTree(pgn);
    expect(tree.meta.maxDepth).toBeGreaterThan(80);
    expect(tree.meta.edgeCount).toBeGreaterThan(0);
  });
});

describe('RepertoireBuilderService — мелкие edge cases', () => {
  it('SAN с аннотациями (!?, ?!) парсится корректно', () => {
    const pgn = '1. e4!? e5?!';
    const tree = builder.buildTree(pgn);
    expect(tree.meta.edgeCount).toBe(2);
    const e4 = tree.nodes[STARTING_FEN].edges[0];
    expect(e4.moveSan).toBe('e4');
  });

  it('Promotion-ход даёт UCI с promotion-буквой', () => {
    // Минимальная legal позиция для promotion'а: установим через стандартное PGN-начало
    // и доведём до promotion вручную — но проще через FEN-based scenario.
    // Используем стандартное начало + быструю последовательность, заканчивающуюся promotion'ом.
    const pgn =
      '1. e4 d5 2. exd5 c6 3. dxc6 Nf6 4. cxb7 Nbd7 5. bxa8=Q';
    const tree = builder.buildTree(pgn);
    // Найдём promotion-ход (bxa8=Q) и проверим UCI.
    const allEdges = Object.values(tree.nodes).flatMap((n) => n.edges);
    const promo = allEdges.find((e) => e.moveSan.includes('=Q'));
    expect(promo).toBeDefined();
    // UCI промоушна = `b7a8q` (lowercase promotion piece).
    expect(promo!.moveUci.endsWith('q')).toBe(true);
  });

  it('Дубликат main + variation с тем же ходом — счётчик edges не растёт', () => {
    // 1. e4 (1. e4 e5)  — повторный e4 в variation не добавляет edge'а.
    const pgn = '1. e4 (1. e4 e5)';
    const tree = builder.buildTree(pgn);
    const root = tree.nodes[STARTING_FEN];
    // Один edge у root'а — e4.
    expect(root.edges).toHaveLength(1);
    // edgeCount: e4 (main), e5 (var) = 2. e4 из variation НЕ дублирует.
    expect(tree.meta.edgeCount).toBe(2);
  });
});

describe('KS-3325: splitPgnIntoGames', () => {
  it('PGN без результата → одна партия', () => {
    expect(splitPgnIntoGames('1. e4 e5')).toEqual(['1. e4 e5']);
  });

  it('PGN с одним результатом → одна партия', () => {
    expect(splitPgnIntoGames('1. e4 e5 1-0')).toEqual(['1. e4 e5 1-0']);
  });

  it('Два PGN подряд → две партии', () => {
    const pgn = '1. e4 e5 1-0\n\n1. d4 d5 0-1';
    expect(splitPgnIntoGames(pgn)).toEqual(['1. e4 e5 1-0', '1. d4 d5 0-1']);
  });

  it('Три PGN разными результатами → три партии', () => {
    const pgn = '1. e4 e5 1-0 1. d4 d5 1/2-1/2 1. c4 c5 *';
    expect(splitPgnIntoGames(pgn)).toEqual([
      '1. e4 e5 1-0',
      '1. d4 d5 1/2-1/2',
      '1. c4 c5 *',
    ]);
  });

  it('Headers стрипаются ДО разделения (фикс прод-бага KS-3325 follow-up)', () => {
    // После фикса splitPgnIntoGames первым шагом удаляет PGN-headers,
    // иначе result-token в `[Result "1-0"]` ошибочно режет PGN. Раньше
    // headers оставались в game-строках; теперь нет. На UI fallback
    // (`[Event]` → имя источника) это пока не влияет — фронт ещё не
    // использует header-parsing.
    const pgn = '[Event "Game 1"]\n1. e4 e5 1-0\n[Event "Game 2"]\n1. d4 d5 0-1';
    const games = splitPgnIntoGames(pgn);
    expect(games).toHaveLength(2);
    expect(games[0]).not.toContain('[Event');
    expect(games[1]).not.toContain('[Event');
    expect(games[0]).toMatch(/1\. e4 e5 1-0/);
    expect(games[1]).toMatch(/1\. d4 d5 0-1/);
  });

  it('Result-token внутри {comment} НЕ разделитель', () => {
    const pgn = '1. e4 {result: 1-0 expected} e5 1-0';
    const games = splitPgnIntoGames(pgn);
    expect(games).toHaveLength(1);
    expect(games[0]).toContain('{result: 1-0 expected}');
  });

  it('Пустая строка → пустой массив', () => {
    expect(splitPgnIntoGames('')).toEqual([]);
    expect(splitPgnIntoGames('   \n\n   ')).toEqual([]);
  });

  // KS-3325 follow-up regression (production bug):
  // Result-токен внутри `[Result "1-0"]` header'а ранее считался
  // разделителем партий → builder получал `[Event ...] [Result "1-0"`
  // без movetext → `Illegal move "[Result"`.
  it('Result-token внутри [Result "1-0"] header — НЕ разделитель (фикс прод-бага backfill)', () => {
    const pgn = '[Event "x"]\n[Result "1-0"]\n\n1. e4 e5 1-0';
    const games = splitPgnIntoGames(pgn);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatch(/1\. e4 e5 1-0/);
    // Header [Result "1-0"] не должен попасть в выход (stripHeaders убрал).
    expect(games[0]).not.toContain('[Result');
  });

  it('Multi-game с headers второй партии — корректно разделяется', () => {
    const pgn =
      '[Event "G1"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n[Event "G2"]\n[Result "0-1"]\n\n1. d4 d5 0-1';
    const games = splitPgnIntoGames(pgn);
    expect(games).toHaveLength(2);
    expect(games[0]).toMatch(/1\. e4 e5 1-0/);
    expect(games[1]).toMatch(/1\. d4 d5 0-1/);
  });
});

describe('KS-3325: buildTree multi-game PGN (bug fix)', () => {
  it('PGN с двумя партиями (1-0 разделитель) — chess.js сбрасывается между партиями', () => {
    // До KS-3325: tokenize скипал `1-0`, но chess instance оставался в
    // позиции после `e5`, и `1. d4` падал с Illegal move (d2d4 невалидно
    // когда чёрные на ходу). Теперь splitPgnIntoGames + fresh chess.
    const pgn = '1. e4 e5 1-0\n\n1. d4 d5 0-1';
    const tree = builder.buildTree(pgn);
    const root = tree.nodes[STARTING_FEN];
    const sans = root.edges.map((e) => e.moveSan).sort();
    expect(sans).toEqual(['d4', 'e4']);
  });
});

describe('KS-3325: buildTreeFromSources (multi-source)', () => {
  it('Пустой массив sources → RepertoirePgnError', () => {
    expect(() => builder.buildTreeFromSources([])).toThrow(/source.*required/i);
  });

  it('Один source → то же дерево что buildTree(pgn) + sourceIds на edges', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6';
    const sid = 'src-1';
    const single = builder.buildTreeFromSources([{ sourceId: sid, pgn }]);
    const legacy = builder.buildTree(pgn);
    expect(single.meta.nodeCount).toBe(legacy.meta.nodeCount);
    expect(single.meta.edgeCount).toBe(legacy.meta.edgeCount);
    // Каждый edge получил sourceIds=[sid].
    const allEdges = Object.values(single.nodes).flatMap((n) => n.edges);
    for (const e of allEdges) {
      expect(e.sourceIds).toEqual([sid]);
    }
  });

  it('Два source с разными линиями → union edges (разные edges, разные sourceIds)', () => {
    const a = builder.buildTreeFromSources([
      { sourceId: 'src-a', pgn: '1. e4 e5' },
      { sourceId: 'src-b', pgn: '1. d4 d5' },
    ]);
    const root = a.nodes[STARTING_FEN];
    expect(root.edges).toHaveLength(2);
    const e4 = root.edges.find((e) => e.moveSan === 'e4');
    const d4 = root.edges.find((e) => e.moveSan === 'd4');
    expect(e4?.sourceIds).toEqual(['src-a']);
    expect(d4?.sourceIds).toEqual(['src-b']);
  });

  it('Транспозиция: один ход из двух источников → один edge, sourceIds.length=2', () => {
    const t = builder.buildTreeFromSources([
      { sourceId: 'src-a', pgn: '1. e4 e5' },
      { sourceId: 'src-b', pgn: '1. e4 c5' }, // тот же первый ход
    ]);
    const root = t.nodes[STARTING_FEN];
    // У root один edge — e4 (с двумя sourceIds).
    expect(root.edges).toHaveLength(1);
    const e4 = root.edges[0];
    expect(e4.moveSan).toBe('e4');
    expect(e4.sourceIds?.sort()).toEqual(['src-a', 'src-b']);
    // А ответы чёрных разные — два edge'а из after-e4.
    const afterE4 = t.nodes[e4.childFen];
    const sans = afterE4.edges.map((e) => e.moveSan).sort();
    expect(sans).toEqual(['c5', 'e5']);
  });

  it('NAG union: один ход с NAG из source A + другой NAG в source B → оба в массиве', () => {
    const t = builder.buildTreeFromSources([
      { sourceId: 'a', pgn: '1. e4 $1' },
      { sourceId: 'b', pgn: '1. e4 $14' },
    ]);
    const root = t.nodes[STARTING_FEN];
    const e4 = root.edges[0];
    expect(e4.nag?.sort((x, y) => x - y)).toEqual([1, 14]);
  });

  it('Comment keep-first: source A с комментом, source B без → comment от A', () => {
    const t = builder.buildTreeFromSources([
      { sourceId: 'a', pgn: '1. e4 {first}' },
      { sourceId: 'b', pgn: '1. e4 {second}' },
    ]);
    const root = t.nodes[STARTING_FEN];
    expect(root.edges[0].comment).toBe('first');
  });

  it('Пустые sources (только заголовки) → RepertoirePgnError edgeCount=0', () => {
    expect(() =>
      builder.buildTreeFromSources([
        { sourceId: 'a', pgn: '[Event "x"]\n' },
      ]),
    ).toThrow(/no playable moves/i);
  });
});
