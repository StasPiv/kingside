import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import type { EvalLine } from '../hooks/useStockfish';
import { useEngine, loadEngineConfigs, saveEngineConfigs } from '../hooks/useEngine';
import type { EngineSource } from '../hooks/useEngine';
import type { ExternalEngineConfig } from '../hooks/useExternalEngine';
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

const DEFAULT_MULTI_PV = 3;

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

  // Standalone analysis state (only used when gameId is undefined)
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
  // Sync URL to /analysis/{localId} without triggering React Router navigation
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
    history,
    currentMove,
    currentGlobalIndex,
    currentFen,
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

  // Panel collapse state — collapse info/engine on narrow screens so moves are visible
  const [panelStates, setPanelStates] = useState(() => {
    const narrow = typeof window !== 'undefined' && window.innerWidth <= 768;
    return {
      gameInfo: !narrow,
      engine: !narrow,
      moves: true,
    };
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
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
      return false;
    }
    // Restore running state from localStorage (default: false = not running)
    try {
      return localStorage.getItem('analysisRunning') === 'true';
    } catch {
      return false;
    }
  });
  const [engineFailed, setEngineFailed] = useState(false);

  // Engine source: wasm (browser Stockfish) or external (WebSocket bridge)
  // Auto-select external if there's a saved config
  const [savedConfigs, setSavedConfigs] = useState<ExternalEngineConfig[]>(() => loadEngineConfigs());
  const [engineSource, setEngineSource] = useState<EngineSource>(() =>
    loadEngineConfigs().length > 0 ? 'external' : 'wasm',
  );
  const [externalConfig, setExternalConfig] = useState<ExternalEngineConfig | null>(() => {
    const configs = loadEngineConfigs();
    return configs.length > 0 ? configs[0] : null;
  });
  const [showEngineSettings, setShowEngineSettings] = useState(false);
  const [extUrlInput, setExtUrlInput] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.wsUrl ?? '';
  });
  const [extKeyInput, setExtKeyInput] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.secretKey ?? '';
  });
  const [extNameInput, setExtNameInput] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.name ?? '';
  });
  const [uciThreads, setUciThreads] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.uciOptions?.Threads ?? '1';
  });
  const [uciHash, setUciHash] = useState(() => {
    const configs = loadEngineConfigs();
    return configs[0]?.uciOptions?.Hash ?? '256';
  });

  const [multiPv, setMultiPvRaw] = useState(() => {
    try {
      const saved = localStorage.getItem('analysisMultiPv');
      if (saved) { const n = Number(saved); if (n >= 1 && n <= 10) return n; }
    } catch {}
    return DEFAULT_MULTI_PV;
  });
  const setMultiPv = useCallback((v: number | ((prev: number) => number)) => {
    setMultiPvRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { localStorage.setItem('analysisMultiPv', String(next)); } catch {}
      return next;
    });
  }, []);
  const [showEngineModal, setShowEngineModal] = useState(false);

  // Auto-save UCI options to localStorage when they change
  useEffect(() => {
    if (savedConfigs.length === 0 || engineSource !== 'external') return;
    const updated = savedConfigs.map((c) =>
      c.wsUrl === externalConfig?.wsUrl
        ? { ...c, uciOptions: { ...c.uciOptions, Threads: uciThreads, Hash: uciHash } }
        : c,
    );
    saveEngineConfigs(updated);
  }, [uciThreads, uciHash]);

  const {
    lines,
    analysisFen,
    evaluate,
    stop: stopEngine,
    setOption: setEngineOption,
    isReady,
    state: sfState,
    engineName,
    engineSource: activeSource,
    errorMessage: engineErrorMessage,
  } = useEngine({
    source: engineSource,
    externalConfig,
    depth: engineSource === 'external' ? 99 : 18,
    multiPv,
    autoStart: analysisEnabled,
  });

  const buildConfig = useCallback((): ExternalEngineConfig => ({
    name: extNameInput.trim() || 'External Engine',
    wsUrl: extUrlInput.trim(),
    secretKey: extKeyInput.trim(),
    uciOptions: { Threads: uciThreads, Hash: uciHash },
  }), [extUrlInput, extKeyInput, extNameInput, uciThreads, uciHash]);

  const handleConnectExternal = useCallback(() => {
    if (!extUrlInput.trim()) return;
    const cfg = buildConfig();
    setExternalConfig(cfg);
    setEngineSource('external');
    setShowEngineSettings(false);
    // Auto-save on connect
    const updated = [...savedConfigs.filter((c) => c.wsUrl !== cfg.wsUrl), cfg];
    setSavedConfigs(updated);
    saveEngineConfigs(updated);
  }, [extUrlInput, buildConfig, savedConfigs]);

  const handleSaveConfig = useCallback(() => {
    if (!extUrlInput.trim()) return;
    const cfg = buildConfig();
    const updated = [...savedConfigs.filter((c) => c.wsUrl !== cfg.wsUrl), cfg];
    setSavedConfigs(updated);
    saveEngineConfigs(updated);
  }, [extUrlInput, buildConfig, savedConfigs]);

  const handleDeleteConfig = useCallback((wsUrl: string) => {
    const updated = savedConfigs.filter((c) => c.wsUrl !== wsUrl);
    setSavedConfigs(updated);
    saveEngineConfigs(updated);
    if (externalConfig?.wsUrl === wsUrl) {
      if (updated.length > 0) {
        setExternalConfig(updated[0]);
      } else {
        setExternalConfig(null);
        setEngineSource('wasm');
      }
    }
  }, [savedConfigs, externalConfig]);

  const handleSelectSavedConfig = useCallback((cfg: ExternalEngineConfig) => {
    setExternalConfig(cfg);
    setEngineSource('external');
    setExtUrlInput(cfg.wsUrl);
    setExtKeyInput(cfg.secretKey);
    setExtNameInput(cfg.name);
    setUciThreads(cfg.uciOptions?.Threads ?? '1');
    setUciHash(cfg.uciOptions?.Hash ?? '256');
    setShowEngineSettings(false);
  }, []);

  const handleSwitchToWasm = useCallback(() => {
    setEngineSource('wasm');
    setExternalConfig(null);
    setShowEngineSettings(false);
  }, []);

  const configFileRef = useRef<HTMLInputElement>(null);

  const handleLoadConfigFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (!text) return;
      // Simple YAML parser for flat keys: "key: value"
      const lines = text.split('\n');
      let port = '9090';
      let secret = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes(':')) continue;
        const colonIdx = trimmed.indexOf(':');
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key === 'port') port = val;
        if (key === 'secret' || key === 'secret_key') secret = val;
      }
      setExtUrlInput(`ws://localhost:${port}`);
      setExtKeyInput(secret);
      if (!extNameInput) setExtNameInput('Local Engine');
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [extNameInput]);

  const lastLinesRef = useRef<EvalLine[]>([]);
  if (lines.length === multiPv) {
    lastLinesRef.current = lines;
  }
  const displayedLines = lines.length === multiPv ? lines : lastLinesRef.current;

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
        const analysisId = localIdRef.current;
        getById(analysisId).then((saved) => {
          if (saved?.pgn) {
            try {
              const parsedMoves = parseAnnotatedPgn(saved.pgn);
              loadFromPgn(parsedMoves);
              // Restore saved position from API.
              // Use requestAnimationFrame to ensure loadFromPgn state
              // has been committed by React before navigating.
              const savedIdx = saved.currentPosition;
              if (savedIdx != null && savedIdx > 0) {
                requestAnimationFrame(() => {
                  for (let i = 0; i < savedIdx; i++) gotoNext();
                });
              }
            } catch {
              // ignore
            }
            setPgnHeaders(parsePgnHeaders(saved.pgn));
          }
          if (saved?.title) {
            setAnalysisTitle(saved.title);
            setTitleInput(saved.title);
          }
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

  // Save current position to API (debounced).
  // Uses a ref to read localIdRef.current at fire time (not capture time)
  // so it works even if the analysis is created after mount.
  const positionSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentGlobalIndexRef = useRef(currentGlobalIndex);
  currentGlobalIndexRef.current = currentGlobalIndex;

  useEffect(() => {
    if (positionSaveRef.current) clearTimeout(positionSaveRef.current);
    positionSaveRef.current = setTimeout(() => {
      const id = localIdRef.current;
      if (!id) return;
      console.log(`[Analysis] Saving position ${currentGlobalIndexRef.current} for ${id}`);
      updateAnalysis(id, { currentPosition: currentGlobalIndexRef.current }).catch(() => {});
    }, 1000);
    return () => { if (positionSaveRef.current) clearTimeout(positionSaveRef.current); };
  }, [currentGlobalIndex, updateAnalysis]);

  // Auto-save standalone analysis to API
  const localSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (gameId) return;
    if (history.length === 0) return;

    if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);

    localSaveTimerRef.current = setTimeout(async () => {
      const pgn = serializeToAnnotatedPgn(history);

      if (!localIdRef.current) {
        try {
          const entry = await createAnalysis(pgn, analysisTitle);
          localIdRef.current = entry.id;
          window.history.replaceState(null, '', '/analysis/' + entry.id);
        } catch {
          // ignore save errors
        }
      } else {
        updateAnalysis(localIdRef.current, { pgn }).catch(() => {});
      }
    }, 2000);

    return () => {
      if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);
    };
  }, [gameId, history, analysisTitle, createAnalysis, updateAnalysis]);

  useEffect(() => {
    game.load(currentFen);
  }, [currentFen, game]);

  const toggleAnalysis = useCallback(() => {
    setAnalysisEnabled((prev) => {
      const next = !prev;
      if (prev) {
        lastLinesRef.current = [];
        stopEngine();
      } else {
        setEngineFailed(false);
      }
      try { localStorage.setItem('analysisRunning', String(next)); } catch {}
      return next;
    });
  }, []);

  // When engine errors out: if external → delayed fallback to WASM; if WASM → disable
  useEffect(() => {
    if (sfState === 'error' && analysisEnabled) {
      if (engineSource === 'external') {
        // Delay fallback — give bridge time to accept the connection.
        // Without this, a brief WebSocket error during handshake
        // immediately switches to WASM even though bridge is running.
        const timer = setTimeout(() => {
          console.log('[Engine] External engine failed, falling back to WASM');
          setEngineSource('wasm');
          setExternalConfig(null);
        }, 3000);
        return () => clearTimeout(timer);
      } else {
        setEngineFailed(true);
        setAnalysisEnabled(false);
        try { localStorage.setItem('analysisRunning', 'false'); } catch {}
      }
    }
    return undefined;
  }, [sfState, analysisEnabled, engineSource]);

  // Skip the first evaluate after mount for external engine — the bridge
  // may already be analyzing and sending line messages.  Re-sending
  // "analyze" would reset the depth the engine already reached.
  const initialMountRef = useRef(true);

  // Auto-evaluate when position changes (debounced to avoid WASM crashes)
  useEffect(() => {
    if (!analysisEnabled || !isReady || !currentFen) return;

    // On initial mount with external engine: don't send analyze — just
    // listen for line messages already in progress.  Set state to
    // 'analyzing' so UI shows the engine panel correctly.
    if (initialMountRef.current && engineSource === 'external') {
      initialMountRef.current = false;
      return;
    }
    initialMountRef.current = false;

    const timer = setTimeout(() => {
      evaluate(currentFen);
    }, 150);
    return () => clearTimeout(timer);
  }, [currentFen, isReady, evaluate, analysisEnabled, engineSource]);

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

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => makeVariantMove(from, to),
    [makeVariantMove],
  );

  const { squareStyles, setLastMove, onSquareClick } = useBoardHighlights({
    game,
    playerColor: null,
    enabled: inputMode === 'click',
    onMove: inputMode === 'click' ? onClickMove : undefined,
  });

  // Highlight last move on board
  useEffect(() => {
    if (currentMove) {
      const from = currentMove.from as Square;
      const to = currentMove.to as Square;
      setLastMove(from, to);
    }
  }, [currentMove, setLastMove]);

  const handleSquareClick = useCallback(
    ({ square }: { piece?: unknown; square: string }) => onSquareClick(square as Square),
    [onSquareClick],
  );

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

  const isBlackTurn = currentFen.split(' ')[1] === 'b';
  const evalIsBlackTurn = analysisFen ? analysisFen.split(' ')[1] === 'b' : isBlackTurn;
  const whitePercent = evalToPercent(displayedLines, evalIsBlackTurn);

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

  const formatCompact = (n: number): string => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
  };

  const topLine = displayedLines[0];
  const engineStats = analysisEnabled && sfState === 'analyzing' && topLine
    ? (() => {
        const parts = [`d${topLine.depth}`];
        if (activeSource === 'external' && uciThreads !== '1') parts.push(`${uciThreads}cores`);
        if (topLine.nodes) parts.push(`${formatCompact(topLine.nodes)}n`);
        if (topLine.nps) parts.push(`${formatCompact(topLine.nps)}nps`);
        return ` · ${parts.join(' · ')}`;
      })()
    : null;

  const engineStatusSuffix = !wasmSupported
    ? ` · ${t('analysis.notSupported', 'Not supported')}`
    : isTouchDevice && engineFailed
      ? ` · ${t('analysis.notSupportedMobile', 'Not supported on mobile')}`
      : engineStats
        ? engineStats
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
      <div className="analysis-board-area">
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
                <span className="analysis-breadcrumbs__current-text">{analysisTitle}</span>
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

          <div className="analysis-eval-board-row">
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
                {engineName}{engineStatusSuffix}
              </span>
              {activeSource === 'external' && (
                <span className={`engine-status-dot engine-status-dot--${sfState === 'ready' || sfState === 'analyzing' ? 'connected' : sfState === 'connecting' ? 'connecting' : 'disconnected'}`} />
              )}
              {engineErrorMessage && (
                <span className="engine-error-detail" title={engineErrorMessage}>
                  {engineErrorMessage}
                </span>
              )}
            </span>
            <span className="analysis-panel-header-right">
              <span className="engine-multipv-controls" onClick={(e) => e.stopPropagation()}>
                <button
                  className="engine-multipv-btn"
                  onClick={() => setMultiPv((v) => Math.max(1, v - 1))}
                  disabled={multiPv <= 1}
                  title="Fewer lines"
                >−</button>
                <span className="engine-multipv-value">{multiPv}</span>
                <button
                  className="engine-multipv-btn"
                  onClick={() => setMultiPv((v) => Math.min(10, v + 1))}
                  disabled={multiPv >= 10}
                  title="More lines"
                >+</button>
              </span>
              <button
                className="engine-settings-btn"
                onClick={(e) => { e.stopPropagation(); setShowEngineModal(true); }}
                title="Engine settings"
              >
                ⚙
              </button>
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
                onPromoteVariation={(move) => promoteVariation(move as ChessMove)}
                onDeleteVariation={(move) => removeVariation(move as ChessMove)}
                onTruncateRemaining={(move) => truncateRemaining(move as ChessMove)}
                gameInfo={gameInfo}
              />
            </div>
          )}
        </div>
      </div>

      {/* Engine Settings Modal */}
      {showEngineModal && (
        <div className="engine-modal-overlay" onClick={() => setShowEngineModal(false)}>
          <div className="engine-modal" onClick={(e) => e.stopPropagation()}>
            <div className="engine-modal-header">
              <h3>Engine Settings</h3>
              <button className="engine-modal-close" onClick={() => setShowEngineModal(false)}>✕</button>
            </div>

            <div className="engine-settings-sources">
              <button
                className={`engine-source-btn${engineSource === 'wasm' ? ' active' : ''}`}
                onClick={handleSwitchToWasm}
              >
                Browser Stockfish
              </button>
              <button
                className={`engine-source-btn${engineSource === 'external' ? ' active' : ''}`}
                onClick={() => setEngineSource('external')}
              >
                External Engine
              </button>
            </div>

            <div className="engine-uci-options">
              <div className="engine-uci-row">
                <label>MultiPV (lines)</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={multiPv}
                  onChange={(e) => setMultiPv(Math.max(1, Math.min(10, Number(e.target.value))))}
                  className="engine-uci-input"
                />
              </div>
            </div>

            {engineSource === 'external' && (
              <div className="engine-settings-form">
                <input
                  ref={configFileRef}
                  type="file"
                  accept=".yaml,.yml"
                  style={{ display: 'none' }}
                  onChange={handleLoadConfigFile}
                />
                <button
                  className="engine-load-config-btn"
                  onClick={() => configFileRef.current?.click()}
                >
                  📂 {t('engineSettings.loadConfig')}
                </button>
                <input type="text" placeholder="Name" value={extNameInput} onChange={(e) => setExtNameInput(e.target.value)} className="engine-settings-input" />
                <input type="text" placeholder="ws://host:port" value={extUrlInput} onChange={(e) => setExtUrlInput(e.target.value)} className="engine-settings-input" />
                <input type="password" placeholder="Secret key" value={extKeyInput} onChange={(e) => setExtKeyInput(e.target.value)} className="engine-settings-input" />

                <div className="engine-uci-options">
                  <div className="engine-uci-row">
                    <label>Threads</label>
                    <input type="number" min={1} max={512} value={uciThreads} onChange={(e) => { setUciThreads(e.target.value); setEngineOption('Threads', e.target.value); }} className="engine-uci-input" />
                  </div>
                  <div className="engine-uci-row">
                    <label>Hash (MB)</label>
                    <input type="number" min={1} max={65536} value={uciHash} onChange={(e) => { setUciHash(e.target.value); setEngineOption('Hash', e.target.value); }} className="engine-uci-input" />
                  </div>
                </div>

                <div className="engine-settings-actions">
                  <button onClick={handleConnectExternal} className="engine-connect-btn">Connect</button>
                </div>

                {savedConfigs.length > 0 && (
                  <div className="engine-saved-list">
                    <div className="engine-saved-label">Saved:</div>
                    {savedConfigs.map((cfg) => (
                      <div key={cfg.wsUrl} className="engine-saved-row">
                        <button className={`engine-saved-item${externalConfig?.wsUrl === cfg.wsUrl ? ' active' : ''}`} onClick={() => { handleSelectSavedConfig(cfg); setShowEngineModal(false); }}>{cfg.name}</button>
                        <button className="engine-saved-delete" onClick={() => handleDeleteConfig(cfg.wsUrl)} title="Delete">✕</button>
                      </div>
                    ))}
                  </div>
                )}

                <Link to="/help/external-engine" className="engine-help-link" target="_blank">
                  {t('engineHelp.linkText')}
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
