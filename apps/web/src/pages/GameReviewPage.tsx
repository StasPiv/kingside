import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import { useStockfish } from '../hooks/useStockfish';
import type { EvalLine } from '../hooks/useStockfish';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardHighlights } from '../hooks/useBoardHighlights';
import { INITIAL_FEN } from '@kingside/shared';
import { api } from '../api';

type GameData = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  status: string;
  ratingChange?: {
    whiteRatingBefore: number;
    whiteRatingAfter: number;
    blackRatingBefore: number;
    blackRatingAfter: number;
  };
};

type MoveData = {
  san: string;
  uci: string;
  fenAfter: string;
};

function formatEval(line: EvalLine, isBlackTurn = false): string {
  const sign = isBlackTurn ? -1 : 1;
  if (line.score.type === 'mate') {
    const mateValue = sign * line.score.value;
    return mateValue === 0 ? '#' : `M${Math.abs(mateValue)}`;
  }
  const cp = sign * line.score.value / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(1);
}

function evalToPercent(lines: EvalLine[], isBlackTurn: boolean): number {
  if (lines.length === 0) return 50;
  const line = lines[0];
  // Stockfish returns score from the perspective of the side to move.
  // Invert when it's black's turn so the result is always from white's perspective.
  const sign = isBlackTurn ? -1 : 1;
  if (line.score.type === 'mate') {
    const mateValue = sign * line.score.value;
    return mateValue > 0 ? 95 : mateValue < 0 ? 5 : 50;
  }
  const cp = sign * line.score.value;
  const pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
  return Math.max(2, Math.min(98, pct));
}

function formatPv(pv: string, fen: string): string {
  try {
    const chess = new Chess(fen);
    const uciMoves = pv.split(' ');
    const fenParts = fen.split(' ');
    let isWhiteTurn = fenParts[1] === 'w';
    let moveNumber = parseInt(fenParts[5] || '1', 10);
    const parts: string[] = [];
    for (const uci of uciMoves.slice(0, 8)) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const move = chess.move({ from, to, promotion });
      if (!move) break;
      if (isWhiteTurn) {
        parts.push(`${moveNumber}. ${move.san}`);
      } else if (parts.length === 0) {
        parts.push(`${moveNumber}... ${move.san}`);
      } else {
        parts.push(move.san);
      }
      if (!isWhiteTurn) {
        moveNumber++;
      }
      isWhiteTurn = !isWhiteTurn;
    }
    return parts.join(' ');
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
  const { boardThemeOptions } = useBoardTheme();

  const game = useMemo(() => new Chess(), []);

  const [analysisEnabled, setAnalysisEnabled] = useState(true);

  const { lines, analysisFen, evaluate, stop: stopEngine, cleanup: cleanupEngine, init: initEngine, isReady, state: sfState } = useStockfish({
    depth: 18,
    multiPv: 3,
    autoStart: analysisEnabled,
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

  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      if (prev) {
        // Turning off: stop engine and terminate worker
        stopEngine();
        cleanupEngine();
      } else {
        // Turning on: re-init engine
        initEngine();
      }
      return !prev;
    });
  }, [stopEngine, cleanupEngine, initEngine]);

  // Auto-evaluate when position changes (debounced to avoid WASM crashes)
  useEffect(() => {
    if (!analysisEnabled || !isReady || !currentFen) return;
    const timer = setTimeout(() => {
      evaluate(currentFen);
    }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate, analysisEnabled]);

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

  const { squareStyles, setLastMove } = useBoardHighlights({
    game,
    playerColor: null,
    enabled: false,
  });

  useEffect(() => {
    if (currentMoveIndex >= 0 && moves[currentMoveIndex]) {
      const uci = moves[currentMoveIndex].uci;
      setLastMove(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square);
    }
  }, [currentMoveIndex, moves, setLastMove]);

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: 'white' as const,
      animationDurationInMs: 200,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
    }),
    [stablePosition, boardStyle, boardThemeOptions, squareStyles],
  );

  const isBlackTurn = currentFen.split(' ')[1] === 'b';
  // Use isBlackTurn from the FEN for which lines were computed, not current FEN.
  // This prevents the eval bar from briefly showing an inverted value when the
  // position changes but Stockfish has not yet started analysing the new FEN.
  const evalIsBlackTurn = analysisFen ? analysisFen.split(' ')[1] === 'b' : isBlackTurn;
  const whitePercent = evalToPercent(lines, evalIsBlackTurn);

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
                  {lines.length > 0 ? formatEval(lines[0], evalIsBlackTurn) : '0.0'}
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
        {/* Engine analysis panel — in sidebar */}
        <div className="stockfish-panel">
          <div className="stockfish-panel-header">
            <span>
              Stockfish 18 {analysisEnabled && sfState === 'analyzing' && lines.length > 0
                ? `· ${t('analysis.depth')} ${lines[0].depth}`
                : analysisEnabled && sfState === 'loading'
                  ? `· ${t('common.loading')}`
                  : analysisEnabled && sfState === 'error'
                    ? ` · ${t('analysis.engineError', 'Engine error')}`
                    : analysisEnabled && sfState === 'ready' && lines.length === 0
                      ? ` · ${t('analysis.ready', 'Ready')}`
                      : !analysisEnabled
                        ? ` · ${t('analysis.off', 'Off')}`
                        : ''}
            </span>
            <button
              className="analysis-toggle-btn"
              onClick={toggleAnalysis}
              title={analysisEnabled ? t('analysis.stop', 'Stop analysis') : t('analysis.start', 'Start analysis')}
              data-testid="stockfish-toggle"
              style={{
                padding: '2px 10px',
                fontSize: 13,
                cursor: 'pointer',
                borderRadius: 4,
                border: '1px solid #555',
                background: analysisEnabled ? '#dc2626' : '#16a34a',
                color: '#fff',
                marginLeft: 8,
                whiteSpace: 'nowrap',
              }}
            >
              {analysisEnabled ? t('analysis.stop', 'Stop') : t('analysis.start', 'Start')}
            </button>
          </div>
          {analysisEnabled && lines.length > 0 && (
            <div className="stockfish-lines">
              {lines.map((line) => (
                <div key={line.multipv} className="stockfish-line">
                  <span className={`stockfish-eval${line.score.type === 'mate' ? ' mate' : line.multipv === 1 ? ' best' : ''}`}>
                    {formatEval(line)}
                  </span>
                  <span className="stockfish-pv">
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
          {gameData.ratingChange && (
            <div className="analysis-ratings">
              <div className="analysis-rating-row">
                <span className="color-indicator white" />
                <span>{gameData.white.username}</span>
                <span className="rating-change-inline">
                  {gameData.ratingChange.whiteRatingBefore} &rarr; {gameData.ratingChange.whiteRatingAfter}
                  <span className={`rating-diff ${gameData.ratingChange.whiteRatingAfter - gameData.ratingChange.whiteRatingBefore > 0 ? 'positive' : gameData.ratingChange.whiteRatingAfter - gameData.ratingChange.whiteRatingBefore < 0 ? 'negative' : ''}`}>
                    ({gameData.ratingChange.whiteRatingAfter - gameData.ratingChange.whiteRatingBefore > 0 ? '+' : ''}{gameData.ratingChange.whiteRatingAfter - gameData.ratingChange.whiteRatingBefore})
                  </span>
                </span>
              </div>
              <div className="analysis-rating-row">
                <span className="color-indicator black" />
                <span>{gameData.black.username}</span>
                <span className="rating-change-inline">
                  {gameData.ratingChange.blackRatingBefore} &rarr; {gameData.ratingChange.blackRatingAfter}
                  <span className={`rating-diff ${gameData.ratingChange.blackRatingAfter - gameData.ratingChange.blackRatingBefore > 0 ? 'positive' : gameData.ratingChange.blackRatingAfter - gameData.ratingChange.blackRatingBefore < 0 ? 'negative' : ''}`}>
                    ({gameData.ratingChange.blackRatingAfter - gameData.ratingChange.blackRatingBefore > 0 ? '+' : ''}{gameData.ratingChange.blackRatingAfter - gameData.ratingChange.blackRatingBefore})
                  </span>
                </span>
              </div>
            </div>
          )}
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

        <Link to={`/game/${gameId}`} className="analysis-back-link">{t('review.backToGame')}</Link>
        <Link to="/profile" className="analysis-back-link">{t('review.backToProfile')}</Link>
      </div>
    </div>
  );
}
