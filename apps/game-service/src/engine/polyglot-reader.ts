/**
 * Polyglot opening book reader.
 * Format: http://hgm.nubati.net/book_format.html
 * Each entry: 16 bytes (8 hash + 2 move + 2 weight + 4 learn)
 *
 * Zobrist keys from https://github.com/ddugovic/polyglot/random.c
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Load pre-computed Zobrist random numbers (781 values)
// Generated from cm-polyglot KeyGenerator.js (standard Polyglot keys)
const RANDOM64_HEX: string[] = JSON.parse(
  readFileSync(join(__dirname, 'polyglot-keys.json'), 'utf-8'),
);
const RANDOM64: bigint[] = RANDOM64_HEX.map((h) => BigInt(h));

// Piece mapping: polyglot uses kind*2+color indexing
// kind: 0=pawn, 1=knight, 2=bishop, 3=rook, 4=queen, 5=king
// color: 0=black, 1=white
const PIECE_TO_POLY: Record<string, number> = {
  P: 1, p: 0,
  N: 3, n: 2,
  B: 5, b: 4,
  R: 7, r: 6,
  Q: 9, q: 8,
  K: 11, k: 10,
};

/**
 * Check if an enemy pawn can actually capture en passant.
 * Polyglot only includes ep square in hash when capture is possible.
 */
function canTakeEnPassant(rows: string[], epFile: number, epRank: number, turn: string): boolean {
  // The capturing pawn must be on the rank adjacent to the ep square
  // If turn=b (black to move), black pawns on rank 3 (index 4 from top) can capture ep on rank 2 (index 5)
  // If turn=w (white to move), white pawns on rank 4 (index 3 from top) can capture ep on rank 5 (index 2)
  const captureRank = turn === 'b' ? 4 : 3; // row index from top (0=rank8, 7=rank1)
  const capturePiece = turn === 'b' ? 'p' : 'P';

  const row = rows[captureRank];
  // Expand row to 8 chars
  let expanded = '';
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') expanded += '.'.repeat(parseInt(ch));
    else expanded += ch;
  }

  // Check adjacent files
  if (epFile > 0 && expanded[epFile - 1] === capturePiece) return true;
  if (epFile < 7 && expanded[epFile + 1] === capturePiece) return true;
  return false;
}

export function polyglotHash(fen: string): bigint {
  const parts = fen.split(' ');
  const board = parts[0];
  const turn = parts[1];
  const castling = parts[2];
  const enPassant = parts[3];

  let hash = 0n;

  // Pieces: index = 64 * polyPiece + square
  const rows = board.split('/');
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch);
      } else {
        const polyPiece = PIECE_TO_POLY[ch];
        if (polyPiece !== undefined) {
          const sq = (7 - rank) * 8 + file;
          hash ^= RANDOM64[64 * polyPiece + sq];
        }
        file++;
      }
    }
  }

  // Castling: indices 768-771
  if (castling.includes('K')) hash ^= RANDOM64[768];
  if (castling.includes('Q')) hash ^= RANDOM64[769];
  if (castling.includes('k')) hash ^= RANDOM64[770];
  if (castling.includes('q')) hash ^= RANDOM64[771];

  // En passant: indices 772-779
  // Polyglot only includes ep in hash if an adjacent enemy pawn can actually capture
  if (enPassant !== '-') {
    const epFile = enPassant.charCodeAt(0) - 'a'.charCodeAt(0);
    const epRank = parseInt(enPassant[1]) - 1; // 0-based
    if (canTakeEnPassant(rows, epFile, epRank, turn)) {
      hash ^= RANDOM64[772 + epFile];
    }
  }

  // Turn: index 780
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
