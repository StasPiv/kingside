import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { PlayVsEnginePuzzleReason } from '@kingside/shared';
import { api } from '../api';
import { PuzzleBoard } from '../components/PuzzleBoard';
import {
  PostGameReview,
  type PostGameReviewProps,
} from '../components/puzzle/PostGameReview';
import type { UserBestSnapshot } from '../components/puzzle/PlayVsEngineRunner';
import type { MoveClass } from '../utils/moveClassification';

/**
 * KS-2719 F4 / ADR-056 §3.4 + §5. Detail-страница одной precision-
 * попытки. Источник — `GET /precision/attempts/:attemptId` (бэкенд
 * KS-2718). Фронт ничего не пересчитывает: моuves[] и агрегаты
 * приходят уже посчитанными (server-trust из ADR-055).
 *
 * # Layout
 *   - summary: result (preserved/lost), halfMoves, accuracy%, wdlLeakSum
 *   - sparkline по wdl_user поплу полходов (Уровень Б ADR-056 §2.2)
 *   - bar-chart распределения classifications
 *   - PostGameReview — переиспользует компонент из KS-2686, но получает
 *     данные не из runtime-state PlayVsEngineRunner, а из API. Маппинг
 *     `moves[]` → `userBestLog: UserBestSnapshot[]` тривиальный.
 *   - доска для подсветки выбранного хода (через onSelectMove → fenBefore).
 *
 * # Graceful fallback
 *   До выкатки backend (KS-2718) endpoint вернёт 404. Показываем
 *   `data-state="error"` + кнопку «Назад в /precision». При reload
 *   данные восстанавливаются из БД, на клиенте ничего не кешируем.
 */

interface PrecisionMove {
  ply: number;
  fenBefore: string;
  playedUci: string;
  bestUci: string;
  cpBefore: number | null;
  cpAfter: number | null;
  wdlBefore: { w: number; d: number; l: number } | null;
  wdlAfter: { w: number; d: number; l: number } | null;
  depth: number | null;
  /** Backend-расчёт server-trust. */
  classification: MoveClass | null;
  /** WDL_user после фактически сыгранного хода (POV user, доли 0..1). */
  wdlUserAfter: number | null;
}

interface PrecisionAttemptResponse {
  id: string;
  puzzleId: string;
  /** Стартовая позиция пазла. */
  initialFen: string;
  /** Чьим цветом играл юзер. */
  userSide: 'w' | 'b';
  /** preserved | lost | aborted. */
  result: 'preserved' | 'lost' | 'aborted';
  reason: PlayVsEnginePuzzleReason | null;
  halfMovesPlayed: number;
  /** Все полуходы партии (user + engine) в SAN. */
  playedSans: string[];
  /** Только user-ходы со снапшотами + классификацией. */
  moves: PrecisionMove[];
  /** Агрегаты по попытке. */
  accuracyPercent: number | null;
  wdlLeakSum: number | null;
  /** Распределение classifications. */
  classificationCounts: Record<MoveClass, number>;
  createdAt: string;
}

type PageState = 'loading' | 'ready' | 'error';

const CLASS_COLORS: Record<MoveClass, string> = {
  best: '#27ae60',
  good: '#7fbf7f',
  inaccuracy: '#f1c40f',
  mistake: '#e67e22',
  blunder: '#c0392b',
};

const CLASS_ORDER: MoveClass[] = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
];

export function PrecisionAttemptPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();

  const [state, setState] = useState<PageState>('loading');
  const [data, setData] = useState<PrecisionAttemptResponse | null>(null);
  const [reviewFen, setReviewFen] = useState<string | null>(null);

  const fetchAttempt = useCallback(async () => {
    if (!id) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      const res = await api.get<PrecisionAttemptResponse>(
        `/precision/attempts/${encodeURIComponent(id)}`,
      );
      setData(res);
      setState('ready');
    } catch {
      // 404/401/5xx — все одинаково: показать error-блок с кнопкой.
      setData(null);
      setState('error');
    }
  }, [id]);

  useEffect(() => {
    void fetchAttempt();
  }, [fetchAttempt]);

  /** Маппинг `moves[]` → `UserBestSnapshot[]` для PostGameReview. */
  const userBestLog = useMemo<UserBestSnapshot[]>(() => {
    if (!data) return [];
    return data.moves.map((m) => ({
      halfMove: m.ply,
      fenBefore: m.fenBefore,
      playedUci: m.playedUci,
      bestUci: m.bestUci,
      cpBefore: m.cpBefore,
      cpAfter: m.cpAfter,
      wdlBefore: m.wdlBefore,
      wdlAfter: m.wdlAfter,
      depth: m.depth,
    }));
  }, [data]);

  // Доска: при выбранном reviewFen показываем его, иначе финальную позицию
  // (проигрываем playedSans от initialFen). chess.js парсит SAN сам.
  const finalFen = useMemo<string>(() => {
    if (!data) return '';
    try {
      const c = new Chess(data.initialFen);
      for (const san of data.playedSans) {
        c.move(san);
      }
      return c.fen();
    } catch {
      return data.initialFen;
    }
  }, [data]);

  if (state === 'loading') {
    return (
      <div
        className="precision-attempt-page"
        data-testid="precision-attempt-page"
        data-state="loading"
      >
        <p>{t('common.loading', 'Loading…')}</p>
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div
        className="precision-attempt-page"
        data-testid="precision-attempt-page"
        data-state="error"
      >
        <p>
          {t(
            'precisionAttempt.notFound',
            'Attempt not found or no longer available.',
          )}
        </p>
        <Link to="/precision" data-testid="precision-attempt-back">
          ← {t('precision.backToAll', 'All puzzles')}
        </Link>
      </div>
    );
  }

  const orientation: 'white' | 'black' =
    data.userSide === 'w' ? 'white' : 'black';
  const accuracyText =
    data.accuracyPercent != null
      ? `${Math.round(data.accuracyPercent)}%`
      : t('precision.stats.noData', '—');
  const wdlLeakText =
    data.wdlLeakSum != null
      ? data.wdlLeakSum.toFixed(2)
      : t('precision.stats.noData', '—');

  // Sparkline точек: wdl_user после каждого user-хода (доли 0..1).
  // null = пропуск (не проводим линию через дыры). Виза сама нормализует
  // координаты, поэтому достаточно массива {x, y|null}.
  const sparkPoints = data.moves.map((m, idx) => ({
    x: idx + 1,
    y: m.wdlUserAfter,
  }));

  // Bar-chart distribution: для каждой категории — кол-во ходов.
  // Если `classificationCounts` отсутствует/частичный — defauлт 0.
  const totalClassified = CLASS_ORDER.reduce(
    (sum, c) => sum + (data.classificationCounts[c] ?? 0),
    0,
  );

  const handleSelect: PostGameReviewProps['onSelectMove'] = ({ fenBefore }) =>
    setReviewFen(fenBefore);

  return (
    <div
      className="precision-attempt-page"
      data-testid="precision-attempt-page"
      data-state="ready"
      data-result={data.result}
      data-half-moves={String(data.halfMovesPlayed)}
    >
      <header className="precision-attempt-page__header">
        <Link
          to="/precision"
          className="precision-attempt-page__back"
          data-testid="precision-attempt-back"
        >
          ← {t('precision.backToAll', 'All puzzles')}
        </Link>
        <h1>
          {t('precisionAttempt.title', 'Attempt #{{id}}', {
            id: data.id.slice(0, 8),
          })}
        </h1>
      </header>

      {/* Сводка: 4 inline-метрики. */}
      <section
        className="precision-attempt-page__summary"
        data-testid="precision-attempt-summary"
      >
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.result', 'Result')}
          </div>
          <div
            className={`precision-attempt-page__summary-value precision-attempt-page__summary-value--${data.result}`}
          >
            {data.result === 'preserved'
              ? t('precisionAttempt.result.preserved', 'Preserved')
              : data.result === 'lost'
                ? t('precisionAttempt.result.lost', 'Lost')
                : t('precisionAttempt.result.aborted', 'Aborted')}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.halfMoves', 'Half-moves')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {data.halfMovesPlayed}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.accuracy', 'Accuracy')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {accuracyText}
          </div>
        </div>
        <div className="precision-attempt-page__summary-cell">
          <div className="precision-attempt-page__summary-label">
            {t('precisionAttempt.summary.wdlLeakSum', 'WDL leak total')}
          </div>
          <div className="precision-attempt-page__summary-value">
            {wdlLeakText}
          </div>
        </div>
      </section>

      {/* Sparkline WDL_user по полуходам (Уровень Б ADR-056 §2.2).
          ViewBox 100×40 — масштабируется через CSS. y_norm = 1 - y
          (сверху 100%, снизу 0%). null-точки разбивают линию. */}
      {sparkPoints.length > 0 && (
        <section
          className="precision-attempt-page__chart"
          data-testid="precision-attempt-sparkline"
        >
          <h2 className="precision-attempt-page__chart-title">
            {t('precisionAttempt.sparkline.title', 'WDL trajectory')}
          </h2>
          <svg
            className="precision-attempt-page__sparkline"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            role="img"
            aria-label={t(
              'precisionAttempt.sparkline.aria',
              'WDL trajectory across half-moves',
            )}
          >
            {/* baseline 50% */}
            <line
              x1="0"
              y1="20"
              x2="100"
              y2="20"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="0.5"
            />
            {(() => {
              const segs: string[] = [];
              let path = '';
              const n = Math.max(1, sparkPoints.length);
              sparkPoints.forEach((p, i) => {
                if (p.y == null) {
                  if (path) segs.push(path);
                  path = '';
                  return;
                }
                const x = (i / (n - 1 || 1)) * 100;
                const y = 40 - p.y * 40;
                path += path ? ` L ${x.toFixed(2)} ${y.toFixed(2)}` : `M ${x.toFixed(2)} ${y.toFixed(2)}`;
              });
              if (path) segs.push(path);
              return segs.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke="#4ea1f7"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ));
            })()}
          </svg>
        </section>
      )}

      {/* Bar-chart distribution по 5 классам ходов. */}
      {totalClassified > 0 && (
        <section
          className="precision-attempt-page__chart"
          data-testid="precision-attempt-bars"
        >
          <h2 className="precision-attempt-page__chart-title">
            {t(
              'precisionAttempt.classifications.title',
              'Move classifications',
            )}
          </h2>
          <ul className="precision-attempt-page__bars">
            {CLASS_ORDER.map((cls) => {
              const count = data.classificationCounts[cls] ?? 0;
              const pct = (count / totalClassified) * 100;
              return (
                <li
                  key={cls}
                  className="precision-attempt-page__bars-row"
                  data-testid={`precision-attempt-bar-${cls}`}
                  data-count={String(count)}
                >
                  <span className="precision-attempt-page__bars-label">
                    {t(
                      `precisionAttempt.classifications.${cls}`,
                      cls.charAt(0).toUpperCase() + cls.slice(1),
                    )}
                  </span>
                  <span className="precision-attempt-page__bars-track">
                    <span
                      className="precision-attempt-page__bars-fill"
                      style={{
                        width: `${pct.toFixed(1)}%`,
                        background: CLASS_COLORS[cls],
                      }}
                    />
                  </span>
                  <span className="precision-attempt-page__bars-count">
                    {count}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Доска + PostGameReview из KS-2686 (тот же компонент, что в
          PlayVsEngineRunner). Источник — moves[] из endpoint, ничего
          не пересчитываем. Клик по ходу подсвечивает позицию. */}
      <section className="precision-attempt-page__review">
        <PuzzleBoard
          game={new Chess(reviewFen ?? finalFen)}
          boardOrientation={orientation}
          enabled={false}
          onPieceDrop={() => false}
          lastMoveUci={null}
          status={data.result === 'preserved' ? 'correct' : 'incorrect'}
        />
        <PostGameReview
          initialFen={data.initialFen}
          playedSans={data.playedSans}
          userBestLog={userBestLog}
          userSide={data.userSide}
          onSelectMove={handleSelect}
        />
      </section>
    </div>
  );
}
