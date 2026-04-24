import { useTranslation } from 'react-i18next';

/**
 * `PublishToggle` — переключатель public/private курса
 * (KS-1848 §3.6, KS-1855 / FE-R7).
 *
 * Controlled: `isPublic` + `onChange(next)` → родитель применяет PATCH
 * через `userCoursesApi.update`. `busy` блокирует toggle на время
 * запроса. Подсказка под toggle объясняет, что видно другим.
 */

interface PublishToggleProps {
  isPublic: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
}

export function PublishToggle({
  isPublic,
  onChange,
  busy,
}: PublishToggleProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`publish-toggle${isPublic ? ' publish-toggle--public' : ' publish-toggle--private'}`}
      data-testid="publish-toggle"
      data-is-public={isPublic ? 'true' : 'false'}
    >
      <label className="publish-toggle__label">
        <input
          type="checkbox"
          checked={isPublic}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="publish-toggle-input"
        />
        <span className="publish-toggle__text">
          {isPublic
            ? t('lessons.my.publicBadge', 'Public')
            : t('lessons.my.privateBadge', 'Private')}
        </span>
      </label>
      <p className="publish-toggle__hint" data-testid="publish-toggle-hint">
        {isPublic
          ? t(
              'lessons.my.editor.visibilityPublicHint',
              'The course is visible to everyone in Lessons',
            )
          : t(
              'lessons.my.editor.visibilityPrivateHint',
              'Only you can see this course',
            )}
      </p>
    </div>
  );
}
