import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChessMove } from '../types';
import { nagToSymbol } from '../utils/nagUtils';
// KS-2266 (ADR-037 §1, §6): категории NAG и `setNagInCategory` —
// заменяет наивный toggle (push в массив) на replace-within-group.
import { groupNagsByCategory, setNagInCategory } from '../../utils/nagCategories';
import {
  processMoveHierarchy,
  getMoveClasses,
  getBracketClasses,
  isProcessedMove,
  isBracketItem,
  ProcessedMove,
} from '../utils/ChessMoveProcessing';
import './ReviewMoveList.css';

export interface GameInfo {
  white: { username: string; rating?: number | null };
  black: { username: string; rating?: number | null };
  opening?: string;
  result?: string;
  event?: string;
  date?: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  move: ChessMove | null;
}

/** NAG buttons shown in the context menu annotate section */
const NAG_BUTTONS: { nag: number; label: string }[] = [
  { nag: 1, label: '!' },
  { nag: 3, label: '!!' },
  { nag: 2, label: '?' },
  { nag: 4, label: '??' },
  { nag: 5, label: '!?' },
  { nag: 6, label: '?!' },
];

interface ReviewMoveListProps {
  history: ChessMove[];
  currentGlobalIndex: number;
  onMoveClick: (move: ChessMove) => void;
  /**
   * KS-2005: edit-колбэки `onPromoteVariation/onDeleteVariation/`
   * `onTruncateRemaining/onSetNag/onSetComment` стали опциональными.
   * Если ни один не передан или установлен `readOnly`, контекстное меню
   * не открывается (right-click и long-press игнорируются), а уже
   * сохранённые в PGN комментарии и NAG-символы рендерятся как обычно.
   * Это позволяет переиспользовать компонент в read-only сценариях
   * (`InlinePgnViewer` для шага «разбор партии» в уроке) без копий.
   */
  onPromoteVariation?: (move: ChessMove) => void;
  onDeleteVariation?: (move: ChessMove) => void;
  onTruncateRemaining?: (move: ChessMove) => void;
  onSetNag?: (globalIndex: number, nags: number[]) => void;
  onSetComment?: (globalIndex: number, comment: string) => void;
  /**
   * Полностью отключить интерактивное редактирование (контекстное меню,
   * редактор комментария по long-press). Клик по ходу через `onMoveClick`
   * остаётся — навигация по партии нужна и в read-only режиме.
   */
  readOnly?: boolean;
}

export function ReviewMoveList({
  history,
  currentGlobalIndex,
  onMoveClick,
  onPromoteVariation,
  onDeleteVariation,
  onTruncateRemaining,
  onSetNag,
  onSetComment,
  readOnly = false,
}: ReviewMoveListProps) {
  const editable = !readOnly && Boolean(
    onPromoteVariation ||
      onDeleteVariation ||
      onTruncateRemaining ||
      onSetNag ||
      onSetComment,
  );
  const { t } = useTranslation();
  const movesContainerRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  // Timestamp until which synthetic click/touch events should be ignored after long press
  const ignoreCloseUntilRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    move: null,
  });
  const [commentEditIndex, setCommentEditIndex] = useState<number | null>(null);
  const [commentText, setCommentText] = useState('');
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [expandedComments, setExpandedComments] = useState<Set<number>>(new Set());

  useEffect(() => {
    const container = movesContainerRef.current;
    if (!container) return;
    const active = container.querySelector('.move-item.current') as HTMLElement | null;
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      // No active move (e.g. initial position after "go to start") —
      // scroll the notation container to the top.
      container.scrollTop = 0;
    }
  }, [currentGlobalIndex]);

  // Autofocus comment textarea
  useEffect(() => {
    if (commentEditIndex !== null && commentTextareaRef.current) {
      commentTextareaRef.current.focus();
    }
  }, [commentEditIndex]);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false, move: null }));
  }, []);

  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleClose = () => {
      // Ignore synthetic click/touch events fired shortly after long press
      if (Date.now() < ignoreCloseUntilRef.current) return;
      closeContextMenu();
    };
    document.addEventListener('click', handleClose);
    document.addEventListener('touchstart', handleClose);
    document.addEventListener('contextmenu', handleClose);
    return () => {
      document.removeEventListener('click', handleClose);
      document.removeEventListener('touchstart', handleClose);
      document.removeEventListener('contextmenu', handleClose);
    };
  }, [contextMenu.visible, closeContextMenu]);

  const showContextMenu = useCallback(
    (coords: { clientX: number; clientY: number }, move: ChessMove) => {
      setContextMenu({ visible: true, x: coords.clientX, y: coords.clientY, move });
    },
    [],
  );

  const handleMoveClick = (processedMove: ProcessedMove): void => {
    if (processedMove.originalMove) {
      onMoveClick(processedMove.originalMove);
    }
  };

  const handleMoveContextMenu = (e: React.MouseEvent, processedMove: ProcessedMove): void => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    if (processedMove.originalMove) {
      showContextMenu(e, processedMove.originalMove);
    }
  };

  const handleTouchStart = (e: React.TouchEvent, processedMove: ProcessedMove): void => {
    if (!editable) return;
    if (!processedMove.originalMove) return;
    const touch = e.touches[0];
    const move = processedMove.originalMove;
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      longPressTimerRef.current = null;
      // Ignore any synthetic click/touchstart events for 700ms after showing the menu
      ignoreCloseUntilRef.current = Date.now() + 700;
      showContextMenu({ clientX: touch.clientX, clientY: touch.clientY }, move);
    }, 500);
  };

  const handleTouchEnd = (): void => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressFiredRef.current = false;
  };

  const handleTouchMove = (): void => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressFiredRef.current = false;
  };

  // KS-2266: внутри одной категории NAG (`quality`: !,?,!!,??,!?,?! /
  // `positionEval`: =, ∞, ⩲, ⩱, ±, ∓, +−, −+) у хода может быть только
  // один NAG. setNagInCategory делает replace-within-group и toggle-off
  // при повторном клике (см. utils/nagCategories.ts).
  const handleNagToggle = (nag: number) => {
    if (!contextMenu.move || !onSetNag) return;
    const move = contextMenu.move;
    const newNags = setNagInCategory(move.nags ?? [], nag);
    onSetNag(move.globalIndex, newNags);
  };

  const openCommentEditor = (move: ChessMove) => {
    setCommentEditIndex(move.globalIndex);
    setCommentText(move.comment ?? '');
    closeContextMenu();
  };

  const saveComment = () => {
    if (commentEditIndex === null || !onSetComment) return;
    onSetComment(commentEditIndex, commentText);
    setCommentEditIndex(null);
    setCommentText('');
  };

  const deleteComment = () => {
    if (commentEditIndex === null || !onSetComment) return;
    onSetComment(commentEditIndex, '');
    setCommentEditIndex(null);
    setCommentText('');
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      saveComment();
    }
    if (e.key === 'Escape') {
      setCommentEditIndex(null);
      setCommentText('');
    }
  };

  const toggleCommentExpand = (globalIndex: number) => {
    setExpandedComments((prev) => {
      const next = new Set(prev);
      if (next.has(globalIndex)) {
        next.delete(globalIndex);
      } else {
        next.add(globalIndex);
      }
      return next;
    });
  };

  /**
   * KS-2266 (ADR-037 §6): рендер NAG-символов inline с ходом —
   * **по одному NAG из каждой категории**. Раньше рендерились все
   * подряд (`!! !?` и т.п.), при наличии legacy-данных с дублями.
   * Теперь groupNagsByCategory отдаёт по одному (последнему)
   * представителю категории, и пользователь видит только актуальный.
   */
  const renderNagSymbols = (move: ChessMove) => {
    if (!move.nags || move.nags.length === 0) return null;
    const grouped = groupNagsByCategory(move.nags);
    const items: React.ReactNode[] = [];
    const qualityNag = grouped.quality;
    if (qualityNag !== undefined) {
      let className = 'review-nag';
      if (qualityNag === 1 || qualityNag === 3) className += ' review-nag--good';
      else if (qualityNag === 2 || qualityNag === 4) className += ' review-nag--bad';
      else if (qualityNag === 5 || qualityNag === 6) className += ' review-nag--interesting';
      items.push(
        <span key={`nag-quality-${qualityNag}`} className={className}>
          {nagToSymbol(qualityNag)}
        </span>,
      );
    }
    const evalNag = grouped.positionEval;
    if (evalNag !== undefined) {
      items.push(
        <span key={`nag-eval-${evalNag}`} className="review-nag review-nag--eval">
          {nagToSymbol(evalNag)}
        </span>,
      );
    }
    return items.length > 0 ? items : null;
  };

  /** Render eval and clock inline after a move */
  const renderEvalClock = (move: ChessMove) => {
    const parts: React.ReactNode[] = [];
    if (move.eval !== undefined) {
      const val = move.eval;
      let className = 'review-eval';
      if (val > 0.3) className += ' review-eval--white';
      else if (val < -0.3) className += ' review-eval--black';
      const display = val >= 100 ? '#' : val <= -100 ? '#' : (val > 0 ? '+' : '') + val.toFixed(1);
      parts.push(
        <span key={`eval-${move.globalIndex}`} className={className} title={`eval: ${val}`}>
          {display}
        </span>,
      );
    }
    if (move.clock) {
      parts.push(
        <span key={`clk-${move.globalIndex}`} className="review-clock" title={`clock: ${move.clock}`}>
          🕐{move.clock}
        </span>,
      );
    }
    return parts.length > 0 ? parts : null;
  };

  /** Render comment block after a move */
  const renderComment = (move: ChessMove) => {
    if (commentEditIndex === move.globalIndex) {
      return (
        <span
          key={`comment-edit-${move.globalIndex}`}
          className="review-comment-editor"
          onClick={(e) => e.stopPropagation()}
        >
          <textarea
            ref={commentTextareaRef}
            className="review-comment-textarea"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onBlur={saveComment}
            onKeyDown={handleCommentKeyDown}
            rows={2}
          />
          <button
            className="review-comment-delete-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              deleteComment();
            }}
            title={t('review.deleteComment', 'Delete comment')}
          >
            ✕
          </button>
        </span>
      );
    }

    if (!move.comment) return null;

    const isExpanded = expandedComments.has(move.globalIndex);
    return (
      <span
        key={`comment-${move.globalIndex}`}
        className={`review-comment${isExpanded ? ' review-comment--expanded' : ''}`}
        data-testid={`review-comment-${move.globalIndex}`}
        onClick={() => toggleCommentExpand(move.globalIndex)}
      >
        {move.comment}
      </span>
    );
  };

  const renderMovesList = () => {
    if (!history || !Array.isArray(history) || history.length === 0) {
      return [];
    }

    const processedItems = processMoveHierarchy(history, currentGlobalIndex);

    return processedItems.flatMap((item, index) => {
      if (isProcessedMove(item)) {
        const move = item.originalMove;
        const elements = [
          <span
            key={`move-${item.globalIndex}-${index}`}
            className={getMoveClasses(item)}
            data-testid={`review-move-${item.globalIndex}`}
            data-current={item.isCurrent ? 'true' : 'false'}
            onClick={() => handleMoveClick(item)}
            onContextMenu={(e) => handleMoveContextMenu(e, item)}
            onTouchStart={(e) => handleTouchStart(e, item)}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
          >
            {item.display}
            {move && renderNagSymbols(move)}
            {move && renderEvalClock(move)}
          </span>,
          ' ',
        ];

        // Render comment block (or editor) after the move
        if (move) {
          const commentEl = renderComment(move);
          if (commentEl) {
            elements.push(commentEl, ' ');
          }
        }

        return elements;
      } else if (isBracketItem(item)) {
        return [
          <span
            key={`bracket-${item.bracketType}-${item.parentMoveIndex}-${item.variationIndex}-${index}`}
            className={getBracketClasses(item)}
          >
            {item.bracketType === 'open' ? '(' : ')'}
          </span>,
          ' ',
        ];
      }
      return [];
    });
  };

  return (
    <div className="review-move-list-wrapper">
      <div ref={movesContainerRef} className="review-moves-container">
        {!history || history.length === 0 ? (
          <div className="review-no-moves">No moves</div>
        ) : (
          <div className="review-moves-list">{renderMovesList()}</div>
        )}
      </div>

      {contextMenu.visible && contextMenu.move && (
        <div
          className="review-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x, transform: 'translateY(-100%)' }}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {/* NAG annotation buttons */}
          {onSetNag && (
            <>
              <div className="review-context-menu__label">
                {t('review.annotate', 'Annotate')}
              </div>
              <div className="review-context-menu__nag-row">
                {NAG_BUTTONS.map(({ nag, label }) => {
                  const isActive = contextMenu.move?.nags?.includes(nag) ?? false;
                  return (
                    <button
                      key={nag}
                      className={`review-nag-btn${isActive ? ' review-nag-btn--active' : ''}`}
                      data-nag={nag}
                      onClick={() => handleNagToggle(nag)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="review-context-menu__divider" />
            </>
          )}

          {/* Comment button */}
          {onSetComment && (
            <>
              <button
                className="review-context-menu__item"
                onClick={() => openCommentEditor(contextMenu.move!)}
              >
                {contextMenu.move.comment
                  ? t('review.editComment', '✎ Edit comment')
                  : t('review.addComment', '+ Add comment')}
              </button>
              <div className="review-context-menu__divider" />
            </>
          )}

          {onPromoteVariation && (
            <button
              className="review-context-menu__item"
              onClick={() => {
                onPromoteVariation(contextMenu.move!);
                closeContextMenu();
              }}
            >
              ↑ {t('review.promote', 'Promote')}
            </button>
          )}
          {onTruncateRemaining && (
            <button
              className="review-context-menu__item"
              onClick={() => {
                onTruncateRemaining(contextMenu.move!);
                closeContextMenu();
              }}
            >
              ] {t('review.truncate', 'Truncate')}
            </button>
          )}
          {onDeleteVariation && (
            <button
              className="review-context-menu__item review-context-menu__item--danger"
              onClick={() => {
                onDeleteVariation(contextMenu.move!);
                closeContextMenu();
              }}
            >
              ✕ {t('review.delete', 'Delete')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
