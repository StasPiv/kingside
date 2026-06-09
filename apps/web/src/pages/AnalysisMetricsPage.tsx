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
  title: string;
  loading: boolean;
  notFound: boolean;
}

/**
 * Раскладываем PGN/move-list анализа в массив UCI-ходов через chess.js.
 * Для отдельной страницы нам не нужно дерево вариантов — достаточно
 * mainline, по которой считаются позиционные метрики.
 */
function pgnToUciMainline(pgn: string): string[] {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    return history.map((m) => {
      const promo = m.promotion ? m.promotion : '';
      return `${m.from}${m.to}${promo}`;
    });
  } catch {
    return [];
  }
}

function useAnalysisMainline(analysisId: string | undefined): MainlineState {
  const [state, setState] = useState<MainlineState>({
    uciMoves: [],
    title: '',
    loading: true,
    notFound: false,
  });
  useEffect(() => {
    if (!analysisId) return;
    let cancelled = false;
    setState({ uciMoves: [], title: '', loading: true, notFound: false });
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
        setState({ uciMoves: [], title: '', loading: false, notFound: true });
        return;
      }
      const uci = dto.pgn ? pgnToUciMainline(dto.pgn) : [];
      setState({
        uciMoves: uci,
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
      data-testid="analysis-metrics-page"
      style={{
        padding: '16px 24px',
        maxWidth: 1400,
        margin: '0 auto',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 12,
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
        <div style={{ color: '#8a1f1f', fontSize: 13 }}>
          Анализ не найден или недоступен.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid #e0e0e0',
            borderRadius: 8,
            background: '#fff',
            padding: 8,
          }}
        >
          <PositionalMetricsPanel
            trace={trace}
            uciMoves={mainline.uciMoves}
            chartHeight={460}
            selectionStorageKey={`ks:metrics:selection:${analysisId}`}
          />
        </div>
      )}
    </div>
  );
}

export default AnalysisMetricsPage;
