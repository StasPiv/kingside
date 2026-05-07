import { useTranslation } from 'react-i18next';
import { classifyMove, type MoveClass } from '../../utils/moveClassification';
import { uciToSan, type UserBestSnapshot } from './PlayVsEngineRunner';

/**
 * KS-2508 / ADR-047 §2.2 + §3 #5.
 *
 * Список user-ходов с метками классификации после завершения play-vs-engine
 * пазла. Метки берутся через `classifyMove` (KS-2504) на основе
 * cpBefore/cpAfter (KS-2505/KS-2506) и флага `isBest = playedUci === bestUci`.
 *
 * Если у snapshot'а cpBefore или cpAfter `null` (race-условие при pre/post
 * analyze, см. ADR-047 §4(i)) — графейфолим в `'good'`. Runner делает
 * fallback-analyze по завершении партии и дописывает cpAfter, поэтому
 * к моменту рендера PostGameReview обычно все поля уже на месте.
 *
 * Pure-компонент: не делает запросов и не дёргает движок. Тестируется
 * на разных классификациях напрямую.
 *
 * i18n RU/EN — минимальные ключи; полировка строк в KS-2511.
 */

export interface PostGameReviewProps {
  userBestLog: UserBestSnapshot[];
  /**
   * KS-2510 / ADR-047 §3 #7. Клик по строке передаёт родителю snapshot
   * выбранного хода — родитель показывает `fenBefore` на доске. Не
   * передан → строки не кликабельны (рендерятся как `<div>`, без button-
   * семантики), что важно для тестов KS-2508, где callback не нужен.
   */
  onSelectMove?: (snapshot: UserBestSnapshot) => void;
}

export function PostGameReview({
  userBestLog,
  onSelectMove,
}: PostGameReviewProps) {
  const { t } = useTranslation();
  if (!userBestLog.length) return null;

  return (
    <div className="post-game-review" data-testid="post-game-review">
      <h3 className="post-game-review__title">
        {t('puzzle.engine.review.title', 'Review')}
      </h3>
      <ol className="post-game-review__list">
        {userBestLog.map((s) => {
          const playedSan = uciToSan(s.playedUci, s.fenBefore);
          const bestSan = uciToSan(s.bestUci, s.fenBefore);
          const isBest = s.playedUci === s.bestUci;
          // Если cp-данных нет (pre-analyze не успел и fallback тоже
          // не помог) — мягко падаем в 'good': вреда от этого нет, но
          // помечать ход как blunder без данных нечестно.
          const cls: MoveClass =
            s.cpBefore == null || s.cpAfter == null
              ? isBest
                ? 'best'
                : 'good'
              : classifyMove({
                  cpBefore: s.cpBefore,
                  cpAfter: s.cpAfter,
                  isBest,
                });
          // «Best was» показываем только когда юзер реально сыграл хуже,
          // т.е. при inaccuracy/mistake/blunder. На best/good — не
          // зашумляем (хороший/идеальный ход и без подсказки понятен).
          const showBest = cls !== 'best' && cls !== 'good';
          // KS-2510: если родитель передал onSelectMove, рендерим строку
          // как button — для клавиатурной/screen-reader доступности и
          // нативного hover/active-стиля; иначе оставляем div (KS-2508
          // unit-тесты этого ожидают).
          const inner = (
            <>
              <span className="post-game-review__half">{s.halfMove}.</span>
              <span className="post-game-review__san">{playedSan}</span>
              <span
                className="post-game-review__class"
                data-testid={`post-game-review-class-${s.halfMove}`}
              >
                {t(`puzzle.engine.review.class.${cls}`, cls)}
              </span>
              {showBest && (
                <div
                  className="post-game-review__best"
                  data-testid={`post-game-review-best-${s.halfMove}`}
                >
                  {t('puzzle.engine.review.bestWas', 'Best was: {{san}}', {
                    san: bestSan,
                  })}
                </div>
              )}
            </>
          );
          return (
            <li
              key={s.halfMove}
              className={`post-game-review__row post-game-review__row--${cls}${onSelectMove ? ' post-game-review__row--clickable' : ''}`}
              data-testid={`post-game-review-row-${s.halfMove}`}
              data-half={s.halfMove}
              data-class={cls}
            >
              {onSelectMove ? (
                <button
                  type="button"
                  className="post-game-review__row-btn"
                  data-testid={`post-game-review-select-${s.halfMove}`}
                  onClick={() => onSelectMove(s)}
                >
                  {inner}
                </button>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
