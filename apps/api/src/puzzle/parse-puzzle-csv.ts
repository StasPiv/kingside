/**
 * Parser for Lichess puzzle database CSV format.
 *
 * CSV columns:
 *   PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 */

export interface PuzzleRecord {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  ratingDev: number;
  popularity: number;
  nbPlays: number;
  themes: string;
  gameUrl: string;
  openingTags: string;
}

export function parseLine(line: string): PuzzleRecord | null {
  const parts = line.split(',');
  if (parts.length < 9) return null;

  const [id, fen, moves, rating, ratingDev, popularity, nbPlays, themes, gameUrl, ...openingParts] = parts;

  const ratingNum = parseInt(rating, 10);
  const ratingDevNum = parseInt(ratingDev, 10);
  const popularityNum = parseInt(popularity, 10);
  const nbPlaysNum = parseInt(nbPlays, 10);

  if ([ratingNum, ratingDevNum, popularityNum, nbPlaysNum].some(Number.isNaN)) {
    return null;
  }

  return {
    id,
    fen,
    moves,
    rating: ratingNum,
    ratingDev: ratingDevNum,
    popularity: popularityNum,
    nbPlays: nbPlaysNum,
    themes,
    gameUrl,
    openingTags: openingParts.join(',') || '',
  };
}
