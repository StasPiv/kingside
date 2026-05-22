import { useTranslation } from 'react-i18next';
import {
  computeVerdictKey,
  type PrecisionVerdictKey,
} from '@kingside/shared';
import type { PuzzleObjective } from '@kingside/shared';

/**
 * KS-3002 (ADR-065 §5.1.1, Этап 3 F1) — итоговый блок 5-балльной оценки
 * precision-попытки.
 *
 * KS-3248 (ADR-076 §7 F3): текст плашки теперь рисуется по матрице 5×2
 * (звёзды × objectiveAchieved) через `verdictKey` от backend
 * (PrecisionAttemptListItem / Detail). Если `verdictKey` не передан, но
 * есть `objectiveAchieved` — вычисляем через `computeVerdictKey` shared-
 * helper'а (PlayVsEngineRunner так делает локально до отправки попытки
 * на backend). Если ни того, ни другого — старый универсальный INTERP_KEY
 * (legacy attempt'ы / null-state).
 *
 * Опц. подзаголовок (по `objective` + `objectiveAchieved`):
 *  - convertAdvantage achieved → «Перевес реализован»
 *  - convertAdvantage missed   → «Перевес упущен»
 *  - saveEquality achieved     → «Равенство удержано»
 *  - saveEquality missed       → «Равенство не удержано»
 *
 * Состав по §5.1.1:
 *  - 5 SVG-звёзд, заполненных по `score`;
 *  - accuracy в процентах (`scorePct`);
 *  - текст по verdictKey (или старый interp при отсутствии данных);
 *  - опц. подзаголовок об objective.
 *
 * Цвета (ADR-065 §4.2):
 *  5★ → emerald, 4★ → lime, 3★ → amber, 2★ → orange, 1★ → red.
 *
 * Тон применяется CSS-классом `--emerald|lime|amber|orange|red` — фактические
 * hex (`#10b981`, `#84cc16`, …) определены в `puzzle.css`, чтобы можно было
 * подкорректировать палитру централизованно, не трогая JSX.
 *
 * i18n: KS-3006 (F5) — все строки приходят из `precision.score.*` в
 * `apps/web/src/i18n/locales/{en,ru}/translation.json`. EN-fallback'и
 * удалены, в коде нет literal-строк.
 */

export type PrecisionScoreValue = 1 | 2 | 3 | 4 | 5;

const TONE_BY_SCORE: Record<PrecisionScoreValue, string> = {
  5: 'emerald',
  4: 'lime',
  3: 'amber',
  2: 'orange',
  1: 'red',
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

/** KS-3006: тип-safe ключ для `t()` без literal-string в JSX. */
const STARS_KEY: Record<PrecisionScoreValue, string> = {
  1: 'precision.score.stars.1',
  2: 'precision.score.stars.2',
  3: 'precision.score.stars.3',
  4: 'precision.score.stars.4',
  5: 'precision.score.stars.5',
};
/**
 * KS-3166 (ADR-070 UI): единый универсальный набор формулировок без
 * привязки к жанру (convertAdvantage / saveEquality). До этого тикета
 * был отдельный `INTERP_KEY_SAVE` (KS-3165) для saveEquality. По
 * запросу пользователя — нейтральный текст «оценка позиции» / «решено»
 * подходит обоим жанрам и не путает.
 *
 * KS-3248: эти ключи используются ТОЛЬКО как fallback когда нет
 * verdictKey и objectiveAchieved (legacy-attempt'ы до KS-3246/3247).
 * Основной путь — `VERDICT_KEY_TO_I18N` ниже.
 */
const INTERP_KEY: Record<PrecisionScoreValue, string> = {
  1: 'precision.score.interpretation.1',
  2: 'precision.score.interpretation.2',
  3: 'precision.score.interpretation.3',
  4: 'precision.score.interpretation.4',
  5: 'precision.score.interpretation.5',
};

/**
 * KS-3248 (ADR-076 §7 F3): сопоставление 9 verdict-keys → i18n.
 * Матрица 5×2 от chess-expert (см. computeVerdictKey в shared
 * `precision-score.ts`).
 */
const VERDICT_KEY_TO_I18N: Record<PrecisionVerdictKey, string> = {
  flawless: 'precision.score.verdict.flawless',
  confident: 'precision.score.verdict.confident',
  suboptimal: 'precision.score.verdict.suboptimal',
  'with-mistakes': 'precision.score.verdict.with-mistakes',
  'with-blunders': 'precision.score.verdict.with-blunders',
  'goal-missed-clean': 'precision.score.verdict.goal-missed-clean',
  'goal-missed': 'precision.score.verdict.goal-missed',
  'goal-missed-mistakes': 'precision.score.verdict.goal-missed-mistakes',
  'goal-missed-blunders': 'precision.score.verdict.goal-missed-blunders',
};

/**
 * KS-3248: i18n-ключ подзаголовка плашки по objective + objectiveAchieved.
 * `null` для legacy / случаев без данных — подзаголовок не рисуется.
 */
function subtitleKey(
  objective: PuzzleObjective | null | undefined,
  achieved: boolean | null | undefined,
): string | null {
  if (objective === undefined || objective === null) return null;
  if (achieved === undefined || achieved === null) return null;
  if (objective === 'convertAdvantage') {
    return achieved
      ? 'precision.score.subtitle.convertAdvantage-achieved'
      : 'precision.score.subtitle.convertAdvantage-missed';
  }
  if (objective === 'saveEquality') {
    return achieved
      ? 'precision.score.subtitle.saveEquality-achieved'
      : 'precision.score.subtitle.saveEquality-missed';
  }
  return null;
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
  /**
   * KS-3248: backend (KS-3246/3247) отдаёт явный verdict-key. Если
   * передан — текст плашки берётся напрямую из `VERDICT_KEY_TO_I18N`,
   * `objectiveAchieved` используется только для подзаголовка.
   */
  verdictKey?: PrecisionVerdictKey | null;
  /**
   * KS-3248: достигнута ли цель пазла. Если `verdictKey` не передан,
   * но `objectiveAchieved !== null/undefined` — вычисляем verdictKey
   * через shared `computeVerdictKey(score, objectiveAchieved)`. Это
   * нужно `PlayVsEngineRunner` для финального экрана сразу после
   * последнего хода (backend ещё не вернул attempt-detail).
   */
  objectiveAchieved?: boolean | null;
  /**
   * KS-3248: жанр пазла. Используется для подзаголовка («Перевес
   * реализован» / «Равенство удержано» и т.п.). Если не передан —
   * подзаголовок не рисуется.
   */
  objective?: PuzzleObjective | null;
}

export function PrecisionScoreBlock({
  score,
  scorePct,
  verdictKey,
  objectiveAchieved,
  objective,
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
            aria-label={t('precision.score.legacyMissing')}
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
            {t('precision.score.legacyMissing')}
          </div>
        </div>
        <p
          className="precision-score-block__interpretation"
          data-testid="precision-score-block-interpretation"
        >
          {t('precision.score.legacyMissingHint')}
        </p>
      </div>
    );
  }

  const safeScore = clampScore(score);
  const safePct = clampPct(scorePct);
  const tone = TONE_BY_SCORE[safeScore];

  // KS-3248: 1) если backend прислал verdictKey — берём текст напрямую.
  // 2) иначе вычисляем через shared `computeVerdictKey(score, achieved)`
  //    (PlayVsEngineRunner — сразу после последнего хода).
  // 3) иначе fallback на старый универсальный INTERP_KEY (legacy attempts
  //    без objectiveAchieved).
  const effectiveVerdictKey: PrecisionVerdictKey | null =
    verdictKey ??
    (objectiveAchieved !== undefined && objectiveAchieved !== null
      ? computeVerdictKey(safeScore, objectiveAchieved)
      : null);
  const verdictI18nKey = effectiveVerdictKey
    ? VERDICT_KEY_TO_I18N[effectiveVerdictKey]
    : INTERP_KEY[safeScore];
  const subtitleI18nKey = subtitleKey(objective, objectiveAchieved);

  return (
    <div
      className={`precision-score-block precision-score-block--${tone}`}
      data-testid="precision-score-block"
      data-score={safeScore}
      data-tone={tone}
      data-score-pct={safePct}
      data-verdict-key={effectiveVerdictKey ?? ''}
      data-objective-achieved={
        objectiveAchieved === undefined || objectiveAchieved === null
          ? ''
          : objectiveAchieved
            ? 'true'
            : 'false'
      }
    >
      <div className="precision-score-block__row">
        <div
          className="precision-score-block__stars"
          role="img"
          aria-label={t(STARS_KEY[safeScore])}
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
          {t('precision.score.accuracy', { value: safePct })}
        </div>
      </div>
      <p
        className="precision-score-block__interpretation"
        data-testid="precision-score-block-interpretation"
      >
        {t(verdictI18nKey)}
      </p>
      {subtitleI18nKey && (
        <p
          className="precision-score-block__subtitle"
          data-testid="precision-score-block-subtitle"
        >
          {t(subtitleI18nKey)}
        </p>
      )}
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
