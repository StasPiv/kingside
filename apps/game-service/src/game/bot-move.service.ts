import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Chess } from 'chess.js';
import { polyglotHash, readPolyglotBook, type BookEntry } from '../engine/polyglot-reader';

/**
 * Server-side fallback for bot moves.
 * Uses polyglot opening book for known positions,
 * falls back to random legal move.
 *
 * This is NOT a full server-side bot — it's a fallback for the client-side
 * bot engine (Stockfish WASM) when it hasn't initialized in time.
 */
@Injectable()
export class BotMoveService implements OnModuleInit {
  private readonly logger = new Logger(BotMoveService.name);
  private book: Map<bigint, BookEntry[]> | null = null;

  onModuleInit() {
    try {
      const bookPath = join(__dirname, '..', '..', 'data', 'opening-book.bin');
      const buffer = readFileSync(bookPath);
      this.book = readPolyglotBook(buffer);
      this.logger.log(`Opening book loaded: ${this.book.size} positions`);
    } catch (e: unknown) {
      this.logger.warn(`Opening book not found, will use random moves: ${(e as Error).message}`);
    }
  }

  /**
   * Pick a move for the given FEN position.
   * Tries opening book first, falls back to random legal move.
   */
  pickMove(fen: string): string | null {
    // Try opening book
    if (this.book) {
      const hash = polyglotHash(fen);
      const entries = this.book.get(hash);
      if (entries && entries.length > 0) {
        const uci = this.weightedPick(entries);
        this.logger.log(`Book move for ${fen.slice(0, 20)}: ${uci}`);
        return uci;
      }
    }

    // Fallback: random legal move
    try {
      const chess = new Chess(fen);
      const moves = chess.moves({ verbose: true });
      if (moves.length === 0) return null;
      const move = moves[Math.floor(Math.random() * moves.length)];
      const uci = move.from + move.to + (move.promotion || '');
      this.logger.log(`Random move for ${fen.slice(0, 20)}: ${uci}`);
      return uci;
    } catch {
      return null;
    }
  }

  private weightedPick(entries: BookEntry[]): string {
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    if (totalWeight === 0) return entries[0].uci;

    let r = Math.random() * totalWeight;
    for (const entry of entries) {
      r -= entry.weight;
      if (r <= 0) return entry.uci;
    }
    return entries[entries.length - 1].uci;
  }
}
