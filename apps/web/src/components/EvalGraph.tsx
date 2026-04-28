import { useMemo, useCallback } from 'react';
import type { MoveAnalysis } from '../hooks/useGameReport';

interface EvalGraphProps {
  moves: MoveAnalysis[];
  currentMoveIndex?: number;
  onSelectMove?: (index: number) => void;
}

/** Convert eval to centipawns from white's perspective, clamped to ±500 */
function evalToWhiteCp(ev: { type: 'cp' | 'mate'; value: number } | null, isAfterWhiteMove: boolean): number {
  if (!ev) return 0;
  if (ev.type === 'mate') {
    // After white's move, eval is from black's perspective (side to move)
    // After black's move, eval is from white's perspective
    const sign = isAfterWhiteMove ? -1 : 1;
    return ev.value === 0 ? (sign > 0 ? 500 : -500) : sign * (ev.value > 0 ? 500 : -500);
  }
  // evalAfter is from perspective of side to move AFTER the move (opponent)
  const sign = isAfterWhiteMove ? -1 : 1;
  return Math.max(-500, Math.min(500, sign * ev.value));
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  brilliant: '#1baca6',
  best: '#96bc4b',
  good: 'transparent',
  inaccuracy: '#f7c631',
  mistake: '#e58f2a',
  blunder: '#ca3431',
  book: '#a88764',
};

export function EvalGraph({ moves, currentMoveIndex, onSelectMove }: EvalGraphProps) {
  const height = 120;
  const midY = height / 2;

  const points = useMemo(() => {
    return moves.map((m, i) => {
      const cp = evalToWhiteCp(m.evalAfter, m.color === 'white');
      // Map ±500cp to ±midY
      const y = midY - (cp / 500) * midY;
      const x = (i / Math.max(moves.length - 1, 1)) * 100;
      return { x, y, classification: m.classification, index: i };
    });
  }, [moves, midY]);

  const pathD = useMemo(() => {
    if (points.length === 0) return '';
    const parts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`);
    return parts.join(' ');
  }, [points]);

  // Fill area: path + close to bottom-right-left
  const fillD = useMemo(() => {
    if (points.length === 0) return '';
    // White advantage area (above midline)
    const above = points.map((p, i) => {
      const cy = Math.min(p.y, midY);
      return `${i === 0 ? 'M' : 'L'}${p.x},${cy}`;
    });
    above.push(`L${points[points.length - 1].x},${midY}`);
    above.push(`L${points[0].x},${midY}`);
    above.push('Z');

    // Black advantage area (below midline)
    const below = points.map((p, i) => {
      const cy = Math.max(p.y, midY);
      return `${i === 0 ? 'M' : 'L'}${p.x},${cy}`;
    });
    below.push(`L${points[points.length - 1].x},${midY}`);
    below.push(`L${points[0].x},${midY}`);
    below.push('Z');

    return { above: above.join(' '), below: below.join(' ') };
  }, [points, midY]);

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!onSelectMove || moves.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const idx = Math.round(x * (moves.length - 1));
      onSelectMove(Math.max(0, Math.min(moves.length - 1, idx)));
    },
    [onSelectMove, moves.length],
  );

  if (moves.length === 0) return null;

  const currentX = currentMoveIndex != null && currentMoveIndex < points.length
    ? points[currentMoveIndex].x
    : null;

  return (
    <div className="eval-graph">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="eval-graph__svg"
        onClick={handleClick}
      >
        {/* White advantage fill */}
        {typeof fillD === 'object' && (
          <>
            <path d={fillD.above} fill="rgba(255,255,255,0.15)" />
            <path d={fillD.below} fill="rgba(0,0,0,0.25)" />
          </>
        )}
        {/* Center line */}
        <line x1="0" y1={midY} x2="100" y2={midY} stroke="#555" strokeWidth="0.3" />
        {/* Eval line */}
        <path d={pathD} fill="none" stroke="#8888ff" strokeWidth="0.8" />
        {/* Classification dots for notable moves */}
        {points.map((p) =>
          p.classification !== 'good' && p.classification !== 'best' && p.classification !== 'book' ? (
            <circle
              key={p.index}
              cx={p.x}
              cy={p.y}
              r="1.5"
              fill={CLASSIFICATION_COLORS[p.classification] || '#888'}
            />
          ) : null,
        )}
        {/* Current move indicator */}
        {currentX != null && (
          <line x1={currentX} y1="0" x2={currentX} y2={height} stroke="#fff" strokeWidth="0.4" opacity="0.6" />
        )}
      </svg>
    </div>
  );
}
