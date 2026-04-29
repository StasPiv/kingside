import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ReviewDueItem } from '@kingside/shared';

import { resolveInlineText } from '../../utils/inlineI18nText';

/**
 * Блок «К повторению сегодня» (L-22 / KS-1799).
 *
 * Показывает уроки, у которых `dueAt <= now` по SM-2. Рендерится в
 * верхней части `LessonsPage`. Пустой список — блок скрывается. Ошибка
 * запроса (`errored`) — тоже скрываем (SM-2-сервис ещё молодой, не
 * должен ломать страницу уроков).
 *
 * Клик «Повторить» ведёт на `/lessons/:courseSlug/:lessonSlug?mode=review`
 * — `LessonPage` по этому query-флагу сбросит `stepsState` и по
 * завершении отправит `quality` на бэк (бэк пересчитывает SM-2
 * интервал).
 */

interface ReviewsDueBlockProps {
  items: ReviewDueItem[];
  errored?: boolean;
}

function formatLastReviewed(
  iso: string | null,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (!iso) return t('lessons.reviewsDue.firstReview', 'First review');
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return t('lessons.reviewsDue.firstReview', 'First review');
    }
    return d.toLocaleDateString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return t('lessons.reviewsDue.firstReview', 'First review');
  }
}

export function ReviewsDueBlock({ items, errored }: ReviewsDueBlockProps) {
  const { t, i18n } = useTranslation();

  // Ошибка запроса / пустой список — ничего не показываем (Gherkin: «блок
  // скрыт либо заглушка»). Выбрали «скрыт», чтобы не отвлекать пустым
  // блоком, пока SM-2 ничего не насчитал.
  if (errored) return null;
  if (items.length === 0) return null;

  return (
    <section
      className="reviews-due-block"
      data-testid="reviews-due-block"
      aria-label={t('lessons.reviewsDue.title', 'To review today')}
    >
      <header className="reviews-due-block__header">
        <h2 className="reviews-due-block__title">
          {t('lessons.reviewsDue.title', 'To review today')}
        </h2>
        <span
          className="reviews-due-block__count"
          data-testid="reviews-due-count"
        >
          {t('lessons.reviewsDue.count', {
            count: items.length,
            defaultValue: '{{count}} lesson',
          })}
        </span>
      </header>
      <ul className="reviews-due-block__list">
        {items.map((item) => (
          <li
            key={`${item.courseSlug}/${item.lessonSlug}`}
            className="reviews-due-block__item"
            data-testid={`reviews-due-item-${item.lessonSlug}`}
          >
            <div className="reviews-due-block__item-text">
              <div className="reviews-due-block__course">
                {/* KS-2147: inline `courseTitle` имеет приоритет над
                    i18n-ключом. Если в `translation.json` ключа нет
                    (типичный случай для системных уроков курсов
                    Capablanca / fundamentals) — раньше fallback падал
                    на slug; теперь backend (KS-2148) присылает raw
                    `Course.title` / `Lesson.title` из БД. */}
                {resolveInlineText(
                  item.courseTitle,
                  item.courseTitleI18nKey,
                  t,
                  item.courseSlug,
                )}
              </div>
              <div className="reviews-due-block__lesson">
                {resolveInlineText(
                  item.lessonTitle,
                  item.lessonTitleI18nKey,
                  t,
                  item.lessonSlug,
                )}
              </div>
              <div className="reviews-due-block__meta">
                <span data-testid={`reviews-due-lastreviewed-${item.lessonSlug}`}>
                  {t('lessons.reviewsDue.lastReviewed', {
                    date: formatLastReviewed(item.lastReviewedAt, i18n.language, t),
                    defaultValue: 'Last review: {{date}}',
                  })}
                </span>
              </div>
            </div>
            <Link
              to={`/lessons/${encodeURIComponent(item.courseSlug)}/${encodeURIComponent(
                item.lessonSlug,
              )}?mode=review`}
              className="reviews-due-block__cta"
              data-testid={`reviews-due-cta-${item.lessonSlug}`}
            >
              {t('lessons.reviewsDue.cta', 'Review')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
