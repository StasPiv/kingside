import { useTranslation } from 'react-i18next';

/**
 * KS-3004 (ADR-065 §5.1.2, Этап 3 F3) — compact-вариант 5-балльной
 * оценки precision-попытки для списка attempts (`PrecisionAttemptsList`).
 *
 * В отличие от `<PrecisionScoreBlock>` (детальная плашка на странице
 * разбора): здесь — inline-ряд из 5 mini-stars (16px) без текстовой
 * интерпретации и accuracy%, потому что:
 *   - accuracy% живёт рядом в `precision-attempts__accuracy`
 *     (вариант (а) §6.4: complementary metrics — категориальное
 *     быстрое сканирование + continuous progress-tracking);
 *   - интерпретация одной строкой раздувает каталог.
 *
 * Цвета (§4.2) — те же, что у блока, через CSS-переменную `--tone-color`.
 * `score === null` → нейтральный «—» (legacy attempt без WDL/cp).
 */

const TONE_BY_SCORE: Record<1 | 2 | 3 | 4 | 5, string> = {
  5: 'emerald',
  4: 'lime',
  3: 'amber',
  2: 'orange',
  1: 'red',
};

const STAR_INDICES: ReadonlyArray<0 | 1 | 2 | 3 | 4> = [0, 1, 2, 3, 4];

/** KS-3006: тип-safe ключи для t() без literal-string в JSX. */
const STARS_KEY: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'precision.score.stars.1',
  2: 'precision.score.stars.2',
  3: 'precision.score.stars.3',
  4: 'precision.score.stars.4',
  5: 'precision.score.stars.5',
};

function clampScore(raw: number): 1 | 2 | 3 | 4 | 5 {
  const r = Math.round(raw);
  if (r <= 1) return 1;
  if (r >= 5) return 5;
  return r as 1 | 2 | 3 | 4 | 5;
}

export interface PrecisionScoreBadgeProps {
  /** Балл попытки 1..5. `null` — данных нет; рисуем «—» в нейтральной палитре. */
  score: number | null;
  /** Опциональный testid-суффикс — удобно когда в одной строке списка ещё что-то с тем же testid. */
  testIdSuffix?: string;
}

export function PrecisionScoreBadge({
  score,
  testIdSuffix,
}: PrecisionScoreBadgeProps) {
  const { t } = useTranslation();
  const testId = testIdSuffix
    ? `precision-score-badge-${testIdSuffix}`
    : 'precision-score-badge';

  if (score === null) {
    return (
      <span
        className="precision-score-badge precision-score-badge--unavailable"
        data-testid={testId}
        data-tone="unavailable"
        data-score=""
        role="img"
        aria-label={t('precision.score.legacyMissing')}
        title={t('precision.score.legacyMissing')}
      >
        <span className="precision-score-badge__dash" aria-hidden="true">
          —
        </span>
      </span>
    );
  }

  const safeScore = clampScore(score);
  const tone = TONE_BY_SCORE[safeScore];
  const starsLabel = t(STARS_KEY[safeScore]);

  return (
    <span
      className={`precision-score-badge precision-score-badge--${tone}`}
      data-testid={testId}
      data-tone={tone}
      data-score={safeScore}
      role="img"
      aria-label={starsLabel}
      title={starsLabel}
    >
      {STAR_INDICES.map((i) => {
        const filled = i < safeScore;
        return (
          <MiniStar
            key={i}
            filled={filled}
            data-testid={
              testIdSuffix
                ? `${testId}-star-${filled ? 'filled' : 'empty'}-${i}`
                : `precision-score-badge-star-${filled ? 'filled' : 'empty'}-${i}`
            }
          />
        );
      })}
    </span>
  );
}

function MiniStar({
  filled,
  ...rest
}: {
  filled: boolean;
  'data-testid'?: string;
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      className={`precision-score-badge__star precision-score-badge__star--${filled ? 'filled' : 'empty'}`}
      aria-hidden="true"
      focusable="false"
      data-filled={filled}
      data-testid={rest['data-testid']}
    >
      <path
        d="M10 1.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L10 14.77l-5.2 2.73.99-5.78L1.58 7.62l5.82-.85L10 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}
