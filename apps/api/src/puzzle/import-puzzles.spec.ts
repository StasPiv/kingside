import { parseLine } from './parse-puzzle-csv';

describe('parseLine', () => {
  it('should parse a valid Lichess CSV line', () => {
    const line =
      '00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2PP/PqP1KP2/4R3 b - - 0 1,e7e6 h6g7,1852,75,97,4121,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,';

    const result = parseLine(line);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('00008');
    expect(result!.fen).toBe('r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2PP/PqP1KP2/4R3 b - - 0 1');
    expect(result!.moves).toBe('e7e6 h6g7');
    expect(result!.rating).toBe(1852);
    expect(result!.ratingDev).toBe(75);
    expect(result!.popularity).toBe(97);
    expect(result!.nbPlays).toBe(4121);
    expect(result!.themes).toBe('crushing hangingPiece long middlegame');
    expect(result!.gameUrl).toBe('https://lichess.org/787zsVup/black#48');
    expect(result!.openingTags).toBe('');
  });

  it('should parse a line with opening tags', () => {
    const line =
      '00sHx,r2qr1k1/pp3ppp/2n5/3pP3/3P4/P1PB1Q2/5PPP/R4RK1 b - - 1 16,d8h4 f3h3 h4h3 g2h3,1760,76,98,86974,advantage middlegame short,https://lichess.org/F8M8OS71#31,Queens_Gambit_Declined';

    const result = parseLine(line);

    expect(result).not.toBeNull();
    expect(result!.openingTags).toBe('Queens_Gambit_Declined');
  });

  it('should return null for lines with too few fields', () => {
    expect(parseLine('only,three,fields')).toBeNull();
    expect(parseLine('')).toBeNull();
  });

  it('should return null for lines with non-numeric rating', () => {
    const line = '00008,fen,moves,abc,75,97,4121,themes,url,';
    expect(parseLine(line)).toBeNull();
  });

  it('should return null for the CSV header line', () => {
    const header =
      'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
    expect(parseLine(header)).toBeNull();
  });

  it('should handle multiple opening tags separated by commas', () => {
    const line =
      'abc,fen,moves,1500,80,90,1000,themes,url,Opening_A,Opening_B';

    const result = parseLine(line);

    expect(result).not.toBeNull();
    expect(result!.openingTags).toBe('Opening_A,Opening_B');
  });
});
