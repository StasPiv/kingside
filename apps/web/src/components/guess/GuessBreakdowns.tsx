import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GuessBreakdownsResponse,
  GuessMoveClass,
  GuessVerdict,
} from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-3510 (ADR-093 §3.3) — два breakdown'а:
 *  1. По `verdict` (strongest/betterThanPlayer/asPlayer/weaker) — pie.
 *  2. По `userClass` (best/good/inaccuracy/mistake/blunder) — bar.
 *
 * Источник — `GET /guess/breakdowns/me` (B-guess, KS-3508).
 */

const VERDICT_ORDER: readonly GuessVerdict[] = [
  'strongest',
  'betterThanPlayer',
  'asPlayer',
  'weaker',
];
const VERDICT_COLOR: Record<GuessVerdict, string> = {
  strongest: '#10b981',
  betterThanPlayer: '#84cc16',
  asPlayer: '#f59e0b',
  weaker: '#ef4444',
};

const CLASS_ORDER: readonly GuessMoveClass[] = [
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
];
const CLASS_COLOR: Record<GuessMoveClass, string> = {
  best: '#10b981',
  good: '#84cc16',
  inaccuracy: '#f59e0b',
  mistake: '#f97316',
  blunder: '#ef4444',
};

const PIE_SIZE = 160;
const PIE_RADIUS = 70;
const PIE_CX = PIE_SIZE / 2;
const PIE_CY = PIE_SIZE / 2;

interface PieSlice {
  d: string;
  color: string;
  label: string;
  count: number;
  share: number;
}

function buildPieSlices(
  rec: Record<string, { count: number; share: number }>,
  order: readonly string[],
  colors: Record<string, string>,
  labelOf: (k: string) => string,
): PieSlice[] {
  const total = order.reduce((s, k) => s + (rec[k]?.count ?? 0), 0);
  if (total === 0) return [];
  let acc = 0;
  const slices: PieSlice[] = [];
  for (const k of order) {
    const e = rec[k];
    if (!e || e.count === 0) continue;
    const share = e.count / total;
    const startA = acc * 2 * Math.PI - Math.PI / 2;
    acc += share;
    const endA = acc * 2 * Math.PI - Math.PI / 2;
    const x1 = PIE_CX + PIE_RADIUS * Math.cos(startA);
    const y1 = PIE_CY + PIE_RADIUS * Math.sin(startA);
    const x2 = PIE_CX + PIE_RADIUS * Math.cos(endA);
    const y2 = PIE_CY + PIE_RADIUS * Math.sin(endA);
    const largeArc = share > 0.5 ? 1 : 0;
    const d =
      share >= 0.9999
        ? // полный круг — рисуем как два полукруга
          `M ${PIE_CX} ${PIE_CY - PIE_RADIUS} A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${PIE_CX} ${
            PIE_CY + PIE_RADIUS
          } A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${PIE_CX} ${PIE_CY - PIE_RADIUS} Z`
        : `M ${PIE_CX} ${PIE_CY} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    slices.push({
      d,
      color: colors[k],
      label: labelOf(k),
      count: e.count,
      share,
    });
  }
  return slices;
}

export interface GuessBreakdownsProps {
  fetcher?: () => Promise<GuessBreakdownsResponse>;
}

export function GuessBreakdowns({ fetcher }: GuessBreakdownsProps = {}) {
  const { t } = useTranslation();
  const [data, setData] = useState<GuessBreakdownsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const get =
        fetcher ??
        (() => api.get<GuessBreakdownsResponse>('/guess/breakdowns/me'));
      const res = await get();
      setData(res);
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  if (loading) {
    return (
      <section
        className="guess-breakdowns"
        data-testid="guess-breakdowns"
        data-state="loading"
      >
        <div
          className="guess-breakdowns__skeleton"
          data-testid="guess-breakdowns-skeleton"
        />
      </section>
    );
  }
  if (error) {
    return (
      <section
        className="guess-breakdowns"
        data-testid="guess-breakdowns"
        data-state="error"
      >
        <p>{t('guess.breakdowns.error', 'Failed to load breakdowns')}</p>
        <button type="button" onClick={() => void doFetch()}>
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }

  const verdictRec = (data?.verdict ?? {}) as Record<
    GuessVerdict,
    { count: number; share: number }
  >;
  const classRec = (data?.userClass ?? {}) as Record<
    GuessMoveClass,
    { count: number; share: number }
  >;
  const verdictSlices = buildPieSlices(
    verdictRec as Record<string, { count: number; share: number }>,
    VERDICT_ORDER as readonly string[],
    VERDICT_COLOR as Record<string, string>,
    (k) => t(`guess.verdictShort.${k}`, k),
  );
  const verdictTotal = VERDICT_ORDER.reduce(
    (s, k) => s + (verdictRec[k]?.count ?? 0),
    0,
  );
  const classMax = Math.max(
    1,
    ...CLASS_ORDER.map((k) => classRec[k]?.count ?? 0),
  );
  const classTotal = CLASS_ORDER.reduce(
    (s, k) => s + (classRec[k]?.count ?? 0),
    0,
  );

  if (verdictTotal === 0 && classTotal === 0) {
    return (
      <section
        className="guess-breakdowns"
        data-testid="guess-breakdowns"
        data-state="empty"
      >
        <p
          className="guess-breakdowns__placeholder"
          data-testid="guess-breakdowns-placeholder"
        >
          {t(
            'guess.breakdowns.empty',
            'Play more sessions to see your move breakdown',
          )}
        </p>
      </section>
    );
  }

  return (
    <section
      className="guess-breakdowns"
      data-testid="guess-breakdowns"
      data-state="ready"
    >
      <div
        className="guess-breakdowns__panel"
        data-testid="guess-breakdowns-verdict"
      >
        <h3 className="guess-breakdowns__title">
          {t('guess.breakdowns.verdictTitle', 'Verdicts')}
        </h3>
        <svg
          className="guess-breakdowns__pie"
          viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
          width={PIE_SIZE}
          height={PIE_SIZE}
          role="img"
          aria-label={t('guess.breakdowns.verdictTitle', 'Verdicts')}
        >
          {verdictSlices.map((s, i) => (
            <path
              key={`v-${i}`}
              d={s.d}
              fill={s.color}
              data-testid={`guess-breakdowns-verdict-slice-${VERDICT_ORDER[i]}`}
            >
              <title>{`${s.label}: ${s.count} (${Math.round(s.share * 100)}%)`}</title>
            </path>
          ))}
        </svg>
        <ul className="guess-breakdowns__legend">
          {VERDICT_ORDER.map((k) => {
            const e = verdictRec[k] ?? { count: 0, share: 0 };
            return (
              <li key={k} data-testid={`guess-breakdowns-verdict-legend-${k}`}>
                <span
                  className="guess-breakdowns__swatch"
                  style={{ background: VERDICT_COLOR[k] }}
                />
                {t(`guess.verdictShort.${k}`, k)}: {e.count} (
                {Math.round(e.share * 100)}%)
              </li>
            );
          })}
        </ul>
      </div>

      <div
        className="guess-breakdowns__panel"
        data-testid="guess-breakdowns-class"
      >
        <h3 className="guess-breakdowns__title">
          {t('guess.breakdowns.classTitle', 'Move classes')}
        </h3>
        <div
          className="guess-breakdowns__bars"
          role="list"
        >
          {CLASS_ORDER.map((k) => {
            const e = classRec[k] ?? { count: 0, share: 0 };
            const w = (e.count / classMax) * 100;
            return (
              <div
                key={k}
                role="listitem"
                className="guess-breakdowns__bar-row"
                data-testid={`guess-breakdowns-class-${k}`}
              >
                <span className="guess-breakdowns__bar-label">
                  {t(`guess.class.${k}`, k)}
                </span>
                <span
                  className="guess-breakdowns__bar"
                  style={{
                    width: `${Math.max(2, w)}%`,
                    background: CLASS_COLOR[k],
                  }}
                  title={`${e.count} (${Math.round(e.share * 100)}%)`}
                />
                <span className="guess-breakdowns__bar-count">
                  {e.count}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
