import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { GameMetaBar } from '../components/GameMetaBar';
import type { GameMetaInfo } from '../components/GameMetaBar';
import { EngineSettingsModal } from '../components/EngineSettingsModal';
import { EvalBar } from '../components/EvalBar';
import { MaterialBalance } from '../components/MaterialBalance';
import { SetPositionModal } from '../components/SetPositionModal';
import { PgnHeadersModal } from '../components/PgnHeadersModal';
import { useStablePosition } from '../hooks/useStablePosition';
import type { EvalLine } from '../hooks/useStockfish';
import { useEngine } from '../hooks/useEngine';
import type { EngineSource } from '../hooks/useEngine';
import { useEngineConfig } from '../hooks/useEngineConfig';
import { useContainerSize } from '../hooks/useContainerSize';
import { useFastDrag } from '../hooks/useFastDrag';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBoardSettings, BOARD_SIZES } from '../hooks/useBoardSettings';
import { useBoardHighlights } from '../hooks/useBoardHighlights';
import { HIGHLIGHT_COLORS, annotationColorByModifiers } from '../hooks/useSquareHighlights';
import type { AnnotationColor, ArrowAnnotation, NodeAnnotations, SquareHighlight } from '../review/types';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useReviewState } from '../review/useReviewState';
import { useAnalysisPersistence } from '../review/useAnalysisPersistence';
// KS-2281 (E5 deferred): localStorage autosave для ad-hoc /analysis,
// чтобы NAG-аннотации не терялись при reload страницы.
import { useAdHocAnalysisAutosave } from '../hooks/useAdHocAnalysisAutosave';
import { ReviewMoveList } from '../review/components/ReviewMoveList';
import { VariationChooser } from '../components/VariationChooser';
import type { ChessMove } from '../review/types';
import { parseAnnotatedPgn, extractInitialAnnotations } from '../review/utils/PgnDeserializer';
import { classifyOpening } from '../utils/ecoClassify';
import { EvalGraph } from '../components/EvalGraph';
import { GameReportPanel } from '../components/GameReportPanel';
import { useGameReport } from '../hooks/useGameReport';
import { formatEval, formatPv, formatCompact } from '../utils/chessFormat';
import { searchInHistory, findGlobalIndexByFen } from '../review/utils/ChessHistoryUtils';
import { useSavedAnalyses, getDefaultTitle, parsePgnHeaders } from '../hooks/useSavedAnalyses';
import { serializeToAnnotatedPgn } from '../review/utils/PgnSerializer';
import { HelpButton } from '../components/HelpButton';
import { ArchiveTreePanel } from '../components/analysis/ArchiveTreePanel';

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

function buildPgnWithFen(moves: string, fen: string, headers?: Record<string, string>): string {
  const parts: string[] = [];
  if (headers) {
    // Standard PGN header order
    for (const key of ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'WhiteTitle', 'BlackTitle', 'ECO', 'Opening']) {
      if (headers[key] && headers[key] !== '?' && headers[key] !== '????.??.??') {
        parts.push(`[${key} "${headers[key]}"]`);
      }
    }
  }
  if (fen !== DEFAULT_FEN) {
    parts.push(`[FEN "${fen}"]`);
  }
  if (parts.length > 0) {
    return parts.join('\n') + '\n\n' + moves;
  }
  return moves;
}

type MoveData = {
  san: string;
  uci: string;
  fenAfter: string;
};

export function AnalysisPage() {
  // Add class to body/app for mobile layout (fallback for browsers without :has() support)
  useEffect(() => {
    document.body.classList.add('has-analysis-page');
    const app = document.querySelector('.app');
    app?.classList.add('has-analysis-page');
    return () => {
      document.body.classList.remove('has-analysis-page');
      app?.classList.remove('has-analysis-page');
    };
  }, []);

  const params = useParams<{ id?: string; gameId?: string }>();
  const rawGameId = params.id ?? params.gameId;
  const isAnalysisRoute = params.id !== undefined;
  const isGameRoute = params.gameId !== undefined;
  const gameId = isGameRoute ? params.gameId : undefined;
  const analysisId = isAnalysisRoute && rawGameId !== 'new' ? rawGameId : undefined;
  const location = useLocation();
  const { t } = useTranslation();
  const { user } = useAuth();
  // KS-2114: размер доски на странице анализа (S/M/L) — пресет из общего
  // BoardSettingsContext, сохраняется в localStorage (см. ключ
  // `analysisBoardSize`). UI-переключатель ниже в `.analysis-board-controls`.
  const { boardSize, setBoardSize } = useBoardSettings();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  type MobileTabId = 'moves' | 'engine' | 'tree' | 'report';
  const [mobileTab, setMobileTab] = useState<MobileTabId>('moves');
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  // KS-2220: inline-сообщение возле кнопок «PGN» после копирования.
  // Глобального toast-сервиса в проекте нет (см. ArchiveGamePage —
  // тот же паттерн state + setTimeout).
  const [pgnCopyMsg, setPgnCopyMsg] = useState<string | null>(null);
  const pgnCopyTimerRef = useRef<number | null>(null);
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
  const urlParams = new URLSearchParams(location.search);
  const puzzleFen = (location.state as { puzzleFen?: string } | null)?.puzzleFen ?? urlParams.get('fen') ?? undefined;
  const puzzlePgn = (location.state as { puzzlePgn?: string } | null)?.puzzlePgn ?? urlParams.get('pgn') ?? undefined;
  const puzzleMovesParam = urlParams.get('moves') ?? undefined;
  const puzzleSide = urlParams.get('side') as 'white' | 'black' | null;
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
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  // KS-1576: Variation chooser state — открывается при ArrowRight если у следующего хода есть альтернативы
  const [variationChooser, setVariationChooser] = useState<
    { mainLine: ChessMove; variations: ChessMove[][] } | null
  >(null);

  useEffect(() => {
    if (!gameId && localIdRef.current && !analysisId) {
      window.history.replaceState(null, '', '/analysis/' + localIdRef.current);
    }
    // KS-2034: эффект «при монтировании выставить URL по локальному id»
    // должен запускаться один раз. Зависимости (`gameId`, `analysisId`)
    // не нужны — при их смене `replaceState` бы перезатёр URL,
    // подставленный пользователем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const containerSize = useContainerSize(boardContainerRef);
  const boardWidth = Math.min(containerSize.width, containerSize.height);
  const { boardThemeOptions } = useBoardTheme();

  const {
    history, currentMove, currentGlobalIndex, currentFen, initialFen,
    loadMoves, loadFromPgn, setInitialFen, gotoMove, gotoFirst, gotoLast,
    gotoPrevious, gotoNext, makeVariantMove, removeVariation,
    truncateRemaining, promoteVariation, setNag, setComment,
    // KS-2287 (ADR-038): variation-color через reducer.
    setVariationColor,
    // KS-2152
    currentAnnotations, initialAnnotations, annotationsByIndex, setAnnotationsForCurrent,
  } = useReviewState();

  const game = useMemo(() => new Chess(), []);

  // Load puzzle position if navigated from PuzzlePage
  useEffect(() => {
    if (puzzleFen && !gameId && !analysisId) {
      setInitialFen(puzzleFen);
      if (puzzleSide) setBoardOrientation(puzzleSide);
      if (puzzlePgn) {
        try {
          // Parse SAN moves from PGN and apply with custom FEN
          const sanMoves = puzzlePgn.replace(/\d+\.\.\./g, '').replace(/\d+\./g, '').trim().split(/\s+/).filter(Boolean);
          const replay = new Chess(puzzleFen);
          const chessMoves: ChessMove[] = [];
          for (const san of sanMoves) {
            if (san === '*' || san === '1-0' || san === '0-1' || san === '1/2-1/2') break;
            const mv = replay.move(san);
            if (!mv) break;
            chessMoves.push({
              san: mv.san,
              uci: mv.from + mv.to + (mv.promotion || ''),
              fenAfter: replay.fen(),
            } as unknown as ChessMove);
          }
          loadFromPgn(chessMoves);
        } catch { /* ignore parse errors */ }
      } else if (puzzleMovesParam) {
        try {
          // Parse UCI moves from query param
          const uciMoves = puzzleMovesParam.split(/[\s+]+/).filter(Boolean);
          const replay = new Chess(puzzleFen);
          const chessMoves: ChessMove[] = [];
          for (const uci of uciMoves) {
            const mv = replay.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
            if (!mv) break;
            chessMoves.push({
              san: mv.san,
              uci: mv.from + mv.to + (mv.promotion || ''),
              fenAfter: replay.fen(),
            } as unknown as ChessMove);
          }
          if (chessMoves.length > 0) loadFromPgn(chessMoves);
        } catch { /* ignore parse errors */ }
      }
    }
    // KS-2034: эффект «загрузить позицию из puzzle при монтировании»
    // запускается один раз. Если положить `puzzleFen/puzzleSide/...` в
    // deps, при их обновлении (router-state) восстановление позиции
    // перетрёт работу пользователя в редакторе.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Game Report
  const { report: gameReport, analyzing: reportAnalyzing, error: reportError, fetchReport, analyze: analyzeGame } = useGameReport(gameId);
  useEffect(() => { if (gameId) fetchReport(); }, [gameId, fetchReport]);



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
  const [showPgnHeaders, setShowPgnHeaders] = useState(false);
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
        try {
          const fenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/);
          if (fenMatch) setInitialFen(fenMatch[1]);
          loadFromPgn(parseAnnotatedPgn(pgn), extractInitialAnnotations(pgn));
        } catch { /* ignore */ }
        setPgnHeaders(parsePgnHeaders(pgn));
      } else if (localIdRef.current) {
        const id = localIdRef.current;
        getById(id).then((saved) => {
          if (saved?.pgn) {
            try {
              // Restore custom starting position if FEN header present
              const fenMatch = saved.pgn.match(/\[FEN\s+"([^"]+)"\]/);
              if (fenMatch) setInitialFen(fenMatch[1]);
              loadFromPgn(parseAnnotatedPgn(saved.pgn), extractInitialAnnotations(saved.pgn));
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
          api.get<GameData>(`/games/${gameId}`),
          api.get<MoveData[]>(`/games/${gameId}/moves`),
          isAuthenticated ? api.get<{ analysisPgn: string | null }>(`/games/${gameId}/analysis`).catch(() => null) : Promise.resolve(null),
        ];
        const [gData, mData, analysisData] = await Promise.all(requests);
        setGameData(gData);
        if (analysisData?.analysisPgn) {
          try { loadFromPgn(parseAnnotatedPgn(analysisData.analysisPgn), extractInitialAnnotations(analysisData.analysisPgn)); } catch { loadMoves(mData); }
        } else { loadMoves(mData); }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('review.loadError'));
      } finally { setLoading(false); }
    };
    fetchData();
  }, [gameId, location.state, t, loadMoves, loadFromPgn, getById]);

  useAnalysisPersistence(gameId, history, initialAnnotations, annotationsByIndex);

  // KS-2281: ad-hoc autosave (localStorage). Активен только когда нет
  // gameId и нет сохранённого analysisId — для review (gameId) работает
  // useAnalysisPersistence через PUT /games/:id/analysis, для saved
  // (analysisId) — useSavedAnalyses.update; для puzzleFen / "/analysis"
  // / custom-position'а раньше autosave не было совсем.
  useAdHocAnalysisAutosave({
    enabled: !gameId && !analysisId,
    initialFen,
    history,
    initialAnnotations,
    annotationsByIndex,
    onRestore: useCallback(
      (pgn: string) => {
        try {
          loadFromPgn(parseAnnotatedPgn(pgn), extractInitialAnnotations(pgn));
        } catch {
          /* пропуск битого snapshot'а — autosave best-effort */
        }
      },
      [loadFromPgn],
    ),
  });

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
  const hasPgnHeaders = Object.keys(pgnHeaders).length > 0;
  const hasInitialAnnotations = !!initialAnnotations;
  useEffect(() => {
    if (!user) return;
    if (gameId) return;
    if (history.length === 0 && !hasPgnHeaders && !hasInitialAnnotations) return;
    if (positionSaveRef.current) { clearTimeout(positionSaveRef.current); positionSaveRef.current = null; }
    if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current);

    localSaveTimerRef.current = setTimeout(async () => {
      // KS-2152: initialAnnotations попадают в leading-комментарий PGN
      const movesOnly = serializeToAnnotatedPgn(history, initialAnnotations, annotationsByIndex);
      const pgn = buildPgnWithFen(movesOnly, initialFen, pgnHeaders);
      if (!localIdRef.current) {
        try {
          const category = gameId ? 'game_review' : puzzleFen ? 'puzzle' : 'analysis';
          const entry = await createAnalysis(pgn, analysisTitle, category);
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
      // KS-2152: debounce 600мс — иначе пользователь успевает перезагрузить
      // страницу до сохранения, и при reload подгружается старый PGN с
      // прошлыми аннотациями (выглядит как «цвет стрелки сменился сам»).
    }, 600);
    return () => { if (localSaveTimerRef.current) clearTimeout(localSaveTimerRef.current); };
  }, [gameId, history, analysisTitle, initialFen, pgnHeaders, hasPgnHeaders, hasInitialAnnotations, initialAnnotations, annotationsByIndex, createAnalysis, updateAnalysis]);

  // KS-2152: при unload/visibility hidden flush'им несохранённое — чтобы
  // ALT-tab или close window не съели только что нарисованные аннотации.
  const flushSaveOnHide = useCallback(() => {
    if (!user) return;
    if (gameId) return;
    if (!localIdRef.current) return;
    if (history.length === 0 && !hasPgnHeaders && !hasInitialAnnotations) return;
    if (localSaveTimerRef.current) {
      clearTimeout(localSaveTimerRef.current);
      localSaveTimerRef.current = null;
    }
    const movesOnly = serializeToAnnotatedPgn(history, initialAnnotations, annotationsByIndex);
    const pgn = buildPgnWithFen(movesOnly, initialFen, pgnHeaders);
    // sendBeacon — единственный надёжный способ сохранить во время unload.
    try {
      const url = `${import.meta.env.VITE_API_URL ?? ''}/analyses/${localIdRef.current}`;
      const token = localStorage.getItem('token');
      const blob = new Blob([JSON.stringify({ pgn })], { type: 'application/json' });
      // sendBeacon does PATCH-like POST; fallback на updateAnalysis
      if (navigator.sendBeacon && !token) {
        navigator.sendBeacon(url, blob);
      } else {
        updateAnalysis(localIdRef.current, { pgn }).catch(() => {});
      }
    } catch {
      updateAnalysis(localIdRef.current, { pgn }).catch(() => {});
    }
  }, [user, gameId, history, hasPgnHeaders, hasInitialAnnotations, initialFen, pgnHeaders, initialAnnotations, annotationsByIndex, updateAnalysis]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushSaveOnHide();
    };
    window.addEventListener('pagehide', flushSaveOnHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flushSaveOnHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flushSaveOnHide]);

  useEffect(() => { game.load(currentFen); }, [currentFen, game]);

  // --- Promotion detection ---
  const isPromotionMove = useCallback((from: string, to: string): boolean => {
    const piece = game.get(from as Square);
    if (!piece || piece.type !== 'p') return false;
    const targetRank = to[1];
    return (piece.color === 'w' && targetRank === '8') || (piece.color === 'b' && targetRank === '1');
  }, [game]);

  const handlePromotionChoice = useCallback((piece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    makeVariantMove(pendingPromotion.from, pendingPromotion.to, piece);
    setPendingPromotion(null);
  }, [pendingPromotion, makeVariantMove]);

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

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

  // KS-1576: helper — вычисляет следующий ход основной линии и альтернативные ветки
  const getNextOptions = useCallback((): { mainLine: ChessMove; variations: ChessMove[][] } | null => {
    let mainLine: ChessMove | null = null;
    if (currentMove === null) {
      if (history.length === 0) return null;
      mainLine = history[0] as ChessMove;
    } else {
      if (!currentMove.next) return null;
      mainLine = currentMove.next as ChessMove;
    }
    const variations = (mainLine.variations ?? []) as ChessMove[][];
    return { mainLine, variations };
  }, [currentMove, history]);

  const handleArrowRight = useCallback(() => {
    // Если окошко выбора уже открыто — ничего не делаем (сценарий: повторное нажатие не открывает второе)
    if (variationChooser) return;
    const options = getNextOptions();
    if (!options) {
      gotoNext();
      return;
    }
    if (options.variations.length > 0) {
      setVariationChooser(options);
      return;
    }
    gotoNext();
  }, [variationChooser, getNextOptions, gotoNext]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Пока открыт variation chooser — он сам управляет клавиатурой
      if (variationChooser) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); gotoPrevious(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); handleArrowRight(); }
      else if (e.key === 'Home') { e.preventDefault(); gotoFirst(); }
      else if (e.key === 'End') { e.preventDefault(); gotoLast(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gotoPrevious, handleArrowRight, gotoFirst, gotoLast, variationChooser]);

  // Close overflow menu on click outside
  useEffect(() => {
    if (!showOverflowMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showOverflowMenu]);

  // KS-2220: сериализация PGN вынесена из handleExportPgn в общий
  // helper, чтобы handleCopyPgn использовал ровно тот же текст, что и
  // скачивание файла (включая заголовки + аннотации).
  const buildAnalysisPgn = useCallback((): string | null => {
    if (history.length === 0) return null;
    const headers: string[] = [];
    headers.push(`[Event "${pgnHeaders['Event'] || analysisTitle || 'Analysis'}"]`);
    headers.push(`[Site "${pgnHeaders['Site'] || 'Kingside'}"]`);
    headers.push(`[Date "${pgnHeaders['Date'] || new Date().toISOString().slice(0, 10).replace(/-/g, '.')}"]`);
    if (pgnHeaders['Round']) headers.push(`[Round "${pgnHeaders['Round']}"]`);
    if (pgnHeaders['White']) headers.push(`[White "${pgnHeaders['White']}"]`);
    if (pgnHeaders['Black']) headers.push(`[Black "${pgnHeaders['Black']}"]`);
    headers.push(`[Result "${pgnHeaders['Result'] || '*'}"]`);
    if (pgnHeaders['WhiteElo']) headers.push(`[WhiteElo "${pgnHeaders['WhiteElo']}"]`);
    if (pgnHeaders['BlackElo']) headers.push(`[BlackElo "${pgnHeaders['BlackElo']}"]`);
    if (initialFen !== DEFAULT_FEN) headers.push(`[FEN "${initialFen}"]`);
    // KS-2152: initialAnnotations попадают в leading-комментарий, а
    // node-annotations берутся из annotationsByIndex (state useReviewState).
    const moves = serializeToAnnotatedPgn(history, initialAnnotations, annotationsByIndex);
    return headers.join('\n') + '\n\n' + moves + '\n';
  }, [history, analysisTitle, initialFen, pgnHeaders, initialAnnotations, annotationsByIndex]);

  // Export PGN handler
  const handleExportPgn = useCallback(() => {
    try {
      const pgn = buildAnalysisPgn();
      if (pgn === null) return;
      const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(analysisTitle || 'analysis').replace(/[^a-zA-Z0-9_-]/g, '_')}.pgn`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (err) {
      console.error('[Export PGN] Failed:', err);
    }
  }, [buildAnalysisPgn, analysisTitle]);

  // KS-2220: handleCopyPgn — копирует тот же PGN, что и handleExportPgn,
  // в буфер обмена через `navigator.clipboard.writeText`. Inline-сообщение
  // возле кнопок (success/error) автоматически скрывается через 1.8 сек.
  const handleCopyPgn = useCallback(async () => {
    const pgn = buildAnalysisPgn();
    if (pgn === null) return;
    try {
      await navigator.clipboard.writeText(pgn);
      setPgnCopyMsg(t('review.pgnCopied', 'PGN copied to clipboard'));
    } catch (err) {
      console.error('[Copy PGN] Failed:', err);
      setPgnCopyMsg(t('review.pgnCopyError', 'Failed to copy PGN'));
    }
    if (pgnCopyTimerRef.current) {
      window.clearTimeout(pgnCopyTimerRef.current);
    }
    pgnCopyTimerRef.current = window.setTimeout(() => setPgnCopyMsg(null), 1800);
  }, [buildAnalysisPgn, t]);

  // Очистка таймера при unmount, чтобы setState не дёргался на размонтированный компонент.
  useEffect(() => {
    return () => {
      if (pgnCopyTimerRef.current) {
        window.clearTimeout(pgnCopyTimerRef.current);
      }
    };
  }, []);

  // --- Board setup ---
  const stablePosition = useStablePosition(currentFen);
  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const onClickMove = useCallback(
    (from: Square, to: Square): boolean => {
      if (isPromotionMove(from, to)) {
        // Validate the move is legal before showing dialog
        const testGame = new Chess(currentFen);
        const testMove = testGame.move({ from, to, promotion: 'q' });
        if (!testMove) return false;
        setPendingPromotion({ from, to });
        return true;
      }
      return makeVariantMove(from, to);
    },
    [makeVariantMove, isPromotionMove, currentFen],
  );

  const { squareStyles, arrows, setLastMove, onSquareClick, setSuggestedArrow } = useBoardHighlights({
    game, playerColor: null, enabled: true,
    onMove: onClickMove,
  });

  // KS-2152: highlight-стили для клеток из текущей ноды/стартовой позиции.
  // Сама логика toggle (ПКМ-click и ПКМ-drag) теперь в handleBoardMouseUp —
  // это единая точка, чтобы Chrome contextmenu (пуляющийся на mousedown)
  // не подсвечивал start-клетку при ПКМ-drag.
  const highlightStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    const list = currentAnnotations?.highlights;
    if (list) {
      for (const h of list) {
        styles[h.square] = { backgroundColor: HIGHLIGHT_COLORS[h.color] };
      }
    }
    return styles;
  }, [currentAnnotations]);

  // KS-2152: запоминаем start-клетку для последующего mouseUp.
  // onSquareRightClick library НЕ используется — Chrome шлёт contextmenu
  // на mousedown right (до завершения drag), library тут же вызывает
  // onSquareRightClick на START-клетке, и highlight приклеивается к
  // начальной клетке стрелки. Поэтому весь right-click-функционал
  // (highlight + drag-toggle стрелок) обрабатываем в одной точке —
  // в handleBoardMouseUp.
  const handleBoardMouseDown = useCallback(
    (_args: { square: string }, e: React.MouseEvent) => {
      if (e.button === 2) {
        arrowDragStartRef.current = _args.square;
        arrowDragModsRef.current = {
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        };
        // KS-2157: фиксируем цвет preview по модификаторам в момент mousedown.
        // Library знает Shift и Ctrl — для них устанавливаются
        // secondaryColor/tertiaryColor в arrowOptions. Alt library не
        // различает: при Alt-only подменяем default `color` на синий, чтобы
        // preview совпадал с финальным.
        if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          setPreviewDefaultColor(HIGHLIGHT_COLORS.blue);
        } else {
          setPreviewDefaultColor(HIGHLIGHT_COLORS.red);
        }
      }
    },
    [],
  );

  const handleBoardMouseUp = useCallback(
    (args: { square: string }, e: React.MouseEvent) => {
      const dragStart = arrowDragStartRef.current;
      const dragMods = arrowDragModsRef.current;
      arrowDragStartRef.current = null;
      arrowDragModsRef.current = null;
      if (e.button !== 2 || !dragStart) return;

      // Используем модификаторы из mouseDown (пользователь мог отпустить
      // клавишу до отпускания мыши); если по какой-то причине ref пуст —
      // fallback на текущее состояние event'а.
      const mods = dragMods ?? {
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      };

      const highlightsCurrent = currentAnnotations?.highlights;
      const arrowsCurrent = currentAnnotations?.arrows;

      if (dragStart === args.square) {
        // Одиночный ПКМ-клик по той же клетке → toggle highlight.
        const color: AnnotationColor = annotationColorByModifiers(mods);
        const list = highlightsCurrent ?? [];
        const idx = list.findIndex((h) => h.square === args.square);
        let newHighlights: SquareHighlight[];
        if (idx >= 0 && list[idx].color === color) {
          newHighlights = list.slice(0, idx).concat(list.slice(idx + 1));
        } else if (idx >= 0) {
          newHighlights = list.slice();
          newHighlights[idx] = { square: args.square, color };
        } else {
          newHighlights = list.concat({ square: args.square, color });
        }
        const next: NodeAnnotations | undefined =
          newHighlights.length === 0 && (!arrowsCurrent || arrowsCurrent.length === 0)
            ? undefined
            : {
                ...(newHighlights.length > 0 && { highlights: newHighlights }),
                ...(arrowsCurrent && { arrows: arrowsCurrent }),
              };
        setAnnotationsForCurrent(next);
        return;
      }

      // Drag — toggle стрелки.
      const list = arrowsCurrent ?? [];
      const idx = list.findIndex((a) => a.from === dragStart && a.to === args.square);
      let newArrows: ArrowAnnotation[];
      if (idx >= 0) {
        newArrows = list.slice(0, idx).concat(list.slice(idx + 1));
      } else {
        const color: AnnotationColor = annotationColorByModifiers(mods);
        newArrows = list.concat({ from: dragStart, to: args.square, color });
      }
      const next: NodeAnnotations | undefined =
        newArrows.length === 0 && (!highlightsCurrent || highlightsCurrent.length === 0)
          ? undefined
          : {
              ...(highlightsCurrent && { highlights: highlightsCurrent }),
              ...(newArrows.length > 0 && { arrows: newArrows }),
            };
      setAnnotationsForCurrent(next);
    },
    [currentAnnotations, setAnnotationsForCurrent],
  );

  // KS-2152: стрелки обрабатываем сами через onSquareMouseDown/MouseUp.
  //
  // Полагаться на library `onArrowsChange` нельзя: react-chessboard в своём
  // drawArrow проверяет `arrows.some((a) => a.startSquare === ... && a.endSquare === ...)`
  // (внешний `arrows`-prop) и если стрелка там есть — РАННИЙ return,
  // internal не меняется, onArrowsChange не вызывается. Это блокирует
  // повторный drag по сохранённой стрелке (toggle off). Поэтому всю
  // логику drag-toggle ведём на нашей стороне:
  //  - onSquareMouseDown с button=2 → запоминаем `from`-клетку;
  //  - onSquareMouseUp с button=2 на ДРУГОЙ клетке → drag завершён,
  //    делаем toggle в state.annotationsByIndex;
  //  - mouseUp на той же клетке → одиночный ПКМ-клик, library сама
  //    вызовет onSquareRightClick (наш highlight-toggle).
  // А `onArrowsChange` оставляем no-op — нам ничего не надо синхронизировать
  // от library, она лишь визуально дублирует наш external arrows до
  // ремоунта (см. `annotationsKey`).
  const arrowDragStartRef = useRef<string | null>(null);
  // KS-2152: модификаторы клавиатуры запоминаются в mouseDown — пользователь
  // мог отпустить Shift/Alt/Ctrl до того, как отпустил мышь, и mouseUp event
  // уже не содержит флага. Финальный цвет аннотации должен быть тем, что
  // был зафиксирован в начале действия.
  const arrowDragModsRef = useRef<{
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  } | null>(null);

  // KS-2157: цвет preview-стрелки (library default `color`) во время drag.
  // Library сама умеет Shift → secondaryColor и Ctrl → tertiaryColor.
  // Alt library не различает — для Alt подменяем default `color` на синий
  // в момент mousedown, чтобы preview совпадал с финальным.
  // По спеке: без модификаторов = красный (= default), Alt = синий.
  const [previewDefaultColor, setPreviewDefaultColor] = useState<string>(HIGHLIGHT_COLORS.red);

  const handleArrowsChange = useCallback(() => {
    // no-op (см. комментарий выше)
  }, []);

  // Стрелки текущей ноды → внешние arrows для react-chessboard.
  const annotationArrows = useMemo(() => {
    const list = currentAnnotations?.arrows ?? [];
    return list.map((a) => ({
      startSquare: a.from,
      endSquare: a.to,
      color: HIGHLIGHT_COLORS[a.color],
    }));
  }, [currentAnnotations]);

  // Объединённые стили: подсветка из useBoardHighlights + правый клик (annotations).
  // Annotations имеют приоритет (показываются поверх).
  const mergedSquareStyles = useMemo(() => {
    const merged: Record<string, React.CSSProperties> = { ...squareStyles };
    for (const [square, style] of Object.entries(highlightStyles)) {
      merged[square] = { ...merged[square], ...style };
    }
    return merged;
  }, [squareStyles, highlightStyles]);

  // Объединённые стрелки: hover-suggestion (useBoardHighlights) + аннотации.
  const mergedArrows = useMemo(
    () => [...arrows, ...annotationArrows],
    [arrows, annotationArrows],
  );

  // KS-2152: Ремоунт MemoChessboard при смене ноды/позиции И при изменении
  // arrows. Highlights в key НЕ кладём — для них достаточно identity-сравнения
  // squareStyles в areOptionsEqual.
  //
  // Зачем ремоунт на arrows: library кэширует свой internalArrows и при
  // повторном drag не очищает их (она ранний return, если стрелка есть в
  // external). Ремоунт сбрасывает internalArrows → новый external из
  // currentAnnotations.arrows становится единственным источником.
  //
  // handleArrowsChange — no-op, поэтому initial useEffect onArrowsChange
  // в Chessboard после ремоунта ничего не сбросит.
  const annotationsKey = useMemo(
    () => `${currentGlobalIndex}|${currentFen}|${JSON.stringify(currentAnnotations?.arrows ?? null)}`,
    [currentGlobalIndex, currentFen, currentAnnotations?.arrows],
  );

  // --- Archive tree handlers ---
  const handleTreeMove = useCallback(
    (uci: string) => {
      if (uci.length < 4) return;
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      makeVariantMove(from, to, promotion);
    },
    [makeVariantMove],
  );

  const handleTreeHover = useCallback(
    (uci: string | null) => {
      if (!uci || uci.length < 4) {
        setSuggestedArrow(null, null);
        return;
      }
      setSuggestedArrow(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square);
    },
    [setSuggestedArrow],
  );

  useEffect(() => {
    if (currentMove) setLastMove(currentMove.from as Square, currentMove.to as Square);
  }, [currentMove, setLastMove]);

  // KS-2215: стрелка-подсказка от hover на ход из дерева/книги обязана
  // исчезать при любой смене позиции на доске. На touch-устройствах
  // mouseLeave у строки дерева после tap не приходит, поэтому стрелка
  // «прилипала» к доске после выбора хода. Любая смена currentFen
  // (стрелки управления, клик в линию движка, ход на доске, выбор строки
  // в дереве) безусловно сбрасывает suggestedArrow.
  useEffect(() => {
    setSuggestedArrow(null, null);
  }, [currentFen, setSuggestedArrow]);

  // KS-2151: звук ходов в Мастерской.
  // Триггерим на смену currentMove — это покрывает оба источника:
  //  - ход пользователя (makeVariantMove → новый currentMove);
  //  - навигация по дереву (gotoNext/Previous/Last/First/gotoMove).
  // Первый рендер (prevIndex === null) НЕ озвучиваем — иначе при открытии
  // сохранённой партии с last-position будет лишний звук на старте.
  // soundEventFromSan различает move/capture/check/castle по SAN.
  const { playSound } = useSounds();
  const prevMoveGlobalIndexRef = useRef<number | null>(null);
  const isFirstSoundRenderRef = useRef(true);
  useEffect(() => {
    const currentIndex = currentMove?.globalIndex ?? null;
    const prevIndex = prevMoveGlobalIndexRef.current;
    if (isFirstSoundRenderRef.current) {
      isFirstSoundRenderRef.current = false;
      prevMoveGlobalIndexRef.current = currentIndex;
      return;
    }
    if (currentIndex !== prevIndex) {
      if (currentMove) {
        playSound(soundEventFromSan(currentMove.san));
      } else {
        // Возврат к стартовой позиции (gotoFirst) — короткий «плик» хода
        playSound('move');
      }
    }
    prevMoveGlobalIndexRef.current = currentIndex;
  }, [currentMove, playSound]);

  // KS-2152: левый клик НЕ сбрасывает аннотации — они привязаны к ноде и
  // должны жить вместе с ней. Сброс происходит автоматически при смене ноды
  // (currentMove → новый currentAnnotations).
  const handleSquareClick = useCallback(
    ({ square }: { piece?: unknown; square: string }) => onSquareClick(square as Square),
    [onSquareClick],
  );

  const handlePieceClick = useCallback(
    ({ square }: { isSparePiece?: boolean; piece?: unknown; square: string | null }) => {
      if (square) onSquareClick(square as Square);
    },
    [onSquareClick],
  );

  // KS-2034: legacy `handlePieceDrop` удалён — вместо него используется
  // `handleFastDragDrop` (быстрый drop без анимации). Если потребуется
  // вернуть «классический» drop — восстановить из истории git.

  const handleFastDragDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!targetSquare) return false;
      if (isPromotionMove(sourceSquare, targetSquare)) {
        const testGame = new Chess(currentFen);
        const testMove = testGame.move({ from: sourceSquare as Square, to: targetSquare as Square, promotion: 'q' });
        if (!testMove) return false;
        setPendingPromotion({ from: sourceSquare, to: targetSquare });
        return true;
      }
      return makeVariantMove(sourceSquare, targetSquare);
    },
    [makeVariantMove, isPromotionMove, currentFen],
  );

  const { suppressAnimationRef } = useFastDrag(boardContainerRef, {
    onPieceDrop: handleFastDragDrop,
    boardOrientation,
    allowBothColors: true,
    enabled: !loading,
  });

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation,
      animationDurationInMs: suppressAnimationRef.current ? 0 : 200,
      allowDragging: false,
      showNotation: true,
      squareStyles: mergedSquareStyles,
      arrows: mergedArrows,
      onSquareClick: handleSquareClick,
      onPieceClick: handlePieceClick,
      onSquareMouseDown: handleBoardMouseDown,
      onSquareMouseUp: handleBoardMouseUp,
      // KS-2157: цвета preview-стрелки во время ПКМ-drag.
      // Спека: без модификаторов = red, Shift = green, Alt = blue, Ctrl = yellow.
      // Library поддерживает Shift и Ctrl — secondaryColor/tertiaryColor.
      // Alt library не знает: для Alt-only мы динамически меняем `color` через
      // previewDefaultColor (см. handleBoardMouseDown).
      arrowOptions: {
        color: previewDefaultColor,
        secondaryColor: HIGHLIGHT_COLORS.green,
        tertiaryColor: HIGHLIGHT_COLORS.yellow,
        // Дефолтные значения react-chessboard.
        arrowLengthReducerDenominator: 8,
        sameTargetArrowLengthReducerDenominator: 4,
        arrowWidthDenominator: 5,
        activeArrowWidthMultiplier: 0.9,
        opacity: 0.65,
        activeOpacity: 0.5,
        arrowStartOffset: 0,
      },
      // KS-2152: onSquareRightClick НЕ передаём — Chrome шлёт contextmenu
      // ещё на mousedown (до завершения drag). Если library вызовет наш
      // right-click-handler, highlight приклеится к старт-клетке drag'а
      // (ПКМ-drag e2→e4 подсвечивал бы e2). Highlight + arrow toggle
      // обрабатываем в handleBoardMouseUp по сравнению start/end.
      // onArrowsChange — no-op; ремоунт через `key={annotationsKey}` сбрасывает
      // library internalArrows, наш external из state — единственный источник.
      onArrowsChange: handleArrowsChange,
      ...(boardStyle && { boardStyle }),
      ...boardThemeOptions,
    }),
    [stablePosition, boardOrientation, boardStyle, boardThemeOptions, mergedSquareStyles, mergedArrows, handleSquareClick, handlePieceClick, handleBoardMouseDown, handleBoardMouseUp, handleArrowsChange, previewDefaultColor],
  );

  // SAN path from the root to the currently viewed position (follows variations).
  // Used for the Database panel's opening heading — must reflect the active branch.
  // NOTE: must live above the early returns below — hooks cannot be conditional.
  const currentSanPath = useMemo(() => {
    if (!currentMove) return [];
    const path: string[] = [];
    let cur: ChessMove | null | undefined = currentMove;
    while (cur) {
      path.push(cur.san);
      cur = cur.previous ?? null;
    }
    return path.reverse();
  }, [currentMove]);

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
  const treeOpeningName = classifyOpening(currentSanPath);

  const gameInfo: GameMetaInfo | undefined = gameData
    ? {
        white: { username: gameData.white.username, rating: gameData.whiteRatingBefore ?? null },
        black: { username: gameData.black.username, rating: gameData.blackRatingBefore ?? null },
        opening: openingName || undefined,
        result: resultPgn,
        ratingChange: gameData.ratingChange || undefined,
      }
    : pgnHeaders['White'] && pgnHeaders['Black']
      ? {
          white: { username: pgnHeaders['White'], rating: pgnHeaders['WhiteElo'] ? Number(pgnHeaders['WhiteElo']) : undefined },
          black: { username: pgnHeaders['Black'], rating: pgnHeaders['BlackElo'] ? Number(pgnHeaders['BlackElo']) : undefined },
          opening: openingName || pgnHeaders['Opening'] || undefined,
          result: pgnHeaders['Result'] && pgnHeaders['Result'] !== '*' ? pgnHeaders['Result'] : undefined,
          event: pgnHeaders['Event'] && pgnHeaders['Event'] !== '?' ? pgnHeaders['Event'] : undefined,
          date: pgnHeaders['Date'] && pgnHeaders['Date'] !== '????.??.??' ? pgnHeaders['Date'] : undefined,
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
            <HelpButton section="analyze" />
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
          {gameInfo ? <GameMetaBar info={gameInfo} /> : <div className="game-meta-bar"><div className="game-meta-bar__mobile" /><div className="game-meta-bar__desktop" /></div>}

          <div className="analysis-eval-board-row">
            <EvalBar lines={displayedLines} isBlackTurn={evalIsBlackTurn} />
            <div className="board-container" ref={boardContainerRef}>
              <MemoChessboard key={annotationsKey} options={boardOptions} />
              {pendingPromotion && (
                <div className="promotion-overlay" onClick={handlePromotionCancel}>
                  <div className="promotion-dialog" onClick={(e) => e.stopPropagation()}>
                    {(['q', 'r', 'b', 'n'] as const).map((piece) => {
                      const color = pendingPromotion.to[1] === '8' ? 'w' : 'b';
                      const isWhite = color === 'w';
                      const pieceNames: Record<string, string> = { q: 'Q', r: 'R', b: 'B', n: 'N' };
                      return (
                        <button
                          key={piece}
                          className="promotion-piece"
                          onClick={() => handlePromotionChoice(piece)}
                          data-piece={`${color}${pieceNames[piece]}`}
                        >
                          {piece === 'q' ? (isWhite ? '\u2655' : '\u265B') : null}
                          {piece === 'r' ? (isWhite ? '\u2656' : '\u265C') : null}
                          {piece === 'b' ? (isWhite ? '\u2657' : '\u265D') : null}
                          {piece === 'n' ? (isWhite ? '\u2658' : '\u265E') : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {variationChooser && (
            <VariationChooser
              mainLine={variationChooser.mainLine}
              variations={variationChooser.variations}
              onSelect={(move) => {
                setVariationChooser(null);
                gotoMove(move);
              }}
              onClose={() => setVariationChooser(null)}
            />
          )}

          <div className="analysis-board-controls">
            <button onClick={gotoFirst} disabled={isAtStart} title={t('review.toStart')}>&#x21E4;</button>
            <button onClick={gotoPrevious} disabled={isAtStart} title={t('review.back')}>&#x2190;</button>
            <button onClick={handleArrowRight} disabled={isAtEnd} title={t('review.forward')}>&#x2192;</button>
            <button onClick={gotoLast} disabled={isAtEnd} title={t('review.toEnd')}>&#x21E5;</button>
            <button
              className="analysis-flip-btn"
              onClick={() => setBoardOrientation((o) => o === 'white' ? 'black' : 'white')}
              title={t('analysis.flipBoard', 'Flip board')}
            >
              ⇅
            </button>
            {/* KS-2114: переключатель размера доски S/M/L. Значение
                сохраняется в localStorage через BoardSettingsContext и
                применяется к `.analysis-page .board-container` через
                CSS-переменную `--analysis-board-size-scale`. */}
            <div
              className="analysis-board-size"
              role="group"
              aria-label={t('analysis.boardSize', 'Board size')}
            >
              {BOARD_SIZES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`analysis-board-size__btn${boardSize === preset.id ? ' is-active' : ''}`}
                  onClick={() => setBoardSize(preset.id)}
                  title={t('analysis.boardSize', 'Board size') + ': ' + preset.label}
                  aria-pressed={boardSize === preset.id}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {/* Inline eval indicator - mobile only */}
            {topLine && analysisEnabled && sfState === 'analyzing' && (
              <span className="analysis-inline-eval">
                <span className={`analysis-inline-eval__score${topLine.score.type === 'mate' ? ' mate' : ''}`}>
                  {formatEval(topLine, evalIsBlackTurn)}
                </span>
                <span className="analysis-inline-eval__depth">d{topLine.depth}</span>
              </span>
            )}
            <span className="analysis-controls-spacer" />
            {/* Desktop: FEN, Game Info, PGN buttons */}
            <span className="analysis-desktop-only">
              {!gameId && (
                <>
                  <button
                    className="analysis-export-btn"
                    onClick={() => setShowSetPosition(true)}
                    title={t('position.title', 'Set Position')}
                  >
                    FEN
                  </button>
                  <button
                    className="analysis-export-btn"
                    onClick={() => setShowPgnHeaders(true)}
                    title={t('analysis.gameInfo', 'Game Info')}
                  >
                    Info
                  </button>
                </>
              )}
              <button
                className="analysis-export-btn"
                onClick={handleExportPgn}
                disabled={history.length === 0}
                title={t('review.exportPgn', 'Export PGN')}
              >
                &#x2B07; PGN
              </button>
              {/* KS-2220: «Copy PGN» рядом с «↓ PGN». */}
              <button
                className="analysis-export-btn"
                onClick={handleCopyPgn}
                disabled={history.length === 0}
                title={t('review.copyPgn', 'Copy PGN to clipboard')}
                data-testid="analysis-copy-pgn"
              >
                &#x1F4CB; PGN
              </button>
              {pgnCopyMsg && (
                <span
                  className="analysis-copy-msg"
                  role="status"
                  data-testid="analysis-copy-pgn-msg"
                >
                  {pgnCopyMsg}
                </span>
              )}
            </span>
            {/* Mobile: overflow menu */}
            <div className="analysis-overflow-wrapper" ref={overflowMenuRef}>
              <button
                className="analysis-overflow-btn"
                onClick={() => setShowOverflowMenu((v) => !v)}
                title={t('common.more', 'More')}
              >
                &#x22EF;
              </button>
              {showOverflowMenu && (
                <div className="analysis-overflow-menu">
                  {!gameId && (
                    <>
                      <button onClick={() => { setShowSetPosition(true); setShowOverflowMenu(false); }}>
                        {t('position.title', 'Set Position')} (FEN)
                      </button>
                      <button onClick={() => { setShowPgnHeaders(true); setShowOverflowMenu(false); }}>
                        {t('analysis.gameInfo', 'Game Info')}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { handleExportPgn(); setShowOverflowMenu(false); }}
                    disabled={history.length === 0}
                  >
                    {t('review.exportPgn', 'Export PGN')}
                  </button>
                  {/* KS-2220: «Copy PGN» в overflow-меню (mobile). */}
                  <button
                    onClick={() => { void handleCopyPgn(); setShowOverflowMenu(false); }}
                    disabled={history.length === 0}
                    data-testid="analysis-copy-pgn-overflow"
                  >
                    {t('review.copyPgn', 'Copy PGN to clipboard')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="analysis-sidebar">
        {/* Desktop-only: GameMetaBar */}
        {gameInfo && (
          <div className="analysis-desktop-only">
            <GameMetaBar info={gameInfo} />
          </div>
        )}

        {/* Desktop: Report (always visible if gameId) */}
        {gameId && (
          <div className="analysis-desktop-only">
            {gameReport && gameReport.status === 'complete' && (
              <EvalGraph
                moves={gameReport.moves}
                currentMoveIndex={currentGlobalIndex != null ? currentGlobalIndex - 1 : undefined}
                onSelectMove={(idx) => {
                  const target = history.find((m) => m.globalIndex === idx + 1);
                  if (target) gotoMove(target);
                }}
              />
            )}
            <GameReportPanel
              report={gameReport}
              analyzing={reportAnalyzing}
              error={reportError}
              onAnalyze={analyzeGame}
              whiteName={typeof gameData?.white === 'object' ? gameData.white.username : (gameData?.white ?? 'White')}
              blackName={typeof gameData?.black === 'object' ? gameData.black.username : (gameData?.black ?? 'Black')}
            />
          </div>
        )}

        {/* Bridge promo — desktop only */}
        {activeSource === 'wasm' && !bridgePromoDismissed && (
          <div className="bridge-promo analysis-desktop-only">
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

        {/* Desktop: Engine panel (collapsible) */}
        <div className="analysis-panel analysis-desktop-only">
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
                  title={analysisEnabled ? t('analysis.stop', 'Stop analysis') : t('analysis.start', 'Start analysis')}
                  data-testid="stockfish-toggle"
                  style={{ padding: '2px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 4, border: '1px solid var(--c-555)', background: analysisEnabled ? 'var(--c-dc2626)' : 'var(--c-16a34a)', color: 'var(--c-fff)', marginLeft: 8, whiteSpace: 'nowrap' }}
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

        {/* Desktop: Archive tree panel (Database) */}
        <div className="analysis-desktop-only">
          <ArchiveTreePanel
            currentFen={currentFen}
            opening={treeOpeningName || null}
            onSelectMove={handleTreeMove}
            onHoverMove={handleTreeHover}
          />
        </div>

        {/* Desktop: Moves panel (collapsible) */}
        <div className="analysis-panel analysis-panel--flex analysis-desktop-only">
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
                onSetNag={setNag}
                onSetComment={setComment}
                // KS-2300 (ADR-038): variation-color через reducer.
                onSetVariationColor={setVariationColor}
              />
            </div>
          )}
          <MaterialBalance fen={currentFen} />
        </div>

        {/* ===== Mobile: Single panel with tabs ===== */}
        <div className="analysis-mobile-panel">
          <div className="analysis-mobile-panel__tabs">
            <button className={`analysis-mobile-tab${mobileTab === 'moves' ? ' active' : ''}`} onClick={() => setMobileTab('moves')}>
              {t('review.moves', 'Moves')}
            </button>
            <button className={`analysis-mobile-tab${mobileTab === 'engine' ? ' active' : ''}`} onClick={() => setMobileTab('engine')}>
              {t('analysis.engine', 'Engine')}
            </button>
            <button className={`analysis-mobile-tab${mobileTab === 'tree' ? ' active' : ''}`} onClick={() => setMobileTab('tree')}>
              {t('archive.tree', 'Tree')}
            </button>
            {gameId && (
              <button className={`analysis-mobile-tab${mobileTab === 'report' ? ' active' : ''}`} onClick={() => setMobileTab('report')}>
                {t('analysis.report', 'Report')}
              </button>
            )}
          </div>
          <div className="analysis-mobile-panel__content">
            {/* KS-1698: каждая вкладка показывает только своё содержимое.
                До этой правки условие было `mobileTab !== 'report' && mobileTab !== 'tree'`
                на обеих секциях (engine + moves), поэтому `moves` и `engine`
                одновременно получали `.active` и показывались вместе. */}
            <div className={`analysis-mobile-section analysis-mobile-section--engine${mobileTab === 'engine' ? ' active' : ''}`}>
              <div className="analysis-mobile-engine-controls">
                <span className="engine-multipv-controls">
                  <button className="engine-multipv-btn" onClick={() => ec.setMultiPv((v) => Math.max(1, v - 1))} disabled={ec.multiPv <= 1}>−</button>
                  <span className="engine-multipv-value">{ec.multiPv}</span>
                  <button className="engine-multipv-btn" onClick={() => ec.setMultiPv((v) => Math.min(10, v + 1))} disabled={ec.multiPv >= 10}>+</button>
                </span>
                <button className="engine-settings-btn" onClick={() => ec.setShowEngineModal(true)}>⚙</button>
                {wasmSupported && !(isTouchDevice && engineFailed) && (
                  <button
                    className="analysis-toggle-btn"
                    onClick={toggleAnalysis}
                    style={{ padding: '2px 10px', fontSize: 13, borderRadius: 4, border: '1px solid var(--c-555)', background: analysisEnabled ? 'var(--c-dc2626)' : 'var(--c-16a34a)', color: 'var(--c-fff)', marginLeft: 8 }}
                  >
                    {analysisEnabled ? t('analysis.stop', 'Stop') : t('analysis.start', 'Start')}
                  </button>
                )}
              </div>
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
            </div>
            <div className={`analysis-mobile-section analysis-mobile-section--moves${mobileTab === 'moves' ? ' active' : ''}`}>
              <div className="analysis-panel-body analysis-panel-body--scroll">
                <ReviewMoveList
                  history={history}
                  currentGlobalIndex={currentGlobalIndex}
                  onMoveClick={gotoMove}
                  onPromoteVariation={(move) => promoteVariation(move as ChessMove)}
                  onDeleteVariation={(move) => removeVariation(move as ChessMove)}
                  onTruncateRemaining={(move) => truncateRemaining(move as ChessMove)}
                  // KS-2297: на mobile эти колбэки тоже нужны, иначе
                  // long-press открывает NagPaletteSheet, но клик по
                  // NAG не доходит до reducer (handlePaletteChange
                  // падает на `!onSetNag` guard) — символ NAG не
                  // появляется в нотации. В desktop ReviewMoveList
                  // (выше) колбэки уже были — отсюда desktop работал,
                  // mobile молча терял ввод.
                  onSetNag={setNag}
                  onSetComment={setComment}
                  // KS-2300 (ADR-038): variation-color через reducer.
                  onSetVariationColor={setVariationColor}
                />
              </div>
            </div>
            {mobileTab === 'tree' && (
              <div className="analysis-mobile-section analysis-mobile-section--tree active">
                <ArchiveTreePanel
                  currentFen={currentFen}
                  opening={treeOpeningName || null}
                  onSelectMove={handleTreeMove}
                  onHoverMove={handleTreeHover}
                />
              </div>
            )}
            {mobileTab === 'report' && gameId && (
              <div className="analysis-mobile-section analysis-mobile-section--report active">
                {gameReport && gameReport.status === 'complete' && (
                  <EvalGraph
                    moves={gameReport.moves}
                    currentMoveIndex={currentGlobalIndex != null ? currentGlobalIndex - 1 : undefined}
                    onSelectMove={(idx) => {
                      const target = history.find((m) => m.globalIndex === idx + 1);
                      if (target) gotoMove(target);
                    }}
                  />
                )}
                <GameReportPanel
                  report={gameReport}
                  analyzing={reportAnalyzing}
                  error={reportError}
                  onAnalyze={analyzeGame}
                  whiteName={typeof gameData?.white === 'object' ? gameData.white.username : (gameData?.white ?? 'White')}
                  blackName={typeof gameData?.black === 'object' ? gameData.black.username : (gameData?.black ?? 'Black')}
                />
              </div>
            )}
          </div>
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

      {showPgnHeaders && (
        <PgnHeadersModal
          headers={pgnHeaders}
          onApply={(h) => setPgnHeaders(h)}
          onClose={() => setShowPgnHeaders(false)}
        />
      )}
    </div>
  );
}
