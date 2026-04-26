import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useLessonsHeroContext } from '../../hooks/useLessonsHeroContext';
import type { ActiveCourseSummary } from '../../hooks/useLessonsHeroContext';
import { useAuth } from '../../context/AuthContext';

/**
 * `LessonsHero` — контекстный hero на `/lessons`.
 *
 * Варианты (KS-1922 → KS-1938 / KS-1931 §3.2):
 *
 * - **continue (B)** — ровно 1 активный курс. Большая карточка с
 *   обложкой/плейсхолдером, прогрессом и CTA «Продолжить» →
 *   `/lessons/<slug>` (system) или `/lessons/my/<slug>` (enrolled).
 * - **multi (C)** — ≥2 активных курса. Компактный блок «У тебя N
 *   курсов в работе» + ссылка на `/lessons/my-active` (страница
 *   появится в F-4).
 * - **author (P4)** — нет активных, но есть свои курсы. Карточка
 *   автора + CTA «Open editor».
 * - **start (A)** — нет активных и нет своих. Приветствие
 *   «С возвращением, @user» + CTA «Открыть курс для начинающих» →
 *   `/lessons/<beginnerSlug>`. Если beginner-курса нет (пустая
 *   платформа) — fallback на якорь `#level-beginner`.
 * - **guest (P3)** — `user === null`. Кнопки «Войти» / «Регистрация»
 *   и ссылка на beginner-секцию.
 * - **loading** — placeholder той же высоты что `continue`,
 *   избегаем layout shift до завершения fetch'ей.
 *
 * Cover/placeholder для variant B по концепту §4.4: при наличии
 * `coverUrl` — `<img>`, иначе плейсхолдер с эмодзи фигуры по
 * уровню (♟ beginner / ♞ intermediate / ♛ advanced) или
 * нейтральный `📘` для пользовательских (enrolled) курсов, у
 * которых уровня нет. FEN-превью текущего шага — отдельный
 * backend-эндпоинт, не в этой задаче.
 */

const PROGRESS_FALLBACK_TOTAL = 1;

const LEVEL_FIGURE: Record<string, string> = {
  beginner: '♟',
  intermediate: '♞',
  advanced: '♛',
};

function ContinueCover({ course }: { course: ActiveCourseSummary }) {
  const { t } = useTranslation();
  if (course.coverUrl) {
    return (
      <div
        className="lessons-hero__cover"
        data-testid="lessons-hero-cover"
        data-source={course.source}
      >
        <img
          src={course.coverUrl}
          alt={t('lessons.hero.continue.coverAlt', 'Course cover')}
          loading="lazy"
        />
      </div>
    );
  }
  // Fallback по концепту §4.4: эмодзи фигуры по уровню для system,
  // 📘 для enrolled (без уровня).
  const figure =
    course.level && LEVEL_FIGURE[course.level]
      ? LEVEL_FIGURE[course.level]
      : '📘';
  return (
    <div
      className="lessons-hero__cover lessons-hero__cover--placeholder"
      data-testid="lessons-hero-cover"
      data-source={course.source}
      data-level={course.level ?? 'none'}
      aria-hidden="true"
    >
      <span className="lessons-hero__cover-figure">{figure}</span>
    </div>
  );
}

export function LessonsHero() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { state } = useLessonsHeroContext();

  if (state.kind === 'loading') {
    return (
      <section
        className="lessons-hero lessons-hero--loading"
        data-testid="lessons-hero"
        data-state="loading"
        aria-busy="true"
      >
        <div className="lessons-hero__skeleton-block" />
        <div className="lessons-hero__skeleton-line" />
        <div className="lessons-hero__skeleton-line lessons-hero__skeleton-line--short" />
        <div className="lessons-hero__skeleton-cta" />
      </section>
    );
  }

  if (state.kind === 'continue') {
    const c = state.course;
    const total = c.lessonCount || PROGRESS_FALLBACK_TOTAL;
    const done = c.completedLessons;
    const percent = Math.min(100, Math.round((done / total) * 100));
    const title = c.titleI18nKey
      ? t(c.titleI18nKey, c.slug)
      : c.title || c.slug;
    return (
      <section
        className="lessons-hero lessons-hero--continue"
        data-testid="lessons-hero"
        data-state="continue"
        data-source={c.source}
      >
        <ContinueCover course={c} />
        <div className="lessons-hero__body">
          <div className="lessons-hero__eyebrow">
            {t('lessons.hero.continue.eyebrow', 'Continue learning')}
          </div>
          <h2 className="lessons-hero__title">{title}</h2>
          <div
            className="lessons-hero__progress"
            data-testid="lessons-hero-progress"
            aria-label={t('lessons.hero.continue.progressLabel', 'Progress')}
          >
            <div
              className="lessons-hero__progress-bar"
              style={{ width: `${percent}%` }}
            />
            <span className="lessons-hero__progress-text">
              {t('lessons.my.progress', {
                done,
                count: total,
                defaultValue: 'Completed {{done}}/{{count}} lessons',
              })}
            </span>
          </div>
          <Link
            to={c.href}
            className="lessons-hero__cta"
            data-testid="lessons-hero-cta"
          >
            {t('lessons.hero.continue.cta', 'Resume course')}
          </Link>
        </div>
      </section>
    );
  }

  if (state.kind === 'multi') {
    return (
      <section
        className="lessons-hero lessons-hero--multi"
        data-testid="lessons-hero"
        data-state="multi"
      >
        <div className="lessons-hero__eyebrow">
          {t('lessons.hero.multi.eyebrow', 'Continue learning')}
        </div>
        <h2 className="lessons-hero__title" data-testid="lessons-hero-multi-title">
          {t('lessons.hero.multi.title', {
            count: state.count,
            defaultValue: 'You have {{count}} courses in progress',
          })}
        </h2>
        <Link
          to="/lessons/my-active"
          className="lessons-hero__cta"
          data-testid="lessons-hero-cta"
        >
          {t('lessons.hero.multi.cta', 'View my active courses')}
        </Link>
      </section>
    );
  }

  if (state.kind === 'author') {
    const latest = state.latestCourse;
    return (
      <section
        className="lessons-hero lessons-hero--author"
        data-testid="lessons-hero"
        data-state="author"
      >
        <div className="lessons-hero__eyebrow">
          {t('lessons.hero.author.eyebrow', 'Your courses')}
        </div>
        <h2 className="lessons-hero__title">
          {t('lessons.hero.author.title', {
            count: state.ownedCount,
            defaultValue: '{{count}} courses',
          })}
        </h2>
        <p className="lessons-hero__subtitle">
          {t('lessons.hero.author.subtitle', {
            publicCount: state.publicCount,
            privateCount: state.privateCount,
            defaultValue: '{{publicCount}} public · {{privateCount}} private',
          })}
        </p>
        {latest ? (
          <Link
            to={`/lessons/my/${latest.slug}/edit`}
            className="lessons-hero__cta"
            data-testid="lessons-hero-cta"
          >
            {t('lessons.hero.author.cta', 'Open editor')}
          </Link>
        ) : (
          <Link
            to="/lessons"
            className="lessons-hero__cta"
            data-testid="lessons-hero-cta"
          >
            {t('lessons.hero.author.create', '+ Create new course')}
          </Link>
        )}
      </section>
    );
  }

  if (state.kind === 'start') {
    // CTA «Открыть курс для начинающих» → конкретный slug первого
    // beginner-курса. Если на платформе нет beginner-курса (пустая
    // CMS / fetch упал) — fallback на якорь `#level-beginner`,
    // страница сама проскроллит к секции.
    const beginnerSubtitle = state.beginnerTitleI18nKey
      ? t(state.beginnerTitleI18nKey, state.beginnerTitleI18nKey)
      : null;
    return (
      <section
        className="lessons-hero lessons-hero--start"
        data-testid="lessons-hero"
        data-state="start"
      >
        <div className="lessons-hero__eyebrow">
          {t('lessons.hero.start.eyebrow', 'Welcome back')}
          {user && `, ${user.username}`}
        </div>
        <h2 className="lessons-hero__title">
          {t('lessons.hero.start.title', 'Start with the Beginner course')}
        </h2>
        <p className="lessons-hero__subtitle">
          {beginnerSubtitle ??
            t(
              'lessons.hero.start.subtitle',
              'A structured path through chess fundamentals.',
            )}
        </p>
        {state.beginnerSlug ? (
          <Link
            to={`/lessons/${state.beginnerSlug}`}
            className="lessons-hero__cta"
            data-testid="lessons-hero-cta"
          >
            {t('lessons.hero.start.cta', 'Open Beginner course')}
          </Link>
        ) : (
          <a
            href="#level-beginner"
            className="lessons-hero__cta"
            data-testid="lessons-hero-cta"
          >
            {t('lessons.hero.start.cta', 'Open Beginner course')}
          </a>
        )}
      </section>
    );
  }

  // state.kind === 'guest'
  return (
    <section
      className="lessons-hero lessons-hero--guest"
      data-testid="lessons-hero"
      data-state="guest"
    >
      <div className="lessons-hero__eyebrow">
        {t('lessons.hero.guest.eyebrow', 'Lessons')}
      </div>
      <h2 className="lessons-hero__title">
        {t(
          'lessons.hero.guest.title',
          'Learn chess with structured courses and community puzzles',
        )}
      </h2>
      <p className="lessons-hero__subtitle">
        {t(
          'lessons.hero.guest.subtitle',
          'Sign in to track your progress, save courses, and continue where you left off.',
        )}
      </p>
      <div className="lessons-hero__cta-row">
        <Link
          to="/login"
          className="lessons-hero__cta"
          data-testid="lessons-hero-cta"
        >
          {t('lessons.hero.guest.signIn', 'Sign in')}
        </Link>
        <Link
          to="/register"
          className="lessons-hero__cta lessons-hero__cta--secondary"
          data-testid="lessons-hero-cta-secondary"
        >
          {t('lessons.hero.guest.register', 'Create account')}
        </Link>
        <a
          href="#level-beginner"
          className="lessons-hero__link"
          data-testid="lessons-hero-browse"
        >
          {t('lessons.hero.guest.browse', 'Browse Beginner →')}
        </a>
      </div>
    </section>
  );
}
