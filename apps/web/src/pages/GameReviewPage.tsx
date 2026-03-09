import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import { useStockfish } from '../hooks/useStockfish';
import type { EvalLine } from '../hooks/useStockfish';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { INITIAL_FEN } from '@kingside/shared';
import { api } from '../api';

type GameData = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  status: string;
};

type MoveData = {
  san: string;
  uci: string;
  fenAfter: string;
};

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
  const params = useParams<{ id?: string; gameId?: string }>();
  const gameId = params.id ?? params.gameId;
  const { t } = useTranslation();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [moves, setMoves] = useState<MoveData[]>([]);
  const [currentMoveIndex, setCurrentMoveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const movesContainerRef = useRef<HTMLDivElement>(null);

  const game = useMemo(() => new Chess(), []);

  const { lines, evaluate, isReady, state: sfState } = useStockfish({
    depth: 18,
    multiPv: 3,
  });

  useEffect(() => {
    if (!gameId) return;

    const fetchData = async () => {
      try {
        const [gData, mData] = await Promise.all([
          api.get<GameData>(`/api/games/${gameId}`),
          api.get<MoveData[]>(`/api/games/${gameId}/moves`),
        ]);
        setGameData(gData);
        setMoves(mData);
        setCurrentMoveIndex(mData.length - 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('review.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [gameId, t]);

  const currentFen = useMemo(() => {
    if (currentMoveIndex < 0) return INITIAL_FEN;
    return moves[currentMoveIndex]?.fenAfter ?? INITIAL_FEN;
  }, [currentMoveIndex, moves]);

  useEffect(() => {
    game.load(currentFen);
  }, [currentFen, game]);

  // Auto-evaluate when position changes (debounced to avoid WASM crashes)
  useEffect(() => {
    if (!isReady || !currentFen) return;
    const timer = setTimeout(() => {
      evaluate(currentFen);
    }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate]);

  const goToStart = useCallback(() => setCurrentMoveIndex(-1), []);
  const goToEnd = useCallback(() => setCurrentMoveIndex(moves.length - 1), [moves.length]);
  const goBack = useCallback(() => setCurrentMoveIndex((i) => Math.max(-1, i - 1)), []);
  const goForward = useCallback(() => setCurrentMoveIndex((i) => Math.min(moves.length - 1, i + 1)), [moves.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToStart();
      } else if (e.key === 'End') {
        e.preventDefault();
        goToEnd();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goBack, goForward, goToStart, goToEnd]);

  // Scroll active move into view
  useEffect(() => {
    if (movesContainerRef.current) {
      const active = movesContainerRef.current.querySelector('.analysis-move.active');
      active?.scrollIntoView({ block: 'nearest' });
    }
  }, [currentMoveIndex]);

  const stablePosition = useStablePosition(currentFen);

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: 'white' as const,
      animationDurationInMs: 200,
      allowDragging: false,
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, boardStyle],
  );

  const whitePercent = evalToPercent(lines);

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (!gameData) return null;

  const resultText = gameData.result === 'draw'
    ? t('game.draw')
    : gameData.result === 'white_wins'
      ? t('game.whiteWins')
      : t('game.blackWins');

  return (
    <div className="analysis-page">
      <div className="analysis-board-area">
        <div className="analysis-board-wrapper">
          <div className="analysis-player-info">
            <span className="color-indicator black" />
            <span className="player-name">{gameData.black.username}</span>
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
            <span className="player-name">{gameData.white.username}</span>
          </div>

          <div className="analysis-board-controls">
            <button onClick={goToStart} disabled={currentMoveIndex < 0} title={t('review.toStart')}>&#x21E4;</button>
            <button onClick={goBack} disabled={currentMoveIndex < 0} title={t('review.back')}>&#x2190;</button>
            <button onClick={goForward} disabled={currentMoveIndex >= moves.length - 1} title={t('review.forward')}>&#x2192;</button>
            <button onClick={goToEnd} disabled={currentMoveIndex >= moves.length - 1} title={t('review.toEnd')}>&#x21E5;</button>
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
                : sfState === 'error'
                  ? ` · ${t('analysis.engineError', 'Engine error')}`
                  : sfState === 'ready' && lines.length === 0
                    ? ` · ${t('analysis.ready', 'Ready')}`
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

        {/* Game result */}
        <div className="analysis-result">
          <h3>{t('game.finished')}</h3>
          <p>{resultText}</p>
        </div>

        {/* Move list */}
        <div className="analysis-moves" ref={movesContainerRef}>
          {moves.map((move, i) =>
            i % 2 === 0 ? (
              <div key={i} className="analysis-move-pair">
                <span className="move-number">{Math.floor(i / 2) + 1}.</span>
                <span
                  className={`analysis-move${currentMoveIndex === i ? ' active' : ''}`}
                  onClick={() => setCurrentMoveIndex(i)}
                >
                  {move.san}
                </span>
                {moves[i + 1] && (
                  <span
                    className={`analysis-move${currentMoveIndex === i + 1 ? ' active' : ''}`}
                    onClick={() => setCurrentMoveIndex(i + 1)}
                  >
                    {moves[i + 1].san}
                  </span>
                )}
              </div>
            ) : null,
          )}
        </div>

        <Link to="/profile" className="analysis-back-link">{t('review.backToProfile')}</Link>
      </div>
    </div>
  );
}
