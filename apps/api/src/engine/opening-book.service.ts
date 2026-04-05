import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

interface BookEntry {
  uci: string;
  weight: number;
}

/**
 * Opening book for bot games.
 * Loads positions from a JSON file generated from master-level games.
 * 222 positions, ~31 opening lines, depth ~8 plies.
 */
@Injectable()
export class OpeningBookService implements OnModuleInit {
  private readonly logger = new Logger(OpeningBookService.name);
  private readonly book = new Map<string, BookEntry[]>();

  onModuleInit(): void {
    this.loadBook();
  }

  private loadBook(): void {
    try {
      const filePath = join(__dirname, 'opening-book.json');
      const raw = readFileSync(filePath, 'utf-8');
      const data: Record<string, BookEntry[]> = JSON.parse(raw);

      for (const [fen, entries] of Object.entries(data)) {
        this.book.set(fen, entries);
      }

      this.logger.log(`Opening book loaded: ${this.book.size} positions`);
    } catch (e: any) {
      this.logger.warn(`Opening book not loaded: ${e.message}`);
    }
  }

  /**
   * Look up a book move for the given FEN.
   * Returns UCI move string or null if position not in book.
   */
  getBookMove(fen: string): string | null {
    const key = fen.split(' ').slice(0, 4).join(' ');
    const entries = this.book.get(key);
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
