import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { polyglotHash, readPolyglotBook, BookEntry } from './polyglot-reader';

/**
 * Opening book for bot games using Polyglot .bin format.
 * Loads book at startup, provides instant move lookup by FEN.
 *
 * KS-3059: загрузка асинхронная и fire-and-forget — на проде это
 * 4.6 МБ файл + парс 265k entries (~1-2с блокировки event loop).
 * До завершения загрузки `getBookMove` возвращает `null` (`book.size===0`),
 * и `BotMoveService` штатно фолбэчит на random legal move.
 */
@Injectable()
export class OpeningBookService implements OnModuleInit {
  private readonly logger = new Logger(OpeningBookService.name);
  private book = new Map<bigint, BookEntry[]>();

  onModuleInit(): void {
    // Не await: пусть startup проходит, книга догрузится в фоне.
    setImmediate(() => {
      this.loadBook().catch((err) => {
        this.logger.warn(`opening book async load failed: ${(err as Error).message}`);
      });
    });
  }

  private async loadBook(): Promise<void> {
    const paths = [
      join(process.cwd(), 'data', 'opening-book.bin'),           // Docker: /app/apps/api/data/
      join(__dirname, '..', '..', 'data', 'opening-book.bin'),   // dev: dist/engine/../../data/
      join(__dirname, '..', 'data', 'opening-book.bin'),         // alt: dist/engine/../data/
      join(process.cwd(), 'apps', 'api', 'data', 'opening-book.bin'), // monorepo root cwd
    ];

    for (const filePath of paths) {
      try {
        const buffer = await readFile(filePath);
        if (buffer.length % 16 !== 0) {
          this.logger.warn(`Invalid polyglot book at ${filePath}: size ${buffer.length} not multiple of 16`);
          continue;
        }
        this.book = readPolyglotBook(buffer);
        this.logger.log(`Opening book loaded async: ${this.book.size} positions from ${filePath}`);
        return;
      } catch {
        // try next path
      }
    }

    this.logger.warn(`Opening book not found. Tried: ${paths.join(', ')}`);
  }

  /**
   * Look up a book move for the given FEN.
   * Returns UCI move string or null if position not in book.
   */
  getBookMove(fen: string): string | null {
    if (this.book.size === 0) {
      this.logger.debug('Book empty — no book loaded');
      return null;
    }

    const hash = polyglotHash(fen);
    const entries = this.book.get(hash);
    if (!entries || entries.length === 0) {
      this.logger.debug(`Book MISS: ${fen.split(' ').slice(0, 2).join(' ')}`);
      return null;
    }

    // Weighted random selection
    const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll <= 0) {
        this.logger.log(`Book HIT: ${entry.uci} (${entries.length} choices, fen=${fen.split(' ').slice(0, 2).join(' ')})`);
        return entry.uci;
      }
    }
    this.logger.log(`Book HIT: ${entries[0].uci} (fallback)`);
    return entries[0].uci;
  }
}
