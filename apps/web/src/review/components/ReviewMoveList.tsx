import { useEffect, useRef, useState, useCallback } from 'react';
import { ChessMove } from '../types';
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
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  move: ChessMove | null;
}

interface ReviewMoveListProps {
  history: ChessMove[];
  currentGlobalIndex: number;
  onMoveClick: (move: ChessMove) => void;
  onPromoteVariation: (move: ChessMove) => void;
  onDeleteVariation: (move: ChessMove) => void;
  onTruncateRemaining: (move: ChessMove) => void;
  gameInfo?: GameInfo;
}

export function ReviewMoveList({
  history,
  currentGlobalIndex,
  onMoveClick,
  onPromoteVariation,
  onDeleteVariation,
  onTruncateRemaining,
  gameInfo,
}: ReviewMoveListProps) {
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

  useEffect(() => {
    const container = movesContainerRef.current;
    if (!container) return;
    const active = container.querySelector('.move-item.current') as HTMLElement | null;
    if (!active) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const itemTop = activeRect.top - containerRect.top + container.scrollTop;
    const itemBottom = itemTop + active.offsetHeight;
    const scrollTop = container.scrollTop;
    const scrollBottom = scrollTop + container.clientHeight;
    if (itemTop < scrollTop) {
      container.scrollTop = itemTop;
    } else if (itemBottom > scrollBottom) {
      container.scrollTop = itemBottom - container.clientHeight;
    }
  }, [currentGlobalIndex]);

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

  const renderMovesList = () => {
    if (!history || !Array.isArray(history) || history.length === 0) {
      return [];
    }

    const processedItems = processMoveHierarchy(history, currentGlobalIndex);

    return processedItems.flatMap((item, index) => {
      if (isProcessedMove(item)) {
        return [
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
          </span>,
          ' ',
        ];
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
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button
            className="review-context-menu__item"
            onClick={() => {
              onPromoteVariation(contextMenu.move!);
              closeContextMenu();
            }}
          >
            ↑ Promote
          </button>
          <button
            className="review-context-menu__item"
            onClick={() => {
              onTruncateRemaining(contextMenu.move!);
              closeContextMenu();
            }}
          >
            ] Truncate
          </button>
          <button
            className="review-context-menu__item review-context-menu__item--danger"
            onClick={() => {
              onDeleteVariation(contextMenu.move!);
              closeContextMenu();
            }}
          >
            ✕ Delete
          </button>
        </div>
      )}
    </div>
  );
}
