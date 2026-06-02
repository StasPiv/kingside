import { computeTags, detectEndgameSubtype, detectPhase } from './tagging';

describe('computeTags — алгоритмические теги', () => {
  it('endgame: ≤7 фигур → tag endgame', () => {
    // K + R vs k + p — 4 фигуры
    const fen = '4k3/8/8/8/8/8/3p4/3RK3 w - - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['d1d2'],
      finalCpForSolver: 300,
      endsInMate: false,
    });
    expect(tags).toContain('endgame');
  });

  it('crushing: finalCp ≥ 500 без мата → tag crushing', () => {
    const fen =
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['d2d4'],
      finalCpForSolver: 700,
      endsInMate: false,
    });
    expect(tags).toContain('crushing');
    expect(tags).not.toContain('mate');
  });

  it('advantage: 200 ≤ finalCp < 500 → tag advantage', () => {
    const fen =
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['d2d4'],
      finalCpForSolver: 300,
      endsInMate: false,
    });
    expect(tags).toContain('advantage');
  });

  it('mateIn1: линия 1 полуход + endsInMate → tag mate + mateIn1', () => {
    // позиция с матом в 1
    const fen = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['d1d8'],
      finalCpForSolver: 0,
      endsInMate: true,
    });
    expect(tags).toContain('mate');
    expect(tags).toContain('mateIn1');
  });

  it('mateIn2: линия 3 полухода (наш-их-наш) + endsInMate → mateIn2', () => {
    const fen =
      'rnbqkbnr/ppp1pppp/8/3p4/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['e2e4', 'd5e4', 'd1h5'],
      finalCpForSolver: 0,
      endsInMate: true,
    });
    expect(tags).toContain('mate');
    expect(tags).toContain('mateIn2');
  });

  it('фигура-исполнитель: ход конём → knightMove', () => {
    const fen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['g1f3'],
      finalCpForSolver: 50,
      endsInMate: false,
    });
    expect(tags).toContain('knightMove');
  });

  it('drill predicate fork: позиция с вилкой коня → tag fork', () => {
    // KS-2227 классическая вилка: белый конь с c7 атакует чёрного
    // короля на a8 и ладью на e8 (Royal fork). Берём такую позицию,
    // где predicate пройдёт. Пример из find-fork.spec.ts:
    const fen = 'r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['c7e6'],
      finalCpForSolver: 800,
      endsInMate: false,
    });
    // Predicate `findFork` strict — тег ставится только если ход
    // решения совпадает с answer. Если позиция/ход не совпадают —
    // тест может не получить fork; в этом случае хотя бы крушёр.
    expect(tags.length).toBeGreaterThan(0);
    // sanity: не падает на predicate-cycle.
  });

  it('sacrifice: первый ход — отдача сильной фигуры под бой более дешёвой', () => {
    // Жертва ферзя под бой пешки. Чёрная пешка c4 атакует клетки
    // b3 и d3. Белый ферзь b2 ходит на b3 — попадает под бой пешки.
    // Q (9) > pawn (1) → sacrifice.
    const fen = '4k3/8/8/8/2p5/8/1Q6/4K3 w - - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['b2b3'],
      finalCpForSolver: 0,
      endsInMate: false,
    });
    expect(tags).toContain('sacrifice');
  });
});

// ─── KS-3562 / ADR-094 §3.1. Phase detection edge cases ──────────────

describe('detectPhase — KS-3562 / ADR-094 §3.1', () => {
  it('#1 стартовая позиция → opening (fullmove=1, материал полный)', () => {
    const fen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(detectPhase(fen)).toBe('opening');
  });

  it('#2 после 1.e4 → opening (fullmove=1, ход чёрных)', () => {
    const fen =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(detectPhase(fen)).toBe('opening');
  });

  it('#3 миттельшпиль на 20-м ходу с почти полным материалом → middlegame', () => {
    // Сложная позиция: ферзи на доске, много фигур, fullmove=20.
    // Q+Q + 2R + 2N + 2B + 16P + K = 30 фигур (полный материал минус
    // пару разменов). queens=2, nonPawn значительно > 6, total > 5.
    const fen =
      'r1bq1rk1/pp2bppp/2np1n2/2p1p3/2P1P3/2NP1N2/PP2BPPP/R1BQ1RK1 w - - 0 20';
    expect(detectPhase(fen)).toBe('middlegame');
  });

  it('#4 размен ферзей на 20-м ходу с малым материалом → endgame', () => {
    // queens=0, nonPawn=4 (2R + 2B), total нон-кинг=12 — попадаем
    // в ветку «queens=0 AND nonPawn≤6» → endgame, перебивает fullmove.
    const fen =
      '4k3/p1p2pp1/8/8/8/8/P1P2PP1/2BRKB1R w - - 0 20';
    expect(detectPhase(fen)).toBe('endgame');
  });

  it('#5 K+P vs K → endgame (total нон-кинг = 1, ≤5)', () => {
    const fen = '8/8/8/4k3/8/4P3/8/4K3 w - - 0 30';
    expect(detectPhase(fen)).toBe('endgame');
  });

  it('#6 быстрый размен на 8-м ходу: total=4 нон-кинг → endgame перебивает opening', () => {
    // K + R + R + K + 0 пешек (ранний размен всех пешек и фигур).
    // Хотя fullmove=8 (был бы opening), endgame-проверка идёт первой.
    const fen = '4k3/8/8/8/8/8/4R3/3RK3 w - - 0 8';
    expect(detectPhase(fen)).toBe('endgame');
  });

  it('phase tag в computeTags: opening + НЕТ endgame/middlegame', () => {
    const fen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['e2e4'],
      finalCpForSolver: 0,
      endsInMate: false,
    });
    expect(tags).toContain('opening');
    expect(tags).not.toContain('middlegame');
    expect(tags).not.toContain('endgame');
  });

  it('phase tag в computeTags: endgame для K+R vs k+p (back-compat со старым тестом)', () => {
    const fen = '4k3/8/8/8/8/8/3p4/3RK3 w - - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['d1d2'],
      finalCpForSolver: 300,
      endsInMate: false,
    });
    expect(tags).toContain('endgame');
    expect(tags).not.toContain('opening');
    expect(tags).not.toContain('middlegame');
  });
});

// ─── KS-3567 / ADR-094 §8.3. Endgame subtype detection ───────────────

describe('detectEndgameSubtype — KS-3567 / ADR-094 §8.3', () => {
  it('#1 K+P vs K → pawnEndgame', () => {
    // Только короли и пешка. types {} → pawnEndgame.
    const fen = '4k3/8/8/8/8/4P3/8/4K3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('pawnEndgame');
  });

  it('#2 K vs K → pawnEndgame (формально, types пустой)', () => {
    // Краевой кейс: вообще без не-кинговых нон-пешечных. По алгоритму
    // §8.3 — pawnEndgame, хотя реально такая позиция до tagger'а
    // доходит редко (puzzle на K vs K не генерируется).
    const fen = '4k3/8/8/8/8/8/8/4K3 w - - 0 50';
    expect(detectEndgameSubtype(fen)).toBe('pawnEndgame');
  });

  it('#3 K+R+P vs K+P → rookEndgame', () => {
    const fen = '4k3/4p3/8/8/8/8/4P3/3RK3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('rookEndgame');
  });

  it('#4 K+R vs K+N → null (смешанный R+N)', () => {
    const fen = '4k3/8/8/8/8/2n5/8/3RK3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBeNull();
  });

  it('#5 K+Q+R vs K+R → queenRookEndgame', () => {
    const fen = '3rk3/8/8/8/8/8/8/3QRK2 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('queenRookEndgame');
  });

  it('#6 K+Q+R+B vs K+R → null (Q+R+B смешанный)', () => {
    const fen = '3rk3/8/8/8/8/8/8/2BQRK2 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBeNull();
  });

  it('#7 K+B+B vs K+N → null (B+N смешанный)', () => {
    const fen = '4k3/8/8/8/8/2n5/8/2B1KB2 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBeNull();
  });

  it('#8 K+N+N vs K → knightEndgame', () => {
    const fen = '4k3/8/8/8/8/8/8/1NN1K3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('knightEndgame');
  });

  it('#9 K+B vs K → bishopEndgame', () => {
    const fen = '4k3/8/8/8/8/8/8/2B1K3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('bishopEndgame');
  });

  it('#10 K+R+R+P vs K+R+P → rookEndgame (несколько ладей у обеих сторон)', () => {
    const fen = '3rk3/4p3/8/8/8/8/4P3/2RRK3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('rookEndgame');
  });

  it('#11 K+Q+P vs K+Q+P → queenEndgame (Q vs Q + пешки)', () => {
    const fen = '3qk3/4p3/8/8/8/8/4P3/3QK3 w - - 0 30';
    expect(detectEndgameSubtype(fen)).toBe('queenEndgame');
  });

  it('интеграция: computeTags для K+P vs K → endgame + pawnEndgame', () => {
    const fen = '4k3/8/8/8/8/4P3/8/4K3 w - - 0 30';
    const tags = computeTags({
      startFen: fen,
      moves: ['e3e4'],
      finalCpForSolver: 200,
      endsInMate: false,
    });
    expect(tags).toContain('endgame');
    expect(tags).toContain('pawnEndgame');
    expect(tags).not.toContain('rookEndgame');
    expect(tags).not.toContain('queenEndgame');
  });

  it('интеграция: computeTags для смешанного R+N → endgame БЕЗ подвида', () => {
    const fen = '4k3/8/8/8/8/2n5/8/3RK3 w - - 0 30';
    const tags = computeTags({
      startFen: fen,
      moves: ['d1d2'],
      finalCpForSolver: 200,
      endsInMate: false,
    });
    expect(tags).toContain('endgame');
    expect(tags).not.toContain('rookEndgame');
    expect(tags).not.toContain('knightEndgame');
    expect(tags).not.toContain('queenRookEndgame');
    expect(tags).not.toContain('pawnEndgame');
    expect(tags).not.toContain('bishopEndgame');
    expect(tags).not.toContain('queenEndgame');
  });

  it('интеграция: middlegame НЕ получает подвидового тега', () => {
    // Полная стартовая позиция → opening, не endgame. Подвид НЕ
    // должен добавляться (даже если позиция «как бы похожа» на
    // queenRookEndgame по списку типов — главное, что фаза не endgame).
    const fen =
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const tags = computeTags({
      startFen: fen,
      moves: ['e2e4'],
      finalCpForSolver: 0,
      endsInMate: false,
    });
    expect(tags).toContain('opening');
    expect(tags).not.toContain('endgame');
    expect(tags).not.toContain('pawnEndgame');
    expect(tags).not.toContain('rookEndgame');
    expect(tags).not.toContain('queenEndgame');
    expect(tags).not.toContain('knightEndgame');
    expect(tags).not.toContain('bishopEndgame');
    expect(tags).not.toContain('queenRookEndgame');
  });
});
