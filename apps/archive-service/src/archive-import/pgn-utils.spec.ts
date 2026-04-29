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

describe('parseGame — timeControlCategory (KS-2118 / KS-2131)', () => {
  function pgnWithTC(
    tc: string | null,
    extraTags: { event?: string; site?: string } = {},
  ): string {
    const tcLine = tc === null ? '' : `[TimeControl "${tc}"]\n`;
    const event = extraTags.event ?? 'Test';
    const site = extraTags.site ?? 'OTB';
    return `[Event "${event}"]
[Site "${site}"]
[White "A"]
[Black "B"]
[Result "1-0"]
${tcLine}
1. e4 e5 1-0
`;
  }

  it('classical TC → timeControlCategory = "classical"', () => {
    const parsed = parseGame(pgnWithTC('5400+30'));
    expect(parsed?.timeControlCategory).toBe('classical');
    expect(parsed?.timeControl).toBe('5400+30');
  });

  it('blitz TC → timeControlCategory = "blitz"', () => {
    expect(parseGame(pgnWithTC('300+3'))?.timeControlCategory).toBe('blitz');
    expect(parseGame(pgnWithTC('180'))?.timeControlCategory).toBe('blitz');
  });

  it('rapid TC → timeControlCategory = "rapid"', () => {
    expect(parseGame(pgnWithTC('900+10'))?.timeControlCategory).toBe('rapid');
  });

  it('bullet TC → timeControlCategory = "bullet"', () => {
    expect(parseGame(pgnWithTC('60'))?.timeControlCategory).toBe('bullet');
    expect(parseGame(pgnWithTC('60+1'))?.timeControlCategory).toBe('bullet');
  });

  it('составной TC `40/7200:1800+30` → по первой фазе → "classical"', () => {
    const parsed = parseGame(pgnWithTC('40/7200:1800+30'));
    expect(parsed?.timeControlCategory).toBe('classical');
    expect(parsed?.timeControl).toBe('40/7200:1800+30');
  });

  it('correspondence `1/86400` → timeControlCategory = "unknown"', () => {
    expect(parseGame(pgnWithTC('1/86400'))?.timeControlCategory).toBe('unknown');
  });

  it('KS-2131: TC = "-" / нет тега + OTB-Event → "classical" (TWIC/OTB legacy fallback)', () => {
    // Большинство TWIC-партий приходят без [TimeControl] тега и с обычным
    // Event/Site (Tata Steel, Linares и т.п.) — должны попадать в classical,
    // иначе фронт-фильтр «Классика» вернёт 0.
    expect(parseGame(pgnWithTC('-'))?.timeControlCategory).toBe('classical');
    expect(parseGame(pgnWithTC(null))?.timeControlCategory).toBe('classical');
    expect(
      parseGame(pgnWithTC(null, { event: 'Tata Steel Masters', site: 'Wijk aan Zee' }))
        ?.timeControlCategory,
    ).toBe('classical');
  });

  it('KS-2131: нет TC + Event «Titled Tuesday» + chess.com → "blitz"', () => {
    const parsed = parseGame(
      pgnWithTC(null, {
        event: 'Titled Tuesday Blitz 21st Apr 2026',
        site: 'chess.com',
      }),
    );
    expect(parsed?.timeControlCategory).toBe('blitz');
  });

  it('KS-2131-fix: сокращённая форма TWIC `Titled Tue 17th Jun Early` → "blitz"', () => {
    const parsed = parseGame(
      pgnWithTC(null, {
        event: 'Titled Tue 17th Jun Early',
        site: 'chess.com',
      }),
    );
    expect(parsed?.timeControlCategory).toBe('blitz');
  });

  it('KS-2131: нет TC + Event «Bullet Brawl» + chess.com → "bullet" (bullet раньше blitz)', () => {
    const parsed = parseGame(
      pgnWithTC(null, {
        event: 'Titled Tuesday Bullet Brawl',
        site: 'chess.com',
      }),
    );
    expect(parsed?.timeControlCategory).toBe('bullet');
  });

  it('KS-2131: нет TC + chess.com Event без хинтов → "unknown"', () => {
    const parsed = parseGame(
      pgnWithTC(null, {
        event: 'Random Casual Game',
        site: 'chess.com',
      }),
    );
    expect(parsed?.timeControlCategory).toBe('unknown');
  });

  it('KS-2131: явный TC игнорирует Event-эвристику (Titled Tuesday + 5400+30 → classical)', () => {
    const parsed = parseGame(
      pgnWithTC('5400+30', {
        event: 'Titled Tuesday Blitz',
        site: 'chess.com',
      }),
    );
    expect(parsed?.timeControlCategory).toBe('classical');
  });
});
