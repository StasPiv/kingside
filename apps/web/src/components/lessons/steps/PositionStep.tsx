import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess, type Square } from 'chess.js';
import type { PositionStepPayload } from '@kingside/shared';

import { MemoChessboard } from '../../MemoChessboard';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import { useFastDrag } from '../../../hooks/useFastDrag';
import { useStablePosition } from '../../../hooks/useStablePosition';
import { useBoardTheme } from '../../../hooks/useBoardTheme';
import { useBoardHighlights } from '../../../hooks/useBoardHighlights';
import { useSounds, soundEventFromSan } from '../../../hooks/useSounds';

/**
 * PositionStep — интерактивный шаг позиции (L-23, KS-1794).
 *
 * Рендерит `MemoChessboard` с позицией из `payload.fen`. Пользователь делает
 * ОДИН ход (drag-n-drop или click-to-move — переиспользуем `useFastDrag`
 * и `useBoardHighlights`). Ход валидируется через `chess.js`:
 *   1) legal на текущей позиции;
 *   2) UCI (`from+to[+promotion]`) сравнивается с каждым из
 *      `payload.expectedMoves` — совпадение с любым даёт `correct`.
 *
 * Визуальные состояния:
 *   • `thinking` — ожидание хода;
 *   • `correct` — зелёная подсветка целевой клетки, звук «success»,
 *     `onStepDone()` вызывается один раз;
 *   • `incorrect` — красная подсветка target-клетки, ход откатывается,
 *     счётчик попыток увеличивается, звук «incorrect».
 *
 * Кнопка «Показать подсказку» подсвечивает стартовую клетку первого из
 * `payload.expectedMoves`. Отдельного поля `hint` в payload нет.
 *
 * Промоушен по умолчанию — в ферзя (UCI 5-го символа = 'q'). Подзадачи
 * L-24 / L-32 добавят выбор фигуры; сейчас expectedMoves с другим
 * promotion-символом просто не засчитываются — это корректное поведение
 * для MVP.
 */

type Status = 'thinking' | 'correct' | 'incorrect';

interface PositionStepProps {
  payload: PositionStepPayload;
  onStepDone?: () => void;
  hideNext?: boolean;
}

const CORRECT_COLOR = 'rgba(34, 197, 94, 0.55)';
const INCORRECT_COLOR = 'rgba(220, 38, 38, 0.55)';
const HINT_COLOR = 'rgba(59, 130, 246, 0.55)';

const INCORRECT_RESET_MS = 800;

/** Парсит UCI-ход "e2e4" или "e7e8q" в компоненты. Возвращает null для мусора. */
export function parseUci(uci: string): {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
} | null {
  if (typeof uci !== 'string' || uci.length < 4 || uci.length > 5) return null;
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promo = uci.length === 5 ? uci[4].toLowerCase() : undefined;
  if (promo && !['q', 'r', 'b', 'n'].includes(promo)) return null;
  return { from, to, promotion: promo as 'q' | 'r' | 'b' | 'n' | undefined };
}

/** Собирает UCI "from+to[+promotion]" из chess.js Move. */
export function moveToUci(move: {
  from: string;
  to: string;
  promotion?: string;
}): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function PositionStep({ payload, onStepDone, hideNext }: PositionStepProps) {
  const { t } = useTranslation();
  const { playSound } = useSounds();

  // Стабильная ссылка на playSound — эффекты/мув-хэндлер не зависят от ре-ссылок.
  const playSoundRef = useRef(playSound);
  playSoundRef.current = playSound;

  // KS-2052: read-only диаграмма — шаг без `expectedMoves` (или с пустым
  // массивом). Доска статичная, drag/click отключены, hint/Attempts/header
  // не рендерятся. Защита от undefined в `payload.expectedMoves.some(...)`.
  const isReadOnly =
    !Array.isArray(payload.expectedMoves) || payload.expectedMoves.length === 0;

  // Базовая позиция из FEN. Пересоздаётся только при смене payload.fen.
  const baseGame = useMemo<Chess>(() => new Chess(payload.fen), [payload.fen]);

  // Чья очередь хода определяется FEN'ом; ориентация — payload.orientation
  // или сторона игрока по умолчанию.
  const playerColor: 'white' | 'black' = baseGame.turn() === 'w' ? 'white' : 'black';
  const orientation: 'white' | 'black' = payload.orientation ?? playerColor;

  const [overrideGame, setOverrideGame] = useState<Chess | null>(null);
  const [status, setStatus] = useState<Status>('thinking');
  const [attempts, setAttempts] = useState(0);
  const [hintSquare, setHintSquare] = useState<Square | null>(null);
  const [highlight, setHighlight] = useState<{ square: Square; kind: Status } | null>(null);

  const stepDoneFiredRef = useRef(false);

  // Сброс при смене payload (новый шаг в том же компоненте).
  useEffect(() => {
    setOverrideGame(null);
    setStatus('thinking');
    setAttempts(0);
    setHintSquare(null);
    setHighlight(null);
    stepDoneFiredRef.current = false;
  }, [payload]);

  const displayGame = overrideGame ?? baseGame;

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const { boardThemeOptions, customPieces } = useBoardTheme();

  // Ссылки на методы useBoardHighlights — чтобы handleMove мог их вызвать,
  // не создавая циклических зависимостей в useCallback.
  const setLastMoveRef = useRef<((from: Square, to: Square) => void) | null>(null);
  const clearLastMoveRef = useRef<(() => void) | null>(null);

  const handleMove = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (isReadOnly || !targetSquare || status !== 'thinking') return false;

      // Применяем ход на КОПИИ baseGame (move мутирует экземпляр). При неудаче
      // получим визуально откат к baseGame через overrideGame = null.
      const test = new Chess(baseGame.fen());
      let moveResult: ReturnType<Chess['move']> | null = null;
      try {
        moveResult = test.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: 'q',
        });
      } catch {
        // chess.js бросает на заведомо невалидных клетках — snap-back.
        return false;
      }
      if (!moveResult) return false;

      const playedUci = moveToUci({
        from: moveResult.from,
        to: moveResult.to,
        promotion: moveResult.promotion,
      });

      // `isReadOnly` уже отсёк ветку без expectedMoves; ?? [] — защитный no-op.
      const isCorrect = (payload.expectedMoves ?? []).some(
        (expected) => expected.toLowerCase() === playedUci.toLowerCase(),
      );

      setOverrideGame(test);
      setLastMoveRef.current?.(moveResult.from as Square, moveResult.to as Square);
      playSoundRef.current(soundEventFromSan(moveResult.san));

      if (isCorrect) {
        setStatus('correct');
        setHighlight({ square: moveResult.to as Square, kind: 'correct' });
        setHintSquare(null);
        playSoundRef.current('puzzle-correct');
        if (!stepDoneFiredRef.current) {
          stepDoneFiredRef.current = true;
          onStepDone?.();
        }
      } else {
        setStatus('incorrect');
        setHighlight({ square: moveResult.to as Square, kind: 'incorrect' });
        setAttempts((n) => n + 1);
        playSoundRef.current('puzzle-incorrect');
      }
      return true;
    },
    [baseGame, status, payload.expectedMoves, onStepDone, isReadOnly],
  );

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean =>
      handleMove({ sourceSquare: from, targetSquare: to }),
    [handleMove],
  );

  const {
    squareStyles: baseSquareStyles,
    onSquareClick,
    setLastMove,
    clearLastMove,
  } = useBoardHighlights({
    game: displayGame,
    playerColor: orientation,
    enabled: !isReadOnly && status === 'thinking',
    onMove: onClickMove,
  });

  // Прокидываем последние ссылки в рефы — handleMove берёт их оттуда.
  setLastMoveRef.current = setLastMove;
  clearLastMoveRef.current = clearLastMove;

  // Откат неправильного хода.
  useEffect(() => {
    if (status !== 'incorrect') return;
    const timer = setTimeout(() => {
      setOverrideGame(null);
      setStatus('thinking');
      setHighlight(null);
      clearLastMoveRef.current?.();
    }, INCORRECT_RESET_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const showHint = useCallback(() => {
    if (isReadOnly || status !== 'thinking') return;
    const first = payload.expectedMoves?.[0];
    const parsed = first ? parseUci(first) : null;
    if (!parsed) return;
    setHintSquare(parsed.from);
  }, [status, payload.expectedMoves, isReadOnly]);

  const squareStyles = useMemo<Record<string, CSSProperties>>(() => {
    const merged: Record<string, CSSProperties> = { ...baseSquareStyles };
    if (hintSquare) {
      merged[hintSquare] = {
        ...merged[hintSquare],
        backgroundColor: HINT_COLOR,
      };
    }
    if (highlight) {
      const color = highlight.kind === 'correct' ? CORRECT_COLOR : INCORRECT_COLOR;
      merged[highlight.square] = {
        ...merged[highlight.square],
        backgroundColor: color,
      };
    }
    return merged;
  }, [baseSquareStyles, hintSquare, highlight]);

  const onPieceDrop = useCallback(
    (args: { sourceSquare: string; targetSquare: string | null }): boolean =>
      handleMove(args),
    [handleMove],
  );

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop,
    boardOrientation: orientation,
    enabled: !isReadOnly && status === 'thinking',
  });

  const handleSquareClick = useCallback(
    ({ square }: { piece: unknown; square: string }) => {
      onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  const handlePieceClick = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (square) onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  const boardStyle = useMemo<CSSProperties | undefined>(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const stablePosition = useStablePosition(displayGame.fen());

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: orientation,
      animationDurationInMs: suppressAnimationRef.current ? 0 : 150,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
      ...(customPieces && { pieces: customPieces }),
    }),
    [
      stablePosition,
      orientation,
      boardStyle,
      boardThemeOptions,
      customPieces,
      squareStyles,
      handleSquareClick,
      handlePieceClick,
      suppressAnimationRef,
    ],
  );

  return (
    <div
      className={`lesson-position-step${isReadOnly ? ' lesson-position-step--readonly' : ''}`}
      data-testid="lesson-position-step"
      data-readonly={isReadOnly ? 'true' : 'false'}
    >
      {/* KS-2052: header (turn + attempts) — только для интерактивного шага.
          Read-only диаграмма не должна мимикрировать под задачу. */}
      {!isReadOnly && (
        <header
          className="lesson-position-step__header"
          style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8 }}
        >
          <span
            className={`lesson-position-step__turn lesson-position-step__turn--${playerColor}`}
            data-testid="lesson-position-step-turn"
          >
            {playerColor === 'white'
              ? t('puzzle.whiteToMove', 'White to move')
              : t('puzzle.blackToMove', 'Black to move')}
          </span>
          <span
            className="lesson-position-step__attempts"
            data-testid="lesson-position-step-attempts"
          >
            {t('lessons.positionAttempts', {
              count: attempts,
              defaultValue: 'Attempts: {{count}}',
            })}
          </span>
        </header>
      )}

      <div className="board-container" ref={boardContainerRef}>
        <MemoChessboard options={boardOptions} />
      </div>

      <div className="lesson-position-step__actions">
        {status === 'correct' && (
          <p
            className="lesson-position-step__result lesson-position-step__result--correct"
            data-testid="lesson-position-step-correct"
          >
            {t('lessons.positionCorrect', 'Correct!')}
          </p>
        )}
        {status === 'incorrect' && (
          <p
            className="lesson-position-step__result lesson-position-step__result--incorrect"
            data-testid="lesson-position-step-incorrect"
          >
            {t('lessons.positionIncorrect', 'Not quite — try again')}
          </p>
        )}

        {!isReadOnly && status === 'thinking' && (
          <button
            type="button"
            className="lesson-position-step__hint"
            data-testid="lesson-position-step-hint"
            onClick={showHint}
            disabled={hintSquare != null}
          >
            {t('lessons.positionHint', 'Show hint')}
          </button>
        )}

        {/* KS-2043: «Готово» вместо «Далее» — внутренняя кнопка
            отмечает шаг done, переключение шага делает nav-кнопка. */}
        {status === 'correct' && !hideNext && (
          <button
            type="button"
            className="lesson-position-step__next"
            data-testid="lesson-position-step-next"
            onClick={() => onStepDone?.()}
          >
            {t('lessons.markDone', 'Got it')}
          </button>
        )}
      </div>
    </div>
  );
}
