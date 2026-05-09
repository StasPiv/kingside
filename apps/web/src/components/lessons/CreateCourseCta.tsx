import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { lessonsApi } from '../../api/lessonsApi';
import { useAuth } from '../../context/AuthContext';

/**
 * `CreateCourseCta` — одна строка CTA «+ Создать свой курс»
 * (KS-1940 / KS-1931 §3 §11.2).
 *
 * После KS-1940 (F-3) `MyCoursesBlock` ушёл с главной /lessons —
 * вместо него остаётся только эта компактная CTA. Логика создания
 * (`userCoursesApi.create` → редирект на `/lessons/my/<slug>/edit`)
 * перенесена сюда из `MyCoursesBlock.handleCreate` без изменений.
 *
 * Гостям компонент не рендерится — анонимам создавать нечего.
 *
 * # Расположение
 * Над секцией «Сообщество» (`CommunityStripBlock`), как просил
 * концепт §3.
 */
export function CreateCourseCta() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const handleClick = async () => {
    setError(null);
    setCreating(true);
    try {
      const created = await lessonsApi.createCourse({
        title: t('lessons.my.editor.defaultCourseTitle', 'New course'),
      });
      navigate(`/lessons/my/${created.slug}/edit`);
    } catch {
      setError(
        t('lessons.my.createModal.error', 'Failed to create the course'),
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <section
      className="create-course-cta"
      data-testid="create-course-cta"
      aria-label={t('lessons.my.create', '+ Create my course')}
    >
      <button
        type="button"
        className="create-course-cta__button"
        onClick={handleClick}
        disabled={creating}
        data-testid="create-course-cta-button"
      >
        {creating
          ? t('lessons.my.createModal.submitting', 'Creating…')
          : t('lessons.my.create', '+ Create my course')}
      </button>
      {error && (
        <p
          className="create-course-cta__error"
          data-testid="create-course-cta-error"
          role="status"
        >
          {error}
        </p>
      )}
    </section>
  );
}
