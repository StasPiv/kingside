import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { polyglotHash, readPolyglotBook, BookEntry } from './polyglot-reader';

/**
 * Opening book for bot games using Polyglot .bin format.
 * Loads book at startup, provides instant move lookup by FEN.
 */
@Injectable()
export class OpeningBookService implements OnModuleInit {
  private readonly logger = new Logger(OpeningBookService.name);
  private book = new Map<bigint, BookEntry[]>();

  onModuleInit(): void {
    this.loadBook();
  }

  private loadBook(): void {
    // Try multiple paths: data/ dir (production), or relative to source
    const paths = [
      join(process.cwd(), 'data', 'opening-book.bin'),
      join(__dirname, '..', '..', 'data', 'opening-book.bin'),
      join(__dirname, 'opening-book.bin'),
    ];

    for (const filePath of paths) {
      try {
        const buffer = readFileSync(filePath);
        if (buffer.length % 16 !== 0) {
          this.logger.warn(`Invalid polyglot book at ${filePath}: size ${buffer.length} not multiple of 16`);
          continue;
        }
        this.book = readPolyglotBook(buffer);
        this.logger.log(`Polyglot opening book loaded: ${this.book.size} positions from ${filePath}`);
        return;
      } catch {
        // try next path
      }
    }

    this.logger.warn('No opening book found — bot will use Stockfish for all moves');
  }

  /**
   * Look up a book move for the given FEN.
   * Returns UCI move string or null if position not in book.
   */
  getBookMove(fen: string): string | null {
    if (this.book.size === 0) return null;

    const hash = polyglotHash(fen);
    const entries = this.book.get(hash);
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
