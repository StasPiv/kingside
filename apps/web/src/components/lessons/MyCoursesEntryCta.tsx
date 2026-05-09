import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { userCoursesApi } from '../../api/userCoursesApi';
import { useAuth } from '../../context/AuthContext';

/**
 * `MyCoursesEntryCta` — компактная кнопка-ссылка на `/lessons/my`
 * со счётчиком своих курсов (ADR-052 §3.3.1, KS-2622, Tier 1 #3).
 *
 * Точка входа на full-страницу «Мои курсы». Размещается на /lessons
 * рядом с `<CreateCourseCta />`. Гостям не рендерится — без авторизации
 * чужие курсы отдаваться не должны, и ссылка теряет смысл.
 *
 * Источник числа — тот же `userCoursesApi.list({ scope: 'own' })`, что
 * и сама страница; backend на этом GET'е не отдаёт `total`, поэтому
 * количество — `data.length`. Ошибка загрузки → CTA рендерится с «—»
 * вместо числа, чтобы не блокировать переход на страницу (там
 * пользователь увидит свой error/empty state).
 */
export function MyCoursesEntryCta() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    userCoursesApi
      .list({ scope: 'own' })
      .then((res) => {
        if (cancelled) return;
        setCount(res.data?.length ?? 0);
      })
      .catch(() => {
        /* ничего: ниже отрендерим «—» вместо числа. */
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;

  return (
    <Link
      to="/lessons/my"
      className="my-courses-entry-cta"
      data-testid="my-courses-entry-cta"
    >
      <span className="my-courses-entry-cta__label">
        {t('lessons.my.entryCta.title', 'My courses')}
      </span>
      <span
        className="my-courses-entry-cta__count"
        data-testid="my-courses-entry-cta-count"
      >
        ({count ?? '—'})
      </span>
      <span className="my-courses-entry-cta__arrow" aria-hidden="true">
        →
      </span>
    </Link>
  );
}
