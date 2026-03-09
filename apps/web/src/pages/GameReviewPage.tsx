import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import { useStockfish } from '../hooks/useStockfish';
import type { EvalLine } from '../hooks/useStockfish';
import { useContainerWidth } from '../hooks/useContainerWidth';
import {
  INITIAL_FEN,
  GameEvents,
  type WsGameStatePayload,
} from '@kingside/shared';
import { socket } from '../socket';

type MoveData = {
  san: string;
  fenAfter: string;
};

function buildMoveList(moves: string[]): MoveData[] {
  const chess = new Chess();
  const result: MoveData[] = [];
  for (const san of moves) {
    chess.move(san);
    result.push({ san, fenAfter: chess.fen() });
  }
  return result;
}

function formatEval(line: EvalLine): string {
  if (line.score.type === 'mate') {
    return line.score.value === 0 ? '#' : `M${Math.abs(line.score.value)}`;
  }
  const cp = line.score.value / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(1);
}

function evalToPercent(lines: EvalLine[]): number {
  if (lines.length === 0) return 50;
  const line = lines[0];
  if (line.score.type === 'mate') {
    return line.score.value > 0 ? 95 : line.score.value < 0 ? 5 : 50;
  }
  const cp = line.score.value;
  // Sigmoid-like mapping: ±500cp -> ~5-95%
  const pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
  return Math.max(2, Math.min(98, pct));
}

function formatPv(pv: string, fen: string): string {
  try {
    const chess = new Chess(fen);
    const uciMoves = pv.split(' ');
    const sanMoves: string[] = [];
    for (const uci of uciMoves.slice(0, 8)) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const move = chess.move({ from, to, promotion });
      if (!move) break;
      sanMoves.push(move.san);
    }
    return sanMoves.join(' ');
  } catch {
    return pv.split(' ').slice(0, 8).join(' ');
  }
}

export function GameReviewPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const { t } = useTranslation();
  const [moveList, setMoveList] = useState<MoveData[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1); // -1 = initial position
  const [players, setPlayers] = useState<{ white: string; black: string }>({ white: '', black: '' });
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const movesContainerRef = useRef<HTMLDivElement>(null);

  const { lines, evaluate, isReady, state: sfState } = useStockfish({
    depth: 18,
    multiPv: 3,
  });

  // Load game state via WebSocket
  useEffect(() => {
    const onGameState = (state: WsGameStatePayload) => {
      const built = buildMoveList(state.moves);
      setMoveList(built);
      setCurrentIndex(built.length - 1);
      setPlayers(state.players ?? { white: '', black: '' });
      setResult(state.result ?? null);
      setLoading(false);
    };

    socket.on(GameEvents.STATE, onGameState);
    socket.emit(GameEvents.JOIN, { gameId });

    return () => {
      socket.off(GameEvents.STATE, onGameState);
    };
  }, [gameId]);

  // Current FEN
  const currentFen = useMemo(() => {
    if (currentIndex < 0) return INITIAL_FEN;
    return moveList[currentIndex]?.fenAfter ?? INITIAL_FEN;
  }, [currentIndex, moveList]);

  // Auto-evaluate when position changes
  useEffect(() => {
    if (isReady && currentFen) {
      evaluate(currentFen);
    }
  }, [currentFen, isReady, evaluate]);

  // Scroll active move into view
  useEffect(() => {
    if (movesContainerRef.current) {
      const active = movesContainerRef.current.querySelector('.analysis-move.active');
      active?.scrollIntoView({ block: 'nearest' });
    }
  }, [currentIndex]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentIndex((prev) => Math.max(-1, prev - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrentIndex((prev) => Math.min(moveList.length - 1, prev + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCurrentIndex(-1);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCurrentIndex(moveList.length - 1);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [moveList.length]);

  const goToMove = useCallback((index: number) => {
    setCurrentIndex(index);
  }, []);

  const goFirst = useCallback(() => setCurrentIndex(-1), []);
  const goPrev = useCallback(() => setCurrentIndex((prev) => Math.max(-1, prev - 1)), []);
  const goNext = useCallback(() => setCurrentIndex((prev) => Math.min(moveList.length - 1, prev + 1)), [moveList.length]);
  const goLast = useCallback(() => setCurrentIndex(moveList.length - 1), [moveList.length]);

  const stablePosition = useStablePosition(currentFen);

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: 'white' as const,
      animationDurationInMs: 0,
      allowDragging: false,
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, boardStyle],
  );

  const whitePercent = evalToPercent(lines);

  if (loading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  return (
    <div className="analysis-page">
      <div className="analysis-board-area">
        <div className="analysis-board-wrapper">
          <div className="analysis-player-info">
            <span className="color-indicator black" />
            <span className="player-name">{players.black || 'Black'}</span>
          </div>

          <div style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
            <div className="eval-bar-container">
              <div className="eval-bar">
                <div
                  className="eval-bar-white"
                  style={{ height: `${whitePercent}%` }}
                />
                <div className="eval-bar-label">
                  {lines.length > 0 ? formatEval(lines[0]) : '0.0'}
                </div>
              </div>
            </div>
            <div className="board-container" ref={boardContainerRef}>
              <MemoChessboard options={boardOptions} />
            </div>
          </div>

          <div className="analysis-player-info">
            <span className="color-indicator white" />
            <span className="player-name">{players.white || 'White'}</span>
          </div>

          <div className="analysis-board-controls">
            <button onClick={goFirst} disabled={currentIndex === -1}>&#x21E4;</button>
            <button onClick={goPrev} disabled={currentIndex === -1}>&#x2190;</button>
            <button onClick={goNext} disabled={currentIndex >= moveList.length - 1}>&#x2192;</button>
            <button onClick={goLast} disabled={currentIndex >= moveList.length - 1}>&#x21E5;</button>
          </div>
        </div>
      </div>

      <div className="analysis-sidebar">
        {/* Engine analysis panel */}
        <div className="analysis-progress">
          <div className="analysis-progress-text">
            Stockfish 18 {sfState === 'analyzing' && lines.length > 0
              ? `· ${t('analysis.depth')} ${lines[0].depth}`
              : sfState === 'loading'
                ? `· ${t('common.loading')}`
                : ''}
          </div>
          {lines.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {lines.map((line) => (
                <div key={line.multipv} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                  <span style={{
                    minWidth: 44,
                    fontWeight: 700,
                    color: line.score.type === 'mate'
                      ? '#ef4444'
                      : (line.multipv === 1 ? '#fff' : '#a0a0c0'),
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {formatEval(line)}
                  </span>
                  <span style={{ color: '#a0a0c0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatPv(line.pv, currentFen)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Move list */}
        <div className="analysis-moves" ref={movesContainerRef}>
          {moveList.map((move, i) =>
            i % 2 === 0 ? (
              <div key={i} className="analysis-move-pair">
                <span className="move-number">{Math.floor(i / 2) + 1}.</span>
                <span
                  className={`analysis-move${currentIndex === i ? ' active' : ''}`}
                  onClick={() => goToMove(i)}
                >
                  {move.san}
                </span>
                {moveList[i + 1] && (
                  <span
                    className={`analysis-move${currentIndex === i + 1 ? ' active' : ''}`}
                    onClick={() => goToMove(i + 1)}
                  >
                    {moveList[i + 1].san}
                  </span>
                )}
              </div>
            ) : null,
          )}
        </div>

        {/* Game result */}
        {result && (
          <div className="analysis-result">
            {result === 'draw'
              ? t('game.draw')
              : result === 'white_wins'
                ? t('game.whiteWins')
                : t('game.blackWins')}
          </div>
        )}

        <Link to="/lobby" className="analysis-back-link">
          {t('analysis.backToLobby')}
        </Link>
      </div>
    </div>
  );
}
