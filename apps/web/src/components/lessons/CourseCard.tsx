import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CourseLevel } from '@kingside/shared';

/**
 * `CourseCard` — M-размер карточки курса (KS-1942 / KS-1931 §4 §7.2).
 *
 * Главная единица рендеринга курсов в новом каталоге: каталог
 * системных курсов, блок «Рекомендуем», `/lessons/my-active`. Все
 * три места используют один и тот же компонент.
 *
 * Структура (сверху вниз, §7.2):
 *  1. Обложка 4:3 — `coverUrl` или плейсхолдер с фигурой по уровню
 *     (♟ beginner / ♞ intermediate / ♛ advanced) или нейтральный 📘
 *     для пользовательских курсов без уровня.
 *  2. Бейджи: уровень · difficulty (★★☆) · длительность (~2ч).
 *     Каждый бейдж скрывается, если соответствующее поле null.
 *  3. Заголовок — max 2 строки (обрезка `…` через CSS `line-clamp`).
 *  4. Audience — одна строка «для кого». Скрыта при пустом значении.
 *  5. Прогресс-бар — рендерится если `progress != null`. Иначе блок
 *     не занимает места.
 *  6. CTA — три варианта: `continue` / `start` / `preview`.
 *  7. Теги (`#эндшпиль`) — внизу, если переданы.
 *
 * # Контракт props
 *
 * Title и audience приходят УЖЕ резолвенными (родитель сам решает,
 * через `t(i18nKey)` или просто строка из DTO пользовательского
 * курса). Это позволяет реюзать карточку для system-курсов
 * (i18n-ключи) и для `UserCourseDto`/`UserEnrolledCourseDto` (просто
 * строки). Вычисление `href` тоже на родителе — `system` ведёт на
 * `/lessons/<slug>`, enrolled на `/lessons/my/<slug>`.
 *
 * Тексты CTA / длительности / прогресса локализуются ВНУТРИ
 * компонента — это общие строки, которым место в одном месте.
 *
 * # Fallback'ы (§4.4)
 *
 * - `coverUrl == null` → placeholder с фигурой по уровню.
 * - `level == null` → бейдж уровня скрыт, плейсхолдер обложки 📘.
 * - `difficulty == null` → бейдж скрыт.
 * - `estimatedMinutes == null` → бейдж длительности скрыт.
 * - `audience == null` → строка не рендерится.
 * - `tags == null || tags.length === 0` → блок тегов отсутствует.
 * - `progress == null` → прогресс-бар не рендерится.
 *
 * # Acceptance KS-1942
 *
 * - Рендерится с полными данными (full-data сценарий).
 * - Рендерится с минимальным набором (только slug + href + title +
 *   ctaVariant) — старые курсы без обогащения визуально проще, но
 *   без падений.
 * - Все три варианта CTA локализованы и видимы.
 */

export type CourseCardCtaVariant = 'continue' | 'start' | 'preview';

export interface CourseCardProgress {
  done: number;
  total: number;
}

export interface CourseCardProps {
  /** Тестовый id, по умолчанию `course-card-<slug>`. */
  testId?: string;
  /** Slug курса — для `data-slug` и тестового id. */
  slug: string;
  /** Куда вести вся карточка-link. Родитель сам решает namespace. */
  href: string;
  /** Резолвенный заголовок. */
  title: string;
  /** Уровень курса. `null` для пользовательских — бейдж скрыт. */
  level?: CourseLevel | null;
  /** 1=easy, 2=medium, 3=hard. `null` — бейдж скрыт. */
  difficulty?: 1 | 2 | 3 | null;
  /** Оценка времени на курс (минут). `null` — бейдж скрыт. */
  estimatedMinutes?: number | null;
  /** Path обложки. `null` — рендерится placeholder. */
  coverUrl?: string | null;
  /** Резолвенная строка «для кого». `null` — строка скрыта. */
  audience?: string | null;
  /** Прогресс — если есть, рендерится бар. */
  progress?: CourseCardProgress | null;
  /** Какой CTA показать (определяется родителем). */
  ctaVariant: CourseCardCtaVariant;
  /** Произвольные теги — рендерятся как `#{tag}` снизу. */
  tags?: string[] | null;
}

const LEVEL_FIGURE: Record<CourseLevel, string> = {
  beginner: '♟',
  intermediate: '♞',
  advanced: '♛',
};

function CourseCardCover({
  coverUrl,
  level,
  alt,
}: {
  coverUrl: string | null | undefined;
  level: CourseLevel | null | undefined;
  alt: string;
}) {
  if (coverUrl) {
    return (
      <div
        className="course-card__cover"
        data-testid="course-card-cover"
        data-source="image"
      >
        <img src={coverUrl} alt={alt} loading="lazy" />
      </div>
    );
  }
  // Fallback по концепту §4.4.
  const figure = level ? LEVEL_FIGURE[level] : '📘';
  return (
    <div
      className="course-card__cover course-card__cover--placeholder"
      data-testid="course-card-cover"
      data-source="placeholder"
      data-level={level ?? 'none'}
      aria-hidden="true"
    >
      <span className="course-card__cover-figure">{figure}</span>
    </div>
  );
}

/**
 * Рендер три-звёзд для difficulty: ★★☆ для difficulty=2.
 * Разделяем на отдельные элементы для CSS-стилизации (полные/пустые
 * звёзды могут быть разных цветов).
 */
function DifficultyStars({ difficulty }: { difficulty: 1 | 2 | 3 }) {
  return (
    <span
      className="course-card__badge-stars"
      data-testid="course-card-difficulty"
      data-difficulty={difficulty}
      aria-label={`difficulty ${difficulty} of 3`}
    >
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={
            i <= difficulty
              ? 'course-card__star course-card__star--filled'
              : 'course-card__star course-card__star--empty'
          }
        >
          {i <= difficulty ? '★' : '☆'}
        </span>
      ))}
    </span>
  );
}

/**
 * Форматирование оценки длительности. До 60 минут — «~Nм», иначе
 * «~Nч» с округлением до целого числа часов (граница округления —
 * стандартное `Math.round`). Для пограничных случаев (например 75
 * минут) ровно «~1ч»: для лёгкой подачи в карточке точность не
 * нужна.
 */
function formatEstimated(
  estimatedMinutes: number,
  t: (key: string, opts: Record<string, unknown> & { defaultValue: string }) => string,
): string {
  if (estimatedMinutes < 60) {
    return t('lessons.card.duration.minutes', {
      count: estimatedMinutes,
      defaultValue: '~{{count}}m',
    });
  }
  const hours = Math.round(estimatedMinutes / 60);
  return t('lessons.card.duration.hours', {
    count: hours,
    defaultValue: '~{{count}}h',
  });
}

const CTA_KEY: Record<CourseCardCtaVariant, { key: string; defaultValue: string }> = {
  continue: { key: 'lessons.card.cta.continue', defaultValue: 'Continue' },
  start: { key: 'lessons.card.cta.start', defaultValue: 'Start' },
  preview: { key: 'lessons.card.cta.preview', defaultValue: 'Preview' },
};

export function CourseCard({
  testId,
  slug,
  href,
  title,
  level,
  difficulty,
  estimatedMinutes,
  coverUrl,
  audience,
  progress,
  ctaVariant,
  tags,
}: CourseCardProps) {
  const { t } = useTranslation();
  const resolvedTestId = testId ?? `course-card-${slug}`;

  const ctaCopy = CTA_KEY[ctaVariant];
  const ctaText = t(ctaCopy.key, { defaultValue: ctaCopy.defaultValue });

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;

  const visibleTags = (tags ?? []).filter((tg) => tg && tg.trim().length > 0);

  return (
    <article
      className="course-card"
      data-testid={resolvedTestId}
      data-slug={slug}
      data-level={level ?? 'none'}
      data-cta={ctaVariant}
    >
      <Link
        to={href}
        className="course-card__link"
        data-testid={`${resolvedTestId}-link`}
      >
        <CourseCardCover
          coverUrl={coverUrl}
          level={level}
          alt={t('lessons.card.coverAlt', {
            title,
            defaultValue: '{{title}} cover',
          })}
        />
        <div className="course-card__body">
          <div className="course-card__badges" data-testid="course-card-badges">
            {level && (
              <span
                className={`course-card__badge course-card__badge--level course-card__badge--level-${level}`}
                data-testid="course-card-badge-level"
              >
                {t(`lessons.level.${level}`)}
              </span>
            )}
            {typeof difficulty === 'number' && difficulty >= 1 && difficulty <= 3 && (
              <DifficultyStars difficulty={difficulty as 1 | 2 | 3} />
            )}
            {typeof estimatedMinutes === 'number' && estimatedMinutes > 0 && (
              <span
                className="course-card__badge course-card__badge--duration"
                data-testid="course-card-badge-duration"
              >
                {formatEstimated(estimatedMinutes, t)}
              </span>
            )}
          </div>
          <h3 className="course-card__title" data-testid="course-card-title">
            {title}
          </h3>
          {audience && (
            <p
              className="course-card__audience"
              data-testid="course-card-audience"
            >
              {audience}
            </p>
          )}
          {progress && progress.total > 0 ? (
            <div
              className="course-card__progress"
              data-testid="course-card-progress"
              aria-label={t('lessons.card.progressLabel', 'Course progress')}
            >
              <div className="course-card__progress-track">
                <div
                  className="course-card__progress-fill"
                  data-testid="course-card-progress-fill"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="course-card__progress-text">
                {t('lessons.card.progress', {
                  done: progress.done,
                  total: progress.total,
                  defaultValue: '{{done}}/{{total}}',
                })}
              </span>
            </div>
          ) : null}
          <span
            className="course-card__cta"
            data-testid="course-card-cta"
            data-variant={ctaVariant}
          >
            {ctaText}
          </span>
          {visibleTags.length > 0 && (
            <ul className="course-card__tags" data-testid="course-card-tags">
              {visibleTags.map((tg) => (
                <li key={tg} className="course-card__tag">
                  #{tg}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Link>
    </article>
  );
}
