import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PuzzleStatsByMode, PuzzleStatsByModeEntry } from '@kingside/shared';

/**
 * KS-2495 (ADR-046 §5.5). Блок «Modes breakdown» на `/puzzles/stats`.
 *
 * Backend `/puzzles/stats/me` (rev:119, KS-2493) возвращает поле
 * `byMode: { 'forced-line': {...}, 'play-vs-engine': {...} }` — две
 * карточки с метриками `attempts` / `solved` / `accuracy` /
 * `avgRating`. Каждая карточка кликабельна и ведёт в свой раздел
 * пазлов.
 *
 * Если попыток в режиме нет (`attempts === 0`) — карточка всё равно
 * рендерится, но метрики показываются прочерками; это нормально:
 * пользователь видит, что режим существует и может попробовать.
 *
 * # Контракт DOM
 *
 *   <section data-testid="modes-breakdown">
 *     <h2>Modes breakdown</h2>
 *     <div class="modes-breakdown__grid">
 *       <Link to="/puzzles" data-testid="modes-breakdown-card-forced-line"
 *             data-mode="forced-line">…</Link>
 *       <Link to="/puzzles/play-vs-engine"
 *             data-testid="modes-breakdown-card-play-vs-engine"
 *             data-mode="play-vs-engine">…</Link>
 *     </div>
 *   </section>
 */

export interface ModesBreakdownProps {
  byMode: PuzzleStatsByMode;
}

interface ModeMeta {
  key: keyof PuzzleStatsByMode;
  to: string;
  titleKey: string;
  titleFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
}

const MODES: ModeMeta[] = [
  {
    key: 'forced-line',
    to: '/puzzles',
    titleKey: 'puzzleStats.modes.forcedLine.title',
    titleFallback: 'Forced line',
    descriptionKey: 'puzzleStats.modes.forcedLine.description',
    descriptionFallback: 'Classic Lichess tactics — find the only winning sequence.',
  },
  {
    key: 'play-vs-engine',
    // KS-2538/2544: путь раздела переехал на `/precision`; ключ
    // `play-vs-engine` остаётся API-маркером (внутренний solutionMode).
    to: '/precision',
    titleKey: 'puzzleStats.modes.precision.title',
    titleFallback: 'Precision',
    descriptionKey: 'puzzleStats.modes.precision.description',
    descriptionFallback: 'Hold the advantage against a strong engine for N half-moves.',
  },
];

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toString();
}

function formatAccuracy(entry: PuzzleStatsByModeEntry): string {
  if (entry.attempts === 0) return '—';
  return `${Math.round(entry.accuracy)}%`;
}

export function ModesBreakdown({ byMode }: ModesBreakdownProps) {
  const { t } = useTranslation();
  return (
    <section className="modes-breakdown" data-testid="modes-breakdown">
      <h2 className="modes-breakdown__title">
        {t('puzzleStats.modes.heading', 'Modes breakdown')}
      </h2>
      <div className="modes-breakdown__grid">
        {MODES.map((meta) => {
          const entry = byMode[meta.key];
          return (
            <Link
              key={meta.key}
              to={meta.to}
              className="modes-breakdown__card"
              data-testid={`modes-breakdown-card-${meta.key}`}
              data-mode={meta.key}
            >
              <div className="modes-breakdown__card-header">
                <h3 className="modes-breakdown__card-title">
                  {t(meta.titleKey, meta.titleFallback)}
                </h3>
                <p className="modes-breakdown__card-description">
                  {t(meta.descriptionKey, meta.descriptionFallback)}
                </p>
              </div>
              <dl className="modes-breakdown__metrics">
                <div className="modes-breakdown__metric">
                  <dt>{t('puzzleStats.modes.attempts', 'Attempts')}</dt>
                  <dd data-testid={`modes-breakdown-${meta.key}-attempts`}>
                    {formatNumber(entry.attempts)}
                  </dd>
                </div>
                <div className="modes-breakdown__metric">
                  <dt>{t('puzzleStats.modes.solved', 'Solved')}</dt>
                  <dd data-testid={`modes-breakdown-${meta.key}-solved`}>
                    {formatNumber(entry.solved)}
                  </dd>
                </div>
                <div className="modes-breakdown__metric">
                  <dt>{t('puzzleStats.modes.accuracy', 'Accuracy')}</dt>
                  <dd data-testid={`modes-breakdown-${meta.key}-accuracy`}>
                    {formatAccuracy(entry)}
                  </dd>
                </div>
                <div className="modes-breakdown__metric">
                  <dt>{t('puzzleStats.modes.avgRating', 'Avg rating')}</dt>
                  <dd data-testid={`modes-breakdown-${meta.key}-avgRating`}>
                    {formatNumber(entry.avgRating)}
                  </dd>
                </div>
              </dl>
              <span className="modes-breakdown__cta">
                {t('puzzleStats.modes.train', 'Train')} →
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
