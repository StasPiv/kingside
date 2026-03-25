import { useReducer, useCallback, useMemo } from 'react';
import { Chess } from 'chess.js';
import { INITIAL_FEN } from '@kingside/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GameMove {
  san: string;
  fen: string;        // FEN after this move
  uci: string;        // e.g. "e2e4"
  from: string;
  to: string;
  ply: number;        // 1-based half-move number
  globalIndex: number;
  variations: GameMove[][];
  next: GameMove | null;
  previous: GameMove | null;
}

interface ChessGameState {
  history: GameMove[];       // main line
  currentMove: GameMove | null;
  currentMoveIndex: number;  // globalIndex of currentMove, or -1
  currentFen: string;
  maxGlobalIndex: number;
}

type Action =
  | { type: 'LOAD'; history: GameMove[]; maxGlobalIndex: number }
  | { type: 'GOTO'; move: GameMove | null }
  | { type: 'ADD_MOVE'; uci: string; san: string; fen: string; from: string; to: string }
  | { type: 'DELETE_VARIATION'; move: GameMove }
  | { type: 'DELETE_REMAINING'; move: GameMove }
  | { type: 'PROMOTE_VARIATION'; move: GameMove };

// ---------------------------------------------------------------------------
// Helpers: linked list management
// ---------------------------------------------------------------------------

function linkMoves(moves: GameMove[]): void {
  for (let i = 0; i < moves.length; i++) {
    moves[i].next = i < moves.length - 1 ? moves[i + 1] : null;
    moves[i].previous = i > 0 ? moves[i - 1] : null;
    for (const v of moves[i].variations) {
      linkMoves(v);
      if (v.length > 0) {
        v[0].previous = i > 0 ? moves[i - 1] : null;
      }
    }
  }
}

function searchMove(moves: GameMove[], idx: number): GameMove | null {
  for (const m of moves) {
    if (m.globalIndex === idx) return m;
    for (const v of m.variations) {
      const found = searchMove(v, idx);
      if (found) return found;
    }
  }
  return null;
}

function isInMainLine(history: GameMove[], idx: number): boolean {
  return history.some(m => m.globalIndex === idx);
}

// Deep-clone history without circular references, then re-link
function cloneHistory(moves: GameMove[]): GameMove[] {
  function cloneMove(m: GameMove): GameMove {
    return {
      san: m.san,
      fen: m.fen,
      uci: m.uci,
      from: m.from,
      to: m.to,
      ply: m.ply,
      globalIndex: m.globalIndex,
      variations: m.variations.map(v => v.map(cloneMove)),
      next: null,
      previous: null,
    };
  }
  const cloned = moves.map(cloneMove);
  linkMoves(cloned);
  return cloned;
}

function findContainer(moves: GameMove[], globalIndex: number): GameMove[] | null {
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].globalIndex === globalIndex) return moves;
    for (const v of moves[i].variations) {
      const found = findContainer(v, globalIndex);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build initial history from API move list
// ---------------------------------------------------------------------------

export function buildHistoryFromMoves(
  apiMoves: { san: string; uci: string; fenAfter: string }[],
): { history: GameMove[]; maxGlobalIndex: number } {
  const history: GameMove[] = apiMoves.map((m, i) => {
    const from = m.uci.slice(0, 2);
    const to = m.uci.slice(2, 4);
    return {
      san: m.san,
      fen: m.fenAfter,
      uci: m.uci,
      from,
      to,
      ply: i + 1,
      globalIndex: i,
      variations: [],
      next: null,
      previous: null,
    };
  });
  linkMoves(history);
  return { history, maxGlobalIndex: history.length - 1 };
}

// ---------------------------------------------------------------------------
// State mutations
// ---------------------------------------------------------------------------

function addMove(
  state: ChessGameState,
  uci: string,
  san: string,
  fen: string,
  from: string,
  to: string,
): ChessGameState {
  const { history, currentMove } = state;
  const newPly = currentMove ? currentMove.ply + 1 : 1;
  const newGlobalIndex = state.maxGlobalIndex + 1001;

  const newMove: GameMove = {
    san,
    fen,
    uci,
    from,
    to,
    ply: newPly,
    globalIndex: newGlobalIndex,
    variations: [],
    next: null,
    previous: null,
  };

  // No next move — append to current line
  if (!currentMove?.next) {
    const cloned = cloneHistory(history);
    if (!currentMove) {
      cloned.unshift(newMove);
      linkMoves(cloned);
    } else {
      const container = findContainer(cloned, currentMove.globalIndex);
      if (container) {
        const idx = container.findIndex(m => m.globalIndex === currentMove.globalIndex);
        container.splice(idx + 1, 0, newMove);
        linkMoves(cloned);
      }
    }
    const found = searchMove(cloned, newGlobalIndex);
    return {
      history: cloned,
      currentMove: found,
      currentMoveIndex: newGlobalIndex,
      currentFen: fen,
      maxGlobalIndex: newGlobalIndex,
    };
  }

  // Next move exists — add as variation on the next move node
  const cloned = cloneHistory(history);
  const nextNode = searchMove(cloned, currentMove.next.globalIndex);
  if (nextNode) {
    nextNode.variations.push([newMove]);
    linkMoves(cloned);
  }
  const found = searchMove(cloned, newGlobalIndex);
  return {
    history: cloned,
    currentMove: found ?? state.currentMove,
    currentMoveIndex: found ? newGlobalIndex : state.currentMoveIndex,
    currentFen: found ? fen : state.currentFen,
    maxGlobalIndex: newGlobalIndex,
  };
}

function deleteVariationFromState(
  state: ChessGameState,
  move: GameMove,
): ChessGameState {
  const { history } = state;
  if (isInMainLine(history, move.globalIndex)) return state;

  function removeFromMoves(moves: GameMove[]): GameMove[] {
    return moves.map(m => {
      const filtered = m.variations
        .map(v => (v.some(vm => vm.globalIndex === move.globalIndex) ? null : removeFromMoves(v)))
        .filter((v): v is GameMove[] => v !== null);
      return { ...m, variations: filtered };
    });
  }

  const cloned = cloneHistory(removeFromMoves(history));
  const parentMove = move.previous
    ? searchMove(cloned, move.previous.globalIndex) ?? null
    : null;

  return {
    history: cloned,
    currentMove: parentMove,
    currentMoveIndex: parentMove?.globalIndex ?? -1,
    currentFen: parentMove?.fen ?? INITIAL_FEN,
    maxGlobalIndex: state.maxGlobalIndex,
  };
}

function deleteRemainingFromState(
  state: ChessGameState,
  move: GameMove,
): ChessGameState {
  function truncate(moves: GameMove[], targetIdx: number): GameMove[] {
    const result: GameMove[] = [];
    for (const m of moves) {
      if (m.globalIndex === targetIdx) {
        result.push({ ...m, variations: m.variations.map(v => truncate(v, -1)) });
        break;
      }
      result.push({
        ...m,
        variations: m.variations.map(v => {
          if (v.some(vm => vm.globalIndex === targetIdx)) {
            return truncate(v, targetIdx);
          }
          return v;
        }),
      });
    }
    return result;
  }

  const truncated = truncate(state.history, move.globalIndex);
  const cloned = cloneHistory(truncated);
  const found = searchMove(cloned, move.globalIndex);
  return {
    history: cloned,
    currentMove: found ?? state.currentMove,
    currentMoveIndex: found?.globalIndex ?? state.currentMoveIndex,
    currentFen: move.fen,
    maxGlobalIndex: state.maxGlobalIndex,
  };
}

function promoteVariationInState(
  state: ChessGameState,
  move: GameMove,
): ChessGameState {
  if (isInMainLine(state.history, move.globalIndex)) return state;

  function promoteInMoves(moves: GameMove[]): { result: GameMove[]; done: boolean } {
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      for (let varIdx = 0; varIdx < m.variations.length; varIdx++) {
        const variation = m.variations[varIdx];
        if (variation.some(vm => vm.globalIndex === move.globalIndex)) {
          const mainContinuation = moves.slice(i + 1);
          const remainingVariations = m.variations.filter((_, idx) => idx !== varIdx);
          const newM: GameMove = {
            ...m,
            variations: mainContinuation.length > 0
              ? [...remainingVariations, mainContinuation]
              : remainingVariations,
          };
          const newMoves = [...moves.slice(0, i), newM, ...variation];
          return { result: newMoves, done: true };
        }
      }
      // Recurse into variations
      const newVariations: GameMove[][] = [];
      let done = false;
      for (const v of m.variations) {
        if (!done) {
          const res = promoteInMoves(v);
          newVariations.push(res.result as GameMove[]);
          done = res.done;
        } else {
          newVariations.push(v);
        }
      }
      if (done) {
        const newMoves = [...moves];
        newMoves[i] = { ...m, variations: newVariations };
        return { result: newMoves, done: true };
      }
    }
    return { result: moves, done: false };
  }

  const { result } = promoteInMoves(state.history);
  const cloned = cloneHistory(result);
  const found = searchMove(cloned, move.globalIndex);
  return {
    history: cloned,
    currentMove: found ?? state.currentMove,
    currentMoveIndex: found?.globalIndex ?? state.currentMoveIndex,
    currentFen: move.fen,
    maxGlobalIndex: state.maxGlobalIndex,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const initialState: ChessGameState = {
  history: [],
  currentMove: null,
  currentMoveIndex: -1,
  currentFen: INITIAL_FEN,
  maxGlobalIndex: -1,
};

function reducer(state: ChessGameState, action: Action): ChessGameState {
  switch (action.type) {
    case 'LOAD': {
      const lastMove = action.history.length > 0
        ? action.history[action.history.length - 1]
        : null;
      return {
        history: action.history,
        currentMove: lastMove,
        currentMoveIndex: lastMove?.globalIndex ?? -1,
        currentFen: lastMove?.fen ?? INITIAL_FEN,
        maxGlobalIndex: action.maxGlobalIndex,
      };
    }
    case 'GOTO':
      return {
        ...state,
        currentMove: action.move,
        currentMoveIndex: action.move?.globalIndex ?? -1,
        currentFen: action.move?.fen ?? INITIAL_FEN,
      };
    case 'ADD_MOVE':
      return addMove(state, action.uci, action.san, action.fen, action.from, action.to);
    case 'DELETE_VARIATION':
      return deleteVariationFromState(state, action.move);
    case 'DELETE_REMAINING':
      return deleteRemainingFromState(state, action.move);
    case 'PROMOTE_VARIATION':
      return promoteVariationInState(state, action.move);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChessGame() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const loadHistory = useCallback(
    (apiMoves: { san: string; uci: string; fenAfter: string }[]) => {
      const { history, maxGlobalIndex } = buildHistoryFromMoves(apiMoves);
      dispatch({ type: 'LOAD', history, maxGlobalIndex });
    },
    [],
  );

  const gotoMove = useCallback((move: GameMove | null) => {
    dispatch({ type: 'GOTO', move });
  }, []);

  const gotoFirst = useCallback(() => {
    dispatch({ type: 'GOTO', move: null });
  }, []);

  const gotoLast = useCallback(() => {
    const last = state.history.length > 0
      ? state.history[state.history.length - 1]
      : null;
    dispatch({ type: 'GOTO', move: last });
  }, [state.history]);

  const gotoPrevious = useCallback(() => {
    const prev = state.currentMove?.previous ?? null;
    dispatch({ type: 'GOTO', move: prev });
  }, [state.currentMove]);

  const gotoNext = useCallback(() => {
    if (!state.currentMove) {
      const first = state.history.length > 0 ? state.history[0] : null;
      dispatch({ type: 'GOTO', move: first });
      return;
    }
    const next = state.currentMove.next ?? null;
    if (next) dispatch({ type: 'GOTO', move: next });
  }, [state.currentMove, state.history]);

  const makeMove = useCallback(
    (sourceSquare: string, targetSquare: string, promotion?: string): boolean => {
      const chess = new Chess(state.currentFen);
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion });
      if (!move) return false;
      const uci = move.from + move.to + (move.promotion ?? '');
      dispatch({
        type: 'ADD_MOVE',
        uci,
        san: move.san,
        fen: chess.fen(),
        from: move.from,
        to: move.to,
      });
      return true;
    },
    [state.currentFen],
  );

  const removeVariation = useCallback((move: GameMove) => {
    dispatch({ type: 'DELETE_VARIATION', move });
  }, []);

  const truncateRemaining = useCallback((move: GameMove) => {
    dispatch({ type: 'DELETE_REMAINING', move });
  }, []);

  const promoteVariation = useCallback((move: GameMove) => {
    dispatch({ type: 'PROMOTE_VARIATION', move });
  }, []);

  const currentIsInMainLine = useMemo(
    () => state.currentMove
      ? isInMainLine(state.history, state.currentMove.globalIndex)
      : true,
    [state.currentMove, state.history],
  );

  return {
    history: state.history,
    currentMove: state.currentMove,
    currentMoveIndex: state.currentMoveIndex,
    fen: state.currentFen,
    currentFen: state.currentFen,
    currentIsInMainLine,
    // canonical names
    loadHistory,
    gotoMove,
    gotoFirst,
    gotoLast,
    gotoPrevious,
    gotoNext,
    makeMove,
    removeVariation,
    truncateRemaining,
    // aliases used by AnalysisPage
    load: loadHistory,
    goToMove: gotoMove,
    goToStart: gotoFirst,
    goToEnd: gotoLast,
    goBack: gotoPrevious,
    goForward: gotoNext,
    tryAddMove: (arg: string | { from: string; to: string; promotion?: string }) => {
      if (typeof arg === 'string') {
        return makeMove(arg.slice(0, 2), arg.slice(2, 4), arg.length > 4 ? arg[4] : undefined);
      }
      return makeMove(arg.from, arg.to, arg.promotion);
    },
    deleteVariation: removeVariation,
    deleteRemaining: truncateRemaining,
    promoteVariation,
  };
}
