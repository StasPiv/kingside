import { useState } from 'react';
import type { ReviewDueItem } from '@kingside/shared';

import { ReviewsDueBlock } from '../components/lessons/ReviewsDueBlock';
// KS-1928 / ADR-032: MistakesDiaryBlock переехал в /puzzles namespace и
// стал self-fetching — больше не подходит для dev-mock'ов в этой
// песочнице. Скриншоты «Слабые темы» теперь снимаются с /puzzles/stats
// и /puzzle на живых данных.

/**
 * Dev-песочница для визуальной проверки UI повторений (KS-1799, L-22).
 *
 * На реальном API для снятия скриншотов нужны реальные
 * `UserLessonProgress.masteredAt` и записи `LessonReview` с
 * `dueAt <= now`. В БД их пока нет. Эта страница рендерит `ReviewsDueBlock`
 * на mock-данных, чтобы можно было снять скриншот блока «К повторению
 * сегодня» для подтверждения UI и адаптива.
 */

const NOW = new Date();
const DAY_AGO = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
const WEEK_AGO = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

const ITEMS: ReviewDueItem[] = [
  {
    courseSlug: 'beginner',
    courseTitleI18nKey: 'lessons.dev.beginnerCourseTitle',
    lessonSlug: 'pieces',
    lessonTitleI18nKey: 'lessons.dev.piecesTitle',
    dueAt: DAY_AGO,
    lastReviewedAt: WEEK_AGO,
    intervalDays: 7,
  },
  {
    courseSlug: 'beginner',
    courseTitleI18nKey: 'lessons.dev.beginnerCourseTitle',
    lessonSlug: 'basic-mates',
    lessonTitleI18nKey: 'lessons.dev.basicMatesTitle',
    dueAt: DAY_AGO,
    lastReviewedAt: null,
    intervalDays: 1,
  },
  {
    courseSlug: 'intermediate',
    courseTitleI18nKey: 'lessons.dev.intermediateCourseTitle',
    lessonSlug: 'tactics-forks',
    lessonTitleI18nKey: 'lessons.dev.tacticsForksTitle',
    dueAt: DAY_AGO,
    lastReviewedAt: WEEK_AGO,
    intervalDays: 14,
  },
];

export function DevReviewsUiPage() {
  const [showEmpty, setShowEmpty] = useState(false);

  return (
    <div className="dev-reviews-ui-page" style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Reviews UI — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1799 (L-22). Mock для скриншотов блока «К повторению сегодня».
        На реальном API данных пока нет.
      </p>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-testid="dev-reviews-toggle"
          onClick={() => setShowEmpty((v) => !v)}
          style={{ padding: '6px 10px' }}
        >
          {showEmpty ? 'Показать списки' : 'Показать пустые (оба блока скрыты)'}
        </button>
      </div>

      <ReviewsDueBlock items={showEmpty ? [] : ITEMS} />

      {showEmpty && (
        <p
          style={{
            color: '#999',
            fontStyle: 'italic',
            padding: '10px',
            border: '1px dashed #ccc',
            borderRadius: '8px',
          }}
        >
          (оба блока скрыты — в списках 0 элементов)
        </p>
      )}
    </div>
  );
}
