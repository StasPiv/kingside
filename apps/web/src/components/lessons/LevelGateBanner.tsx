import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CourseLevel,
  LevelGateBlocker,
  LevelGateResponse,
} from '@kingside/shared';

import { lessonsApi } from '../../api/lessonsApi';

/**
 * Плашка прогресса по уровням обучения (L-15 / KS-1770 / KS-1781).
 *
 * Дёргает `GET /lessons/level-gate`. При `unlocked=true` показывает
 * «Можно перейти на <next>», иначе — список блокеров (курс / puzzle-
 * рейтинг / сыграно партий).
 *
 * Молча скрывается, если бэк ответил ошибкой / нет следующего уровня /
 * пользователь не аутентифицирован — плашка не должна ломать страницу.
 *
 * `restrictTo` ограничивает рендер по `currentLevel` (`LessonsPage`
 * показывает только для уровня `beginner`, `CoursePage` — для конкретного
 * уровня курса). Без него плашка показывается для любого `currentLevel`.
 */

interface LevelGateBannerProps {
  /** Если задан — рендер только когда `currentLevel === restrictTo`. */
  restrictTo?: CourseLevel;
  /** data-testid для отладки/тестов. По умолчанию `level-gate`. */
  testId?: string;
}

export function LevelGateBanner({
  restrictTo,
  testId = 'level-gate',
}: LevelGateBannerProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<LevelGateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    lessonsApi
      .getLevelGate()
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  if (errored || !data) return null;
  if (data.nextLevel === null) return null;
  if (restrictTo && data.currentLevel !== restrictTo) return null;

  if (data.unlocked) {
    return (
      <div
        className="level-gate level-gate--unlocked"
        data-testid={testId}
        data-state="unlocked"
      >
        <h3 className="level-gate__title">
          {t('lessons.levelGate.unlocked', {
            level: t(`lessons.level.${data.nextLevel}`),
            defaultValue: 'You can move to {{level}} level',
          })}
        </h3>
        <p className="level-gate__hint">
          {t('lessons.levelGate.unlockedHint', 'All requirements met.')}
        </p>
      </div>
    );
  }

  return (
    <div
      className="level-gate level-gate--locked"
      data-testid={testId}
      data-state="locked"
    >
      <h3 className="level-gate__title">
        {t('lessons.levelGate.locked', {
          level: t(`lessons.level.${data.nextLevel}`),
          defaultValue: 'To unlock {{level}} level:',
        })}
      </h3>
      <ul className="level-gate__blockers">
        {data.blockers.map((b, idx) => (
          <li
            key={`${b.kind}-${idx}`}
            className={`level-gate__blocker level-gate__blocker--${b.kind}`}
            data-testid={`level-gate-blocker-${b.kind}`}
          >
            {renderBlocker(b, t)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderBlocker(
  b: LevelGateBlocker,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  switch (b.kind) {
    case 'course_not_completed':
      return t('lessons.levelGate.blocker.course', {
        count: b.lessonsRemaining ?? 0,
        defaultValue: 'Lessons remaining: {{count}}',
      });
    case 'puzzle_rating':
      return t('lessons.levelGate.blocker.rating', {
        current: b.current ?? 0,
        required: b.required ?? 0,
        defaultValue: 'Puzzle rating: {{current}}/{{required}}',
      });
    case 'games_played':
      return t('lessons.levelGate.blocker.games', {
        current: b.current ?? 0,
        required: b.required ?? 0,
        defaultValue: 'Games played: {{current}}/{{required}}',
      });
    default:
      return b.kind;
  }
}
