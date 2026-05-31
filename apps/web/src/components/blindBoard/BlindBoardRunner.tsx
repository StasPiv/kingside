/**
 * KS-3442 (ADR-088 §11 F1). Runner режима «слепая доска»: пустая
 * react-chessboard, drag off, click-only ввод; подсветка from/to
 * предыдущего хода компьютера + стрелка from→to (без изображения
 * фигуры — на пустой доске это автоматически).
 *
 * Ввод ответа: клик клетки → промоушн-модал (Q/R/B/N) → callback
 * `onSubmit({square, pieceType})`. Caller (`BlindBoardSessionRunner`)
 * шлёт ответ на backend и подсовывает следующий ход через перерендер
 * с новым `move`.
 *
 * Раскрытие позиции после wrong-answer/dead-end рисуется caller'ом
 * (там FinalScreen с табло) — runner отвечает только за активный
 * раунд.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardMove,
  BlindBoardPieceType,
  BlindBoardSquare,
} from '@kingside/shared';

import { MemoChessboard } from '../MemoChessboard';
import { useBoardSettings } from '../../hooks/useBoardSettings';
import { BlindBoardPieceIcon } from './BlindBoardPieceIcon';

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';
const PIECE_TYPES: BlindBoardPieceType[] = ['Q', 'R', 'B', 'N'];
const HIGHLIGHT_FROM = 'rgba(155, 199, 0, 0.45)';
const HIGHLIGHT_TO = 'rgba(155, 199, 0, 0.75)';
const ARROW_COLOR = '#7c83ff';

/**
 * KS-3447 → KS-3492: иконка фигуры из текущего piece-style вынесена в
 * общий компонент `BlindBoardPieceIcon` для переиспользования в
 * `BlindBoardConfigForm`. Тут — тонкая обёртка с runner-классами,
 * чтобы существующий CSS (`.blind-board-runner__piece-svg*`)
 * продолжал работать без правки в layout.
 */
function PieceIcon({ pieceType }: { pieceType: BlindBoardPieceType }) {
  return (
    <BlindBoardPieceIcon
      pieceType={pieceType}
      className="blind-board-runner__piece-svg"
    />
  );
}

export interface BlindBoardRunnerProps {
  /** Ход компьютера в текущем раунде; `null` если сессия завершена. */
  move: BlindBoardMove | null;
  /** Вызывается после выбора {клетка + тип фигуры} в промоушн-модале. */
  onSubmit: (answer: {
    square: BlindBoardSquare;
    pieceType: BlindBoardPieceType;
  }) => void;
  /**
   * Внешний флаг «ввод заморожен» — пока caller ждёт ответ от backend
   * на предыдущий answer, не пускаем второй клик.
   */
  disabled?: boolean;
}

export function BlindBoardRunner({
  move,
  onSubmit,
  disabled = false,
}: BlindBoardRunnerProps) {
  const { t } = useTranslation();
  const { pieceSet } = useBoardSettings();
  const [pendingSquare, setPendingSquare] =
    useState<BlindBoardSquare | null>(null);

  const handleSquareClick = useCallback(
    ({ square }: { square: string }) => {
      if (disabled || !move) return;
      setPendingSquare(square as BlindBoardSquare);
    },
    [disabled, move],
  );

  const handlePieceClick = useCallback(
    ({ square }: { square: string }) => {
      // На пустой доске фигур нет — но react-chessboard может прислать
      // событие при клике в ячейку с DnD-маркером. Делегируем в
      // squareClick, чтобы UX был одинаковым.
      handleSquareClick({ square });
    },
    [handleSquareClick],
  );

  const closeModal = useCallback(() => setPendingSquare(null), []);

  const handlePick = useCallback(
    (pieceType: BlindBoardPieceType) => {
      if (!pendingSquare) return;
      onSubmit({ square: pendingSquare, pieceType });
      setPendingSquare(null);
    },
    [pendingSquare, onSubmit],
  );

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!move) return {};
    return {
      [move.from]: { background: HIGHLIGHT_FROM },
      [move.to]: { background: HIGHLIGHT_TO },
    };
  }, [move]);

  const arrows = useMemo(() => {
    if (!move) return [];
    return [
      {
        startSquare: move.from,
        endSquare: move.to,
        color: ARROW_COLOR,
      },
    ];
  }, [move]);

  const boardOptions = useMemo(
    () => ({
      position: EMPTY_FEN,
      boardOrientation: 'white' as const,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      arrows,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
      animationDurationInMs: 0,
    }),
    [squareStyles, arrows, handleSquareClick, handlePieceClick],
  );

  return (
    <div
      className="blind-board-runner"
      data-testid="blind-board-runner"
      data-pending-square={pendingSquare ?? ''}
      data-disabled={disabled ? 'true' : 'false'}
    >
      <div
        className="blind-board-runner__board"
        data-testid="blind-board-runner-board"
      >
        <MemoChessboard options={boardOptions} />
      </div>

      {pendingSquare && (
        <div
          className="blind-board-runner__promotion"
          data-testid="blind-board-promotion"
          role="dialog"
          aria-modal="true"
          aria-label={t(
            'blindBoard.promotion.title',
            'Pick the piece type',
          )}
        >
          <button
            type="button"
            className="blind-board-runner__promotion-backdrop"
            data-testid="blind-board-promotion-backdrop"
            onClick={closeModal}
            aria-label={t('common.close', 'Close')}
          />
          <div className="blind-board-runner__promotion-panel">
            <header className="blind-board-runner__promotion-header">
              <h2 className="blind-board-runner__promotion-title">
                {t('blindBoard.promotion.title', 'Pick the piece type')}
              </h2>
              <span
                className="blind-board-runner__promotion-square"
                data-testid="blind-board-promotion-square"
              >
                {pendingSquare}
              </span>
            </header>
            {/* KS-3447: иконки фигур из текущего piece-style (как в
                обычном промоушн-диалоге). 4 кнопки в одну строку через
                grid `repeat(4, minmax(0, 1fr))` — на узких экранах
                кнопки сжимаются равномерно вместо обрезки последней.
                Inline-style оставлен fallback'ом на случай если CSS
                из L1 не подгружен; финальная стилизация — за layout. */}
            <div
              className="blind-board-runner__promotion-grid"
              data-testid="blind-board-promotion-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: '8px',
              }}
            >
              {PIECE_TYPES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`blind-board-runner__promotion-piece blind-board-runner__promotion-piece--${p}`}
                  data-testid={`blind-board-promotion-${p}`}
                  data-piece={p}
                  data-piece-style={pieceSet}
                  aria-label={t(`blindBoard.piece.${p}`, p)}
                  onClick={() => handlePick(p)}
                >
                  <PieceIcon pieceType={p} />
                </button>
              ))}
            </div>
            <button
              type="button"
              className="blind-board-runner__promotion-cancel"
              data-testid="blind-board-promotion-cancel"
              onClick={closeModal}
            >
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
