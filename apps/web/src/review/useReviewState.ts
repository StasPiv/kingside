import { useReducer, useCallback } from 'react';
import { Chess } from 'chess.js';
import { ChessMove, NodeAnnotations, VariationColor } from './types';
import { addMoveToHistory } from './utils/AddMoveToHistory';
import { addVariationToHistory } from './utils/AddVariationToHistory';
import {
  findVariationRoot,
  linkAllMovesRecursively,
  safeClone,
  searchInHistory,
} from './utils/ChessHistoryUtils';
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
  /**
   * KS-2152: аннотации для стартовой позиции (currentMove === null).
   * Хранятся отдельно, потому что у нулевой позиции нет узла дерева,
   * к которому можно было бы прикрепить annotations.
   */
  initialAnnotations?: NodeAnnotations;
  /**
   * KS-2152: аннотации для каждого узла дерева, привязанные по globalIndex.
   * ВАЖНО: храним в отдельной мапе, а не на самом ChessMove, чтобы reducer
   * был полностью immutable. Мутация move.annotations внутри reducer
   * ломалась в React.StrictMode — второй reducer-call видел уже
   * мутированное значение, считал sameAsBefore=true и возвращал старый
   * state, из-за чего React не вызывал re-render и выделение проявлялось
   * только после перезагрузки страницы.
   */
  annotationsByIndex: Record<number, NodeAnnotations>;
};

type ReviewAction =
  | { type: 'LOAD_MOVES'; payload: ApiMove[] }
  | { type: 'LOAD_FROM_PGN'; payload: { moves: ChessMove[]; initialAnnotations?: NodeAnnotations } }
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
  | { type: 'DELETE_REMAINING'; payload: ChessMove }
  | { type: 'SET_NAG'; payload: { globalIndex: number; nags: number[] } }
  | { type: 'SET_COMMENT'; payload: { globalIndex: number; comment: string } }
  | {
      /**
       * KS-2287 (ADR-038 §6, VC E1) — установить / снять
       * пользовательский цвет варианта.
       *  - `moveIndex` — globalIndex любого хода ВНУТРИ вариации
       *    (не обязательно head'а). Reducer находит variation-root
       *    через `findVariationRoot`.
       *  - `color: VariationColor` — поставить (зеленый/синий/...).
       *  - `color: null` — снять (clear).
       *  - move на main-line → no-op (variation-color применим только
       *    к веткам).
       */
      type: 'SET_VARIATION_COLOR';
      payload: { moveIndex: number; color: VariationColor | null };
    }
  | {
      type: 'SET_ANNOTATIONS';
      payload:
        | { kind: 'move'; globalIndex: number; annotations: NodeAnnotations | undefined }
        | { kind: 'initial'; annotations: NodeAnnotations | undefined };
    };

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
        annotationsByIndex: {},
      };
    }
    case 'LOAD_FROM_PGN': {
      const history = action.payload.moves;
      const lastMove = history.length > 0 ? history[history.length - 1] : null;
      const maxIdx = maxGlobalIndexInHistory(history);
      // KS-2152: собираем annotationsByIndex из move.annotations,
      // которые уже распарсились deserializer'ом. Сами move'ы оставляем
      // нетронутыми — annotations живут только в state map.
      const annotationsByIndex: Record<number, NodeAnnotations> = {};
      const collect = (moves: ChessMove[]) => {
        for (const m of moves) {
          if (m.annotations) annotationsByIndex[m.globalIndex] = m.annotations;
          if (m.variations) {
            for (const v of m.variations) collect(v);
          }
        }
      };
      collect(history);
      return {
        history,
        currentMove: lastMove,
        nextGlobalIndex: maxIdx + 1,
        initialFen: state.initialFen,
        initialAnnotations: action.payload.initialAnnotations,
        annotationsByIndex,
      };
    }
    case 'SET_INITIAL_FEN': {
      return {
        history: [],
        currentMove: null,
        nextGlobalIndex: 0,
        initialFen: action.payload,
        annotationsByIndex: {},
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
      // KS-3039: на root (currentMove === null) variation добавляется к
      // history[0] — это альтернативный first-move основной линии.
      // Раньше ранний return съедал диспатч, а makeVariantMove из-за этого
      // фолбэкал в ADD_MOVE и addMoveToHistory затирал всю историю.
      // Синтезируем «виртуальный branch-point» c .next=history[0] и
      // переиспользуем общую утилиту — никаких других мест трогать не надо.
      const branchPoint = state.currentMove
        ?? (state.history.length > 0
          ? ({ next: state.history[0] } as unknown as ChessMove)
          : null);
      if (!branchPoint) return state;
      const { updatedHistory } = addVariationToHistory(
        action.payload,
        branchPoint,
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
      const updatedHistory = deleteRemainingUtil(action.payload, state.history) as ChessMove[];
      const found = searchInHistory(updatedHistory, action.payload.globalIndex) as ChessMove | null;
      if (found) {
        return { ...state, history: updatedHistory, currentMove: found };
      }
      // KS-4960: целевой ход удалён целиком (был последним в главной линии) →
      // встаём на предшественника, а если ходов не осталось — в стартовую позицию.
      const idx = state.history.findIndex(m => m.globalIndex === action.payload.globalIndex);
      const prev = idx > 0
        ? (searchInHistory(updatedHistory, state.history[idx - 1].globalIndex) as ChessMove | null)
        : null;
      return { ...state, history: updatedHistory, currentMove: prev };
    }
    case 'SET_NAG': {
      const move = searchInHistory(state.history, action.payload.globalIndex) as ChessMove | null;
      if (!move) return state;
      const nags = action.payload.nags.length > 0 ? action.payload.nags : undefined;
      move.nags = nags;
      return {
        ...state,
        history: [...state.history],
      };
    }
    case 'SET_COMMENT': {
      const move = searchInHistory(state.history, action.payload.globalIndex) as ChessMove | null;
      if (!move) return state;
      move.comment = action.payload.comment || undefined;
      return {
        ...state,
        history: [...state.history],
      };
    }
    case 'SET_VARIATION_COLOR': {
      // KS-2287: ставим/снимаем variationColor на ROOT'е вариации.
      // Если moveIndex указывает на main-line — no-op.
      //
      // KS-2294: убраны no-op-guard'ы (`if (already same) return state`).
      // В React StrictMode reducer вызывается дважды; второй вызов
      // видит УЖЕ мутированный объект (мы пишем in-place в `root`),
      // возвращает старый state ref → React не делает re-render → PGN
      // не пересчитывается → e2e видит old PGN. Та же ловушка, что в
      // KS-2152 (см. комментарий в SET_ANNOTATIONS). Безопаснее всегда
      // возвращать новый state ref — лишний equal re-render дешевле,
      // чем потерянный ход обновления.
      const move = searchInHistory(
        state.history,
        action.payload.moveIndex,
      ) as ChessMove | null;
      if (!move) return state;
      const root = findVariationRoot(state.history, move) as
        | ChessMove
        | null;
      if (!root) return state; // main-line — variationColor неприменим
      if (action.payload.color === null) {
        delete root.variationColor;
      } else {
        root.variationColor = action.payload.color;
      }
      return {
        ...state,
        history: [...state.history],
      };
    }
    case 'SET_ANNOTATIONS': {
      // KS-2152: полностью immutable update — пишем только в
      // annotationsByIndex (или initialAnnotations). Мутация move
      // запрещена, иначе reducer ломается в React.StrictMode.
      if (action.payload.kind === 'initial') {
        const newAnn = action.payload.annotations;
        const sameAsBefore =
          JSON.stringify(state.initialAnnotations ?? null) === JSON.stringify(newAnn ?? null);
        if (sameAsBefore) return state;
        return { ...state, initialAnnotations: newAnn };
      }
      const idx = action.payload.globalIndex;
      const prev = state.annotationsByIndex[idx];
      const next = action.payload.annotations;
      const sameAsBefore = JSON.stringify(prev ?? null) === JSON.stringify(next ?? null);
      if (sameAsBefore) return state;
      const newMap = { ...state.annotationsByIndex };
      if (next === undefined) {
        delete newMap[idx];
      } else {
        newMap[idx] = next;
      }
      return { ...state, annotationsByIndex: newMap };
    }
    default:
      return state;
  }
}

/* -------------------------------------------------------------------------
 * KS-4961 — Отменить/Вернуть (Undo/Redo) для дерева анализа.
 *
 * Обёртка над reducer'ом ведёт стек снимков дерева. Снимок делается ПЕРЕД
 * применением мутирующего действия (add/variation/promote/delete/truncate/
 * nag/comment/variation-color/annotations). Навигация (goto-*) дерево не
 * меняет и в стек не пишется. LOAD_* и SET_INITIAL_FEN задают новый
 * контекст и очищают оба стека.
 *
 * Снимок хранит дерево без next/previous (их вырезает safeClone) — при
 * восстановлении связи и currentMove перестраиваются по globalIndex.
 * ----------------------------------------------------------------------- */

/** Действия, меняющие дерево (пишутся в стек отмены). */
const UNDOABLE_ACTIONS = new Set<ReviewAction['type']>([
  'ADD_MOVE',
  'ADD_VARIATION',
  'PROMOTE_VARIATION',
  'DELETE_VARIATION',
  'DELETE_REMAINING',
  'SET_NAG',
  'SET_COMMENT',
  'SET_VARIATION_COLOR',
  'SET_ANNOTATIONS',
]);

/** Действия, задающие новый контекст (сбрасывают историю отмен). */
const RESET_ACTIONS = new Set<ReviewAction['type']>([
  'LOAD_MOVES',
  'LOAD_FROM_PGN',
  'SET_INITIAL_FEN',
]);

/** Глубина стека отмены/возврата. */
const MAX_UNDO_DEPTH = 100;

type ReviewSnapshot = {
  history: ChessMove[];
  currentGlobalIndex: number | null;
  nextGlobalIndex: number;
  initialFen: string;
  initialAnnotations?: NodeAnnotations;
  annotationsByIndex: Record<number, NodeAnnotations>;
};

function makeSnapshot(s: ReviewState): ReviewSnapshot {
  return {
    history: safeClone(s.history) as ChessMove[],
    currentGlobalIndex: s.currentMove ? s.currentMove.globalIndex : null,
    nextGlobalIndex: s.nextGlobalIndex,
    initialFen: s.initialFen,
    initialAnnotations: s.initialAnnotations
      ? (safeClone(s.initialAnnotations) as NodeAnnotations)
      : undefined,
    annotationsByIndex: safeClone(s.annotationsByIndex) as Record<number, NodeAnnotations>,
  };
}

function restoreSnapshot(snap: ReviewSnapshot): ReviewState {
  const history = safeClone(snap.history) as ChessMove[];
  linkAllMovesRecursively(history);
  const currentMove =
    snap.currentGlobalIndex != null
      ? (searchInHistory(history, snap.currentGlobalIndex) as ChessMove | null)
      : null;
  return {
    history,
    currentMove,
    nextGlobalIndex: snap.nextGlobalIndex,
    initialFen: snap.initialFen,
    initialAnnotations: snap.initialAnnotations
      ? (safeClone(snap.initialAnnotations) as NodeAnnotations)
      : undefined,
    annotationsByIndex: safeClone(snap.annotationsByIndex) as Record<number, NodeAnnotations>,
  };
}

type UndoableState = {
  past: ReviewSnapshot[];
  present: ReviewState;
  future: ReviewSnapshot[];
};

type UndoableAction = ReviewAction | { type: 'UNDO' } | { type: 'REDO' };

function undoableReducer(state: UndoableState, action: UndoableAction): UndoableState {
  if (action.type === 'UNDO') {
    if (state.past.length === 0) return state;
    const snapshot = state.past[state.past.length - 1];
    return {
      past: state.past.slice(0, -1),
      present: restoreSnapshot(snapshot),
      future: [makeSnapshot(state.present), ...state.future],
    };
  }
  if (action.type === 'REDO') {
    if (state.future.length === 0) return state;
    const snapshot = state.future[0];
    return {
      past: [...state.past, makeSnapshot(state.present)],
      present: restoreSnapshot(snapshot),
      future: state.future.slice(1),
    };
  }

  const isUndoable = UNDOABLE_ACTIONS.has(action.type);
  // Снимок делаем ДО мутации: SET_NAG/SET_COMMENT/SET_VARIATION_COLOR меняют
  // узлы дерева in-place, снимок после уже содержал бы новое значение.
  const snapshotBefore = isUndoable ? makeSnapshot(state.present) : null;
  const nextPresent = reducer(state.present, action);
  if (nextPresent === state.present) return state; // no-op — стек не трогаем

  if (RESET_ACTIONS.has(action.type)) {
    return { past: [], present: nextPresent, future: [] };
  }
  if (isUndoable && snapshotBefore) {
    const past = [...state.past, snapshotBefore];
    if (past.length > MAX_UNDO_DEPTH) past.shift();
    return { past, present: nextPresent, future: [] };
  }
  // Навигация и прочие немутирующие действия — стек без изменений.
  return { ...state, present: nextPresent };
}

export function useReviewState() {
  const [wrapped, dispatch] = useReducer(undoableReducer, {
    past: [],
    present: {
      history: [],
      currentMove: null,
      nextGlobalIndex: 0,
      initialFen: INITIAL_FEN,
      annotationsByIndex: {},
    },
    future: [],
  });
  const state = wrapped.present;

  const loadMoves = useCallback((apiMoves: ApiMove[]) => {
    dispatch({ type: 'LOAD_MOVES', payload: apiMoves });
  }, []);

  const loadFromPgn = useCallback(
    (moves: ChessMove[], initialAnnotations?: NodeAnnotations) => {
      dispatch({ type: 'LOAD_FROM_PGN', payload: { moves, initialAnnotations } });
    },
    [],
  );

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

        // If the entered move matches an existing continuation (main line next
        // or first move of any existing variation of the next position), just
        // navigate to it instead of creating a duplicate. This prevents the
        // "move appears twice in notation" bug when the user replays a move
        // that is already present in the current line.
        const matchesMove = (candidate: ChessMove | null | undefined): boolean =>
          !!candidate
          && candidate.from === move.from
          && candidate.to === move.to
          && (candidate.promotion ?? '') === (move.promotion ?? '');

        let existingNext: ChessMove | null = null;
        let existingVariations: ChessMove[][] | undefined;
        if (state.currentMove) {
          existingNext = state.currentMove.next ?? null;
          existingVariations = state.currentMove.next?.variations;
        } else if (state.history.length > 0) {
          existingNext = state.history[0];
          existingVariations = state.history[0].variations;
        }

        if (matchesMove(existingNext)) {
          dispatch({ type: 'GOTO_MOVE', payload: existingNext as ChessMove });
          return true;
        }
        if (existingVariations) {
          for (const variation of existingVariations) {
            const first = variation[0];
            if (matchesMove(first)) {
              dispatch({ type: 'GOTO_MOVE', payload: first });
              return true;
            }
          }
        }

        const newFen = chess.fen();
        // KS-3039 follow-up: на root (currentMove === null) при непустой
        // основной линии variation создаётся как альтернатива history[0].
        // По шахматной семантике она играется из той же позиции и
        // соответствует тому же ply, что и history[0] (если основная
        // партия — фрагмент из середины с FEN-headers `... b ... 1 25`,
        // то history[0].ply = 49 и вариант к нему должен быть ply=49,
        // отображаться как `25...<SAN>`, а не `1.<SAN>`).
        // Прежняя формула `(currentMove?.ply ?? 0) + 1` давала на root
        // всегда ply=1, и formatMoveDisplay рисовал «1.e5» вместо
        // «25...e5» для партии из произвольного branching-point.
        const ply = state.currentMove
          ? state.currentMove.ply + 1
          : state.history.length > 0
            ? state.history[0].ply
            : 1;
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
        // KS-3039: на ply=0 (currentMove === null) при непустой
        // основной линии существующее продолжение — это history[0].
        // Раньше условие проверяло только `currentMove?.next` (всегда
        // false на root) и фолбэкало в ADD_MOVE → addMoveToHistory
        // затирал всю историю до [newMove]. Теперь — корректно
        // создаём variation для альтернативного first-move.
        const hasMainContinuation =
          !!state.currentMove?.next
          || (state.currentMove === null && state.history.length > 0);
        if (hasMainContinuation) {
          dispatch({ type: 'ADD_VARIATION', payload: newMove });
        } else {
          dispatch({ type: 'ADD_MOVE', payload: newMove });
        }
        return true;
      } catch {
        return false;
      }
    },
    [state.currentMove, state.nextGlobalIndex, state.initialFen, state.history],
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

  const setNag = useCallback((globalIndex: number, nags: number[]) => {
    dispatch({ type: 'SET_NAG', payload: { globalIndex, nags } });
  }, []);

  const setComment = useCallback((globalIndex: number, comment: string) => {
    dispatch({ type: 'SET_COMMENT', payload: { globalIndex, comment } });
  }, []);

  /**
   * KS-2287 (ADR-038 §6) — установить/снять цвет вариации.
   * `moveIndex` — globalIndex любого хода ВНУТРИ вариации; reducer
   * сам найдёт variation-root через `findVariationRoot`. `color: null`
   * — clear.
   */
  const setVariationColor = useCallback(
    (moveIndex: number, color: VariationColor | null) => {
      dispatch({ type: 'SET_VARIATION_COLOR', payload: { moveIndex, color } });
    },
    [],
  );

  /**
   * KS-2152: установить аннотации (стрелки/выделения) для текущего
   * положения. Если currentMove === null — сохраняем в initialAnnotations,
   * иначе — на сам узел дерева.
   */
  const setAnnotationsForCurrent = useCallback(
    (annotations: NodeAnnotations | undefined) => {
      // Reducer'у нужен globalIndex текущей ноды (или kind:'initial')
      // в момент dispatch — берём из замыкания state.currentMove.
      dispatch(
        state.currentMove
          ? {
              type: 'SET_ANNOTATIONS',
              payload: { kind: 'move', globalIndex: state.currentMove.globalIndex, annotations },
            }
          : { type: 'SET_ANNOTATIONS', payload: { kind: 'initial', annotations } },
      );
    },
    [state.currentMove],
  );

  // KS-4961: Отменить/Вернуть.
  const undo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatch({ type: 'REDO' }), []);
  const canUndo = wrapped.past.length > 0;
  const canRedo = wrapped.future.length > 0;

  const currentFen = state.currentMove?.fen ?? state.initialFen;
  const currentGlobalIndex = state.currentMove?.globalIndex ?? -1;
  /**
   * KS-2152: аннотации для отображения на доске в текущей позиции.
   * Если мы на стартовой позиции (currentMove === null) — используем
   * initialAnnotations. Иначе — annotationsByIndex[globalIndex].
   * Без fallback'а на initialAnnotations: узел без аннотаций → пустая доска.
   */
  const currentAnnotations: NodeAnnotations | undefined = state.currentMove
    ? state.annotationsByIndex[state.currentMove.globalIndex]
    : state.initialAnnotations;

  // Check if current move is in a variation (not in the top-level main-line history)
  const isInVariation = state.currentMove !== null
    && !state.history.some(m => m.globalIndex === state.currentMove!.globalIndex);

  return {
    history: state.history,
    currentMove: state.currentMove,
    currentGlobalIndex,
    currentFen,
    initialFen: state.initialFen,
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
    setNag,
    setComment,
    /** KS-2287 (ADR-038 §6, VC E1) */
    setVariationColor,
    /** KS-2152 */
    currentAnnotations,
    initialAnnotations: state.initialAnnotations,
    annotationsByIndex: state.annotationsByIndex,
    setAnnotationsForCurrent,
    /** KS-4961: Отменить/Вернуть операции с деревом. */
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
