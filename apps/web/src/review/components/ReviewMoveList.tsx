import { useEffect, useRef } from 'react';
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

interface ReviewMoveListProps {
  history: ChessMove[];
  currentGlobalIndex: number;
  onMoveClick: (move: ChessMove) => void;
}

export function ReviewMoveList({
  history,
  currentGlobalIndex,
  onMoveClick,
}: ReviewMoveListProps) {
  const movesContainerRef = useRef<HTMLDivElement>(null);

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

  const handleMoveClick = (processedMove: ProcessedMove): void => {
    if (processedMove.originalMove) {
      onMoveClick(processedMove.originalMove);
    }
  };

  const renderMovesList = () => {
    if (!history || !Array.isArray(history) || history.length === 0) {
      return [];
    }

    const processedItems = processMoveHierarchy(history, currentGlobalIndex);

    return processedItems
      .map((item, index) => {
        if (isProcessedMove(item)) {
          return (
            <span
              key={`move-${item.globalIndex}-${index}`}
              className={getMoveClasses(item)}
              onClick={() => handleMoveClick(item)}
            >
              {item.display}
            </span>
          );
        } else if (isBracketItem(item)) {
          return (
            <span
              key={`bracket-${item.bracketType}-${item.parentMoveIndex}-${item.variationIndex}-${index}`}
              className={getBracketClasses(item)}
            >
              {item.bracketType === 'open' ? '(' : ')'}
            </span>
          );
        }
        return null;
      })
      .filter(Boolean);
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
    </div>
  );
}
