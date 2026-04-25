import { useTranslation } from 'react-i18next';

/**
 * `PublishToggle` — переключатель public/private курса
 * (KS-1848 §3.6, KS-1855 / FE-R7).
 *
 * Controlled: `isPublic` + `onChange(next)` → родитель применяет PATCH
 * через `userCoursesApi.update`. `busy` блокирует toggle на время
 * запроса. Подсказка под toggle объясняет, что видно другим.
 *
 * # KS-1916 (P0): label фиксирован
 *
 * До этого фикса label был динамическим — «Public» при `isPublic=true`
 * и «Private» при `isPublic=false`. Это создавало семантическую
 * двусмысленность: пользователь видел «☐ Private» (галка снята)
 * и интерпретировал «галочка = приватный, галки нет → публичный».
 * После клика checkbox.checked становился `true` → onChange(true) →
 * isPublic=true → курс становился ПУБЛИЧНЫМ, а не приватным как он
 * ожидал. Объективно код был правильный (`checked = isPublic`), но
 * label «Private» под снятой галкой читался как «галочка означает
 * private».
 *
 * Теперь label всегда «Public» / «Публичный», `checked = isPublic`.
 * Снятая галка → не публичный (приватный). Поставленная → публичный.
 * Это согласовано с полем БД (`isPublic`) и убирает двусмысленность.
 * Динамический hint остаётся — он объясняет ТЕКУЩЕЕ состояние.
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
          {t('lessons.my.publicBadge', 'Public')}
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
