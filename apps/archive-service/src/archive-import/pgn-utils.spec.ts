import { parseGame } from './pgn-utils';

const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('parseGame — startFen (KS-1624)', () => {
  it('обычная партия без SetUp/FEN-заголовков → startFen === undefined', () => {
    const pgn = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0
`;
    const parsed = parseGame(pgn);
    expect(parsed).not.toBeNull();
    expect(parsed?.startFen).toBeUndefined();
    expect(parsed?.moves.length).toBeGreaterThan(0);
  });

  it('партия с [FEN "стандартный старт"] без SetUp → startFen === undefined', () => {
    const pgn = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]
[FEN "${STANDARD_START}"]

1. e4 e5 1-0
`;
    const parsed = parseGame(pgn);
    expect(parsed).not.toBeNull();
    // FEN равен стандартному стартовому — это НЕ SetUp-партия.
    expect(parsed?.startFen).toBeUndefined();
  });

  it('партия [SetUp "1"][FEN "нестандартный"] → startFen заполнен FEN-значением', () => {
    // Позиция после 1.e4 — легальная, используем её как "нестандартный старт".
    const nonStandard =
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const pgn = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "0-1"]
[SetUp "1"]
[FEN "${nonStandard}"]

1... e5 2. Nf3 Nc6 0-1
`;
    const parsed = parseGame(pgn);
    expect(parsed).not.toBeNull();
    expect(parsed?.startFen).toBe(nonStandard);
    expect(parsed?.moves[0]?.uci).toBe('e7e5');
  });

  it('[SetUp "0"][FEN "нестандартный"] — SetUp явно отменён → startFen === undefined', () => {
    const nonStandard = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const pgn = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]
[SetUp "0"]
[FEN "${nonStandard}"]

1. e4 e5 1-0
`;
    const parsed = parseGame(pgn);
    expect(parsed).not.toBeNull();
    expect(parsed?.startFen).toBeUndefined();
  });
});
