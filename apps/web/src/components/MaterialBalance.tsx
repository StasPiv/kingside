import { useMemo } from 'react';
import { useBoardSettings } from '../hooks/useBoardSettings';

const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];

const PIECE_CODES: Record<string, { white: string; black: string }> = {
  q: { white: 'wQ', black: 'bQ' },
  r: { white: 'wR', black: 'bR' },
  b: { white: 'wB', black: 'bB' },
  n: { white: 'wN', black: 'bN' },
  p: { white: 'wP', black: 'bP' },
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

  for (const piece of PIECE_ORDER) {
    const diff = white[piece] - black[piece];
    if (diff > 0) {
      for (let i = 0; i < diff; i++) whiteExtra.push(piece);
    } else if (diff < 0) {
      for (let i = 0; i < -diff; i++) blackExtra.push(piece);
    }
  }

  return { whiteExtra, blackExtra };
}

function pieceSrc(pieceSet: string, code: string): string {
  if (pieceSet === 'standard') return `/pieces/cburnett/${code}.svg`;
  return `/pieces/${pieceSet}/${code}.svg`;
}

type Props = {
  fen: string;
};

export function MaterialBalance({ fen }: Props) {
  const { pieceSet } = useBoardSettings();

  const { whiteExtra, blackExtra } = useMemo(() => {
    const { white, black } = parseMaterial(fen);
    return computeDiff(white, black);
  }, [fen]);

  if (whiteExtra.length === 0 && blackExtra.length === 0) return null;

  return (
    <div className="material-balance">
      {whiteExtra.length > 0 && (
        <span className="material-balance__side">
          {whiteExtra.map((p, i) => (
            <img key={i} className="material-balance__piece" src={pieceSrc(pieceSet, PIECE_CODES[p].white)} alt={p} />
          ))}
        </span>
      )}
      {blackExtra.length > 0 && (
        <span className="material-balance__side">
          {blackExtra.map((p, i) => (
            <img key={i} className="material-balance__piece" src={pieceSrc(pieceSet, PIECE_CODES[p].black)} alt={p} />
          ))}
        </span>
      )}
    </div>
  );
}
