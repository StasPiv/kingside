/**
 * KS-4027 / ADR-122. Отдельная страница аналитики позиционных метрик
 * партии: `/analyses/:analysisId/metrics`.
 *
 * Отличается от вкладки в `AnalysisSidebar` тем, что:
 *   - график занимает всю ширину страницы (большое полотно для 50+
 *     линий);
 *   - сверху шапка с названием анализа и кнопкой «← Назад к анализу»;
 *   - используется ровно тот же `usePositionalTrace({ analysisId })`,
 *     поэтому данные шарятся с боковой вкладкой через тот же
 *     IndexedDB-кеш и BroadcastChannel-канал.
 *
 * Mainline ходов забираем простым GET `/analyses/:id` (если есть JWT —
 * для своих анализов) либо GET `/analyses/public/:id` (публичный
 * fallback). На анализе без mainline — заглушка «Сделайте хотя бы
 * один ход» внутри панели.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { AnalysisResponse } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { usePositionalTrace } from '../hooks/usePositionalTrace';
import { PositionalMetricsPanel } from '../components/analysis/PositionalMetricsPanel';

interface MainlineState {
  uciMoves: string[];
  sanMoves: string[];
  /**
   * KS-4027. FEN-позиция после каждого полухода. `fens[0]` — стартовая
   * позиция, `fens[i]` — позиция после полухода `i`. Длина = `uciMoves.length + 1`.
   */
  fens: string[];
  title: string;
  loading: boolean;
  notFound: boolean;
}

/**
 * Раскладываем PGN/move-list анализа в массивы UCI- и SAN-ходов через
 * chess.js. Для отдельной страницы нам не нужно дерево вариантов —
 * достаточно mainline, по которой считаются позиционные метрики.
 * KS-4027: SAN-ходы используются для подписей оси X на графике.
 */
function pgnToMainline(pgn: string): {
  uci: string[];
  san: string[];
  fens: string[];
} {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    const uci: string[] = [];
    const san: string[] = [];
    for (const m of history) {
      const promo = m.promotion ? m.promotion : '';
      uci.push(`${m.from}${m.to}${promo}`);
      san.push(m.san);
    }
    // KS-4027. Восстанавливаем FEN на каждом полуходе: проигрываем
    // mainline c нуля. fens[0] — стартовая, fens[i] — после ply i.
    const fens: string[] = [];
    const replay = new Chess();
    fens.push(replay.fen());
    for (const m of history) {
      replay.move({ from: m.from, to: m.to, promotion: m.promotion });
      fens.push(replay.fen());
    }
    return { uci, san, fens };
  } catch {
    return { uci: [], san: [], fens: [] };
  }
}

function useAnalysisMainline(analysisId: string | undefined): MainlineState {
  const [state, setState] = useState<MainlineState>({
    uciMoves: [],
    sanMoves: [],
    fens: [],
    title: '',
    loading: true,
    notFound: false,
  });
  useEffect(() => {
    if (!analysisId) return;
    let cancelled = false;
    setState({
      uciMoves: [],
      sanMoves: [],
      fens: [],
      title: '',
      loading: true,
      notFound: false,
    });
    (async () => {
      const fetchOne = async (path: string) => {
        try {
          return await api.get<AnalysisResponse>(path);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) return null;
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            return null;
          }
          throw err;
        }
      };
      let dto = await fetchOne(`/analyses/${analysisId}`);
      if (!dto) dto = await fetchOne(`/analyses/public/${analysisId}`);
      if (cancelled) return;
      if (!dto) {
        setState({
          uciMoves: [],
          sanMoves: [],
          fens: [],
          title: '',
          loading: false,
          notFound: true,
        });
        return;
      }
      const parsed = dto.pgn
        ? pgnToMainline(dto.pgn)
        : { uci: [], san: [], fens: [] };
      setState({
        uciMoves: parsed.uci,
        sanMoves: parsed.san,
        fens: parsed.fens,
        // KS-4633: пустой title оставляем — локализованный fallback
        // подставит вызывающая сторона через `t('analysisMetrics.defaultTitle')`.
        title: dto.title || '',
        loading: false,
        notFound: false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [analysisId]);
  return state;
}

export function AnalysisMetricsPage() {
  const { t } = useTranslation();
  const { analysisId } = useParams<{ analysisId: string }>();
  const mainline = useAnalysisMainline(analysisId);
  const trace = usePositionalTrace({ analysisId: analysisId ?? null });
  // KS-4027. Текущий полуход для доски-просмотрщика. Меняется при
  // клике на точку графика (`onPlySelect` пробрасывается в панель).
  const [currentPly, setCurrentPly] = useState(0);
  // Сбрасываем currentPly если поменялся анализ (другой analysisId).
  useEffect(() => {
    setCurrentPly(0);
  }, [analysisId]);

  // FEN для доски: позиция после `currentPly` полуходов. Если не
  // загружено — стартовая позиция.
  const boardFen = useMemo(() => {
    if (mainline.fens.length === 0) {
      return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    }
    const idx = Math.max(0, Math.min(mainline.fens.length - 1, currentPly));
    return mainline.fens[idx];
  }, [mainline.fens, currentPly]);
  const boardCaption = useMemo(() => {
    if (currentPly === 0) {
      return t('analysisMetrics.startingPosition', 'Starting position');
    }
    const moveNo = Math.ceil(currentPly / 2);
    const san = mainline.sanMoves[currentPly - 1] ?? '';
    return t('analysisMetrics.afterMove', 'After {{n}}{{sep}}{{san}}', {
      n: moveNo,
      sep: currentPly % 2 === 1 ? '.' : '…',
      san,
    });
  }, [currentPly, mainline.sanMoves, t]);

  if (!analysisId) {
    return (
      <div style={{ padding: 24 }}>
        <p>{t('analysisMetrics.missingId', 'Analysis identifier is not specified.')}</p>
        <Link to="/lessons">← {t('common.backToHome', 'Back to home')}</Link>
      </div>
    );
  }

  return (
    <div
      className="analysis-metrics-page"
      data-testid="analysis-metrics-page"
      style={{
        // KS-4027: страница на всю ширину окна, без maxWidth и без
        // боковых отступов — пользователь специально просил «во весь
        // экран», без пустот слева и справа. Сам `.main` (родитель)
        // зажимает `max-width: 1200px` + `padding: 24px` — снимается
        // CSS-правилом `.main:has(.analysis-metrics-page)` в layout.css.
        width: '100%',
        padding: 0,
        margin: 0,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          padding: '12px 16px',
        }}
      >
        <Link
          to={`/analysis/${analysisId}`}
          style={{
            fontSize: 13,
            color: '#1e88e5',
            textDecoration: 'none',
          }}
        >
          ← {t('analysisMetrics.backToAnalysis', 'Back to analysis')}
        </Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {mainline.loading
            ? t('analysisMetrics.loading', 'Loading…')
            : mainline.title || t('analysisMetrics.defaultTitle', 'Analysis')}
        </h1>
        <span style={{ color: '#999', fontSize: 12 }}>
          · {t('analysisMetrics.pliesCount', '{{count}} plies', {
            count: mainline.uciMoves.length,
          })}
        </span>
      </div>
      {mainline.notFound ? (
        <div style={{ color: '#8a1f1f', fontSize: 13, padding: '0 16px' }}>
          {t('analysisMetrics.notFound', 'Analysis not found or not available.')}
        </div>
      ) : (
        <div style={{ background: '#fff', padding: 0 }}>
          <PositionalMetricsPanel
            trace={trace}
            uciMoves={mainline.uciMoves}
            sanMoves={mainline.sanMoves}
            currentPly={currentPly}
            onPlySelect={(ply) => setCurrentPly(ply)}
            chartHeight={520}
            selectionStorageKey={`ks:metrics:selection:${analysisId}`}
            layout="fullpage"
          />
          {/* KS-4027. Доска-просмотрщик под графиком. При клике на точку
              графика сюда подставляется позиция этого полухода. */}
          {mainline.fens.length > 0 && (
            <div
              data-testid="analysis-metrics-board"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                padding: '12px 16px 24px',
              }}
            >
              <div style={{ fontSize: 13, color: '#555' }}>{boardCaption}</div>
              <div style={{ width: 360, maxWidth: '100%' }}>
                <Chessboard
                  options={{
                    position: boardFen,
                    boardOrientation: 'white',
                    animationDurationInMs: 0,
                    allowDragging: false,
                    showNotation: true,
                  }}
                />
              </div>
              {/* Простые навигационные кнопки на случай если кликать по
                  точкам неудобно. */}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setCurrentPly(0)}
                  style={navButtonStyle}
                  disabled={currentPly === 0}
                  aria-label={t('analysisMetrics.nav.start', 'Start')}
                >
                  ⏮
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentPly((p) => Math.max(0, p - 1))}
                  style={navButtonStyle}
                  disabled={currentPly === 0}
                  aria-label={t('analysisMetrics.nav.back', 'Back')}
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCurrentPly((p) => Math.min(mainline.fens.length - 1, p + 1))
                  }
                  style={navButtonStyle}
                  disabled={currentPly >= mainline.fens.length - 1}
                  aria-label={t('analysisMetrics.nav.forward', 'Forward')}
                >
                  ▶
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentPly(mainline.fens.length - 1)}
                  style={navButtonStyle}
                  disabled={currentPly >= mainline.fens.length - 1}
                  aria-label={t('analysisMetrics.nav.end', 'End')}
                >
                  ⏭
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const navButtonStyle: React.CSSProperties = {
  fontSize: 14,
  padding: '4px 10px',
  background: '#f5f5f5',
  border: '1px solid #ccc',
  borderRadius: 4,
  cursor: 'pointer',
  lineHeight: 1,
};

export default AnalysisMetricsPage;
