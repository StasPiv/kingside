import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { GameMetaBar } from '../../components/GameMetaBar';
import type { GameMetaInfo } from '../../components/GameMetaBar';
import { MaterialBalance } from '../../components/MaterialBalance';
import { ArchiveTreePanel } from '../../components/analysis/ArchiveTreePanel';
import { AiPositionCommentPanel } from '../../components/analysis/AiPositionCommentPanel';
import type { UseAiPositionCommentResult } from '../../hooks/useAiPositionComment';

import { ReviewMoveList } from '../../review/components/ReviewMoveList';
// KS-3258 follow-up: forfeit-плашка для broadcast-партий без ходов.
import { ForfeitPlaceholder } from '../../components/ForfeitPlaceholder';
import { isForfeitFromHeaders } from '../../utils/forfeitTermination';
import type { ChessMove, VariationColor } from '../../review/types';
import type { EvalLine, EngineErrorReason } from '../../hooks/useStockfish';
import type { useMaiaAnalysis } from '../../hooks/useMaiaAnalysis';
import type { EngineSortMode } from '../../hooks/useEngineSortMode';
// KS-3606 (ADR-100 §9): «Разобрать партию» перенесена из engine-panel в
// `AnalysisActionsMenu` (см. AnalysisPage). Здесь оставлен только
// source-link «← Исходный анализ» для auto-дублей. Импорт `Link` — выше
// (строка 2).
// KS-3593 (ADR-098): extractBestUci/sortLines вынесены в общий utils,
// чтобы переиспользовать из engineSort и не дублировать. Sidebar
// продолжает звать `extractBestUci` для inline-вероятности Maia.
import { extractBestUci, sortLines } from '../../utils/engineSort';
import type { useEngineConfig } from '../../hooks/useEngineConfig';
import { formatEval, formatPv } from '../../utils/chessFormat';
import { EngineLoader } from '../../components/EngineLoader';
import { SidebarFontSizeButton } from '../../components/SidebarFontSizeButton';
import { useBottomSheet } from '../../hooks/useBottomSheet';
import { useFocusMode } from '../../context/FocusModeContext';

/**
 * KS-2866 (ADR-060 §10.1 FR3) — извлечённый sidebar `AnalysisPage`.
 *
 * Содержит:
 * - Desktop-only GameMetaBar (когда есть `gameInfo`).
 * - Bridge promo (предложение внешнего движка, desktop).
 * - Desktop engine-panel (collapsible) — список линий Stockfish.
 * - Desktop ArchiveTreePanel (дерево из архива).
 * - Desktop Moves panel — `ReviewMoveList` + `MaterialBalance`.
 * - Mobile single-panel с вкладками moves/engine/tree.
 *
 * На FR3-этапе компонент чисто-presentational: все state и callback'и
 * приходят props из AnalysisPage. На FR4 большая часть props переедет
 * в `AnalysisContext` (history/currentGlobalIndex/handlers — readOnly
 * через resolver, engine — через useEngine-обёртку).
 */

// KS-3687: 4-й collapsible-блок «AI» (desktop) и 4-я вкладка `ai` (mobile).
// Панель AI-комментария вынесена из engine-panel в отдельный блок.
export type AnalysisPanelKey = 'gameInfo' | 'engine' | 'moves' | 'ai';
export type AnalysisMobileTab = 'moves' | 'engine' | 'tree' | 'ai';

export interface AnalysisSidebarProps {
  /* ---------- desktop-only мета ---------- */
  gameInfo?: GameMetaInfo;

  /* ---------- bridge promo ---------- */
  activeSource: 'wasm' | 'external';
  bridgePromoDismissed: boolean;
  onDismissBridgePromo: () => void;

  /* ---------- engine ---------- */
  engineName: string;
  engineStatusSuffix: string;
  engineErrorMessage: string | null;
  sfState: string;
  analysisEnabled: boolean;
  wasmSupported: boolean;
  isTouchDevice: boolean;
  engineFailed: boolean;
  onToggleAnalysis: () => void;
  ec: ReturnType<typeof useEngineConfig>;
  /** KS-3067: прогресс загрузки wasm-движка (0..1). Только для wasm-источника. */
  engineLoadProgress?: number;
  /** KS-3067: причина error-состояния wasm-движка. */
  engineErrorReason?: EngineErrorReason;
  /** KS-3067: повторная инициализация wasm-движка (кнопка «Попробовать снова»). */
  onEngineRetry?: () => void;

  /* ---------- panels (collapsible) ---------- */
  panelStates: Record<AnalysisPanelKey, boolean>;
  onTogglePanel: (panel: AnalysisPanelKey) => void;

  /* ---------- lines / position ---------- */
  displayedLines: EvalLine[];
  evalIsBlackTurn: boolean;
  currentFen: string;

  /* ---------- archive tree ---------- */
  treeOpeningName: string | null;
  onTreeMove: (uci: string) => void;
  onTreeHover: (uci: string | null) => void;

  /* ---------- moves (ReviewMoveList) ---------- */
  history: ChessMove[];
  currentGlobalIndex: number;
  onMoveClick: (move: ChessMove) => void;
  onPromoteVariation: (move: ChessMove) => void;
  onDeleteVariation: (move: ChessMove) => void;
  onTruncateRemaining: (move: ChessMove) => void;
  onSetNag: (globalIndex: number, nags: number[]) => void;
  onSetComment: (globalIndex: number, comment: string) => void;
  onSetVariationColor: (moveIndex: number, color: VariationColor | null) => void;

  /* ---------- mobile tabs ---------- */
  mobileTab: AnalysisMobileTab;
  onMobileTabChange: (tab: AnalysisMobileTab) => void;

  /* ---------- read-only (KS-2868/2869 FS1/FS2) ---------- */
  /**
   * Когда true: ReviewMoveList не открывает контекстное меню (right-click,
   * long-press игнорируются), NAG-палитра скрыта. Клик по ходу для
   * навигации остаётся.
   */
  readOnly?: boolean;
  /**
   * KS-2872 (FM3): conceal — порог ply, после которого SAN скрывается.
   * null = без сокрытия.
   */
  concealAfterPly?: number | null;
  /**
   * KS-3258 follow-up: распарсенные PGN-headers. Если `history` пустая
   * и headers содержат [Termination "Unplayed"]/[Result] != '*' —
   * вместо «No moves» в moves-панели (desktop + mobile-tab "Ходы")
   * рендерится `<ForfeitPlaceholder>` (см. AnalysisPage.tsx).
   */
  pgnHeaders?: Record<string, string> | null;
  /**
   * KS-3603/KS-3606: source-link «← Исходный анализ» при
   * `originalAnalysisId != null`. Кнопка «Разобрать партию»
   * перенесена в `AnalysisActionsMenu` (KS-3606), сюда поля
   * `analysisId`/`analysisPgn` больше не нужны.
   */
  originalAnalysisId?: string | null;
  /**
   * KS-3597 (ADR-099 F2): Maia-hook и sort-режим теперь живут на уровне
   * `AnalysisPage`, чтобы `useEngine` мог получить `searchmoves` без
   * дублирования экземпляров. Sidebar получает их через props и
   * только рендерит селект ELO / inline-вероятности / sort-header.
   */
  maia: ReturnType<typeof useMaiaAnalysis>;
  sortMode: EngineSortMode;
  onSortModeChange: (mode: EngineSortMode) => void;
  /**
   * KS-3597. Флаг от `useEngine.supportsSearchmoves` — для tooltip над
   * `Maia%`-кнопкой при ситуации «sort=maia, но engine не поддерживает»
   * (external bridge по R-этапу KS-3595). Tooltip объясняет: «Maia-
   * режим недоступен для внешнего движка, показан порядок Stockfish».
   */
  engineSupportsSearchmoves: boolean;
  /**
   * KS-3597. Maia top-N (UCI), посчитанный на уровне AnalysisPage
   * через `useMemo([maia.policyByMove, ec.multiPv])`. Sidebar
   * использует его для:
   *  - placeholder-карт `--` для тех ходов, по которым Stockfish ещё
   *    не отдал eval (после смены `searchmoves`);
   *  - inline-вероятности в порядке Maia при sortMode=maia.
   * При sortMode='stockfish' или эскалации (no support / no ready) —
   * массив пустой.
   */
  maiaTopMoves: string[];
  /**
   * KS-3680 (ADR-108). Контроллер кнопки «Оценка позиции от AI» — то
   * что возвращает `useAiPositionComment` на уровне AnalysisPage.
   * Sidebar монтирует панель в engine-panel (desktop + mobile) до
   * `.stockfish-lines-header`. Может быть `undefined`, если страница
   * не хочет показывать панель (например, в режиме read-only / для
   * каких-то режимов тренировки) — тогда блок просто не рендерится.
   */
  aiPositionComment?: UseAiPositionCommentResult;
}

export function AnalysisSidebar({
  gameInfo,
  activeSource,
  bridgePromoDismissed,
  onDismissBridgePromo,
  engineName,
  engineStatusSuffix,
  engineErrorMessage,
  sfState,
  analysisEnabled,
  wasmSupported,
  isTouchDevice,
  engineFailed,
  onToggleAnalysis,
  ec,
  engineLoadProgress = 0,
  engineErrorReason = null,
  onEngineRetry,
  panelStates,
  onTogglePanel,
  displayedLines,
  evalIsBlackTurn,
  currentFen,
  treeOpeningName,
  onTreeMove,
  onTreeHover,
  history,
  currentGlobalIndex,
  onMoveClick,
  onPromoteVariation,
  onDeleteVariation,
  onTruncateRemaining,
  onSetNag,
  onSetComment,
  onSetVariationColor,
  mobileTab,
  onMobileTabChange,
  readOnly = false,
  concealAfterPly = null,
  pgnHeaders = null,
  maia,
  sortMode,
  onSortModeChange,
  engineSupportsSearchmoves,
  maiaTopMoves,
  originalAnalysisId = null,
  aiPositionComment,
}: AnalysisSidebarProps) {
  const { t } = useTranslation();
  // KS-3190 (ADR-073 §7 F3): bottom-sheet поведение для mobile-panel в
  // focus-mode (внутри шага game). Snap-state и drag-handle — здесь.
  // На desktop и вне focus-mode hook вызывается, но `data-snap` атрибут
  // ниже подставляется в `.analysis-mobile-panel` только когда нужно
  // (`focusModeActive`), а CSS-правила висят под `@media (max-width:
  // 767px) .focus-mode-active .analysis-mobile-panel` — это исключает
  // регрессии на обычном /analysis.
  const {
    active: focusModeActive,
    sheetSnap,
    setSheetSnap,
  } = useFocusMode();

  // KS-3597: `maia` и `sortMode` приходят из `AnalysisPage` —
  // их объединяет с `useEngine({ searchmoves })` единый источник.
  const setSortMode = onSortModeChange;
  const sortedLines = sortLines(
    displayedLines,
    sortMode,
    maia.getProbability,
  );

  /**
   * KS-3597: финальный список slot'ов для рендера. В режиме maia
   * (с support и ready) — гарантируем порядок Maia top-N и
   * placeholder-карты `--` для тех ходов, по которым Stockfish ещё не
   * отдал eval после смены `searchmoves`. В режиме stockfish (и при
   * эскалации) — просто `sortedLines` как есть.
   */
  type EngineRow =
    | { kind: 'eval'; line: EvalLine }
    | { kind: 'pending'; uci: string; multipv: number };

  const engineRows: EngineRow[] = (() => {
    const maiaActive =
      sortMode === 'maia' &&
      engineSupportsSearchmoves &&
      maia.status === 'ready' &&
      maiaTopMoves.length > 0;
    if (!maiaActive) {
      return sortedLines.map((line) => ({ kind: 'eval', line }));
    }
    const byFirstUci = new Map<string, EvalLine>();
    for (const line of sortedLines) {
      const u = extractBestUci(line.pv);
      if (u) byFirstUci.set(u, line);
    }
    return maiaTopMoves.map((uci, i): EngineRow => {
      const line = byFirstUci.get(uci);
      if (line) return { kind: 'eval', line };
      return { kind: 'pending', uci, multipv: i + 1 };
    });
  })();

  // KS-3597: tooltip для Maia%-кнопки. Два разных сценария:
  //  - `maia.status === 'error'` — Maia вообще не загрузилась (worker
  //    crash, network), показываем `analysis.engine.sort.maiaUnavailableTip`.
  //  - `!engineSupportsSearchmoves && sortMode === 'maia'` — Maia ок, но
  //    activный engine (external bridge) не умеет `searchmoves`, sort
  //    деградирует на Stockfish-порядок. Показываем отдельный текст
  //    `analysis.engine.sort.maiaUnsupportedTip`.
  // Kнопка не дизаблится в обоих сценариях (KS-3593, ADR-098 §4.5).
  const maiaSortTooltip = (() => {
    if (maia.status === 'error') {
      return t(
        'analysis.engine.sort.maiaUnavailableTip',
        'Maia unavailable — Stockfish order',
      );
    }
    if (!engineSupportsSearchmoves && sortMode === 'maia') {
      return t(
        'analysis.engine.sort.maiaUnsupportedTip',
        'Maia mode unavailable for external engine — Stockfish order',
      );
    }
    return undefined;
  })();

  // KS-3258 follow-up: forfeit-fallback. Если history пуста и headers
  // указывают на [Termination "Unplayed"] / Result != "*" — рендерим
  // <ForfeitPlaceholder> вместо «No moves». Иначе передаём undefined и
  // ReviewMoveList фолбэчится на стандартное сообщение.
  const forfeitEmpty =
    isForfeitFromHeaders(pgnHeaders, history.length) ? (
      <ForfeitPlaceholder headers={pgnHeaders} />
    ) : undefined;
  // KS-3190: useBottomSheet даёт handleProps для drag-жестов; `snap`
  // здесь — это «теневое» состояние внутри хука, реальный snap живёт в
  // `FocusModeContext.sheetSnap`. Через колбэк `onChange` ниже мы
  // синхронизируем оба: жест меняет `sheetSnap` в контексте, тот
  // используется и здесь (через `data-snap`), и в `GameStep` (для
  // `data-sheet-snap` на корне → CSS подстраивает high доски).
  const sheet = useBottomSheet({ initial: sheetSnap });
  // Прокинем «текущий снап» обратно в context при каждом изменении
  // внутри хука. Делаем через `useEffect`, чтобы не дёргать сеттер
  // в render-фазе. См. ниже.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sheet.snap !== sheetSnap) setSheetSnap(sheet.snap);
  }, [sheet.snap]);
  // Если кто-то ещё изменит context.sheetSnap (например tap по табу
  // ниже зовёт sheet.setSnap → context update → ререндер → внутренний
  // state хука уже синхрон). Дополнительной обратной синхронизации
  // тут не нужно: единственный writer внешний — handleTabTap, который
  // зовёт sheet.setSnap напрямую.

  // Tap по табу должен подтянуть sheet в `half`, если он в `peek`.
  // В `half`/`full` оставляем как есть, чтобы лишний tap не сворачивал.
  const handleTabTap = (tab: AnalysisMobileTab) => {
    onMobileTabChange(tab);
    if (focusModeActive && sheet.snap === 'peek') sheet.setSnap('half');
  };

  return (
    <div className="analysis-sidebar" data-testid="analysis-sidebar">
      {/* KS-3603 (ADR-100 §8): source-link для авто-аннотированных
          дубликатов. Backend проставляет `originalAnalysisId` для
          дубля; для оригинала / независимого анализа — null. */}
      {originalAnalysisId && (
        <div className="analysis-original-link-wrap analysis-desktop-only">
          <Link
            to={`/analysis/${originalAnalysisId}`}
            className="analysis-original-link"
            data-testid="analysis-original-link"
          >
            <span className="analysis-original-link__icon">←</span>
            <span>{t('analysis.auto.backToOriginal', '← Original analysis')}</span>
          </Link>
        </div>
      )}
      {/* Desktop-only: GameMetaBar */}
      {gameInfo && (
        <div className="analysis-desktop-only">
          <GameMetaBar info={gameInfo} />
        </div>
      )}

      {/* Bridge promo — desktop only */}
      {activeSource === 'wasm' && !bridgePromoDismissed && (
        <div className="bridge-promo analysis-desktop-only">
          <div className="bridge-promo__text">
            <strong>{t('bridgePromo.title', 'Want deeper analysis?')}</strong>
            <span>
              {t(
                'bridgePromo.desc',
                'Connect your local engine for unlimited depth and speed.',
              )}
            </span>
          </div>
          <div className="bridge-promo__actions">
            <Link to="/help/external-engine" className="bridge-promo__link">
              {t('bridgePromo.learnMore', 'Learn more')}
            </Link>
            <button
              className="bridge-promo__dismiss"
              onClick={onDismissBridgePromo}
              title={t('bridgePromo.dismiss', 'Dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Desktop: Engine panel (collapsible) */}
      <div className="analysis-panel analysis-desktop-only">
        <div
          className="analysis-panel-header"
          onClick={() => onTogglePanel('engine')}
        >
          <span className="analysis-panel-header-left">
            <span className="analysis-panel-icon">⚙</span>
            <span className="analysis-panel-title">
              {engineName}
              {engineStatusSuffix}
            </span>
            {activeSource === 'external' && (
              <span
                className={`engine-status-dot engine-status-dot--${
                  sfState === 'ready' || sfState === 'analyzing'
                    ? 'connected'
                    : sfState === 'connecting'
                      ? 'connecting'
                      : 'disconnected'
                }`}
              />
            )}
            {engineErrorMessage && (
              <span className="engine-error-detail" title={engineErrorMessage}>
                {engineErrorMessage}
              </span>
            )}
          </span>
          <span className="analysis-panel-header-right">
            {/* KS-3606: «Разобрать партию» перенесена в
                AnalysisActionsMenu (см. AnalysisPage). */}
            {/* KS-3099 v2: единый контрол размера шрифта правой
                панели — Aa-кнопка с dropdown S/M/L. Размещён в шапке
                первой панели (Stockfish-engine), управляет шрифтом
                ВСЕЙ правой колонки (engine + ходы + «База партий»).
                stopPropagation на самой кнопке — чтобы клик не
                сворачивал родительскую панель. */}
            <SidebarFontSizeButton />
            {/* KS-3600: ELO Maia переехал в общие настройки —
                в engine-panel селекта больше нет. */}
            <span
              className="engine-multipv-controls"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="engine-multipv-btn"
                onClick={() => ec.setMultiPv((v) => Math.max(1, v - 1))}
                disabled={ec.multiPv <= 1}
                title="Fewer lines"
              >
                −
              </button>
              <span className="engine-multipv-value">{ec.multiPv}</span>
              <button
                className="engine-multipv-btn"
                onClick={() => ec.setMultiPv((v) => Math.min(10, v + 1))}
                disabled={ec.multiPv >= 10}
                title="More lines"
              >
                +
              </button>
            </span>
            <button
              className="engine-settings-btn"
              onClick={(e) => {
                e.stopPropagation();
                ec.setShowEngineModal(true);
              }}
              title="Engine settings"
            >
              ⚙
            </button>
            {wasmSupported && !(isTouchDevice && engineFailed) && (
              <button
                className="analysis-toggle-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleAnalysis();
                }}
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
                  border: '1px solid var(--c-555)',
                  background: analysisEnabled
                    ? 'var(--c-dc2626)'
                    : 'var(--c-16a34a)',
                  color: 'var(--c-fff)',
                  marginLeft: 8,
                  whiteSpace: 'nowrap',
                }}
              >
                {analysisEnabled
                  ? t('analysis.stop', 'Stop')
                  : t('analysis.start', 'Start')}
              </button>
            )}
            <span className="analysis-panel-chevron">
              {panelStates.engine ? '▾' : '▸'}
            </span>
          </span>
        </div>
        {panelStates.engine && (
          // KS-3584 (ADR-096): добавлен Maia-блок внутри engine-panel.
          // KS-3588 (ADR-097): возвращаем `.analysis-panel-body` без
          // `--scroll` — после удаления отдельной Maia-секции (KS-3584)
          // в engine-panel остаются только PV Stockfish + кнопка KS-3579,
          // max-height: 132px от KS-3585 опять подходит. CSS-решение —
          // в задаче B/layout.
          <div className="analysis-panel-body">
            {/* KS-3067: индикатор загрузки/ошибки wasm-движка. Только для
                wasm-источника — у external свой error-баннер выше. */}
            {activeSource === 'wasm' && analysisEnabled && (sfState === 'loading' || sfState === 'error') && (
              <EngineLoader
                variant="inline"
                state={sfState}
                loadProgress={engineLoadProgress}
                errorReason={engineErrorReason}
                onRetry={() => onEngineRetry?.()}
              />
            )}
            {/* KS-3687: AI-панель вынесена из engine-panel в отдельный
                collapsible-блок «AI» (см. ниже). */}
            {/* KS-3593 (ADR-098): заголовок-переключатель сортировки
                линий. Eval / Maia% — кликабельны, Line — нерактивный
                label. Maia%-кнопка не дизаблится даже при ошибке Maia
                (иначе юзер бы застрял в режиме maia), но показывает
                tooltip-tip когда `maia.status === 'error'`. */}
            <div className="stockfish-lines-header">
              <button
                type="button"
                className={`stockfish-lines-header__col stockfish-lines-header__col--eval${
                  sortMode === 'stockfish'
                    ? ' stockfish-lines-header__col--active'
                    : ''
                }`}
                onClick={() => setSortMode('stockfish')}
                data-testid="engine-sort-eval"
              >
                {t('analysis.engine.sort.eval', 'Eval')}
                {sortMode === 'stockfish' && (
                  <span aria-hidden="true"> ↓</span>
                )}
              </button>
              <button
                type="button"
                className={`stockfish-lines-header__col stockfish-lines-header__col--maia${
                  sortMode === 'maia'
                    ? ' stockfish-lines-header__col--active'
                    : ''
                }`}
                onClick={() => setSortMode('maia')}
                title={maiaSortTooltip}
                data-testid="engine-sort-maia"
              >
                {t('analysis.engine.sort.maia', 'Maia%')}
                {sortMode === 'maia' && <span aria-hidden="true"> ↓</span>}
              </button>
              <span className="stockfish-lines-header__col stockfish-lines-header__col--label">
                {t('analysis.engine.sort.line', 'Line')}
              </span>
            </div>
            <div className="stockfish-lines">
              {(analysisEnabled || engineRows.length > 0) &&
                engineRows.map((row) => {
                  // KS-3597: одинаковая структура для `eval` (готовая
                  // линия от Stockfish) и `pending` (placeholder `--`,
                  // SF ещё не отдал eval по этому searchmove'у).
                  const uci =
                    row.kind === 'eval' ? extractBestUci(row.line.pv) : row.uci;
                  const prob = maia.getProbability(uci);
                  const probLabel =
                    prob == null ? '(--)' : `(${(prob * 100).toFixed(1)}%)`;
                  const isMate = row.kind === 'eval' && row.line.score.type === 'mate';
                  const isBest = row.kind === 'eval' && row.line.multipv === 1;
                  const key =
                    row.kind === 'eval' ? `eval-${row.line.multipv}` : `pending-${row.uci}`;
                  return (
                    <div
                      key={key}
                      className={`stockfish-line${row.kind === 'pending' ? ' stockfish-line--pending' : ''}`}
                    >
                      <span
                        className={`stockfish-eval${
                          isMate ? ' mate' : isBest ? ' best' : ''
                        }${row.kind === 'pending' ? ' stockfish-eval--pending' : ''}`}
                      >
                        {row.kind === 'eval'
                          ? formatEval(row.line, evalIsBlackTurn)
                          : '--'}
                      </span>
                      <span
                        className={`stockfish-maia-prob${
                          maia.status === 'loading'
                            ? ' stockfish-maia-prob--stale'
                            : ''
                        }`}
                        data-testid={`maia-prob-${row.kind === 'eval' ? row.line.multipv : row.multipv}`}
                      >
                        {probLabel}
                      </span>
                      <span className="stockfish-pv">
                        {row.kind === 'eval'
                          ? formatPv(row.line.pv, currentFen)
                          : ''}
                      </span>
                    </div>
                  );
                })}
            </div>
            {/* KS-3590: блок «Получить рейтинг позиции» (KS-3579) удалён —
                inline-вероятности Maia в Stockfish-линиях (KS-3588 ADR-097)
                перекрывают его функционально. */}
          </div>
        )}
      </div>

      {/* KS-3687: Desktop AI panel — отдельный collapsible-блок над
          ArchiveTreePanel. Контроллер приходит из AnalysisPage. */}
      {aiPositionComment && (
        <div className="analysis-panel analysis-desktop-only" data-testid="analysis-ai-panel">
          <div
            className="analysis-panel-header"
            onClick={() => onTogglePanel('ai')}
          >
            <span className="analysis-panel-header-left">
              <span className="analysis-panel-icon">★</span>
              <span className="analysis-panel-title">
                {t('analysis.aiTab.title', 'AI')}
              </span>
            </span>
            <span className="analysis-panel-header-right">
              <span className="analysis-panel-chevron">
                {panelStates.ai ? '▾' : '▸'}
              </span>
            </span>
          </div>
          {panelStates.ai && (
            <div className="analysis-panel-body">
              <AiPositionCommentPanel
                controller={aiPositionComment}
                testIdSuffix="desktop"
              />
            </div>
          )}
        </div>
      )}

      {/* Desktop: Archive tree panel (Database) */}
      <div className="analysis-desktop-only">
        <ArchiveTreePanel
          currentFen={currentFen}
          opening={treeOpeningName}
          onSelectMove={onTreeMove}
          onHoverMove={onTreeHover}
        />
      </div>

      {/* Desktop: Moves panel (collapsible) */}
      <div className="analysis-panel analysis-panel--flex analysis-desktop-only">
        <div
          className="analysis-panel-header"
          onClick={() => onTogglePanel('moves')}
        >
          <span className="analysis-panel-header-left">
            <span className="analysis-panel-icon">☰</span>
            <span className="analysis-panel-title">
              {t('review.moves', 'Moves')}
            </span>
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
              onMoveClick={onMoveClick}
              onPromoteVariation={onPromoteVariation}
              onDeleteVariation={onDeleteVariation}
              onTruncateRemaining={onTruncateRemaining}
              onSetNag={onSetNag}
              onSetComment={onSetComment}
              onSetVariationColor={onSetVariationColor}
              readOnly={readOnly}
              concealAfterPly={concealAfterPly}
              emptyState={forfeitEmpty}
            />
          </div>
        )}
        <MaterialBalance fen={currentFen} />
      </div>

      {/* ===== Mobile: Single panel with tabs =====
          KS-3190 (ADR-073 §7 F3): в focus-mode на mobile панель ведёт
          себя как bottom-sheet с 3 snap-точками. `data-focus-sheet` +
          `data-snap` управляют CSS-стилем (`@media (max-width: 767px)
          .focus-mode-active .analysis-mobile-panel[data-focus-sheet="true"]
          { ... }`). Stockfish-worker не зависит от этого DOM —
          init/анализ продолжаются через useStockfish, видимость UI
          лишь скрывает его панель. */}
      <div
        className="analysis-mobile-panel"
        data-focus-sheet={focusModeActive ? 'true' : 'false'}
        data-snap={focusModeActive ? sheet.snap : undefined}
        data-testid="analysis-mobile-panel"
      >
        {focusModeActive && (
          <div
            className="analysis-mobile-panel__handle"
            data-testid="analysis-mobile-panel-handle"
            role="separator"
            aria-label={t('focusMode.sheet.handle', 'Drag to resize')}
            {...sheet.handleProps}
          >
            <span className="analysis-mobile-panel__handle-bar" aria-hidden="true" />
          </div>
        )}
        <div className="analysis-mobile-panel__tabs">
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'moves' ? ' active' : ''
            }`}
            data-testid="analysis-mobile-tab-moves"
            onClick={() => handleTabTap('moves')}
          >
            {t('review.moves', 'Moves')}
          </button>
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'engine' ? ' active' : ''
            }`}
            data-testid="analysis-mobile-tab-engine"
            onClick={() => handleTabTap('engine')}
          >
            {t('analysis.engine', 'Engine')}
          </button>
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'tree' ? ' active' : ''
            }`}
            data-testid="analysis-mobile-tab-tree"
            onClick={() => handleTabTap('tree')}
          >
            {t('archive.tree', 'Tree')}
          </button>
          {/* KS-3687: 4-я mobile-вкладка «AI». Кнопка показывается всегда —
              если контроллер не пришёл, секция ниже просто пустая. */}
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'ai' ? ' active' : ''
            }`}
            data-testid="analysis-mobile-tab-ai"
            onClick={() => handleTabTap('ai')}
          >
            {t('analysis.aiTab.title', 'AI')}
          </button>
        </div>
        <div className="analysis-mobile-panel__content">
          <div
            className={`analysis-mobile-section analysis-mobile-section--engine${
              mobileTab === 'engine' ? ' active' : ''
            }`}
          >
            {/* KS-3083: метрики WASM-движка (название · d · n · nps) на
                мобильном. На десктопе они в analysis-panel-title (строки
                201-202), на мобильном раньше не выводились вовсе — был
                только ряд контролов. Тестовая жалоба в Telegram: на
                /analysis вкладке «Движок» не видно ни depth, ни nps, ни
                версии движка. Кладём над контролами отдельной приглушённой
                строкой; на ширине ≥4 значений (название + d + n + nps)
                строка переносится по словам, ничего не обрезается. */}
            <div
              className="analysis-mobile-engine-meta"
              data-testid="analysis-mobile-engine-meta"
            >
              {engineName}
              {engineStatusSuffix}
            </div>
            <div className="analysis-mobile-engine-controls">
              {/* KS-3600: ELO Maia в общих настройках, не здесь. */}
              <span className="engine-multipv-controls">
                <button
                  className="engine-multipv-btn"
                  onClick={() => ec.setMultiPv((v) => Math.max(1, v - 1))}
                  disabled={ec.multiPv <= 1}
                >
                  −
                </button>
                <span className="engine-multipv-value">{ec.multiPv}</span>
                <button
                  className="engine-multipv-btn"
                  onClick={() => ec.setMultiPv((v) => Math.min(10, v + 1))}
                  disabled={ec.multiPv >= 10}
                >
                  +
                </button>
              </span>
              <button
                className="engine-settings-btn"
                onClick={() => ec.setShowEngineModal(true)}
              >
                ⚙
              </button>
              {wasmSupported && !(isTouchDevice && engineFailed) && (
                <button
                  className="analysis-toggle-btn"
                  onClick={onToggleAnalysis}
                  style={{
                    padding: '2px 10px',
                    fontSize: 13,
                    borderRadius: 4,
                    border: '1px solid var(--c-555)',
                    background: analysisEnabled
                      ? 'var(--c-dc2626)'
                      : 'var(--c-16a34a)',
                    color: 'var(--c-fff)',
                    marginLeft: 8,
                  }}
                >
                  {analysisEnabled
                    ? t('analysis.stop', 'Stop')
                    : t('analysis.start', 'Start')}
                </button>
              )}
            </div>
            {/* KS-3588 (ADR-097): возвращаем `.analysis-panel-body`
                без `--scroll`, см. desktop-комментарий выше. */}
            <div className="analysis-panel-body">
              {/* KS-3067: тот же индикатор для мобильной вкладки «Engine». */}
              {activeSource === 'wasm' && analysisEnabled && (sfState === 'loading' || sfState === 'error') && (
                <EngineLoader
                  variant="inline"
                  state={sfState}
                  loadProgress={engineLoadProgress}
                  errorReason={engineErrorReason}
                  onRetry={() => onEngineRetry?.()}
                />
              )}
              {/* KS-3687: AI-панель вынесена из engine-секции в отдельную
                  4-ю вкладку «AI» (см. ниже). */}
              {/* KS-3593 (ADR-098): mobile-копия sort-header'а. */}
              <div className="stockfish-lines-header">
                <button
                  type="button"
                  className={`stockfish-lines-header__col stockfish-lines-header__col--eval${
                    sortMode === 'stockfish'
                      ? ' stockfish-lines-header__col--active'
                      : ''
                  }`}
                  onClick={() => setSortMode('stockfish')}
                  data-testid="engine-sort-eval-mobile"
                >
                  {t('analysis.engine.sort.eval', 'Eval')}
                  {sortMode === 'stockfish' && (
                    <span aria-hidden="true"> ↓</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`stockfish-lines-header__col stockfish-lines-header__col--maia${
                    sortMode === 'maia'
                      ? ' stockfish-lines-header__col--active'
                      : ''
                  }`}
                  onClick={() => setSortMode('maia')}
                  title={maiaSortTooltip}
                  data-testid="engine-sort-maia-mobile"
                >
                  {t('analysis.engine.sort.maia', 'Maia%')}
                  {sortMode === 'maia' && <span aria-hidden="true"> ↓</span>}
                </button>
                <span className="stockfish-lines-header__col stockfish-lines-header__col--label">
                  {t('analysis.engine.sort.line', 'Line')}
                </span>
              </div>
              <div className="stockfish-lines">
                {(analysisEnabled || engineRows.length > 0) &&
                  engineRows.map((row) => {
                    // KS-3597: тот же helper-pattern, что и в desktop.
                    const uci =
                      row.kind === 'eval'
                        ? extractBestUci(row.line.pv)
                        : row.uci;
                    const prob = maia.getProbability(uci);
                    const probLabel =
                      prob == null
                        ? '(--)'
                        : `(${(prob * 100).toFixed(1)}%)`;
                    const isMate =
                      row.kind === 'eval' && row.line.score.type === 'mate';
                    const isBest =
                      row.kind === 'eval' && row.line.multipv === 1;
                    const key =
                      row.kind === 'eval'
                        ? `eval-${row.line.multipv}`
                        : `pending-${row.uci}`;
                    return (
                      <div
                        key={key}
                        className={`stockfish-line${row.kind === 'pending' ? ' stockfish-line--pending' : ''}`}
                      >
                        <span
                          className={`stockfish-eval${
                            isMate ? ' mate' : isBest ? ' best' : ''
                          }${row.kind === 'pending' ? ' stockfish-eval--pending' : ''}`}
                        >
                          {row.kind === 'eval'
                            ? formatEval(row.line, evalIsBlackTurn)
                            : '--'}
                        </span>
                        <span
                          className={`stockfish-maia-prob${
                            maia.status === 'loading'
                              ? ' stockfish-maia-prob--stale'
                              : ''
                          }`}
                          data-testid={`maia-prob-mobile-${row.kind === 'eval' ? row.line.multipv : row.multipv}`}
                        >
                          {probLabel}
                        </span>
                        <span className="stockfish-pv">
                          {row.kind === 'eval'
                            ? formatPv(row.line.pv, currentFen)
                            : ''}
                        </span>
                      </div>
                    );
                  })}
              </div>
              {/* KS-3590: mobile-кнопка KS-3579 удалена (см. desktop). */}
            </div>
          </div>
          <div
            className={`analysis-mobile-section analysis-mobile-section--moves${
              mobileTab === 'moves' ? ' active' : ''
            }`}
          >
            <div className="analysis-panel-body analysis-panel-body--scroll">
              <ReviewMoveList
                history={history}
                currentGlobalIndex={currentGlobalIndex}
                onMoveClick={onMoveClick}
                onPromoteVariation={onPromoteVariation}
                onDeleteVariation={onDeleteVariation}
                onTruncateRemaining={onTruncateRemaining}
                onSetNag={onSetNag}
                onSetComment={onSetComment}
                onSetVariationColor={onSetVariationColor}
                emptyState={forfeitEmpty}
              />
            </div>
          </div>
          {mobileTab === 'tree' && (
            <div className="analysis-mobile-section analysis-mobile-section--tree active">
              <ArchiveTreePanel
                currentFen={currentFen}
                opening={treeOpeningName}
                onSelectMove={onTreeMove}
                onHoverMove={onTreeHover}
              />
            </div>
          )}
          {/* KS-3687: 4-я mobile-вкладка «AI». Lazy-mount по mobileTab —
              панель не дёргает свои эффекты, пока пользователь не открыл
              вкладку (как сделано для `tree`). */}
          {mobileTab === 'ai' && aiPositionComment && (
            <div className="analysis-mobile-section analysis-mobile-section--ai active">
              <div className="analysis-panel-body">
                <AiPositionCommentPanel
                  controller={aiPositionComment}
                  testIdSuffix="mobile"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
