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
import { broadcastApi } from '../api/broadcastApi';
import { useReviewState } from '../review/useReviewState';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import type { ChessMove } from '../review/types';
import { parseAnnotatedPgn } from '../review/utils/PgnDeserializer';
import { formatEval, formatPv } from '../utils/chessFormat';
import { EvalBar } from '../components/EvalBar';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';

/**
 * KS-1747: Lichess-only broadcast-viewer. Страница загружает партию по UUID
 * (`gameId` в URL — `BroadcastGame.id` из broadcast-service) через
 * `broadcastApi`. Поллинг каждые 5 секунд за обновлениями PGN / result.
 */

// Lichess game shape из broadcast-service (/:id/rounds/:roundId/games).
type LichessGame = {
  id: string;
  lichessGameId: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
};

type BroadcastMeta = {
  id: string;
  title: string;
};

function loadGameIntoReview(
  pgn: string,
  loadFromPgn: (moves: ChessMove[]) => void,
): void {
  if (!pgn) return;
  try {
    loadFromPgn(parseAnnotatedPgn(pgn));
  } catch {
    // leave board at initial position
  }
}

function computeLastMoveSan(pgn: string): string | null {
  if (!pgn) return null;
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const hist = chess.history();
    return hist.length > 0 ? hist[hist.length - 1] : null;
  } catch {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn.replace(/\{[^}]*\}/g, ''));
      const hist = chess.history();
      return hist.length > 0 ? hist[hist.length - 1] : null;
    } catch {
      return null;
    }
  }
}

const MULTI_PV = 3;

export function BroadcastGamePage() {
  const { tournamentId, roundId, gameId } = useParams<{
    tournamentId: string;
    roundId: string;
    gameId: string;
  }>();
  const { t } = useTranslation();

  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [roundName, setRoundName] = useState('');
  const [game, setGame] = useState<LichessGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const {
    history,
    currentMove,
    currentGlobalIndex,
    currentFen,
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

  const chessGame = useMemo(() => new Chess(), []);
  const { playSound } = useSounds();

  const [panelStates, setPanelStates] = useState({
    engine: true,
    moves: true,
  });

  const togglePanel = useCallback((panel: 'engine' | 'moves') => {
    setPanelStates((prev) => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  const analysisPageRef = useRef<HTMLDivElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const isAtEndRef = useRef(false);
  const gameRef = useRef<LichessGame | null>(null);
  const { boardThemeOptions } = useBoardTheme();

  const [boardAreaPx, setBoardAreaPx] = useState(() => {
    const saved = localStorage.getItem('analysis-layout-boardAreaPx');
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return Math.floor((window.innerWidth - 8) * 0.55);
  });

  useLayoutEffect(() => {
    if (loading) return;
    if (!analysisPageRef.current) return;
    const total = analysisPageRef.current.clientWidth;
    if (total === 0) return;
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

  const wasmSupported = typeof WebAssembly !== 'undefined';
  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  const [analysisEnabled, setAnalysisEnabled] = useState<boolean>(() => {
    if (typeof WebAssembly === 'undefined') return false;
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
      return false;
    }
    return true;
  });
  const [engineFailed, setEngineFailed] = useState(false);

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

  // Initial load
  useEffect(() => {
    if (!tournamentId || !roundId || !gameId) return;
    let cancelled = false;

    setLoading(true);
    Promise.all([
      broadcastApi.get<BroadcastMeta>(`/${tournamentId}`),
      broadcastApi.get<{ data: Array<{ id: string; name: string }> }>(`/${tournamentId}/rounds`),
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
    ])
      .then(([meta, roundsRes, gamesRes]) => {
        if (cancelled) return;
        setBroadcastTitle(meta.title);
        const rounds = Array.isArray(roundsRes?.data) ? roundsRes.data : [];
        setRoundName(rounds.find((r) => r.id === roundId)?.name ?? '');
        const games = Array.isArray(gamesRes?.data) ? gamesRes.data : [];
        const found = games.find((g) => g.id === gameId) ?? null;
        setGame(found);
        if (found?.pgn) loadGameIntoReview(found.pgn, loadFromPgn);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, roundId, gameId, t, loadFromPgn]);

  useEffect(() => {
    if (sfState === 'error' && analysisEnabled) {
      setEngineFailed(true);
      setAnalysisEnabled(false);
    }
  }, [sfState, analysisEnabled]);

  useEffect(() => {
    if (!analysisEnabled || !isReady || !currentFen) return;
    const timer = setTimeout(() => {
      evaluate(currentFen);
    }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate, analysisEnabled]);

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

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  // Polling: every 5s re-fetch the games list and update if PGN changed
  useEffect(() => {
    if (!tournamentId || !roundId || !gameId) return;
    let cancelled = false;

    const poll = () => {
      broadcastApi
        .get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`)
        .then((res) => {
          if (cancelled) return;
          const games = Array.isArray(res?.data) ? res.data : [];
          const found = games.find((g) => g.id === gameId) ?? null;
          if (!found) return;
          const prev = gameRef.current;
          const prevPgn = prev?.pgn ?? '';
          const curPgn = found.pgn ?? '';
          if (curPgn !== prevPgn) {
            if (prevPgn.length > 0 && curPgn.length > prevPgn.length) {
              const lastSan = computeLastMoveSan(curPgn);
              if (lastSan) playSound(soundEventFromSan(lastSan));
            }
            setGame(found);
            if (isAtEndRef.current || prevPgn.length === 0) {
              loadGameIntoReview(curPgn, loadFromPgn);
            }
          } else if ((prev?.result ?? null) !== (found.result ?? null)) {
            // Result changed (game ended) — refresh game state.
            setGame(found);
          }
        })
        .catch(() => {
          // ignore polling errors silently
        });
    };

    const intervalId = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [tournamentId, roundId, gameId, loadFromPgn, playSound]);

  useEffect(() => {
    chessGame.load(currentFen);
  }, [currentFen, chessGame]);

  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      if (prev) {
        lastLinesRef.current = [];
      } else {
        setEngineFailed(false);
      }
      return !prev;
    });
  }, []);

  const stablePosition = useStablePosition(currentFen);

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const { squareStyles, setLastMove } = useBoardHighlights({
    game: chessGame,
    playerColor: null,
    enabled: false,
  });

  useEffect(() => {
    if (currentMove) {
      const from = currentMove.from as Square;
      const to = currentMove.to as Square;
      setLastMove(from, to);
    }
  }, [currentMove, setLastMove]);

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

  const isAtStart = currentMove === null;
  const isAtEnd = currentMove !== null && !currentMove.next;
  isAtEndRef.current = isAtEnd;

  const whiteName = game?.whitePlayer ?? '';
  const blackName = game?.blackPlayer ?? '';

  const engineStatusSuffix = !wasmSupported
    ? ` · ${t('analysis.notSupported', 'Not supported')}`
    : isTouchDevice && engineFailed
      ? ` · ${t('analysis.notSupportedMobile', 'Not supported on mobile')}`
      : analysisEnabled && sfState === 'analyzing' && displayedLines.length > 0
        ? ` · ${t('analysis.depth')} ${displayedLines[0].depth}`
        : analysisEnabled && sfState === 'loading'
          ? ` · ${t('common.loading')}`
          : analysisEnabled && sfState === 'error'
            ? ` · ${t('analysis.engineError', 'Engine error')}`
            : analysisEnabled && sfState === 'ready' && displayedLines.length === 0
              ? ` · ${t('analysis.ready', 'Ready')}`
              : !analysisEnabled && engineFailed
                ? ` · ${t('analysis.engineError', 'Engine error')}`
                : !analysisEnabled
                  ? ` · ${t('analysis.off', 'Off')}`
                  : '';

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;

  const gameTitle = game ? `${whiteName} vs ${blackName}` : `#${gameId}`;

  return (
    <div className="analysis-page" ref={analysisPageRef}>
      <div
        className="analysis-board-area"
        style={boardAreaPx > 0 ? { width: boardAreaPx, flexShrink: 0 } : undefined}
      >
        <nav className="analysis-breadcrumbs">
          <Link to="/broadcasts" className="analysis-breadcrumbs__link">
            {t('broadcasts.title')}
          </Link>
          {broadcastTitle && (
            <>
              <span className="analysis-breadcrumbs__sep"> / </span>
              <Link
                to={`/broadcasts/${tournamentId}`}
                state={{ fromRound: true }}
                className="analysis-breadcrumbs__link"
              >
                {broadcastTitle}
              </Link>
            </>
          )}
          <span className="analysis-breadcrumbs__sep"> / </span>
          <Link
            to={`/broadcasts/${tournamentId}/${roundId}`}
            className="analysis-breadcrumbs__link"
          >
            {roundName || t('broadcastRound.title', 'Round')}
          </Link>
          <span className="analysis-breadcrumbs__sep"> / </span>
          <span className="analysis-breadcrumbs__current">
            <span className="analysis-breadcrumbs__current-text">{gameTitle}</span>
          </span>
        </nav>

        <div className="analysis-board-wrapper">
          {game && (
            <div className="analysis-player-row">
              <span className="analysis-player-dot analysis-player-dot--black" />
              <span className="analysis-player-name">{blackName}</span>
            </div>
          )}

          <div className="analysis-eval-board-row">
            <EvalBar lines={displayedLines} isBlackTurn={evalIsBlackTurn} />
            <div className="board-container" ref={boardContainerRef}>
              <MemoChessboard options={boardOptions} />
            </div>
          </div>

          {game && (
            <div className="analysis-player-row">
              <span className="analysis-player-dot analysis-player-dot--white" />
              <span className="analysis-player-name">{whiteName}</span>
            </div>
          )}

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
        <div className="analysis-panel">
          <div
            className="analysis-panel-header"
            onClick={() => togglePanel('engine')}
          >
            <span className="analysis-panel-header-left">
              <span className="analysis-panel-icon">&#9881;</span>
              <span className="analysis-panel-title">
                Stockfish 18{engineStatusSuffix}
              </span>
            </span>
            <span className="analysis-panel-header-right">
              {wasmSupported && !(isTouchDevice && engineFailed) && (
                <button
                  className="analysis-toggle-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAnalysis();
                  }}
                  title={
                    analysisEnabled
                      ? t('analysis.stop', 'Stop analysis')
                      : isTouchDevice
                        ? t('analysis.startMobile', 'Start analysis (may not work on mobile)')
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
              <span className="analysis-panel-chevron">
                {panelStates.engine ? '▾' : '▸'}
              </span>
            </span>
          </div>
          {panelStates.engine && (
            <div className="analysis-panel-body">
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
          )}
        </div>

        <div className="analysis-panel analysis-panel--flex">
          <div
            className="analysis-panel-header"
            onClick={() => togglePanel('moves')}
          >
            <span className="analysis-panel-header-left">
              <span className="analysis-panel-icon">&#9776;</span>
              <span className="analysis-panel-title">{t('review.moves', 'Moves')}</span>
            </span>
            <span className="analysis-panel-header-right">
              <span className="analysis-panel-chevron">
                {panelStates.moves ? '▾' : '▸'}
              </span>
            </span>
          </div>
          {panelStates.moves && (
            <div className="analysis-panel-body analysis-panel-body--scroll">
              <ReviewMoveList
                history={history}
                currentGlobalIndex={currentGlobalIndex}
                onMoveClick={gotoMove}
                onPromoteVariation={(move) => promoteVariation(move as ChessMove)}
                onDeleteVariation={(move) => removeVariation(move as ChessMove)}
                onTruncateRemaining={(move) => truncateRemaining(move as ChessMove)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
