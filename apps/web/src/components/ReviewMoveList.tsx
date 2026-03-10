import { useCallback, useEffect, useRef } from 'react';
import type { GameMove } from '../hooks/useChessGame';

// ---------------------------------------------------------------------------
// Processing: flatten move tree into renderable items
// ---------------------------------------------------------------------------

interface MoveItem {
  type: 'move';
  move: GameMove;
  display: string;
  isCurrent: boolean;
  isVariation: boolean;
  level: number;
  key: string;
}

interface BracketItem {
  type: 'bracket';
  bracketType: 'open' | 'close';
  level: number;
  key: string;
}

type RenderItem = MoveItem | BracketItem;

function formatDisplay(
  move: GameMove,
  indexInLine: number,
  level: number,
  prevMove: GameMove | undefined,
): string {
  const ply = move.ply;
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;

  // First move of a variation always shows move number
  if (level > 0 && indexInLine === 0) {
    return isWhite ? `${moveNumber}.${move.san}` : `${moveNumber}...${move.san}`;
  }

  // Black move after a variation block needs move number prefix
  if (!isWhite && prevMove && prevMove.variations.length > 0) {
    return `${moveNumber}...${move.san}`;
  }

  return isWhite ? `${moveNumber}.${move.san}` : move.san;
}

let keyCounter = 0;
function nextKey(): string {
  return String(keyCounter++);
}

function processHistory(
  moves: GameMove[],
  currentGlobalIndex: number | null,
  level: number,
): RenderItem[] {
  const result: RenderItem[] = [];

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const prevMove = i > 0 ? moves[i - 1] : undefined;

    const display = formatDisplay(move, i, level, prevMove);

    result.push({
      type: 'move',
      move,
      display,
      isCurrent: move.globalIndex === currentGlobalIndex,
      isVariation: level > 0,
      level,
      key: `m-${move.globalIndex}`,
    });

    // Process variation branches attached to this move
    if (move.variations.length > 0) {
      move.variations.forEach((variation, vIdx) => {
        const brKey = `v-${move.globalIndex}-${vIdx}`;
        result.push({
          type: 'bracket',
          bracketType: 'open',
          level,
          key: `open-${brKey}`,
        });
        result.push(...processHistory(variation, currentGlobalIndex, level + 1));
        result.push({
          type: 'bracket',
          bracketType: 'close',
          level,
          key: `close-${brKey}`,
        });
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  history: GameMove[];
  currentMoveIndex: number;
  currentMove: GameMove | null;
  onMoveClick: (move: GameMove | null) => void;
  onPromoteVariation: (move: GameMove) => void;
  onDeleteVariation: (move: GameMove) => void;
  onTruncateRemaining: (move: GameMove) => void;
}

export function ReviewMoveList({
  history,
  currentMoveIndex,
  currentMove,
  onMoveClick,
  onPromoteVariation,
  onDeleteVariation,
  onTruncateRemaining,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const items = processHistory(history, currentMoveIndex, 0);

  const handleClick = useCallback(
    (move: GameMove) => {
      onMoveClick(move);
    },
    [onMoveClick],
  );

  // Determine if current move is in a variation (globalIndex >= 1000)
  const currentIsVariation =
    currentMove !== null && currentMove.globalIndex >= 1000;

  // Scroll active move into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector('.review-move.active') as HTMLElement | null;
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
  }, [currentMoveIndex]);

  if (history.length === 0) {
    return (
      <div className="review-move-list">
        <div className="review-move-list__empty">No moves</div>
      </div>
    );
  }

  return (
    <div className="review-move-list">
      <div className="review-move-list__moves" ref={containerRef}>
        {items.map((item) => {
          if (item.type === 'bracket') {
            return (
              <span
                key={item.key}
                className={`review-bracket review-bracket--${item.bracketType} review-level-${Math.min(item.level, 4)}`}
              >
                {item.bracketType === 'open' ? ' (' : ') '}
              </span>
            );
          }

          const { move, display, isCurrent, isVariation, level } = item;
          const classes = [
            'review-move',
            isCurrent ? 'active' : '',
            isVariation ? 'variation' : '',
            level > 0 ? `review-level-${Math.min(level, 4)}` : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <span
              key={item.key}
              className={classes}
              onClick={() => handleClick(move)}
            >
              {display}
            </span>
          );
        })}
      </div>

      {/* Editor panel for variation moves */}
      {currentIsVariation && currentMove && (
        <div className="review-editor-panel">
          <button
            className="review-editor-btn"
            onClick={() => onPromoteVariation(currentMove)}
            title="Promote variation to main line"
          >
            &#x2191; Promote
          </button>
          <button
            className="review-editor-btn review-editor-btn--danger"
            onClick={() => onDeleteVariation(currentMove)}
            title="Delete this variation"
          >
            &#x2715; Delete
          </button>
          <button
            className="review-editor-btn"
            onClick={() => onTruncateRemaining(currentMove)}
            title="Delete remaining moves in this line"
          >
            ] Truncate
          </button>
        </div>
      )}
    </div>
  );
}
