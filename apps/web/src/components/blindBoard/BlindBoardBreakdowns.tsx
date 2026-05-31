import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardBreakdownsResponse,
  BlindBoardPieceType,
} from '@kingside/shared';
import { api } from '../../api';

/**
 * KS-3511 (ADR-093 §4.3) — pie по `wrongByPieceType`. Простая
 * inline-SVG диаграмма, как в `GuessBreakdowns` (но один piepart).
 */

const PIECE_ORDER: readonly BlindBoardPieceType[] = ['Q', 'R', 'B', 'N'];
const PIECE_COLOR: Record<BlindBoardPieceType, string> = {
  Q: '#7c83ff',
  R: '#f59e0b',
  B: '#10b981',
  N: '#ef4444',
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
        ? `M ${PIE_CX} ${PIE_CY - PIE_RADIUS} A ${PIE_RADIUS} ${PIE_RADIUS} 0 1 1 ${PIE_CX} ${
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

export interface BlindBoardBreakdownsProps {
  fetcher?: () => Promise<BlindBoardBreakdownsResponse>;
}

export function BlindBoardBreakdowns({
  fetcher,
}: BlindBoardBreakdownsProps = {}) {
  const { t } = useTranslation();
  const [data, setData] = useState<BlindBoardBreakdownsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const get =
        fetcher ??
        (() =>
          api.get<BlindBoardBreakdownsResponse>(
            '/blind-board/breakdowns/me',
          ));
      setData(await get());
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
        className="blind-board-breakdowns"
        data-testid="blind-board-breakdowns"
        data-state="loading"
      >
        <div
          className="blind-board-breakdowns__skeleton"
          data-testid="blind-board-breakdowns-skeleton"
        />
      </section>
    );
  }
  if (error) {
    return (
      <section
        className="blind-board-breakdowns"
        data-testid="blind-board-breakdowns"
        data-state="error"
      >
        <p>
          {t('blindBoard.breakdowns.error', 'Failed to load breakdowns')}
        </p>
        <button type="button" onClick={() => void doFetch()}>
          {t('common.retry', 'Retry')}
        </button>
      </section>
    );
  }

  const rec = (data?.wrongByPieceType ?? {}) as Record<
    BlindBoardPieceType,
    { count: number; share: number }
  >;
  const slices = buildPieSlices(
    rec as Record<string, { count: number; share: number }>,
    PIECE_ORDER as readonly string[],
    PIECE_COLOR as Record<string, string>,
    (k) => t(`blindBoard.piece.${k}`, k),
  );
  const total = PIECE_ORDER.reduce((s, k) => s + (rec[k]?.count ?? 0), 0);

  if (total === 0) {
    return (
      <section
        className="blind-board-breakdowns"
        data-testid="blind-board-breakdowns"
        data-state="empty"
      >
        <p
          className="blind-board-breakdowns__placeholder"
          data-testid="blind-board-breakdowns-placeholder"
        >
          {t(
            'blindBoard.breakdowns.empty',
            'Make some mistakes to see your piece-type breakdown',
          )}
        </p>
      </section>
    );
  }

  return (
    <section
      className="blind-board-breakdowns"
      data-testid="blind-board-breakdowns"
      data-state="ready"
    >
      <div
        className="blind-board-breakdowns__panel"
        data-testid="blind-board-breakdowns-piece"
      >
        <h3 className="blind-board-breakdowns__title">
          {t('blindBoard.breakdowns.pieceTitle', 'Wrong by piece type')}
        </h3>
        <svg
          className="blind-board-breakdowns__pie"
          viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
          width={PIE_SIZE}
          height={PIE_SIZE}
          role="img"
          aria-label={t(
            'blindBoard.breakdowns.pieceTitle',
            'Wrong by piece type',
          )}
        >
          {slices.map((s, i) => (
            <path
              key={`p-${i}`}
              d={s.d}
              fill={s.color}
              data-testid={`blind-board-breakdowns-piece-slice-${PIECE_ORDER[i]}`}
            >
              <title>{`${s.label}: ${s.count} (${Math.round(s.share * 100)}%)`}</title>
            </path>
          ))}
        </svg>
        <ul className="blind-board-breakdowns__legend">
          {PIECE_ORDER.map((k) => {
            const e = rec[k] ?? { count: 0, share: 0 };
            return (
              <li
                key={k}
                data-testid={`blind-board-breakdowns-piece-legend-${k}`}
              >
                <span
                  className="blind-board-breakdowns__swatch"
                  style={{ background: PIECE_COLOR[k] }}
                />
                {t(`blindBoard.piece.${k}`, k)}: {e.count} (
                {Math.round(e.share * 100)}%)
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
