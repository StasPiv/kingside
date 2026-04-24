import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { AutoSaveStatus } from '../../../../hooks/useAutoSave';
import { SaveStatusPill } from './SaveStatusPill';
import { PublishToggle } from './PublishToggle';
import { OwnerActionsMenu } from './OwnerActionsMenu';

/**
 * `UserCourseHeader` — шапка редактора user-курса
 * (KS-1848 §3.1, KS-1855 / FE-R7).
 *
 * Собирает:
 *  - Breadcrumb «Мои курсы / <title>»
 *  - Inline-редактируемый `<h1>` с названием курса
 *  - `<SaveStatusPill>` справа
 *  - `<PublishToggle>` рядом с меню
 *  - `<OwnerActionsMenu>` (dropdown) — view / copy-link / delete
 *
 * Компонент — чисто презентационный. Родитель передаёт колбэки для
 * всех действий (save/save-retry — через внешний `useAutoSave`).
 */

interface UserCourseHeaderProps {
  title: string;
  isPublic: boolean;
  saveStatus: AutoSaveStatus;
  lastSavedAt: Date | null;
  onTitleChange: (next: string) => void;
  onRetrySave: () => void;
  onPublicChange: (next: boolean) => void;
  onView: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
  /** Время обновления курса — для disabling UI во время критичных запросов. */
  busy?: boolean;
}

export function UserCourseHeader({
  title,
  isPublic,
  saveStatus,
  lastSavedAt,
  onTitleChange,
  onRetrySave,
  onPublicChange,
  onView,
  onCopyLink,
  onDelete,
  busy,
}: UserCourseHeaderProps) {
  const { t } = useTranslation();
  // Inline-edit: локальное значение для buffering, чтобы каждый keypress
  // не кидал onTitleChange (у родителя будет debounced save). После blur —
  // commit через onTitleChange. Если родитель сам debounced'ит save по
  // change — достаточно прокинуть onTitleChange напрямую на onChange,
  // но это policy шапки: меньше шума в родителе.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== title) onTitleChange(draft);
    else setDraft(title);
  };

  return (
    <header className="user-course-header" data-testid="user-course-header">
      <nav
        className="user-course-header__breadcrumbs"
        data-testid="user-course-header-breadcrumbs"
      >
        <Link to="/lessons" data-testid="user-course-header-breadcrumb-root">
          {t('lessons.my.title', 'My courses')}
        </Link>
        <span className="user-course-header__sep"> / </span>
        <span className="user-course-header__crumb-current">{title}</span>
      </nav>

      <div className="user-course-header__row">
        <div className="user-course-header__title-group">
          {editing ? (
            <input
              type="text"
              className="user-course-header__title-input"
              value={draft}
              autoFocus
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === 'Escape') {
                  setDraft(title);
                  setEditing(false);
                }
              }}
              data-testid="user-course-header-title-input"
            />
          ) : (
            <h1
              className="user-course-header__title"
              data-testid="user-course-header-title"
              onClick={() => {
                if (!busy) {
                  setDraft(title);
                  setEditing(true);
                }
              }}
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                  e.preventDefault();
                  setDraft(title);
                  setEditing(true);
                }
              }}
            >
              {title}
            </h1>
          )}
        </div>

        <div className="user-course-header__actions">
          <SaveStatusPill
            status={saveStatus}
            lastSavedAt={lastSavedAt}
            onRetry={saveStatus === 'error' ? onRetrySave : undefined}
          />
          <PublishToggle
            isPublic={isPublic}
            onChange={onPublicChange}
            busy={busy}
          />
          <OwnerActionsMenu
            onView={onView}
            onCopyLink={onCopyLink}
            onDelete={onDelete}
          />
        </div>
      </div>
    </header>
  );
}
