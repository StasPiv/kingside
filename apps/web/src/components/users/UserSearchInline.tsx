import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserSearch, type UserSearchItem } from '../../hooks/useUserSearch';

/**
 * KS-3970 / ADR-119 §8 эпик C (C01). Inline-поиск пользователей —
 * легковесный компонент с инпутом и выпадающим списком найденных
 * пользователей. Используется в `LectureAccessPanel` (KS-3972) и
 * `CreateLectureModal` (KS-3973) для выдачи доступа к лекции.
 *
 * API:
 *  - `onSelect(user)` — вызывается при клике по строке из
 *    выпадающего списка. Родитель сам решает, добавить ли
 *    пользователя в allowlist (`POST /lectures/:id/access`),
 *    показать ли подтверждение и т.д.
 *  - `excludeIds` — id пользователей, которые уже в списке
 *    (родитель прокидывает, чтобы спрятать их из выдачи и
 *    избежать дубль-добавлений).
 *
 * Поведение:
 *  - Дебаунс 200 мс внутри `useUserSearch`.
 *  - Выпадающий список — `role="listbox"`, элементы — `role="option"`,
 *    клавишная навигация ↑/↓/Enter/Esc.
 *  - При клике вне или Esc выпадающий список закрывается, инпут
 *    очищается. После выбора пользователя инпут тоже очищается.
 *  - Состояния «loading» / «пусто» / «forbidden» / «load-failed»
 *    показываются как небольшая строка под инпутом. Все
 *    осмысленные элементы помечены `data-testid`.
 */

interface UserSearchInlineProps {
  onSelect: (user: UserSearchItem) => void;
  /** id'ы пользователей, которые уже добавлены и не должны попадать в выдачу. */
  excludeIds?: ReadonlyArray<string>;
  /** Placeholder инпута; по умолчанию — i18n-ключ. */
  placeholder?: string;
  /** Disabled — например, пока идёт mutate-операция. */
  disabled?: boolean;
  /** Идентификатор для `data-testid`, чтобы можно было использовать несколько инстансов. */
  testIdPrefix?: string;
}

export function UserSearchInline({
  onSelect,
  excludeIds,
  placeholder,
  disabled,
  testIdPrefix = 'user-search-inline',
}: UserSearchInlineProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [open, setOpen] = useState(false);
  const listboxId = useId();

  const { results, loading, error } = useUserSearch(query);

  const excludeSet = new Set(excludeIds ?? []);
  const filtered = results.filter((u) => !excludeSet.has(u.id));

  const showDropdown =
    open && !disabled && query.trim().length >= 2;

  const choose = (user: UserSearchItem) => {
    onSelect(user);
    setQuery('');
    setHighlight(0);
    setOpen(false);
  };

  return (
    <div
      className="user-search-inline"
      data-testid={testIdPrefix}
      style={{ position: 'relative' }}
    >
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        disabled={disabled}
        placeholder={
          placeholder ?? t('userSearch.placeholder', 'Find user by name…')
        }
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Закрываем список с задержкой, чтобы успел отработать клик
          // по строке (onMouseDown на option отрабатывает раньше blur,
          // но клик `pointerup` приходит уже после blur при некоторых
          // браузерах; небольшая задержка убирает гонку).
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (!showDropdown) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            const item = filtered[highlight];
            if (item) {
              e.preventDefault();
              choose(item);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-autocomplete="list"
        data-testid={`${testIdPrefix}-input`}
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid #ddd',
        }}
      />
      {showDropdown && (
        <div
          id={listboxId}
          role="listbox"
          data-testid={`${testIdPrefix}-listbox`}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            zIndex: 10,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {loading && (
            <div
              data-testid={`${testIdPrefix}-loading`}
              style={{ padding: 8, opacity: 0.7, fontSize: 13 }}
            >
              {t('common.loading', 'Loading…')}
            </div>
          )}
          {!loading && error === 'forbidden' && (
            <div
              data-testid={`${testIdPrefix}-forbidden`}
              style={{ padding: 8, opacity: 0.7, fontSize: 13 }}
            >
              {t(
                'userSearch.forbidden',
                'You don’t have permission to search users.',
              )}
            </div>
          )}
          {!loading && error === 'load-failed' && (
            <div
              data-testid={`${testIdPrefix}-error`}
              style={{ padding: 8, opacity: 0.7, fontSize: 13 }}
            >
              {t('userSearch.loadFailed', 'Failed to search users. Try again.')}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div
              data-testid={`${testIdPrefix}-empty`}
              style={{ padding: 8, opacity: 0.7, fontSize: 13 }}
            >
              {t('userSearch.empty', 'No matches')}
            </div>
          )}
          {!loading && !error &&
            filtered.map((user, idx) => {
              const isActive = idx === highlight;
              return (
                <button
                  type="button"
                  key={user.id}
                  role="option"
                  aria-selected={isActive}
                  data-testid={`${testIdPrefix}-option-${user.id}`}
                  onMouseDown={(e) => {
                    // Останавливаем потерю фокуса — иначе onBlur инпута
                    // успеет закрыть выпадающий список до клика.
                    e.preventDefault();
                  }}
                  onClick={() => choose(user)}
                  onMouseEnter={() => setHighlight(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '8px 10px',
                    background: isActive ? '#f0f4ff' : '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      width={28}
                      height={28}
                      style={{
                        borderRadius: '50%',
                        objectFit: 'cover',
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: '#e5e7eb',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        flexShrink: 0,
                      }}
                    >
                      {user.username.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      lineHeight: 1.2,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{user.displayName}</span>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      @{user.username}
                    </span>
                  </span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
