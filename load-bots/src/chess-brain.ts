import { Chess } from 'chess.js';

export type Strategy = 'random' | 'smart';

/**
 * Generates chess moves for load bot games.
 * - random: picks any legal move
 * - smart: captures > checks > center pawns > random
 */
export class ChessBrain {
  private chess: Chess;

  constructor(private strategy: Strategy = 'smart') {
    this.chess = new Chess();
  }

  loadFen(fen: string): void {
    try {
      this.chess.load(fen);
    } catch {
      // Reset to starting position on invalid FEN
      this.chess = new Chess();
    }
  }

  applyUci(uci: string): void {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci[4] as 'q' | 'r' | 'b' | 'n' | undefined;
    this.chess.move({ from, to, promotion });
  }

  /**
   * Pick a move using the configured strategy. Returns UCI string.
   * Returns null if no legal moves (game over).
   */
  pickMove(): string | null {
    const moves = this.chess.moves({ verbose: true });
    if (moves.length === 0) return null;

    let chosen;
    if (this.strategy === 'random') {
      chosen = moves[Math.floor(Math.random() * moves.length)];
    } else {
      // Smart: prioritize captures > checks > center pawns > random
      const captures = moves.filter((m) => m.captured);
      const checks = moves.filter((m) => m.san.includes('+'));
      const centerPawns = moves.filter(
        (m) => m.piece === 'p' && ['d4', 'd5', 'e4', 'e5'].includes(m.to),
      );

      if (captures.length > 0 && Math.random() < 0.7) {
        chosen = captures[Math.floor(Math.random() * captures.length)];
      } else if (checks.length > 0 && Math.random() < 0.5) {
        chosen = checks[Math.floor(Math.random() * checks.length)];
      } else if (centerPawns.length > 0 && Math.random() < 0.3) {
        chosen = centerPawns[Math.floor(Math.random() * centerPawns.length)];
      } else {
        chosen = moves[Math.floor(Math.random() * moves.length)];
      }
    }

    return chosen.from + chosen.to + (chosen.promotion || '');
  }

  isGameOver(): boolean {
    return this.chess.isGameOver();
  }

  fen(): string {
    return this.chess.fen();
  }

  turn(): 'w' | 'b' {
    return this.chess.turn();
  }
}
