import { useReducer, useCallback } from 'react';
import { Chess } from 'chess.js';
import { ChessMove } from './types';
import { addMoveToHistory } from './utils/AddMoveToHistory';
import { addVariationToHistory } from './utils/AddVariationToHistory';
import { linkAllMovesRecursively, searchInHistory } from './utils/ChessHistoryUtils';
import { promoteVariationLink } from './utils/PromoteVariationLink';
import { deleteVariation as deleteVariationUtil } from './utils/DeleteVariation';
import { deleteRemaining as deleteRemainingUtil } from './utils/DeleteRemaining';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type ApiMove = {
  san: string;
  uci: string;
  fenAfter: string;
};

type ReviewState = {
  history: ChessMove[];
  currentMove: ChessMove | null;
  nextGlobalIndex: number;
  initialFen: string;
};

type ReviewAction =
  | { type: 'LOAD_MOVES'; payload: ApiMove[] }
  | { type: 'LOAD_FROM_PGN'; payload: ChessMove[] }
  | { type: 'SET_INITIAL_FEN'; payload: string }
  | { type: 'GOTO_MOVE'; payload: ChessMove }
  | { type: 'GOTO_FIRST' }
  | { type: 'GOTO_PREVIOUS' }
  | { type: 'GOTO_NEXT' }
  | { type: 'GOTO_LAST' }
  | { type: 'ADD_MOVE'; payload: ChessMove }
  | { type: 'ADD_VARIATION'; payload: ChessMove }
  | { type: 'PROMOTE_VARIATION'; payload: ChessMove }
  | { type: 'DELETE_VARIATION'; payload: ChessMove }
  | { type: 'DELETE_REMAINING'; payload: ChessMove };

function apiMovesToHistory(apiMoves: ApiMove[]): ChessMove[] {
  const history: ChessMove[] = apiMoves.map((m, i) => {
    const uci = m.uci;
    return {
      san: m.san,
      fen: m.fenAfter,
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
      piece: '',
      flags: '',
      lan: uci,
      before: i > 0 ? apiMoves[i - 1].fenAfter : INITIAL_FEN,
      after: m.fenAfter,
      globalIndex: i,
      ply: i + 1,
    };
  });
  linkAllMovesRecursively(history);
  return history;
}

function followNextToEnd(move: ChessMove | null): ChessMove | null {
  let curr = move;
  while (curr?.next) {
    curr = curr.next;
  }
  return curr;
}

function maxGlobalIndexInHistory(moves: ChessMove[]): number {
  let max = -1;
  for (const move of moves) {
    if (move.globalIndex > max) max = move.globalIndex;
    if (move.variations) {
      for (const variation of move.variations) {
        const varMax = maxGlobalIndexInHistory(variation);
        if (varMax > max) max = varMax;
      }
    }
  }
  return max;
}

function reducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'LOAD_MOVES': {
      const history = apiMovesToHistory(action.payload);
      const lastMove = history.length > 0 ? history[history.length - 1] : null;
      return {
        history,
        currentMove: lastMove,
        nextGlobalIndex: history.length,
        initialFen: INITIAL_FEN,
      };
    }
    case 'LOAD_FROM_PGN': {
      const history = action.payload;
      const lastMove = history.length > 0 ? history[history.length - 1] : null;
      const maxIdx = maxGlobalIndexInHistory(history);
      return {
        history,
        currentMove: lastMove,
        nextGlobalIndex: maxIdx + 1,
        initialFen: state.initialFen,
      };
    }
    case 'SET_INITIAL_FEN': {
      return {
        history: [],
        currentMove: null,
        nextGlobalIndex: 0,
        initialFen: action.payload,
      };
    }
    case 'GOTO_MOVE': {
      return { ...state, currentMove: action.payload };
    }
    case 'GOTO_FIRST': {
      return { ...state, currentMove: null };
    }
    case 'GOTO_PREVIOUS': {
      const prev = state.currentMove?.previous ?? null;
      return { ...state, currentMove: prev };
    }
    case 'GOTO_NEXT': {
      if (state.currentMove === null) {
        const first = state.history[0] ?? null;
        return { ...state, currentMove: first };
      }
      if (!state.currentMove.next) {
        return state; // Already at the end — do nothing
      }
      return { ...state, currentMove: state.currentMove.next };
    }
    case 'GOTO_LAST': {
      let curr: ChessMove | null = state.currentMove;
      if (curr === null && state.history.length > 0) {
        curr = state.history[0];
      }
      return { ...state, currentMove: followNextToEnd(curr) };
    }
    case 'ADD_MOVE': {
      const { updatedCurrentMove, updatedHistory } = addMoveToHistory(
        action.payload,
        state.currentMove,
        state.history,
      );
      return {
        ...state,
        history: updatedHistory,
        currentMove: updatedCurrentMove,
        nextGlobalIndex: state.nextGlobalIndex + 1,
      };
    }
    case 'ADD_VARIATION': {
      if (!state.currentMove) return state;
      const { updatedHistory } = addVariationToHistory(
        action.payload,
        state.currentMove,
        state.history,
      );
      return {
        ...state,
        history: updatedHistory,
        currentMove: action.payload,
        nextGlobalIndex: state.nextGlobalIndex + 1,
      };
    }
    case 'PROMOTE_VARIATION': {
      const updatedHistory = promoteVariationLink(action.payload, state.history, true);
      // Find the same move in the updated history
      const found = searchInHistory(updatedHistory as ChessMove[], action.payload.globalIndex) as ChessMove | null;
      return {
        ...state,
        history: updatedHistory as ChessMove[],
        currentMove: found ?? state.currentMove,
      };
    }
    case 'DELETE_VARIATION': {
      const result = deleteVariationUtil(action.payload, state.history, true);
      const newCurrentMove = result.newCurrentMove as ChessMove | null;
      return {
        ...state,
        history: result.updatedHistory as ChessMove[],
        currentMove: newCurrentMove,
      };
    }
    case 'DELETE_REMAINING': {
      const updatedHistory = deleteRemainingUtil(action.payload, state.history);
      const found = searchInHistory(updatedHistory as ChessMove[], action.payload.globalIndex) as ChessMove | null;
      return {
        ...state,
        history: updatedHistory as ChessMove[],
        currentMove: found ?? state.currentMove,
      };
    }
    default:
      return state;
  }
}

export function useReviewState() {
  const [state, dispatch] = useReducer(reducer, {
    history: [],
    currentMove: null,
    nextGlobalIndex: 0,
    initialFen: INITIAL_FEN,
  });

  const loadMoves = useCallback((apiMoves: ApiMove[]) => {
    dispatch({ type: 'LOAD_MOVES', payload: apiMoves });
  }, []);

  const loadFromPgn = useCallback((moves: ChessMove[]) => {
    dispatch({ type: 'LOAD_FROM_PGN', payload: moves });
  }, []);

  const setInitialFen = useCallback((fen: string) => {
    dispatch({ type: 'SET_INITIAL_FEN', payload: fen });
  }, []);

  const gotoMove = useCallback((move: ChessMove) => {
    dispatch({ type: 'GOTO_MOVE', payload: move });
  }, []);

  const gotoFirst = useCallback(() => dispatch({ type: 'GOTO_FIRST' }), []);
  const gotoPrevious = useCallback(() => dispatch({ type: 'GOTO_PREVIOUS' }), []);
  const gotoNext = useCallback(() => dispatch({ type: 'GOTO_NEXT' }), []);
  const gotoLast = useCallback(() => dispatch({ type: 'GOTO_LAST' }), []);

  const makeVariantMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      const fen = state.currentMove?.fen ?? state.initialFen;
      try {
        const chess = new Chess(fen);
        const move = chess.move({
          from,
          to,
          promotion: (promotion as 'q' | 'r' | 'b' | 'n') ?? undefined,
        });
        if (!move) return false;
        const newFen = chess.fen();
        const ply = (state.currentMove?.ply ?? 0) + 1;
        const globalIndex = state.nextGlobalIndex;
        const newMove: ChessMove = {
          san: move.san,
          fen: newFen,
          from: move.from,
          to: move.to,
          promotion: move.promotion,
          piece: move.piece,
          captured: move.captured,
          flags: move.flags,
          lan: move.from + move.to + (move.promotion ?? ''),
          before: fen,
          after: newFen,
          globalIndex,
          ply,
        };
        if (state.currentMove?.next) {
          dispatch({ type: 'ADD_VARIATION', payload: newMove });
        } else {
          dispatch({ type: 'ADD_MOVE', payload: newMove });
        }
        return true;
      } catch {
        return false;
      }
    },
    [state.currentMove, state.nextGlobalIndex],
  );

  const promoteVariation = useCallback((move: ChessMove) => {
    dispatch({ type: 'PROMOTE_VARIATION', payload: move });
  }, []);

  const removeVariation = useCallback((move: ChessMove) => {
    dispatch({ type: 'DELETE_VARIATION', payload: move });
  }, []);

  const truncateRemaining = useCallback((move: ChessMove) => {
    dispatch({ type: 'DELETE_REMAINING', payload: move });
  }, []);

  const currentFen = state.currentMove?.fen ?? state.initialFen;
  const currentGlobalIndex = state.currentMove?.globalIndex ?? -1;

  // Check if current move is in a variation (not in the top-level main-line history)
  const isInVariation = state.currentMove !== null
    && !state.history.some(m => m.globalIndex === state.currentMove!.globalIndex);

  return {
    history: state.history,
    currentMove: state.currentMove,
    currentGlobalIndex,
    currentFen,
    isInVariation,
    loadMoves,
    loadFromPgn,
    setInitialFen,
    gotoMove,
    gotoFirst,
    gotoPrevious,
    gotoNext,
    gotoLast,
    makeVariantMove,
    promoteVariation,
    removeVariation,
    truncateRemaining,
  };
}
