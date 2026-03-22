import type { EvalLine } from '../hooks/useStockfish';
import { formatEval, evalToPercent } from '../utils/chessFormat';

type Props = {
  lines: EvalLine[];
  isBlackTurn: boolean;
};

export function EvalBar({ lines, isBlackTurn }: Props) {
  const whitePercent = evalToPercent(lines, isBlackTurn);

  return (
    <div className="eval-bar-container">
      <div className="eval-bar">
        <div
          className="eval-bar-white"
          style={{ transform: `scaleY(${whitePercent / 100})` }}
        />
        <div className="eval-bar-label">
          {lines.length > 0 ? formatEval(lines[0], isBlackTurn) : '0.0'}
        </div>
      </div>
    </div>
  );
}
