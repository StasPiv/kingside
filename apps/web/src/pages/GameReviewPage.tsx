import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
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
import { useSavedAnalyses, getDefaultTitle, parsePgnHeaders } from '../hooks/useSavedAnalyses';
import { serializeToAnnotatedPgn } from '../review/utils/PgnSerializer';

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
  const rawGameId = params.id ?? params.gameId;
  const isLocalAnalysisId = typeof rawGameId === 'string' && rawGameId.startsWith('local-');
  const gameId = rawGameId === 'new' || isLocalAnalysisId ? undefined : rawGameId;
  const location = useLocation();
  const { t } = useTranslation();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Standalone analysis state (only used when gameId is undefined)
  const { create: createAnalysis, update: updateAnalysis, getById } = useSavedAnalyses();
  const localIdRef = useRef<string | undefined>(
    (location.state as { localId?: string } | null)?.localId ??
      (isLocalAnalysisId ? rawGameId : undefined),
  );
  const breadcrumbRootTitle = (location.state as { breadcrumbRootTitle?: string } | null)?.breadcrumbRootTitle;
  const breadcrumbRootUrl = (location.state as { breadcrumbRootUrl?: string } | null)?.breadcrumbRootUrl;
  const breadcrumbSection = (location.state as { breadcrumbSection?: string } | null)?.breadcrumbSection;
  const breadcrumbBackUrl = (location.state as { breadcrumbBackUrl?: string } | null)?.breadcrumbBackUrl;
  const breadcrumbBackState = (location.state as { breadcrumbBackState?: unknown } | null)?.breadcrumbBackState;
  const breadcrumbFileName = (location.state as { breadcrumbFileName?: string } | null)?.breadcrumbFileName;
  const breadcrumbFileBackUrl = (location.state as { breadcrumbFileBackUrl?: string } | null)?.breadcrumbFileBackUrl;
  const breadcrumbFileBackState = (location.state as { breadcrumbFileBackState?: unknown } | null)?.breadcrumbFileBackState;
  const [analysisTitle, setAnalysisTitle] = useState<string>(() => {
    const state = location.state as { title?: string } | null;
    return state?.title ?? getDefaultTitle();
  });
  const [pgnHeaders, setPgnHeaders] = useState<Record<string, string>>(() => {
    const state = location.state as { pgn?: string } | null;
    return state?.pgn ? parsePgnHeaders(state.pgn) : {};
  });
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(analysisTitle);
  // Sync URL to /analysis/{localId} without triggering React Router navigation
  useEffect(() => {
    if (!gameId && localIdRef.current && !isLocalAnalysisId) {
      window.history.replaceState(null, '', '/analysis/' + localIdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Panel collapse state
  const [panelStates, setPanelStates] = useState({
    gameInfo: true,
    engine: true,
    moves: true,
  });

  const togglePanel = useCallback((panel: 'gameInfo' | 'engine' | 'moves') => {
    setPanelStates((prev) => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  const handleTitleClick = useCallback(() => {
    if (gameId) return;
    setTitleInput(analysisTitle);
    setIsEditingTitle(true);
  }, [gameId, analysisTitle]);

  const handleTitleSave = useCallback(() => {
    const trimmed = titleInput.trim() || getDefaultTitle();
    setAnalysisTitle(trimmed);
    setIsEditingTitle(false);
    if (localIdRef.current) {
      updateAnalysis(localIdRef.current, { title: trimmed });
    }
  }, [titleInput, updateAnalysis]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleTitleSave();
      if (e.key === 'Escape') setIsEditingTitle(false);
    },
    [handleTitleSave],
  );

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

  const wasmSupported = typeof WebAssembly !== 'undefined';
  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const [analysisEnabled, setAnalysisEnabled] = useState<boolean>(() => {
    if (typeof WebAssembly === 'undefined') return false;
    // On touch devices (mobile) the 113 MB WASM binary often fails to compile —
    // don't auto-start the engine; the user can still start it manually.
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

  useEffect(() => {
    if (!gameId) {
      const pgn = (location.state as { pgn?: string } | null)?.pgn;
      if (pgn) {
        try {
          const parsedMoves = parseAnnotatedPgn(pgn);
          loadFromPgn(parsedMoves);
        } catch {
          // ignore parse error — start with empty board
        }
        setPgnHeaders(parsePgnHeaders(pgn));
      } else if (localIdRef.current) {
        const saved = getById(localIdRef.current);
        if (saved?.pgn) {
          try {
            const parsedMoves = parseAnnotatedPgn(saved.pgn);
            loadFromPgn(parsedMoves);
          } catch {
            // ignore
          }
          setPgnHeaders(parsePgnHeaders(saved.pgn));
        }
        if (saved?.title) {
          setAnalysisTitle(saved.title);
          setTitleInput(saved.title);
        }
      }
      setLoading(false);
      return;
    }

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
  }, [gameId, location.state, t, loadMoves, loadFromPgn, getById]);

  useAnalysisPersistence(gameId, history);

  // Auto-save standalone analysis to localStorage
  const localSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (gameId) return;
    if (history.length === 0) return;

    if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);

    localSaveTimerRef.current = setTimeout(() => {
      const pgn = serializeToAnnotatedPgn(history);
      const opening = classifyOpening(history.map((m) => m.san)) ?? undefined;

      if (!localIdRef.current) {
        const state = location.state as { pgn?: string } | null;
        const headers = state?.pgn ? parsePgnHeaders(state.pgn) : {};
        const entry = createAnalysis(pgn, analysisTitle, {
          opening,
          whitePgn: headers['White'] || undefined,
          blackPgn: headers['Black'] || undefined,
        });
        localIdRef.current = entry.id;
        window.history.replaceState(null, '', '/analysis/' + entry.id);
      } else {
        updateAnalysis(localIdRef.current, { pgn, opening });
      }
    }, 2000);

    return () => {
      if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);
    };
  }, [gameId, history, analysisTitle, createAnalysis, updateAnalysis, location.state]);

  useEffect(() => {
    game.load(currentFen);
  }, [currentFen, game]);

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

  // When engine errors out, auto-disable analysis so the UI resets to "Start"
  useEffect(() => {
    if (sfState === 'error' && analysisEnabled) {
      setEngineFailed(true);
      setAnalysisEnabled(false);
    }
  }, [sfState, analysisEnabled]);

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
  if (gameId && !gameData) return null;

  const resultPgn = gameData
    ? gameData.result === 'draw' ? '½–½' : gameData.result === 'white_wins' ? '1–0' : '0–1'
    : undefined;

  const openingName = classifyOpening(history.map((m) => m.san));

  const gameInfo = gameData
    ? {
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
      }
    : pgnHeaders['White'] && pgnHeaders['Black']
      ? {
          white: { username: pgnHeaders['White'] },
          black: { username: pgnHeaders['Black'] },
          opening: openingName || undefined,
          result:
            pgnHeaders['Result'] && pgnHeaders['Result'] !== '*'
              ? pgnHeaders['Result']
              : undefined,
        }
      : undefined;

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

  return (
    <div className="analysis-page" ref={analysisPageRef}>
      <div
        className="analysis-board-area"
        style={boardAreaPx > 0 ? { width: boardAreaPx, flexShrink: 0 } : undefined}
      >
        {!gameId && (
          <>
          <div className="analysis-workshop-shortcut">
            <Link to="/workshop" className="analysis-workshop-shortcut__link">
              {t('workshop.title')}
            </Link>
          </div>
          <nav className="analysis-breadcrumbs">
            <Link to={breadcrumbRootUrl ?? '/workshop'} className="analysis-breadcrumbs__link">
              {breadcrumbRootTitle ?? t('workshop.title')}
            </Link>
            {breadcrumbSection && (
              <>
                <span className="analysis-breadcrumbs__sep"> / </span>
                <Link
                  to={breadcrumbBackUrl ?? '/workshop'}
                  state={breadcrumbBackState}
                  className="analysis-breadcrumbs__link"
                >
                  {breadcrumbSection}
                </Link>
              </>
            )}
            {breadcrumbFileName && (
              <>
                <span className="analysis-breadcrumbs__sep"> / </span>
                <Link
                  to={breadcrumbFileBackUrl ?? '/workshop/pgn-files'}
                  state={breadcrumbFileBackState}
                  className="analysis-breadcrumbs__link"
                >
                  {breadcrumbFileName}
                </Link>
              </>
            )}
            <span className="analysis-breadcrumbs__sep"> / </span>
            {isEditingTitle ? (
              <input
                className="analysis-title__input analysis-breadcrumbs__input"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                maxLength={100}
              />
            ) : (
              <span
                className="analysis-breadcrumbs__current"
                onClick={handleTitleClick}
                title={t('analysis.editTitle', 'Click to edit title')}
              >
                {analysisTitle}
                <span className="analysis-title__edit-icon">✎</span>
              </span>
            )}
          </nav>
          </>
        )}
        <div className="analysis-board-wrapper">
          {/* Black player row above board */}
          {gameData && (
            <div className="analysis-player-row">
              <span className="analysis-player-dot analysis-player-dot--black" />
              <span className="analysis-player-name">{gameData.black.username}</span>
              {gameData.blackRatingBefore != null && (
                <span className="analysis-player-rating">{gameData.blackRatingBefore}</span>
              )}
            </div>
          )}

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

          {/* White player row below board */}
          {gameData && (
            <div className="analysis-player-row">
              <span className="analysis-player-dot analysis-player-dot--white" />
              <span className="analysis-player-name">{gameData.white.username}</span>
              {gameData.whiteRatingBefore != null && (
                <span className="analysis-player-rating">{gameData.whiteRatingBefore}</span>
              )}
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
        {/* Game Information panel — only when game data is present */}
        {gameData && (
          <div className="analysis-panel">
            <div
              className="analysis-panel-header"
              onClick={() => togglePanel('gameInfo')}
            >
              <span className="analysis-panel-header-left">
                <span className="analysis-panel-icon">&#9432;</span>
                <span className="analysis-panel-title">
                  {t('review.gameInfo', 'Game Information')}
                </span>
              </span>
              <span className="analysis-panel-header-right">
                <Link
                  to="/profile"
                  className="analysis-panel-back-link"
                  onClick={(e) => e.stopPropagation()}
                >
                  {t('review.backToGames')}
                </Link>
                <span className="analysis-panel-chevron">
                  {panelStates.gameInfo ? '▾' : '▸'}
                </span>
              </span>
            </div>
            {panelStates.gameInfo && (
              <div className="analysis-panel-body">
                <div className="analysis-game-players">
                  <div className="analysis-game-player">
                    <span className="analysis-player-dot analysis-player-dot--white" />
                    <span className="analysis-game-player-name">{gameData.white.username}</span>
                    {gameData.ratingChange && (
                      <span className="analysis-player-rating">
                        {gameData.ratingChange.whiteRatingBefore}
                        <span
                          className={`rating-diff ${
                            gameData.ratingChange.whiteRatingAfter -
                              gameData.ratingChange.whiteRatingBefore >
                            0
                              ? 'positive'
                              : gameData.ratingChange.whiteRatingAfter -
                                  gameData.ratingChange.whiteRatingBefore <
                                0
                                ? 'negative'
                                : ''
                          }`}
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
                    )}
                  </div>
                  <span className="analysis-result-badge">{resultPgn}</span>
                  <div className="analysis-game-player">
                    <span className="analysis-player-dot analysis-player-dot--black" />
                    <span className="analysis-game-player-name">{gameData.black.username}</span>
                    {gameData.ratingChange && (
                      <span className="analysis-player-rating">
                        {gameData.ratingChange.blackRatingBefore}
                        <span
                          className={`rating-diff ${
                            gameData.ratingChange.blackRatingAfter -
                              gameData.ratingChange.blackRatingBefore >
                            0
                              ? 'positive'
                              : gameData.ratingChange.blackRatingAfter -
                                  gameData.ratingChange.blackRatingBefore <
                                0
                                ? 'negative'
                                : ''
                          }`}
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
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Engine panel */}
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

        {/* Moves panel — takes remaining space */}
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
                gameInfo={gameInfo}
              />
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
          )}
        </div>
      </div>
    </div>
  );
}
