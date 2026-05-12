import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { GameMetaBar } from '../../components/GameMetaBar';
import type { GameMetaInfo } from '../../components/GameMetaBar';
import { MaterialBalance } from '../../components/MaterialBalance';
import { ArchiveTreePanel } from '../../components/analysis/ArchiveTreePanel';
import type { ReactNode } from 'react';

import { ReviewMoveList } from '../../review/components/ReviewMoveList';
import type { ChessMove, VariationColor } from '../../review/types';
import type { EvalLine } from '../../hooks/useStockfish';
import type { useEngineConfig } from '../../hooks/useEngineConfig';
import { formatEval, formatPv } from '../../utils/chessFormat';

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

export type AnalysisPanelKey = 'gameInfo' | 'engine' | 'moves';
export type AnalysisMobileTab = 'moves' | 'engine' | 'tree';

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
   * KS-2873 (FM4): дополнительный блок над moves-panel (например,
   * AnalysisGamebookEditor в gamebook-режиме). Если undefined — не
   * рендерится.
   */
  extraPanel?: ReactNode;
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
  extraPanel,
}: AnalysisSidebarProps) {
  const { t } = useTranslation();

  return (
    <div className="analysis-sidebar" data-testid="analysis-sidebar">
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
          <div className="analysis-panel-body">
            <div className="stockfish-lines">
              {(analysisEnabled || displayedLines.length > 0) &&
                displayedLines.map((line) => (
                  <div key={line.multipv} className="stockfish-line">
                    <span
                      className={`stockfish-eval${
                        line.score.type === 'mate'
                          ? ' mate'
                          : line.multipv === 1
                            ? ' best'
                            : ''
                      }`}
                    >
                      {formatEval(line, evalIsBlackTurn)}
                    </span>
                    <span className="stockfish-pv">
                      {formatPv(line.pv, currentFen)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* KS-2873 (FM4): extraPanel — например AnalysisGamebookEditor для
          study-роута в gamebook-режиме. Размещён ПЕРЕД ArchiveTreePanel
          (контент важнее «дерева»). */}
      {extraPanel && (
        <div
          className="analysis-extra-panel"
          data-testid="analysis-sidebar-extra"
        >
          {extraPanel}
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
            />
          </div>
        )}
        <MaterialBalance fen={currentFen} />
      </div>

      {/* ===== Mobile: Single panel with tabs ===== */}
      <div className="analysis-mobile-panel">
        <div className="analysis-mobile-panel__tabs">
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'moves' ? ' active' : ''
            }`}
            onClick={() => onMobileTabChange('moves')}
          >
            {t('review.moves', 'Moves')}
          </button>
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'engine' ? ' active' : ''
            }`}
            onClick={() => onMobileTabChange('engine')}
          >
            {t('analysis.engine', 'Engine')}
          </button>
          <button
            className={`analysis-mobile-tab${
              mobileTab === 'tree' ? ' active' : ''
            }`}
            onClick={() => onMobileTabChange('tree')}
          >
            {t('archive.tree', 'Tree')}
          </button>
        </div>
        <div className="analysis-mobile-panel__content">
          <div
            className={`analysis-mobile-section analysis-mobile-section--engine${
              mobileTab === 'engine' ? ' active' : ''
            }`}
          >
            <div className="analysis-mobile-engine-controls">
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
            <div className="analysis-panel-body">
              <div className="stockfish-lines">
                {(analysisEnabled || displayedLines.length > 0) &&
                  displayedLines.map((line) => (
                    <div key={line.multipv} className="stockfish-line">
                      <span
                        className={`stockfish-eval${
                          line.score.type === 'mate'
                            ? ' mate'
                            : line.multipv === 1
                              ? ' best'
                              : ''
                        }`}
                      >
                        {formatEval(line, evalIsBlackTurn)}
                      </span>
                      <span className="stockfish-pv">
                        {formatPv(line.pv, currentFen)}
                      </span>
                    </div>
                  ))}
              </div>
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
        </div>
      </div>
    </div>
  );
}
