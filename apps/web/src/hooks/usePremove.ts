import { useState, useRef, useCallback } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type React from 'react';

const PREMOVE_FROM_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(255, 128, 0, 0.65)',
};
const PREMOVE_TO_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(255, 128, 0, 0.4)',
};

export interface Premove {
  from: Square;
  to: Square;
}

export interface UsePremoveReturn {
  premove: Premove | null;
  setPremove: (from: Square, to: Square) => void;
  clearPremove: () => void;
  tryExecutePremove: (game: Chess) => Premove | null;
  premoveSquareStyles: Record<string, React.CSSProperties>;
}

/**
 * Manages premove state for a chess game.
 *
 * A premove is a move queued by the player while waiting for the
 * opponent's turn. It executes automatically (if legal) when the
 * opponent's move arrives, or is silently discarded if illegal.
 */
export function usePremove(): UsePremoveReturn {
  const [premove, setPremoveState] = useState<Premove | null>(null);
  // Ref keeps the latest premove accessible inside stable callbacks
  // registered once in useEffect without re-subscribing on every change.
  const premoveRef = useRef<Premove | null>(null);

  const setPremove = useCallback((from: Square, to: Square) => {
    const next: Premove = { from, to };
    premoveRef.current = next;
    setPremoveState(next);
  }, []);

  const clearPremove = useCallback(() => {
    premoveRef.current = null;
    setPremoveState(null);
  }, []);

  /**
   * Attempts to execute the stored premove against the given game state.
   * Always clears the premove regardless of legality.
   * Returns the premove if legal, null otherwise.
   */
  const tryExecutePremove = useCallback((game: Chess): Premove | null => {
    const current = premoveRef.current;
    if (!current) return null;

    // Clear immediately — premove fires at most once
    premoveRef.current = null;
    setPremoveState(null);

    // Validate move legality in a temporary game instance
    const testGame = new Chess(game.fen());
    try {
      const result = testGame.move({
        from: current.from,
        to: current.to,
        promotion: 'q', // default auto-promote to queen
      });
      if (!result) return null;
    } catch {
      return null;
    }

    return current;
  }, []);

  const premoveSquareStyles: Record<string, React.CSSProperties> = premove
    ? {
        [premove.from]: PREMOVE_FROM_STYLE,
        [premove.to]: PREMOVE_TO_STYLE,
      }
    : {};

  return {
    premove,
    setPremove,
    clearPremove,
    tryExecutePremove,
    premoveSquareStyles,
  };
}
