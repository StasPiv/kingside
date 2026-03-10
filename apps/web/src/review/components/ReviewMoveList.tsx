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

export interface GameInfo {
  white: { username: string; rating?: number | null };
  black: { username: string; rating?: number | null };
  opening?: string;
  result?: string;
}

interface ReviewMoveListProps {
  history: ChessMove[];
  currentGlobalIndex: number;
  onMoveClick: (move: ChessMove) => void;
  gameInfo?: GameInfo;
}

export function ReviewMoveList({
  history,
  currentGlobalIndex,
  onMoveClick,
  gameInfo,
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

    return processedItems.flatMap((item, index) => {
      if (isProcessedMove(item)) {
        return [
          <span
            key={`move-${item.globalIndex}-${index}`}
            className={getMoveClasses(item)}
            onClick={() => handleMoveClick(item)}
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
    </div>
  );
}
