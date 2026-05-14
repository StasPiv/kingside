import { useTranslation } from 'react-i18next';

/**
 * KS-3002 (ADR-065 §5.1.1, Этап 3 F1) — итоговый блок 5-балльной оценки
 * precision-попытки.
 *
 * Заменяет бинарную плашку «Удержано / Потеряно» из
 * `PrecisionAttemptReview`. F2 встраивает этот блок туда.
 *
 * Состав по §5.1.1:
 *  - 5 SVG-звёзд, заполненных по `score`;
 *  - accuracy в процентах (`scorePct`);
 *  - короткая текстовая интерпретация.
 *
 * Цвета (ADR-065 §4.2):
 *  5★ → emerald, 4★ → lime, 3★ → amber, 2★ → orange, 1★ → red.
 *
 * Тон применяется CSS-классом `--emerald|lime|amber|orange|red` — фактические
 * hex (`#10b981`, `#84cc16`, …) определены в `puzzle.css`, чтобы можно было
 * подкорректировать палитру централизованно, не трогая JSX.
 *
 * i18n: используем плейсхолдеры `t(...)` с дефолтами; ключи официально
 * добавит F5. Это безопасно — если ключа нет, i18next вернёт fallback.
 */

export type PrecisionScoreValue = 1 | 2 | 3 | 4 | 5;

const TONE_BY_SCORE: Record<PrecisionScoreValue, string> = {
  5: 'emerald',
  4: 'lime',
  3: 'amber',
  2: 'orange',
  1: 'red',
};

interface InterpretationKey {
  /** i18n-ключ (F5 добавит официальные тексты). */
  key: string;
  /** Fallback пока F5 не подъехал. */
  fallback: string;
}

const INTERPRETATION_BY_SCORE: Record<PrecisionScoreValue, InterpretationKey> = {
  5: {
    key: 'precision.score.interpretation.5',
    fallback: 'Excellent — played at near-engine level.',
  },
  4: {
    key: 'precision.score.interpretation.4',
    fallback: 'Strong — only minor inaccuracies.',
  },
  3: {
    key: 'precision.score.interpretation.3',
    fallback: 'Solid — kept the position with some imprecisions.',
  },
  2: {
    key: 'precision.score.interpretation.2',
    fallback: 'Shaky — significant mistakes hurt the edge.',
  },
  1: {
    key: 'precision.score.interpretation.1',
    fallback: 'Poor — a major blunder cost the advantage.',
  },
};

const STAR_INDICES: ReadonlyArray<0 | 1 | 2 | 3 | 4> = [0, 1, 2, 3, 4];

function isPrecisionScoreValue(n: number): n is PrecisionScoreValue {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

function clampScore(raw: number): PrecisionScoreValue {
  const rounded = Math.round(raw);
  if (rounded <= 1) return 1;
  if (rounded >= 5) return 5;
  return isPrecisionScoreValue(rounded) ? rounded : 3;
}

function clampPct(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  if (raw >= 100) return 100;
  return Math.round(raw);
}

export interface PrecisionScoreBlockProps {
  /**
   * Итоговый балл попытки, 1..5. `null` — данных нет (legacy attempt без
   * WDL/cp / `halfMovesPlayed < 2` / >50% gaps). В null-state блок
   * рендерится в нейтральной палитре с «—» и подписью «Score unavailable»,
   * чтобы у каждой попытки был визуально консистентный слот.
   *
   * Не-integer/выход за диапазон округляется и зажимается.
   */
  score: number | null;
  /**
   * Точность в процентах, 0..100. `null` если `score === null` (нет данных).
   * Не-integer/выход за диапазон округляется и зажимается.
   */
  scorePct: number | null;
}

export function PrecisionScoreBlock({
  score,
  scorePct,
}: PrecisionScoreBlockProps) {
  const { t } = useTranslation();

  // KS-3003: null-state. Backend B5 пересчитал legacy attempts с WDL/cp,
  // null остаётся только для патологических случаев — но всё равно надо
  // показать слот, чтобы не было пустого места над разбором.
  if (score === null || scorePct === null) {
    return (
      <div
        className="precision-score-block precision-score-block--unavailable"
        data-testid="precision-score-block"
        data-score=""
        data-tone="unavailable"
        data-score-pct=""
      >
        <div className="precision-score-block__row">
          <div
            className="precision-score-block__stars precision-score-block__stars--unavailable"
            role="img"
            aria-label={t(
              'precision.score.unavailable.aria',
              'Score unavailable',
            )}
            data-testid="precision-score-block-stars"
          >
            <span
              className="precision-score-block__dash"
              data-testid="precision-score-block-dash"
            >
              —
            </span>
          </div>
          <div
            className="precision-score-block__accuracy"
            data-testid="precision-score-block-accuracy"
          >
            {t('precision.score.unavailable.label', 'Score unavailable')}
          </div>
        </div>
        <p
          className="precision-score-block__interpretation"
          data-testid="precision-score-block-interpretation"
        >
          {t(
            'precision.score.unavailable.hint',
            'Not enough WDL/cp data to score this attempt.',
          )}
        </p>
      </div>
    );
  }

  const safeScore = clampScore(score);
  const safePct = clampPct(scorePct);
  const tone = TONE_BY_SCORE[safeScore];
  const interp = INTERPRETATION_BY_SCORE[safeScore];

  return (
    <div
      className={`precision-score-block precision-score-block--${tone}`}
      data-testid="precision-score-block"
      data-score={safeScore}
      data-tone={tone}
      data-score-pct={safePct}
    >
      <div className="precision-score-block__row">
        <div
          className="precision-score-block__stars"
          role="img"
          aria-label={t('precision.score.aria', '{{score}} out of 5 stars', {
            score: safeScore,
          })}
          data-testid="precision-score-block-stars"
        >
          {STAR_INDICES.map((i) => {
            const filled = i < safeScore;
            return (
              <StarIcon
                key={i}
                filled={filled}
                data-testid={
                  filled
                    ? `precision-score-block-star-filled-${i}`
                    : `precision-score-block-star-empty-${i}`
                }
              />
            );
          })}
        </div>
        <div
          className="precision-score-block__accuracy"
          data-testid="precision-score-block-accuracy"
        >
          {t('precision.score.accuracy', 'Accuracy: {{value}}%', {
            value: safePct,
          })}
        </div>
      </div>
      <p
        className="precision-score-block__interpretation"
        data-testid="precision-score-block-interpretation"
      >
        {t(interp.key, interp.fallback)}
      </p>
    </div>
  );
}

function StarIcon({
  filled,
  ...rest
}: {
  filled: boolean;
  'data-testid'?: string;
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      className={`precision-score-block__star precision-score-block__star--${filled ? 'filled' : 'empty'}`}
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
