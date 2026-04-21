import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

interface RatingEntry {
  id: string;
  category: string;
  rating: number;
  gameId: string | null;
  createdAt: string;
}

interface RatingHistoryChartProps {
  userId: string;
}

const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'] as const;
const CATEGORY_COLORS: Record<string, string> = {
  bullet: '#f59e0b',
  blitz: '#ef4444',
  rapid: '#3b82f6',
  classical: '#10b981',
};

export function RatingHistoryChart({ userId }: RatingHistoryChartProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<RatingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string>('blitz');

  useEffect(() => {
    setLoading(true);
    api.get<{ data: RatingEntry[] }>(`/users/${userId}/rating-history?category=${category}`)
      .then((res) => setData(res.data))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [userId, category]);

  const height = 140;
  const padding = { top: 10, bottom: 20, left: 0, right: 0 };
  const graphH = height - padding.top - padding.bottom;

  const { points, minR, maxR } = useMemo(() => {
    if (data.length === 0) return { points: [], minR: 0, maxR: 0 };
    const ratings = data.map((d) => d.rating);
    const min = Math.min(...ratings);
    const max = Math.max(...ratings);
    const range = max - min || 100;
    const padded = { min: min - range * 0.1, max: max + range * 0.1 };
    const rRange = padded.max - padded.min;

    return {
      points: data.map((d, i) => ({
        x: (i / Math.max(data.length - 1, 1)) * 100,
        y: padding.top + graphH - ((d.rating - padded.min) / rRange) * graphH,
        rating: d.rating,
        date: d.createdAt,
      })),
      minR: Math.floor(padded.min),
      maxR: Math.ceil(padded.max),
    };
  }, [data, graphH]);

  const pathD = useMemo(() => {
    if (points.length === 0) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  }, [points]);

  const fillD = useMemo(() => {
    if (points.length === 0) return '';
    const bottom = padding.top + graphH;
    const parts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`);
    parts.push(`L${points[points.length - 1].x},${bottom}`);
    parts.push(`L${points[0].x},${bottom}`);
    parts.push('Z');
    return parts.join(' ');
  }, [points, graphH]);

  const [hover, setHover] = useState<{ x: number; y: number; rating: number; date: string } | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (points.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const xPct = ((e.clientX - rect.left) / rect.width) * 100;
      let closest = points[0];
      let minDist = Math.abs(xPct - points[0].x);
      for (const p of points) {
        const d = Math.abs(xPct - p.x);
        if (d < minDist) { minDist = d; closest = p; }
      }
      setHover(closest);
    },
    [points],
  );

  const color = CATEGORY_COLORS[category] || '#8888ff';

  return (
    <div className="rating-history">
      <div className="rating-history__header">
        <h3 className="rating-history__title">{t('profile.ratingHistory', 'Rating History')}</h3>
        <div className="rating-history__filters">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`rating-history__filter${category === cat ? ' active' : ''}`}
              onClick={() => setCategory(cat)}
              style={category === cat ? { borderColor: CATEGORY_COLORS[cat], color: CATEGORY_COLORS[cat] } : undefined}
            >
              {t(`profile.rating.${cat}`, cat.charAt(0).toUpperCase() + cat.slice(1))}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="rating-history__empty">{t('common.loading')}</div>
      ) : data.length === 0 ? (
        <div className="rating-history__empty">{t('profile.noRatingData', 'No games played in this category')}</div>
      ) : (
        <div className="rating-history__chart">
          <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            className="rating-history__svg"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* Grid lines */}
            {[0.25, 0.5, 0.75].map((pct) => (
              <line
                key={pct}
                x1="0" y1={padding.top + graphH * (1 - pct)}
                x2="100" y2={padding.top + graphH * (1 - pct)}
                stroke="#333" strokeWidth="0.3"
              />
            ))}
            {/* Fill */}
            <path d={fillD} fill={color} opacity="0.15" />
            {/* Line */}
            <path d={pathD} fill="none" stroke={color} strokeWidth="0.8" />
            {/* Hover indicator */}
            {hover && (
              <>
                <line x1={hover.x} y1={padding.top} x2={hover.x} y2={padding.top + graphH} stroke="#fff" strokeWidth="0.3" opacity="0.5" />
                <circle cx={hover.x} cy={hover.y} r="1.5" fill={color} stroke="#fff" strokeWidth="0.5" />
              </>
            )}
          </svg>
          <div className="rating-history__labels">
            <span>{maxR}</span>
            <span>{minR}</span>
          </div>
          {hover && (
            <div className="rating-history__tooltip">
              <strong>{hover.rating}</strong>
              <span>{new Date(hover.date).toLocaleDateString()}</span>
            </div>
          )}
          <div className="rating-history__summary">
            <span>{t('profile.games', 'Games')}: {data.length}</span>
            {data.length > 0 && (
              <span>{t('profile.current', 'Current')}: {data[data.length - 1].rating}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
