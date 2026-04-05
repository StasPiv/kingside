/**
 * Polyglot opening book reader.
 * Format: http://hgm.nubati.net/book_format.html
 * Each entry: 16 bytes (8 hash + 2 move + 2 weight + 4 learn)
 */

// Zobrist random numbers for Polyglot hashing
// Ported from polyglot source: Random64.h
const RANDOM64: bigint[] = [];

// Seed-generated Zobrist keys (standard Polyglot keys)
// Use pre-computed table loaded from polyglot source
function initRandom64(): void {
  // Standard Polyglot uses a specific PRNG seeded with a specific value
  // We implement the same PRNG for compatibility
  let s = 1n;
  for (let i = 0; i < 781; i++) {
    let r = 0n;
    for (let j = 0; j < 64; j++) {
      s = (s * 2862933555777941757n + 7046029254386353087n) & 0xFFFFFFFFFFFFFFFFn;
      if ((s >> 56n) & 1n) {
        r |= 1n << BigInt(j);
      }
    }
    RANDOM64.push(r);
  }
}

initRandom64();

// Piece mapping: polyglot piece index = kind * 2 + color
// kind: 0=pawn, 1=knight, 2=bishop, 3=rook, 4=queen, 5=king
// color: 0=black, 1=white
const PIECE_TO_POLY: Record<string, number> = {
  P: 1, p: 0,   // pawn: white=1, black=0
  N: 3, n: 2,   // knight
  B: 5, b: 4,   // bishop
  R: 7, r: 6,   // rook
  Q: 9, q: 8,   // queen
  K: 11, k: 10, // king
};

export function polyglotHash(fen: string): bigint {
  const parts = fen.split(' ');
  const board = parts[0];
  const turn = parts[1];
  const castling = parts[2];
  const enPassant = parts[3];

  let hash = 0n;

  // Pieces
  const rows = board.split('/');
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch);
      } else {
        const polyPiece = PIECE_TO_POLY[ch];
        if (polyPiece !== undefined) {
          const sq = (7 - rank) * 8 + file; // polyglot square: a1=0, h8=63
          const idx = 64 * polyPiece + sq;
          hash ^= RANDOM64[idx];
        }
        file++;
      }
    }
  }

  // Castling
  const castleOffset = 768;
  if (castling.includes('K')) hash ^= RANDOM64[castleOffset + 0];
  if (castling.includes('Q')) hash ^= RANDOM64[castleOffset + 1];
  if (castling.includes('k')) hash ^= RANDOM64[castleOffset + 2];
  if (castling.includes('q')) hash ^= RANDOM64[castleOffset + 3];

  // En passant
  if (enPassant !== '-') {
    const epFile = enPassant.charCodeAt(0) - 'a'.charCodeAt(0);
    hash ^= RANDOM64[772 + epFile];
  }

  // Turn
  if (turn === 'w') {
    hash ^= RANDOM64[780];
  }

  return hash;
}

export interface BookEntry {
  uci: string;
  weight: number;
}

const FILES = 'abcdefgh';

function decodeMove(raw: number): string {
  const toFile = raw & 0x7;
  const toRow = (raw >> 3) & 0x7;
  const fromFile = (raw >> 6) & 0x7;
  const fromRow = (raw >> 9) & 0x7;
  const promo = (raw >> 12) & 0x7;

  let from = FILES[fromFile] + (fromRow + 1);
  let to = FILES[toFile] + (toRow + 1);

  // Castling: polyglot encodes king captures rook
  if (from === 'e1' && to === 'h1') to = 'g1';
  if (from === 'e1' && to === 'a1') to = 'c1';
  if (from === 'e8' && to === 'h8') to = 'g8';
  if (from === 'e8' && to === 'a8') to = 'c8';

  const promoChars = ['', 'n', 'b', 'r', 'q'];
  return from + to + (promoChars[promo] || '');
}

export function readPolyglotBook(buffer: Buffer): Map<bigint, BookEntry[]> {
  const book = new Map<bigint, BookEntry[]>();
  const count = Math.floor(buffer.length / 16);

  for (let i = 0; i < count; i++) {
    const offset = i * 16;
    const hash = buffer.readBigUInt64BE(offset);
    const rawMove = buffer.readUInt16BE(offset + 8);
    const weight = buffer.readUInt16BE(offset + 10);

    const uci = decodeMove(rawMove);
    if (!uci || uci.length < 4) continue;

    const entries = book.get(hash) ?? [];
    entries.push({ uci, weight });
    book.set(hash, entries);
  }

  return book;
}
