import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * KS-4829. Лобби администратора — общий вход во все админ-разделы.
 *
 * До задачи иконка `🛡 Админка` в сайдбаре вела сразу на
 * `/admin/feature-flags`; остальные разделы (Блог, Подсказки) были
 * доступны только по прямому URL. Теперь иконка ведёт сюда, отсюда —
 * на конкретный раздел. Список ведём вручную: маршруты в `App.tsx`
 * не помечены метаданными, авто-сбор бессмысленен (часть подразделов
 * — это вложенные edit-страницы, их в лобби не нужно).
 *
 * Доступ — `<AdminRoute>` в `App.tsx`, тот же гард, что и у остальных
 * админ-страниц.
 */

interface AdminSection {
  to: string;
  titleKey: string;
  titleFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  icon: string;
}

const SECTIONS: ReadonlyArray<AdminSection> = [
  {
    to: '/admin/feature-flags',
    icon: '🚩',
    titleKey: 'adminLobby.featureFlags.title',
    titleFallback: 'Feature-флаги',
    descriptionKey: 'adminLobby.featureFlags.description',
    descriptionFallback:
      'Runtime-флаги: переключение функций без переразвёртывания.',
  },
  {
    to: '/admin/hints',
    icon: '💡',
    titleKey: 'adminLobby.hints.title',
    titleFallback: 'Контекстные подсказки',
    descriptionKey: 'adminLobby.hints.description',
    descriptionFallback:
      'CRUD контекстных подсказок (HintHost): тексты, CTA, правила DSL.',
  },
  {
    to: '/admin/blog/posts',
    icon: '📝',
    titleKey: 'adminLobby.blogPosts.title',
    titleFallback: 'Блог: посты',
    descriptionKey: 'adminLobby.blogPosts.description',
    descriptionFallback:
      'Создание и редактирование статей блога (ru/en, draft/publish).',
  },
  {
    to: '/admin/blog/authors',
    icon: '✍️',
    titleKey: 'adminLobby.blogAuthors.title',
    titleFallback: 'Блог: авторы',
    descriptionKey: 'adminLobby.blogAuthors.description',
    descriptionFallback: 'Справочник авторов блога: имя, аватар, био.',
  },
];

export function AdminLobbyPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="admin-page" data-testid="admin-lobby-page">
      <header className="admin-page__header">
        <h1>{t('adminLobby.title', 'Админка')}</h1>
        <p className="admin-page__subtitle">
          {t(
            'adminLobby.subtitle',
            'Выберите раздел. Все страницы доступны только администраторам.',
          )}
        </p>
      </header>

      <ul className="admin-lobby__list" data-testid="admin-lobby-list">
        {SECTIONS.map((s) => (
          <li key={s.to} className="admin-lobby__item">
            <Link
              to={s.to}
              className="admin-lobby__link"
              data-testid={`admin-lobby-link-${s.to.replace(/^\/admin\//, '').replace(/\//g, '-')}`}
            >
              <span className="admin-lobby__icon" aria-hidden="true">
                {s.icon}
              </span>
              <span className="admin-lobby__text">
                <span className="admin-lobby__title">
                  {t(s.titleKey, s.titleFallback)}
                </span>
                <span className="admin-lobby__description">
                  {t(s.descriptionKey, s.descriptionFallback)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
