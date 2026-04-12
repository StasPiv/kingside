import { useMemo } from 'react';

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];

const WHITE_PIECES: Record<string, string> = {
  q: '\u2655', r: '\u2656', b: '\u2657', n: '\u2658', p: '\u2659',
};
const BLACK_PIECES: Record<string, string> = {
  q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F',
};

function parseMaterial(fen: string) {
  const board = fen.split(' ')[0];
  const white: Record<string, number> = { q: 0, r: 0, b: 0, n: 0, p: 0 };
  const black: Record<string, number> = { q: 0, r: 0, b: 0, n: 0, p: 0 };
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (lower in white) {
      if (ch === lower) black[lower]++;
      else white[lower]++;
    }
  }
  return { white, black };
}

function computeDiff(white: Record<string, number>, black: Record<string, number>) {
  const whiteExtra: string[] = [];
  const blackExtra: string[] = [];
  let scoreDiff = 0;

  for (const piece of PIECE_ORDER) {
    const diff = white[piece] - black[piece];
    scoreDiff += diff * PIECE_VALUES[piece];
    if (diff > 0) {
      for (let i = 0; i < diff; i++) whiteExtra.push(piece);
    } else if (diff < 0) {
      for (let i = 0; i < -diff; i++) blackExtra.push(piece);
    }
  }

  return { whiteExtra, blackExtra, scoreDiff };
}

type Props = {
  fen: string;
};

export function MaterialBalance({ fen }: Props) {
  const { whiteExtra, blackExtra, scoreDiff } = useMemo(() => {
    const { white, black } = parseMaterial(fen);
    return computeDiff(white, black);
  }, [fen]);

  if (whiteExtra.length === 0 && blackExtra.length === 0) return null;

  return (
    <div className="material-balance">
      <span className="material-balance__side">
        {whiteExtra.map((p, i) => (
          <span key={i} className="material-balance__piece material-balance__piece--white">
            {WHITE_PIECES[p]}
          </span>
        ))}
        {scoreDiff > 0 && <span className="material-balance__score">+{scoreDiff}</span>}
      </span>
      <span className="material-balance__side">
        {blackExtra.map((p, i) => (
          <span key={i} className="material-balance__piece material-balance__piece--black">
            {BLACK_PIECES[p]}
          </span>
        ))}
        {scoreDiff < 0 && <span className="material-balance__score">+{-scoreDiff}</span>}
      </span>
    </div>
  );
}
