/**
 * KS-3489 (ADR-088 V2 §15 F2). Overlay на level-up.
 *
 * KS-3522: источник позиции — `levelUp.boardPosition` (KS-3520),
 * snapshot ВСЕХ фигур в актуальных клетках с сервера. Раньше клиент
 * локально накапливал `piecesOnBoard = startPosition + addedPieces` и
 * фигуры показывались на стартовых клетках, без учёта compMove'ов —
 * получалась неверная картина. Теперь сервер кладёт актуальную
 * позицию, фронт её просто рисует.
 *
 * Подпись: «Уровень N — добавился {newPiece} на {newSquare}»;
 * подсветка `newSquare` 1.5с; autoclose через `memorizeTimeSec`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { BlindBoardPiece, BlindBoardSquare } from '@kingside/shared';

import { MemoChessboard } from '../MemoChessboard';
import { piecesToFen } from './BlindBoardFinalScreen';

const HIGHLIGHT_DURATION_MS = 1500;
const HIGHLIGHT_COLOR = 'rgba(155, 199, 0, 0.65)';

export interface BlindBoardLevelUpOverlayProps {
  /**
   * KS-3522: snapshot всех фигур в актуальных клетках, пришедший в
   * `SubmitBlindBoardAnswerResponse.levelUp.boardPosition` (KS-3520).
   * Включает старые фигуры на текущих позициях + только что добавленную.
   */
  boardPosition: BlindBoardPiece[];
  /** Новый уровень. */
  newLevel: number;
  /** Тип добавленной фигуры. */
  newPiece: BlindBoardPiece['type'];
  /** Клетка добавленной фигуры. */
  newSquare: BlindBoardSquare;
  /** Сколько секунд autoclose. */
  memorizeTimeSec: number;
  /** Колбэк закрытия (auto / клик «Готов»). */
  onClose: () => void;
}

export function BlindBoardLevelUpOverlay({
  boardPosition,
  newLevel,
  newPiece,
  newSquare,
  memorizeTimeSec,
  onClose,
}: BlindBoardLevelUpOverlayProps) {
  const { t } = useTranslation();
  const [highlightOn, setHighlightOn] = useState(true);
  const closedRef = useRef(false);

  // Подсветка newSquare ~1.5 сек, потом гаснет.
  useEffect(() => {
    const timer = window.setTimeout(
      () => setHighlightOn(false),
      HIGHLIGHT_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  // Auto-close через memorizeTimeSec секунд (но не меньше 1.5с
  // подсветки — иначе пользователь не увидит подсвеченную клетку).
  useEffect(() => {
    const ms = Math.max(memorizeTimeSec * 1000, HIGHLIGHT_DURATION_MS + 100);
    const t = window.setTimeout(() => {
      if (closedRef.current) return;
      closedRef.current = true;
      onClose();
    }, ms);
    return () => window.clearTimeout(t);
  }, [memorizeTimeSec, onClose]);

  // Esc закрывает.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !closedRef.current) {
        closedRef.current = true;
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fen = useMemo(() => piecesToFen(boardPosition), [boardPosition]);

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(
    () =>
      highlightOn
        ? { [newSquare]: { background: HIGHLIGHT_COLOR } }
        : {},
    [highlightOn, newSquare],
  );

  const handleClose = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  };

  const node = (
    <div
      className="blind-board-level-up"
      data-testid="blind-board-level-up"
      data-new-level={newLevel}
      role="dialog"
      aria-modal="true"
      aria-label={t('blindBoard.levelUp.title', 'Level up')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="blind-board-level-up__backdrop"
        data-testid="blind-board-level-up-backdrop"
      />
      <div className="blind-board-level-up__panel">
        <header className="blind-board-level-up__header">
          <h2
            className="blind-board-level-up__title"
            data-testid="blind-board-level-up-title"
          >
            {t('blindBoard.levelUp.title', 'Level up')}
          </h2>
          <p
            className="blind-board-level-up__sub"
            data-testid="blind-board-level-up-sub"
          >
            {t(
              'blindBoard.levelUp.body',
              'Level {{level}} — added {{piece}} at {{square}}',
              {
                level: newLevel,
                piece: t(`blindBoard.piece.${newPiece}`, newPiece),
                square: newSquare,
              },
            )}
          </p>
        </header>
        <div
          className="blind-board-level-up__board"
          data-testid="blind-board-level-up-board"
          data-fen={fen}
          data-highlight-square={newSquare}
        >
          <MemoChessboard
            options={{
              position: fen,
              boardOrientation: 'white',
              allowDragging: false,
              showNotation: true,
              animationDurationInMs: 0,
              squareStyles,
            }}
          />
        </div>
        <footer className="blind-board-level-up__footer">
          <button
            type="button"
            className="blind-board-level-up__ready play-btn"
            data-testid="blind-board-level-up-ready"
            onClick={handleClose}
          >
            {t('blindBoard.levelUp.ready', 'Ready')}
          </button>
        </footer>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return node;
  return createPortal(node, document.body);
}
