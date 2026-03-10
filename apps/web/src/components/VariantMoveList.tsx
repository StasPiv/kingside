import { useCallback, useEffect, useRef } from 'react';
import type { GameMove } from '../hooks/useChessGame';

// ---------------------------------------------------------------------------
// Processing: flatten move tree into renderable items
// ---------------------------------------------------------------------------

interface MoveItem {
  type: 'move';
  move: GameMove;
  display: string;    // e.g. "1.e4", "1...e5", "Nf3"
  isCurrent: boolean;
  isVariation: boolean;
  level: number;
}

interface BracketItem {
  type: 'bracket';
  bracketType: 'open' | 'close';
  level: number;
  key: string;
}

type RenderItem = MoveItem | BracketItem;

function formatDisplay(move: GameMove, indexInLine: number, level: number): string {
  const ply = move.ply;
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;

  if (level > 0 && indexInLine === 0) {
    return isWhite ? `${moveNumber}.${move.san}` : `${moveNumber}...${move.san}`;
  }
  return isWhite ? `${moveNumber}.${move.san}` : move.san;
}

function processHistory(
  moves: GameMove[],
  currentGlobalIndex: number | null,
  level: number,
  parentKey: string,
): RenderItem[] {
  const result: RenderItem[] = [];

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];

    // After a variation block, black's next move needs move number prefix
    const needsNumberPrefix =
      i > 0 &&
      moves[i - 1].variations.length > 0 &&
      move.ply % 2 === 0;

    let display = formatDisplay(move, i, level);
    if (needsNumberPrefix && level === 0 && i > 0) {
      const moveNumber = Math.ceil(move.ply / 2);
      display = `${moveNumber}...${move.san}`;
    }

    result.push({
      type: 'move',
      move,
      display,
      isCurrent: move.globalIndex === currentGlobalIndex,
      isVariation: level > 0,
      level,
    });

    // Process variation branches
    if (move.variations.length > 0) {
      move.variations.forEach((variation, vIdx) => {
        const brKey = `${parentKey}-${move.globalIndex}-v${vIdx}`;
        result.push({ type: 'bracket', bracketType: 'open', level, key: `open-${brKey}` });
        result.push(...processHistory(variation, currentGlobalIndex, level + 1, brKey));
        result.push({ type: 'bracket', bracketType: 'close', level, key: `close-${brKey}` });
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
  currentMove: GameMove | null;
  onMoveClick: (move: GameMove) => void;
}

export function VariantMoveList({ history, currentMove, onMoveClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentGlobalIndex = currentMove?.globalIndex ?? null;

  const items = processHistory(history, currentGlobalIndex, 0, 'root');

  const handleClick = useCallback(
    (move: GameMove) => {
      onMoveClick(move);
    },
    [onMoveClick],
  );

  // Scroll active move into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector('.vml-move.active') as HTMLElement | null;
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

  if (history.length === 0) {
    return (
      <div className="vml-container">
        <div className="vml-empty">No moves</div>
      </div>
    );
  }

  return (
    <div className="vml-container" ref={containerRef}>
      <div className="vml-moves">
        {items.map((item, idx) => {
          if (item.type === 'bracket') {
            return (
              <span
                key={item.key}
                className={`vml-bracket vml-bracket-${item.bracketType} vml-level-${Math.min(item.level, 4)}`}
              >
                {item.bracketType === 'open' ? '(' : ')'}
              </span>
            );
          }

          const { move, display, isCurrent, isVariation, level } = item;
          const classes = [
            'vml-move',
            isCurrent ? 'active' : '',
            isVariation ? 'variation' : '',
            level > 0 ? `vml-level-${Math.min(level, 4)}` : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <span
              key={`${move.globalIndex}-${idx}`}
              className={classes}
              onClick={() => handleClick(move)}
            >
              {display}
            </span>
          );
        })}
      </div>
    </div>
  );
}
