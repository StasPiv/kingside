import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChessMove } from '../types';
import { nagToSymbol } from '../utils/nagUtils';
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
  onPromoteVariation: (move: ChessMove) => void;
  onDeleteVariation: (move: ChessMove) => void;
  onTruncateRemaining: (move: ChessMove) => void;
  onSetNag?: (globalIndex: number, nags: number[]) => void;
  onSetComment?: (globalIndex: number, comment: string) => void;
  gameInfo?: GameInfo;
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
  gameInfo,
}: ReviewMoveListProps) {
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
    e.preventDefault();
    e.stopPropagation();
    if (processedMove.originalMove) {
      showContextMenu(e, processedMove.originalMove);
    }
  };

  const handleTouchStart = (e: React.TouchEvent, processedMove: ProcessedMove): void => {
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

  const handleNagToggle = (nag: number) => {
    if (!contextMenu.move || !onSetNag) return;
    const move = contextMenu.move;
    const currentNags = move.nags ?? [];
    const hasNag = currentNags.includes(nag);
    const newNags = hasNag
      ? currentNags.filter((n) => n !== nag)
      : [...currentNags, nag];
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

  /** Render NAG symbols for a move */
  const renderNagSymbols = (move: ChessMove) => {
    if (!move.nags || move.nags.length === 0) return null;
    // Only render move-quality NAGs (1-6) inline with the move text
    const moveNags = move.nags.filter((n) => n >= 1 && n <= 6);
    if (moveNags.length === 0) return null;
    return moveNags.map((nag) => {
      let className = 'review-nag';
      if (nag === 1 || nag === 3) className += ' review-nag--good';
      else if (nag === 2 || nag === 4) className += ' review-nag--bad';
      else if (nag === 5 || nag === 6) className += ' review-nag--interesting';
      return (
        <span key={`nag-${nag}`} className={className}>
          {nagToSymbol(nag)}
        </span>
      );
    });
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
      {gameInfo && (
        <div className="review-game-info">
          {gameInfo.opening && (
            <div className="review-game-info-opening">{gameInfo.opening}</div>
          )}
          <div className="review-game-info-players">
            <span className="review-game-info-player">
              <span className="review-game-info-color review-game-info-color--white" />
              {gameInfo.white.username}
              {gameInfo.white.rating != null && (
                <span className="review-game-info-rating">({gameInfo.white.rating})</span>
              )}
            </span>
            <span className="review-game-info-vs">vs</span>
            <span className="review-game-info-player">
              <span className="review-game-info-color review-game-info-color--black" />
              {gameInfo.black.username}
              {gameInfo.black.rating != null && (
                <span className="review-game-info-rating">({gameInfo.black.rating})</span>
              )}
            </span>
          </div>
          {gameInfo.result && (
            <div className="review-game-info-result">{gameInfo.result}</div>
          )}
          {(gameInfo.event || gameInfo.date) && (
            <div className="review-game-info-meta">
              {gameInfo.event && <span>{gameInfo.event}</span>}
              {gameInfo.event && gameInfo.date && <span> — </span>}
              {gameInfo.date && <span>{gameInfo.date}</span>}
            </div>
          )}
        </div>
      )}
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

          <button
            className="review-context-menu__item"
            onClick={() => {
              onPromoteVariation(contextMenu.move!);
              closeContextMenu();
            }}
          >
            ↑ {t('review.promote', 'Promote')}
          </button>
          <button
            className="review-context-menu__item"
            onClick={() => {
              onTruncateRemaining(contextMenu.move!);
              closeContextMenu();
            }}
          >
            ] {t('review.truncate', 'Truncate')}
          </button>
          <button
            className="review-context-menu__item review-context-menu__item--danger"
            onClick={() => {
              onDeleteVariation(contextMenu.move!);
              closeContextMenu();
            }}
          >
            ✕ {t('review.delete', 'Delete')}
          </button>
        </div>
      )}
    </div>
  );
}
