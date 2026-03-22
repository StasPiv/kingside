import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { GameInfoPanel } from '../components/GameInfoPanel';
import { EngineSettingsModal } from '../components/EngineSettingsModal';
import { EvalBar } from '../components/EvalBar';
import { SetPositionModal } from '../components/SetPositionModal';
import { useStablePosition } from '../hooks/useStablePosition';
import type { EvalLine } from '../hooks/useStockfish';
import { useEngine } from '../hooks/useEngine';
import type { EngineSource } from '../hooks/useEngine';
import { useEngineConfig } from '../hooks/useEngineConfig';
import { useContainerSize } from '../hooks/useContainerSize';
import { useFastDrag } from '../hooks/useFastDrag';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardSettings } from '../hooks/useBoardSettings';
import { useBoardHighlights } from '../hooks/useBoardHighlights';
import { api } from '../api';
import { useReviewState } from '../review/useReviewState';
import { useAnalysisPersistence } from '../review/useAnalysisPersistence';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import type { ChessMove } from '../review/types';
import { parseAnnotatedPgn } from '../review/utils/PgnDeserializer';
import { classifyOpening } from '../utils/ecoClassify';
import { formatEval, formatPv, formatCompact } from '../utils/chessFormat';
import { searchInHistory, findGlobalIndexByFen } from '../review/utils/ChessHistoryUtils';
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

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function buildPgnWithFen(moves: string, fen: string): string {
  if (fen === DEFAULT_FEN) return moves;
  return `[FEN "${fen}"]\n\n${moves}`;
}

type MoveData = {
  san: string;
  uci: string;
  fenAfter: string;
};

export function GameReviewPage() {
  const params = useParams<{ id?: string; gameId?: string }>();
  const rawGameId = params.id ?? params.gameId;
  const isAnalysisRoute = params.id !== undefined;
  const isGameRoute = params.gameId !== undefined;
  const gameId = isGameRoute ? params.gameId : undefined;
  const analysisId = isAnalysisRoute && rawGameId !== 'new' ? rawGameId : undefined;
  const location = useLocation();
  const { t } = useTranslation();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pendingPositionRef = useRef<number | null>(null);

  // Standalone analysis state
  const { create: createAnalysis, update: updateAnalysis, getById } = useSavedAnalyses();
  const localIdRef = useRef<string | undefined>(
    (location.state as { localId?: string } | null)?.localId ?? analysisId,
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

  useEffect(() => {
    if (!gameId && localIdRef.current && !analysisId) {
      window.history.replaceState(null, '', '/analysis/' + localIdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const containerSize = useContainerSize(boardContainerRef);
  const boardWidth = Math.min(containerSize.width, containerSize.height);
  const { boardThemeOptions } = useBoardTheme();
  const { inputMode } = useBoardSettings();

  const {
    history, currentMove, currentGlobalIndex, currentFen, initialFen,
    loadMoves, loadFromPgn, setInitialFen, gotoMove, gotoFirst, gotoLast,
    gotoPrevious, gotoNext, makeVariantMove, removeVariation,
    truncateRemaining, promoteVariation,
  } = useReviewState();

  const game = useMemo(() => new Chess(), []);

  // Panel collapse state
  const [panelStates, setPanelStates] = useState(() => {
    const narrow = typeof window !== 'undefined' && window.innerWidth <= 768;
    return { gameInfo: !narrow, engine: !narrow, moves: true };
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
      updateAnalysis(localIdRef.current, { title: trimmed }).catch(() => {});
    }
  }, [titleInput, updateAnalysis]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleTitleSave();
      if (e.key === 'Escape') setIsEditingTitle(false);
    },
    [handleTitleSave],
  );

  const analysisPageRef = useRef<HTMLDivElement>(null);

  const wasmSupported = typeof WebAssembly !== 'undefined';
  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const [analysisEnabled, setAnalysisEnabled] = useState<boolean>(() => {
    if (typeof WebAssembly === 'undefined') return false;
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return false;
    try { return localStorage.getItem('analysisRunning') === 'true'; } catch { return false; }
  });
  const [engineFailed, setEngineFailed] = useState(false);

  // Engine config (extracted hook)
  const ec = useEngineConfig();
  const [showSetPosition, setShowSetPosition] = useState(false);
  const [bridgePromoDismissed, setBridgePromoDismissed] = useState(() => {
    try { return localStorage.getItem('bridgePromoDismissed') === '1'; } catch { return false; }
  });

  const {
    lines, analysisFen, evaluate, stop: stopEngine, setOption: setEngineOption,
    isReady, state: sfState, engineName, engineSource: activeSource,
    errorMessage: engineErrorMessage,
  } = useEngine({
    source: ec.engineSource,
    externalConfig: ec.externalConfig,
    depth: ec.engineSource === 'external' ? 99 : 18,
    multiPv: ec.multiPv,
    autoStart: analysisEnabled,
  });

  const lastLinesRef = useRef<EvalLine[]>([]);
  const prevSourceRef = useRef<EngineSource>(activeSource);
  if (prevSourceRef.current !== activeSource) {
    lastLinesRef.current = [];
    prevSourceRef.current = activeSource;
  }
  if (activeSource === 'external' ? lines.length > 0 : lines.length === ec.multiPv) {
    lastLinesRef.current = lines;
  }
  const displayedLines = lastLinesRef.current.length > 0 ? lastLinesRef.current : lines;

  // --- Data loading ---
  useEffect(() => {
    if (!gameId) {
      const pgn = (location.state as { pgn?: string } | null)?.pgn;
      if (pgn) {
        try { loadFromPgn(parseAnnotatedPgn(pgn)); } catch { /* ignore */ }
        setPgnHeaders(parsePgnHeaders(pgn));
      } else if (localIdRef.current) {
        const id = localIdRef.current;
        getById(id).then((saved) => {
          if (saved?.pgn) {
            try {
              // Restore custom starting position if FEN header present
              const fenMatch = saved.pgn.match(/\[FEN\s+"([^"]+)"\]/);
              if (fenMatch) setInitialFen(fenMatch[1]);
              loadFromPgn(parseAnnotatedPgn(saved.pgn));
              if (saved.currentPosition != null && saved.currentPosition > 0) {
                pendingPositionRef.current = saved.currentPosition;
              }
            } catch { /* ignore */ }
            setPgnHeaders(parsePgnHeaders(saved.pgn));
          }
          if (saved?.title) { setAnalysisTitle(saved.title); setTitleInput(saved.title); }
          setLoading(false);
        });
        return;
      }
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        const isAuthenticated = Boolean(localStorage.getItem('token'));
        const requests: [Promise<GameData>, Promise<MoveData[]>, Promise<{ analysisPgn: string | null } | null>] = [
          api.get<GameData>(`/api/games/${gameId}`),
          api.get<MoveData[]>(`/api/games/${gameId}/moves`),
          isAuthenticated ? api.get<{ analysisPgn: string | null }>(`/api/games/${gameId}/analysis`).catch(() => null) : Promise.resolve(null),
        ];
        const [gData, mData, analysisData] = await Promise.all(requests);
        setGameData(gData);
        if (analysisData?.analysisPgn) {
          try { loadFromPgn(parseAnnotatedPgn(analysisData.analysisPgn)); } catch { loadMoves(mData); }
        } else { loadMoves(mData); }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('review.loadError'));
      } finally { setLoading(false); }
    };
    fetchData();
  }, [gameId, location.state, t, loadMoves, loadFromPgn, getById]);

  useAnalysisPersistence(gameId, history);

  // --- Position save/restore ---
  const suppressPositionSaveRef = useRef(true);

  useEffect(() => {
    if (pendingPositionRef.current == null || history.length === 0) return;
    const target = pendingPositionRef.current;
    const timer = setTimeout(() => {
      pendingPositionRef.current = null;
      const targetMove = searchInHistory(history, target);
      if (targetMove) gotoMove(targetMove);
      setTimeout(() => { suppressPositionSaveRef.current = false; }, 1500);
    }, 100);
    return () => clearTimeout(timer);
  }, [history, gotoNext, gotoFirst]);

  useEffect(() => {
    if (pendingPositionRef.current == null && history.length > 0) {
      suppressPositionSaveRef.current = false;
    }
  }, [history]);

  const positionSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentGlobalIndexRef = useRef(currentGlobalIndex);
  currentGlobalIndexRef.current = currentGlobalIndex;
  const currentFenRef = useRef(currentFen);
  currentFenRef.current = currentFen;

  useEffect(() => {
    if (suppressPositionSaveRef.current) return;
    if (positionSaveRef.current) clearTimeout(positionSaveRef.current);
    positionSaveRef.current = setTimeout(() => {
      const id = localIdRef.current;
      if (!id) return;
      const fen = currentFenRef.current;
      let position = currentGlobalIndexRef.current;
      if (fen && fen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
        try {
          const pgn = serializeToAnnotatedPgn(history);
          const reparsed = parseAnnotatedPgn(pgn);
          const idx = findGlobalIndexByFen(reparsed, fen);
          if (idx !== null) position = idx;
        } catch { /* keep runtime index */ }
      }
      updateAnalysis(id, { currentPosition: position }).catch(() => {});
    }, 1000);
    return () => { if (positionSaveRef.current) clearTimeout(positionSaveRef.current); };
  }, [currentGlobalIndex, updateAnalysis, history]);

  // Auto-save standalone analysis to API
  const localSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (gameId) return;
    if (history.length === 0) return;
    if (positionSaveRef.current) { clearTimeout(positionSaveRef.current); positionSaveRef.current = null; }
    if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);

    localSaveTimerRef.current = setTimeout(async () => {
      const movesOnly = serializeToAnnotatedPgn(history);
      const pgn = buildPgnWithFen(movesOnly, initialFen);
      if (!localIdRef.current) {
        try {
          const entry = await createAnalysis(pgn, analysisTitle);
          localIdRef.current = entry.id;
          window.history.replaceState(null, '', '/analysis/' + entry.id);
        } catch { /* ignore */ }
      } else {
        let savedPosition: number | null = null;
        const fen = currentFenRef.current;
        if (fen && fen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
          try {
            const reparsed = parseAnnotatedPgn(pgn);
            savedPosition = findGlobalIndexByFen(reparsed, fen);
          } catch { savedPosition = currentGlobalIndexRef.current; }
        }
        updateAnalysis(localIdRef.current, {
          pgn,
          ...(savedPosition != null && { currentPosition: savedPosition }),
        }).catch(() => {});
      }
    }, 2000);
    return () => { if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current); };
  }, [gameId, history, analysisTitle, initialFen, createAnalysis, updateAnalysis]);

  useEffect(() => { game.load(currentFen); }, [currentFen, game]);

  // --- Engine control ---
  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      const next = !prev;
      if (prev) { stopEngine(); } else { setEngineFailed(false); }
      try { localStorage.setItem('analysisRunning', String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (sfState === 'error' && analysisEnabled) {
      if (ec.engineSource === 'external') {
        const timer = setTimeout(() => {
          ec.setEngineSource('wasm');
          ec.setExternalConfig(null);
        }, 3000);
        return () => clearTimeout(timer);
      } else {
        setEngineFailed(true);
        setAnalysisEnabled(false);
        try { localStorage.setItem('analysisRunning', 'false'); } catch { /* ignore */ }
      }
    }
    return undefined;
  }, [sfState, analysisEnabled, ec.engineSource]);

  const initialMountRef = useRef(true);

  useEffect(() => {
    if (!analysisEnabled || !isReady || !currentFen) return;
    if (initialMountRef.current && ec.engineSource === 'external' && sfState === 'analyzing') {
      initialMountRef.current = false;
      return;
    }
    initialMountRef.current = false;
    const timer = setTimeout(() => { evaluate(currentFen); }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate, analysisEnabled, ec.engineSource]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); gotoPrevious(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); gotoNext(); }
      else if (e.key === 'Home') { e.preventDefault(); gotoFirst(); }
      else if (e.key === 'End') { e.preventDefault(); gotoLast(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gotoPrevious, gotoNext, gotoFirst, gotoLast]);

  // --- Board setup ---
  const stablePosition = useStablePosition(currentFen);
  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => makeVariantMove(from, to),
    [makeVariantMove],
  );

  const { squareStyles, setLastMove, onSquareClick } = useBoardHighlights({
    game, playerColor: null, enabled: inputMode === 'click',
    onMove: inputMode === 'click' ? onClickMove : undefined,
  });

  useEffect(() => {
    if (currentMove) setLastMove(currentMove.from as Square, currentMove.to as Square);
  }, [currentMove, setLastMove]);

  const handleSquareClick = useCallback(
    ({ square }: { piece?: unknown; square: string }) => onSquareClick(square as Square),
    [onSquareClick],
  );

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      return makeVariantMove(sourceSquare, targetSquare);
    },
    [makeVariantMove],
  );

  const handleFastDragDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      return makeVariantMove(sourceSquare, targetSquare);
    },
    [makeVariantMove],
  );

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop: handleFastDragDrop,
    boardOrientation: 'white',
    allowBothColors: true,
    enabled: !loading && inputMode === 'drag',
  });

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: 'white' as const,
      animationDurationInMs: suppressAnimationRef.current ? 0 : 200,
      allowDragging: false,
      showNotation: true,
      squareStyles,
      onSquareClick: handleSquareClick,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
    }),
    [stablePosition, boardStyle, boardThemeOptions, squareStyles, handleSquareClick, inputMode],
  );

  // --- Computed values ---
  const isBlackTurn = currentFen.split(' ')[1] === 'b';
  const evalIsBlackTurn = analysisFen ? analysisFen.split(' ')[1] === 'b' : isBlackTurn;
  const isAtStart = currentMove === null;
  const isAtEnd = currentMove !== null && !currentMove.next;

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (gameId && !gameData) return null;

  const resultPgn = gameData
    ? gameData.result === 'draw' ? '½–½' : gameData.result === 'white' ? '1–0' : '0–1'
    : undefined;

  const openingName = classifyOpening(history.map((m) => m.san));

  const gameInfo = gameData
    ? {
        white: { username: gameData.white.username, rating: gameData.whiteRatingBefore ?? null },
        black: { username: gameData.black.username, rating: gameData.blackRatingBefore ?? null },
        opening: openingName || undefined,
        result: resultPgn,
      }
    : pgnHeaders['White'] && pgnHeaders['Black']
      ? {
          white: { username: pgnHeaders['White'] },
          black: { username: pgnHeaders['Black'] },
          opening: openingName || undefined,
          result: pgnHeaders['Result'] && pgnHeaders['Result'] !== '*' ? pgnHeaders['Result'] : undefined,
        }
      : undefined;

  const topLine = displayedLines[0];
  const engineStats = analysisEnabled && sfState === 'analyzing' && topLine
    ? (() => {
        const parts = [`d${topLine.depth}`];
        if (activeSource === 'external' && ec.uciThreads !== '1') parts.push(`${ec.uciThreads}cores`);
        if (topLine.nodes) parts.push(`${formatCompact(topLine.nodes)}n`);
        if (topLine.nps) parts.push(`${formatCompact(topLine.nps)}nps`);
        return ` · ${parts.join(' · ')}`;
      })()
    : null;

  const engineStatusSuffix = !wasmSupported
    ? ` · ${t('analysis.notSupported', 'Not supported')}`
    : isTouchDevice && engineFailed
      ? ` · ${t('analysis.notSupportedMobile', 'Not supported on mobile')}`
      : engineStats ?? (
          analysisEnabled && sfState === 'loading' ? ` · ${t('common.loading')}`
          : analysisEnabled && sfState === 'error' ? ` · ${t('analysis.engineError', 'Engine error')}`
          : analysisEnabled && sfState === 'ready' && displayedLines.length === 0 ? ` · ${t('analysis.ready', 'Ready')}`
          : !analysisEnabled && engineFailed ? ` · ${t('analysis.engineError', 'Engine error')}`
          : !analysisEnabled ? ` · ${t('analysis.off', 'Off')}`
          : ''
        );

  return (
    <div className="analysis-page" ref={analysisPageRef}>
      <div className="analysis-board-area">
        {!gameId && (
          <>
          <div className="analysis-workshop-shortcut">
            <Link to="/workshop" className="analysis-workshop-shortcut__link">{t('workshop.title')}</Link>
          </div>
          <nav className="analysis-breadcrumbs">
            <Link to={breadcrumbRootUrl ?? '/workshop'} className="analysis-breadcrumbs__link">
              {breadcrumbRootTitle ?? t('workshop.title')}
            </Link>
            {breadcrumbSection && (
              <>
                <span className="analysis-breadcrumbs__sep"> / </span>
                <Link to={breadcrumbBackUrl ?? '/workshop'} state={breadcrumbBackState} className="analysis-breadcrumbs__link">{breadcrumbSection}</Link>
              </>
            )}
            {breadcrumbFileName && (
              <>
                <span className="analysis-breadcrumbs__sep"> / </span>
                <Link to={breadcrumbFileBackUrl ?? '/workshop/pgn-files'} state={breadcrumbFileBackState} className="analysis-breadcrumbs__link">{breadcrumbFileName}</Link>
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
              <span className="analysis-breadcrumbs__current" onClick={handleTitleClick} title={t('analysis.editTitle', 'Click to edit title')}>
                <span className="analysis-breadcrumbs__current-text">{analysisTitle}</span>
                <span className="analysis-title__edit-icon">✎</span>
              </span>
            )}
          </nav>
          </>
        )}
        <div className="analysis-board-wrapper">
          {gameData && (
            <div className="analysis-player-row">
              <span className="analysis-player-dot analysis-player-dot--black" />
              <span className="analysis-player-name">{gameData.black.username}</span>
              {gameData.blackRatingBefore != null && <span className="analysis-player-rating">{gameData.blackRatingBefore}</span>}
            </div>
          )}

          <div className="analysis-eval-board-row">
            <EvalBar lines={displayedLines} isBlackTurn={evalIsBlackTurn} />
            <div className="board-container" ref={boardContainerRef}>
              <MemoChessboard options={boardOptions} />
            </div>
          </div>

          {gameData && (
            <div className="analysis-player-row">
              <span className="analysis-player-dot analysis-player-dot--white" />
              <span className="analysis-player-name">{gameData.white.username}</span>
              {gameData.whiteRatingBefore != null && <span className="analysis-player-rating">{gameData.whiteRatingBefore}</span>}
            </div>
          )}

          <div className="analysis-board-controls">
            <button onClick={gotoFirst} disabled={isAtStart} title={t('review.toStart')}>&#x21E4;</button>
            <button onClick={gotoPrevious} disabled={isAtStart} title={t('review.back')}>&#x2190;</button>
            <button onClick={gotoNext} disabled={isAtEnd} title={t('review.forward')}>&#x2192;</button>
            <button onClick={gotoLast} disabled={isAtEnd} title={t('review.toEnd')}>&#x21E5;</button>
            <span className="analysis-controls-spacer" />
            {!gameId && (
              <button
                className="analysis-export-btn"
                onClick={() => setShowSetPosition(true)}
                title={t('position.title', 'Set Position')}
              >
                FEN
              </button>
            )}
            <button
              className="analysis-export-btn"
              onClick={() => {
                if (history.length === 0) return;
                const headers: string[] = [];
                headers.push(`[Event "${analysisTitle || 'Analysis'}"]`);
                headers.push(`[Site "Kingside"]`);
                headers.push(`[Date "${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}"]`);
                if (pgnHeaders['White']) headers.push(`[White "${pgnHeaders['White']}"]`);
                if (pgnHeaders['Black']) headers.push(`[Black "${pgnHeaders['Black']}"]`);
                if (pgnHeaders['Result']) headers.push(`[Result "${pgnHeaders['Result']}"]`);
                else headers.push('[Result "*"]');
                const moves = serializeToAnnotatedPgn(history);
                const pgn = headers.join('\n') + '\n\n' + moves + '\n';
                const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${(analysisTitle || 'analysis').replace(/[^a-zA-Z0-9_-]/g, '_')}.pgn`;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }, 100);
              }}
              disabled={history.length === 0}
              title={t('review.exportPgn', 'Export PGN')}
            >
              &#x2B07; PGN
            </button>
          </div>
        </div>
      </div>

      <div className="analysis-sidebar">
        {gameData && (
          <GameInfoPanel
            gameData={gameData}
            resultPgn={resultPgn}
            collapsed={!panelStates.gameInfo}
            onToggle={() => togglePanel('gameInfo')}
          />
        )}

        {activeSource === 'wasm' && !bridgePromoDismissed && (
          <div className="bridge-promo">
            <div className="bridge-promo__text">
              <strong>{t('bridgePromo.title', 'Want deeper analysis?')}</strong>
              <span>{t('bridgePromo.desc', 'Connect your local engine for unlimited depth and speed.')}</span>
            </div>
            <div className="bridge-promo__actions">
              <Link to="/help/external-engine" className="bridge-promo__link">
                {t('bridgePromo.learnMore', 'Learn more')}
              </Link>
              <button
                className="bridge-promo__dismiss"
                onClick={() => {
                  setBridgePromoDismissed(true);
                  try { localStorage.setItem('bridgePromoDismissed', '1'); } catch { /* ignore */ }
                }}
                title={t('bridgePromo.dismiss', 'Dismiss')}
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Engine panel */}
        <div className="analysis-panel">
          <div className="analysis-panel-header" onClick={() => togglePanel('engine')}>
            <span className="analysis-panel-header-left">
              <span className="analysis-panel-icon">&#9881;</span>
              <span className="analysis-panel-title">{engineName}{engineStatusSuffix}</span>
              {activeSource === 'external' && (
                <span className={`engine-status-dot engine-status-dot--${sfState === 'ready' || sfState === 'analyzing' ? 'connected' : sfState === 'connecting' ? 'connecting' : 'disconnected'}`} />
              )}
              {engineErrorMessage && (
                <span className="engine-error-detail" title={engineErrorMessage}>{engineErrorMessage}</span>
              )}
            </span>
            <span className="analysis-panel-header-right">
              <span className="engine-multipv-controls" onClick={(e) => e.stopPropagation()}>
                <button className="engine-multipv-btn" onClick={() => ec.setMultiPv((v) => Math.max(1, v - 1))} disabled={ec.multiPv <= 1} title="Fewer lines">−</button>
                <span className="engine-multipv-value">{ec.multiPv}</span>
                <button className="engine-multipv-btn" onClick={() => ec.setMultiPv((v) => Math.min(10, v + 1))} disabled={ec.multiPv >= 10} title="More lines">+</button>
              </span>
              <button className="engine-settings-btn" onClick={(e) => { e.stopPropagation(); ec.setShowEngineModal(true); }} title="Engine settings">⚙</button>
              {wasmSupported && !(isTouchDevice && engineFailed) && (
                <button
                  className="analysis-toggle-btn"
                  onClick={(e) => { e.stopPropagation(); toggleAnalysis(); }}
                  title={analysisEnabled ? t('analysis.stop', 'Stop analysis') : isTouchDevice ? t('analysis.startMobile', 'Start analysis (may not work on mobile)') : t('analysis.start', 'Start analysis')}
                  data-testid="stockfish-toggle"
                  style={{ padding: '2px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 4, border: '1px solid #555', background: analysisEnabled ? '#dc2626' : '#16a34a', color: '#fff', marginLeft: 8, whiteSpace: 'nowrap' }}
                >
                  {analysisEnabled ? t('analysis.stop', 'Stop') : t('analysis.start', 'Start')}
                </button>
              )}
              <span className="analysis-panel-chevron">{panelStates.engine ? '▾' : '▸'}</span>
            </span>
          </div>
          {panelStates.engine && (
            <div className="analysis-panel-body">
              <div className="stockfish-lines">
                {(analysisEnabled || displayedLines.length > 0) &&
                  displayedLines.map((line) => (
                    <div key={line.multipv} className="stockfish-line">
                      <span className={`stockfish-eval${line.score.type === 'mate' ? ' mate' : line.multipv === 1 ? ' best' : ''}`}>
                        {formatEval(line, evalIsBlackTurn)}
                      </span>
                      <span className="stockfish-pv">{formatPv(line.pv, currentFen)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Moves panel */}
        <div className="analysis-panel analysis-panel--flex">
          <div className="analysis-panel-header" onClick={() => togglePanel('moves')}>
            <span className="analysis-panel-header-left">
              <span className="analysis-panel-icon">&#9776;</span>
              <span className="analysis-panel-title">{t('review.moves', 'Moves')}</span>
            </span>
            <span className="analysis-panel-header-right">
              <span className="analysis-panel-chevron">{panelStates.moves ? '▾' : '▸'}</span>
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
                gameInfo={gameInfo}
              />
            </div>
          )}
        </div>
      </div>

      {ec.showEngineModal && (
        <EngineSettingsModal
          engineSource={ec.engineSource}
          multiPv={ec.multiPv}
          setMultiPv={(v) => ec.setMultiPv(v)}
          extUrlInput={ec.extUrlInput}
          setExtUrlInput={ec.setExtUrlInput}
          extKeyInput={ec.extKeyInput}
          setExtKeyInput={ec.setExtKeyInput}
          extNameInput={ec.extNameInput}
          setExtNameInput={ec.setExtNameInput}
          uciThreads={ec.uciThreads}
          setUciThreads={ec.setUciThreads}
          uciHash={ec.uciHash}
          setUciHash={ec.setUciHash}
          savedConfigs={ec.savedConfigs}
          externalConfig={ec.externalConfig}
          setEngineOption={setEngineOption}
          connectionState={sfState}
          errorMessage={engineErrorMessage}
          onClose={() => ec.setShowEngineModal(false)}
          onSwitchToWasm={ec.handleSwitchToWasm}
          onSwitchToExternal={() => ec.setEngineSource('external')}
          onConnectExternal={ec.handleConnectExternal}
          onSelectSavedConfig={ec.handleSelectSavedConfig}
          onDeleteConfig={ec.handleDeleteConfig}
        />
      )}

      {showSetPosition && (
        <SetPositionModal
          initialFen={currentFen}
          onApply={(fen) => {
            setInitialFen(fen);
            setShowSetPosition(false);
          }}
          onClose={() => setShowSetPosition(false)}
        />
      )}
    </div>
  );
}
