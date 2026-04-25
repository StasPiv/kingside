import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useLessonsHeroContext } from '../../hooks/useLessonsHeroContext';
import { useAuth } from '../../context/AuthContext';

/**
 * `LessonsHero` — контекстный hero на `/lessons` (KS-1922,
 * ADR-031 §4.1). Один из 5 вариантов в зависимости от
 * `useLessonsHeroContext().state`:
 *
 * - **continue (P1)** — Large card с названием курса, прогрессом
 *   и CTA «Продолжить» → `/lessons/my/<slug>`.
 * - **author (P4)** — карточка автора: «N курсов / K публичных»,
 *   CTA «Открыть редактор» (последний обновлённый курс) или
 *   «+ Создать новый» если последний обновлён > 7д назад.
 * - **start (P2)** — приветствие + CTA «Курс для начинающих» →
 *   системный курс /lessons/courses/(beginner-slug). Slug первого
 *   beginner-курса не пробрасывается через хук — линкуемся на
 *   общий якорь беginner-секции на /lessons (#level-beginner) и
 *   страница сама проскроллит.
 * - **guest (P3)** — заголовок + краткое описание + кнопки
 *   «Войти» / «Зарегистрироваться».
 * - **loading** — placeholder того же размера что `continue`,
 *   избегаем layout shift до завершения fetch'ей.
 *
 * # Почему не делим на 5 разных компонентов
 *
 * Один компонент с условным рендером проще проследить (всё
 * содержательное в одном файле) и удобнее для skeleton-варианта
 * (loading и continue имеют одинаковый footprint). Если в KS-1925
 * стилистика разъедется на сильно разные shape'ы — выделим.
 */

const PROGRESS_FALLBACK_TOTAL = 1;

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
    const done = c.progress?.completedLessonsCount ?? 0;
    const percent = Math.min(100, Math.round((done / total) * 100));
    return (
      <section
        className="lessons-hero lessons-hero--continue"
        data-testid="lessons-hero"
        data-state="continue"
      >
        <div className="lessons-hero__eyebrow">
          {t('lessons.hero.continue.eyebrow', 'Continue learning')}
        </div>
        <h2 className="lessons-hero__title">{c.title}</h2>
        {c.description && (
          <p className="lessons-hero__subtitle">{c.description}</p>
        )}
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
          to={`/lessons/my/${c.slug}`}
          className="lessons-hero__cta"
          data-testid="lessons-hero-cta"
        >
          {t('lessons.hero.continue.cta', 'Resume course')}
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
          {t(
            'lessons.hero.start.subtitle',
            'A structured path through chess fundamentals.',
          )}
        </p>
        <a
          href="#level-beginner"
          className="lessons-hero__cta"
          data-testid="lessons-hero-cta"
        >
          {t('lessons.hero.start.cta', 'Browse Beginner curriculum')}
        </a>
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
