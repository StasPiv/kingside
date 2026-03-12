import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
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
import { api } from '../api';
import { useReviewState } from '../review/useReviewState';
import { useAnalysisPersistence } from '../review/useAnalysisPersistence';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import type { ChessMove } from '../review/types';
import { parseAnnotatedPgn } from '../review/utils/PgnDeserializer';
import { classifyOpening } from '../utils/ecoClassify';

type GameData = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  status: string;
  whiteRatingBefore?: number | null;
  blackRatingBefore?: number | null;
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
  const cp = (sign * line.score.value) / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(2);
}

function evalToPercent(lines: EvalLine[], isBlackTurn: boolean): number {
  if (lines.length === 0) return 50;
  const line = lines[0];
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
      let move;
      try {
        move = chess.move({ from, to, promotion });
      } catch {
        break;
      }
      if (!move) break;
      if (isWhiteTurn) {
        parts.push(`${moveNumber}. ${move.san}`);
      } else if (parts.length === 0) {
        parts.push(`${moveNumber}... ${move.san}`);
      } else {
        parts.push(move.san);
      }
      if (!isWhiteTurn) moveNumber++;
      isWhiteTurn = !isWhiteTurn;
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

const MULTI_PV = 3;

export function GameReviewPage() {
  const params = useParams<{ id?: string; gameId?: string }>();
  const gameId = params.id ?? params.gameId;
  const { t } = useTranslation();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const { boardThemeOptions } = useBoardTheme();

  const {
    history,
    currentMove,
    currentGlobalIndex,
    currentFen,
    isInVariation,
    loadMoves,
    loadFromPgn,
    gotoMove,
    gotoFirst,
    gotoLast,
    gotoPrevious,
    gotoNext,
    makeVariantMove,
    removeVariation,
    truncateRemaining,
    promoteVariation,
  } = useReviewState();

  const game = useMemo(() => new Chess(), []);

  // Resizable layout: horizontal split between board area and sidebar
  const analysisPageRef = useRef<HTMLDivElement>(null);
  const [boardAreaPx, setBoardAreaPx] = useState(() => {
    const saved = localStorage.getItem('analysis-layout-boardAreaPx');
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return Math.floor((window.innerWidth - 8) * 0.55);
  });
  const [enginePanelHeight, setEnginePanelHeight] = useState(() => {
    const saved = localStorage.getItem('analysis-layout-enginePanelHeight');
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 140;
  });

  useLayoutEffect(() => {
    if (loading) return;
    if (!analysisPageRef.current) return;
    const total = analysisPageRef.current.clientWidth;
    if (total === 0) return;
    // Only recalculate if no saved layout exists
    const saved = localStorage.getItem('analysis-layout-boardAreaPx');
    if (saved === null) {
      setBoardAreaPx(Math.floor((total - 8) * 0.55));
    }
  }, [loading]);

  const handleHResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startBoardPx = boardAreaPx;
      document.body.style.userSelect = 'none';
      let lastValue = startBoardPx;
      const onMouseMove = (ev: MouseEvent) => {
        const total = analysisPageRef.current?.clientWidth ?? 900;
        const delta = ev.clientX - startX;
        const next = Math.max(200, Math.min(total - 320, startBoardPx + delta));
        lastValue = next;
        setBoardAreaPx(next);
      };
      const onMouseUp = () => {
        document.body.style.userSelect = '';
        localStorage.setItem('analysis-layout-boardAreaPx', String(lastValue));
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [boardAreaPx],
  );

  const handleVResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = enginePanelHeight;
      let lastValue = startHeight;
      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startY;
        const next = Math.max(80, Math.min(500, startHeight + delta));
        lastValue = next;
        setEnginePanelHeight(next);
      };
      const onMouseUp = () => {
        localStorage.setItem('analysis-layout-enginePanelHeight', String(lastValue));
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [enginePanelHeight],
  );

  const wasmSupported = typeof WebAssembly !== 'undefined';
  const [analysisEnabled, setAnalysisEnabled] = useState<boolean>(() => {
    if (typeof WebAssembly === 'undefined') return false;
    // On touch devices (mobile) the 113 MB WASM binary often fails to compile —
    // don't auto-start the engine; the user can still start it manually.
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
      return false;
    }
    return true;
  });

  const {
    lines,
    analysisFen,
    evaluate,
    isReady,
    state: sfState,
  } = useStockfish({
    depth: 18,
    multiPv: MULTI_PV,
    autoStart: analysisEnabled,
  });

  const lastLinesRef = useRef<EvalLine[]>([]);
  if (lines.length === MULTI_PV) {
    lastLinesRef.current = lines;
  }
  const displayedLines = lines.length === MULTI_PV ? lines : lastLinesRef.current;

  useEffect(() => {
    if (!gameId) return;

    const fetchData = async () => {
      try {
        const isAuthenticated = Boolean(localStorage.getItem('token'));

        const requests: [
          Promise<GameData>,
          Promise<MoveData[]>,
          Promise<{ analysisPgn: string | null } | null>,
        ] = [
          api.get<GameData>(`/api/games/${gameId}`),
          api.get<MoveData[]>(`/api/games/${gameId}/moves`),
          isAuthenticated
            ? api.get<{ analysisPgn: string | null }>(`/api/games/${gameId}/analysis`).catch(() => null)
            : Promise.resolve(null),
        ];

        const [gData, mData, analysisData] = await Promise.all(requests);
        setGameData(gData);

        if (analysisData?.analysisPgn) {
          try {
            const parsedMoves = parseAnnotatedPgn(analysisData.analysisPgn);
            loadFromPgn(parsedMoves);
          } catch {
            loadMoves(mData);
          }
        } else {
          loadMoves(mData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('review.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [gameId, t, loadMoves, loadFromPgn]);

  useAnalysisPersistence(gameId, history);

  useEffect(() => {
    game.load(currentFen);
  }, [currentFen, game]);

  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      if (prev) {
        lastLinesRef.current = [];
      }
      return !prev;
    });
  }, []);

  // Auto-evaluate when position changes (debounced to avoid WASM crashes)
  useEffect(() => {
    if (!analysisEnabled || !isReady || !currentFen) return;
    const timer = setTimeout(() => {
      evaluate(currentFen);
    }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate, analysisEnabled]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gotoPrevious();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        gotoNext();
      } else if (e.key === 'Home') {
        e.preventDefault();
        gotoFirst();
      } else if (e.key === 'End') {
        e.preventDefault();
        gotoLast();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gotoPrevious, gotoNext, gotoFirst, gotoLast]);

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

  // Highlight last move on board
  useEffect(() => {
    if (currentMove) {
      const from = currentMove.from as Square;
      const to = currentMove.to as Square;
      setLastMove(from, to);
    }
  }, [currentMove, setLastMove]);

  // Handle piece drop — insert move or variation
  const handlePieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      piece: unknown;
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare) return false;
      return makeVariantMove(sourceSquare, targetSquare);
    },
    [makeVariantMove],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: 'white' as const,
      animationDurationInMs: 200,
      allowDragging: true,
      showNotation: true,
      squareStyles,
      onPieceDrop: handlePieceDrop,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
    }),
    [stablePosition, boardStyle, boardThemeOptions, squareStyles, handlePieceDrop],
  );

  const isBlackTurn = currentFen.split(' ')[1] === 'b';
  const evalIsBlackTurn = analysisFen ? analysisFen.split(' ')[1] === 'b' : isBlackTurn;
  const whitePercent = evalToPercent(displayedLines, evalIsBlackTurn);

  const isAtStart = currentMove === null;
  const isAtEnd = currentMove !== null && !currentMove.next;

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (!gameData) return null;

  const resultText =
    gameData.result === 'draw'
      ? t('game.draw')
      : gameData.result === 'white_wins'
        ? t('game.whiteWins')
        : t('game.blackWins');

  const resultPgn =
    gameData.result === 'draw' ? '½–½' : gameData.result === 'white_wins' ? '1–0' : '0–1';

  const openingName = classifyOpening(history.map((m) => m.san));

  const gameInfo = {
    white: {
      username: gameData.white.username,
      rating: gameData.whiteRatingBefore ?? null,
    },
    black: {
      username: gameData.black.username,
      rating: gameData.blackRatingBefore ?? null,
    },
    opening: openingName || undefined,
    result: resultPgn,
  };

  return (
    <div className="analysis-page" ref={analysisPageRef}>
      <div
        className="analysis-board-area"
        style={boardAreaPx > 0 ? { width: boardAreaPx, flexShrink: 0 } : undefined}
      >
        <div className="analysis-board-wrapper">
          <div style={{ display: 'flex', gap: 0, alignItems: 'stretch' }}>
            <div className="eval-bar-container">
              <div className="eval-bar">
                <div
                  className="eval-bar-white"
                  style={{ transform: `scaleY(${whitePercent / 100})` }}
                />
                <div className="eval-bar-label">
                  {displayedLines.length > 0 ? formatEval(displayedLines[0], evalIsBlackTurn) : '0.0'}
                </div>
              </div>
            </div>
            <div className="board-container" ref={boardContainerRef}>
              <MemoChessboard options={boardOptions} />
            </div>
          </div>

          <div className="analysis-board-controls">
            <button onClick={gotoFirst} disabled={isAtStart} title={t('review.toStart')}>
              &#x21E4;
            </button>
            <button onClick={gotoPrevious} disabled={isAtStart} title={t('review.back')}>
              &#x2190;
            </button>
            <button onClick={gotoNext} disabled={isAtEnd} title={t('review.forward')}>
              &#x2192;
            </button>
            <button onClick={gotoLast} disabled={isAtEnd} title={t('review.toEnd')}>
              &#x21E5;
            </button>
          </div>
        </div>
      </div>

      <div className="analysis-h-resizer" onMouseDown={handleHResizerMouseDown} />

      <div className="analysis-sidebar">
        {/* Back navigation */}
        <Link to="/profile" className="analysis-back-link analysis-back-link--top">
          {t('review.backToGames')}
        </Link>

        {/* Engine analysis panel */}
        <div className="stockfish-panel" style={{ height: enginePanelHeight }}>
          <div className="stockfish-panel-header">
            <span>
              Stockfish 18{' '}
              {!wasmSupported
                ? ` · ${t('analysis.notSupported', 'Not supported')}`
                : analysisEnabled && sfState === 'analyzing' && displayedLines.length > 0
                  ? `· ${t('analysis.depth')} ${displayedLines[0].depth}`
                  : analysisEnabled && sfState === 'loading'
                    ? `· ${t('common.loading')}`
                    : analysisEnabled && sfState === 'error'
                      ? ` · ${t('analysis.engineError', 'Engine error')}`
                      : analysisEnabled && sfState === 'ready' && displayedLines.length === 0
                        ? ` · ${t('analysis.ready', 'Ready')}`
                        : !analysisEnabled
                          ? ` · ${t('analysis.off', 'Off')}`
                          : ''}
            </span>
            {wasmSupported && (
              <button
                className="analysis-toggle-btn"
                onClick={toggleAnalysis}
                title={
                  analysisEnabled
                    ? t('analysis.stop', 'Stop analysis')
                    : t('analysis.start', 'Start analysis')
                }
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
            )}
          </div>
          <div className="stockfish-lines">
            {analysisEnabled &&
              displayedLines.map((line) => (
                <div key={line.multipv} className="stockfish-line">
                  <span
                    className={`stockfish-eval${line.score.type === 'mate' ? ' mate' : line.multipv === 1 ? ' best' : ''}`}
                  >
                    {formatEval(line, evalIsBlackTurn)}
                  </span>
                  <span className="stockfish-pv">{formatPv(line.pv, currentFen)}</span>
                </div>
              ))}
          </div>
        </div>

        <div className="analysis-v-resizer" onMouseDown={handleVResizerMouseDown} />

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
                  {gameData.ratingChange.whiteRatingBefore} &rarr;{' '}
                  {gameData.ratingChange.whiteRatingAfter}
                  <span
                    className={`rating-diff ${gameData.ratingChange.whiteRatingAfter - gameData.ratingChange.whiteRatingBefore > 0 ? 'positive' : gameData.ratingChange.whiteRatingAfter - gameData.ratingChange.whiteRatingBefore < 0 ? 'negative' : ''}`}
                  >
                    (
                    {gameData.ratingChange.whiteRatingAfter -
                      gameData.ratingChange.whiteRatingBefore >
                    0
                      ? '+'
                      : ''}
                    {gameData.ratingChange.whiteRatingAfter -
                      gameData.ratingChange.whiteRatingBefore}
                    )
                  </span>
                </span>
              </div>
              <div className="analysis-rating-row">
                <span className="color-indicator black" />
                <span>{gameData.black.username}</span>
                <span className="rating-change-inline">
                  {gameData.ratingChange.blackRatingBefore} &rarr;{' '}
                  {gameData.ratingChange.blackRatingAfter}
                  <span
                    className={`rating-diff ${gameData.ratingChange.blackRatingAfter - gameData.ratingChange.blackRatingBefore > 0 ? 'positive' : gameData.ratingChange.blackRatingAfter - gameData.ratingChange.blackRatingBefore < 0 ? 'negative' : ''}`}
                  >
                    (
                    {gameData.ratingChange.blackRatingAfter -
                      gameData.ratingChange.blackRatingBefore >
                    0
                      ? '+'
                      : ''}
                    {gameData.ratingChange.blackRatingAfter -
                      gameData.ratingChange.blackRatingBefore}
                    )
                  </span>
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Move list with variant support */}
        <div className="analysis-moves analysis-moves--variants">
          <ReviewMoveList
            history={history}
            currentGlobalIndex={currentGlobalIndex}
            onMoveClick={gotoMove}
            gameInfo={gameInfo}
          />
          {/* Variation editor — shown only when on a user-inserted variation move */}
          {isInVariation && currentMove && (
            <div className="review-editor-panel">
              <button
                className="review-editor-btn"
                onClick={() => promoteVariation(currentMove as ChessMove)}
                title="Promote variation to main line"
              >
                &#x2191; Promote
              </button>
              <button
                className="review-editor-btn review-editor-btn--danger"
                onClick={() => removeVariation(currentMove as ChessMove)}
                title="Delete this variation"
              >
                &#x2715; Delete
              </button>
              <button
                className="review-editor-btn"
                onClick={() => truncateRemaining(currentMove as ChessMove)}
                title="Delete remaining moves"
              >
                ] Truncate
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
