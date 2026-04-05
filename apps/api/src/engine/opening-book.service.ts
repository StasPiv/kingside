import { Injectable } from '@nestjs/common';

/**
 * In-memory opening book for bot games.
 * Maps FEN (position part only, no counters) → array of UCI moves with weights.
 * Bot picks a random move weighted by frequency.
 */

interface BookEntry {
  uci: string;
  weight: number;
}

// FEN key: only piece placement + active color + castling + en passant (no halfmove/fullmove)
function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

// Opening book: common lines up to ~8 moves deep
// Weights approximate relative popularity
const BOOK = new Map<string, BookEntry[]>([
  // Starting position
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', [
    { uci: 'e2e4', weight: 40 },
    { uci: 'd2d4', weight: 35 },
    { uci: 'g1f3', weight: 15 },
    { uci: 'c2c4', weight: 10 },
  ]],
  // 1. e4
  ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -', [
    { uci: 'e7e5', weight: 30 },
    { uci: 'c7c5', weight: 30 },
    { uci: 'e7e6', weight: 15 },
    { uci: 'c7c6', weight: 10 },
    { uci: 'd7d5', weight: 10 },
    { uci: 'g7g6', weight: 5 },
  ]],
  // 1. d4
  ['rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -', [
    { uci: 'g8f6', weight: 40 },
    { uci: 'd7d5', weight: 35 },
    { uci: 'e7e6', weight: 10 },
    { uci: 'f7f5', weight: 5 },
  ]],
  // 1. e4 e5
  ['rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', [
    { uci: 'g1f3', weight: 60 },
    { uci: 'f1c4', weight: 15 },
    { uci: 'b1c3', weight: 10 },
    { uci: 'f2f4', weight: 10 },
  ]],
  // 1. e4 c5 (Sicilian)
  ['rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', [
    { uci: 'g1f3', weight: 55 },
    { uci: 'b1c3', weight: 20 },
    { uci: 'c2c3', weight: 15 },
    { uci: 'f1b5', weight: 10 },
  ]],
  // 1. e4 e6 (French)
  ['rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', [
    { uci: 'd2d4', weight: 70 },
    { uci: 'd2d3', weight: 15 },
    { uci: 'g1f3', weight: 15 },
  ]],
  // 1. e4 c6 (Caro-Kann)
  ['rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -', [
    { uci: 'd2d4', weight: 60 },
    { uci: 'b1c3', weight: 20 },
    { uci: 'g1f3', weight: 15 },
  ]],
  // 1. d4 Nf6
  ['rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -', [
    { uci: 'c2c4', weight: 50 },
    { uci: 'g1f3', weight: 25 },
    { uci: 'c1g5', weight: 10 },
    { uci: 'b1c3', weight: 10 },
  ]],
  // 1. d4 d5
  ['rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -', [
    { uci: 'c2c4', weight: 50 },
    { uci: 'g1f3', weight: 25 },
    { uci: 'c1f4', weight: 10 },
    { uci: 'b1c3', weight: 10 },
  ]],
  // 1. e4 e5 2. Nf3
  ['rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -', [
    { uci: 'b8c6', weight: 50 },
    { uci: 'g8f6', weight: 30 },
    { uci: 'd7d6', weight: 10 },
  ]],
  // 1. e4 e5 2. Nf3 Nc6
  ['r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -', [
    { uci: 'f1b5', weight: 35 },
    { uci: 'f1c4', weight: 30 },
    { uci: 'd2d4', weight: 20 },
    { uci: 'b1c3', weight: 10 },
  ]],
  // 1. e4 c5 2. Nf3
  ['rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -', [
    { uci: 'd7d6', weight: 35 },
    { uci: 'b8c6', weight: 30 },
    { uci: 'e7e6', weight: 25 },
  ]],
  // 1. d4 Nf6 2. c4
  ['rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq -', [
    { uci: 'e7e6', weight: 30 },
    { uci: 'g7g6', weight: 30 },
    { uci: 'c7c5', weight: 15 },
    { uci: 'e7e5', weight: 10 },
  ]],
  // 1. d4 d5 2. c4
  ['rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq -', [
    { uci: 'e7e6', weight: 35 },
    { uci: 'c7c6', weight: 30 },
    { uci: 'd5c4', weight: 15 },
    { uci: 'g8f6', weight: 15 },
  ]],
  // 1. Nf3
  ['rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -', [
    { uci: 'd7d5', weight: 35 },
    { uci: 'g8f6', weight: 35 },
    { uci: 'c7c5', weight: 15 },
  ]],
  // 1. c4 (English)
  ['rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq -', [
    { uci: 'e7e5', weight: 30 },
    { uci: 'g8f6', weight: 30 },
    { uci: 'c7c5', weight: 20 },
    { uci: 'e7e6', weight: 10 },
  ]],
]);

@Injectable()
export class OpeningBookService {
  /**
   * Look up a book move for the given FEN.
   * Returns UCI move string or null if position not in book.
   */
  getBookMove(fen: string): string | null {
    const key = fenKey(fen);
    const entries = BOOK.get(key);
    if (!entries || entries.length === 0) return null;

    // Weighted random selection
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry.uci;
    }
    return entries[0].uci;
  }
}
