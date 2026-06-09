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
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import type { AnalysisResponse } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { usePositionalTrace } from '../hooks/usePositionalTrace';
import { PositionalMetricsPanel } from '../components/analysis/PositionalMetricsPanel';

interface MainlineState {
  uciMoves: string[];
  sanMoves: string[];
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
function pgnToMainline(pgn: string): { uci: string[]; san: string[] } {
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
    return { uci, san };
  } catch {
    return { uci: [], san: [] };
  }
}

function useAnalysisMainline(analysisId: string | undefined): MainlineState {
  const [state, setState] = useState<MainlineState>({
    uciMoves: [],
    sanMoves: [],
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
          title: '',
          loading: false,
          notFound: true,
        });
        return;
      }
      const parsed = dto.pgn ? pgnToMainline(dto.pgn) : { uci: [], san: [] };
      setState({
        uciMoves: parsed.uci,
        sanMoves: parsed.san,
        title: dto.title || 'Анализ',
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
  const { analysisId } = useParams<{ analysisId: string }>();
  const mainline = useAnalysisMainline(analysisId);
  const trace = usePositionalTrace({ analysisId: analysisId ?? null });

  if (!analysisId) {
    return (
      <div style={{ padding: 24 }}>
        <p>Не указан идентификатор анализа.</p>
        <Link to="/lessons">← На главную</Link>
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
          ← Назад к анализу
        </Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {mainline.loading ? 'Загрузка…' : mainline.title || 'Анализ'}
        </h1>
        <span style={{ color: '#999', fontSize: 12 }}>
          · {mainline.uciMoves.length} полуходов
        </span>
      </div>
      {mainline.notFound ? (
        <div style={{ color: '#8a1f1f', fontSize: 13, padding: '0 16px' }}>
          Анализ не найден или недоступен.
        </div>
      ) : (
        <div style={{ background: '#fff', padding: 0 }}>
          <PositionalMetricsPanel
            trace={trace}
            uciMoves={mainline.uciMoves}
            sanMoves={mainline.sanMoves}
            chartHeight={520}
            selectionStorageKey={`ks:metrics:selection:${analysisId}`}
            layout="fullpage"
          />
        </div>
      )}
    </div>
  );
}

export default AnalysisMetricsPage;
