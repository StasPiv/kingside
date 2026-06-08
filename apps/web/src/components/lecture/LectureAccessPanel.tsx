import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LectureVisibility } from '@kingside/shared';
import { useLectureAccess } from '../../hooks/useLectureAccess';
import { UserSearchInline } from '../users/UserSearchInline';

/**
 * KS-3972 / ADR-119 §8 эпик C (C03). Панель «Доступ учеников».
 *
 * Содержимое:
 *  1. Группа радио-кнопок visibility — `public` / `unlisted` /
 *     `restricted`. Смена выставляется через `onVisibilityChange`;
 *     родитель (`LectureSettingsModal` / `CreateLectureModal`)
 *     сам решает, делать ли `PATCH /lectures/:id { visibility }`
 *     сразу или отложить до «Сохранить».
 *  2. Для `restricted` (или когда `lectureId` уже создан и хочется
 *     заранее показать список) — список «Кто имеет доступ»:
 *     чипы из `LectureAccessGrantWithUser` с кнопкой «×»
 *     (revoke) + `UserSearchInline` (KS-3970) для добавления.
 *     Источник данных и mutate — `useLectureAccess(lectureId)`
 *     (KS-3971) с оптимистическими обновлениями.
 *
 * Все mutate-операции делаются мгновенно через хук; UI обновляется
 * ещё до ответа backend'а, при ошибке откат + строка ошибки под
 * списком (с `errorCode` для специфических сообщений вида
 * `course_access_not_supported`).
 *
 * KS-3982: встроенные стили заменены на CSS-классы из
 * `apps/web/src/styles/lecture.css`. Сама панель — оформление
 * содержимого; оболочка (выдвижной лист на mobile / центральная
 * модалка на desktop) реализуется через классы `.lecture-modal*`
 * в `LectureSettingsModal` (C05) и `CreateLectureModal`.
 */

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: LectureVisibility;
  labelKey: string;
  fallback: string;
  hintKey: string;
  hintFallback: string;
}> = [
  {
    value: 'public',
    labelKey: 'lectureAccess.visibility.public.label',
    fallback: 'Public',
    hintKey: 'lectureAccess.visibility.public.hint',
    hintFallback: 'Anyone with the link can join.',
  },
  {
    value: 'unlisted',
    labelKey: 'lectureAccess.visibility.unlisted.label',
    fallback: 'Unlisted',
    hintKey: 'lectureAccess.visibility.unlisted.hint',
    hintFallback: 'Only people who have the direct link can join.',
  },
  {
    value: 'restricted',
    labelKey: 'lectureAccess.visibility.restricted.label',
    fallback: 'Restricted',
    hintKey: 'lectureAccess.visibility.restricted.hint',
    hintFallback: 'Only people you list below can join.',
  },
];

export interface LectureAccessPanelProps {
  /**
   * UUID лекции. Когда лекция ещё не создана (`CreateLectureModal`),
   * сюда передаётся `null` — список доступа не рендерится, только
   * группа visibility. Доступ можно будет добавить после первого
   * `POST /lectures`.
   */
  lectureId: string | null;
  visibility: LectureVisibility;
  onVisibilityChange: (next: LectureVisibility) => void;
  /** Видимый рендер списка allowlist скрыть полностью (например, в CreateLectureModal). */
  hideAllowlist?: boolean;
  /** Отключить взаимодействие — пока идёт save родителя. */
  disabled?: boolean;
}

export function LectureAccessPanel({
  lectureId,
  visibility,
  onVisibilityChange,
  hideAllowlist,
  disabled,
}: LectureAccessPanelProps) {
  const { t } = useTranslation();
  const radioGroupId = useId();
  const [lastSearchKey, setLastSearchKey] = useState(0);

  const showAllowlist =
    !hideAllowlist && visibility === 'restricted' && Boolean(lectureId);

  const {
    grants,
    loading: grantsLoading,
    error: grantsError,
    lastMutationError,
    grantUser,
    revokeGrant,
  } = useLectureAccess(showAllowlist ? lectureId : null);

  const excludeIds = useMemo(
    () =>
      grants
        .filter((g) => g.grant.subjectType === 'user')
        .map((g) => g.grant.subjectId),
    [grants],
  );

  const handleSelect = useCallback(
    (user: { id: string }) => {
      void grantUser(user.id);
      // Сбрасываем UserSearchInline (он сам очищает инпут после
      // выбора), но дополнительно перерендериваем с новым key,
      // чтобы экономно гасить внутреннее highlight-состояние.
      setLastSearchKey((n) => n + 1);
    },
    [grantUser],
  );

  return (
    <div
      className="lecture-access-panel"
      data-testid="lecture-access-panel"
      data-visibility={visibility}
    >
      <fieldset
        disabled={disabled}
        className="lecture-access-panel__visibility"
        data-testid="lecture-access-visibility-group"
      >
        <legend className="lecture-access-panel__legend">
          {t('lectureAccess.heading', 'Who can see this lecture')}
        </legend>
        <div className="lecture-access-panel__visibility-list">
          {VISIBILITY_OPTIONS.map((opt) => {
            const id = `${radioGroupId}-${opt.value}`;
            const isActive = visibility === opt.value;
            return (
              <label
                key={opt.value}
                htmlFor={id}
                className={
                  'lecture-access-panel__option' +
                  (isActive ? ' lecture-access-panel__option--active' : '')
                }
                data-testid={`lecture-access-visibility-${opt.value}`}
              >
                <input
                  id={id}
                  type="radio"
                  name={radioGroupId}
                  value={opt.value}
                  checked={isActive}
                  onChange={() => onVisibilityChange(opt.value)}
                  disabled={disabled}
                  className="lecture-access-panel__option-radio"
                />
                <span className="lecture-access-panel__option-text">
                  <span className="lecture-access-panel__option-title">
                    {t(opt.labelKey, opt.fallback)}
                  </span>
                  <span className="lecture-access-panel__option-hint">
                    {t(opt.hintKey, opt.hintFallback)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {showAllowlist && (
        <section
          aria-labelledby={`${radioGroupId}-allowlist`}
          data-testid="lecture-access-allowlist"
          className="lecture-access-panel__allowlist"
        >
          <h3
            id={`${radioGroupId}-allowlist`}
            className="lecture-access-panel__allowlist-heading"
          >
            {t('lectureAccess.allowlist.heading', 'Who has access')}
          </h3>

          <UserSearchInline
            key={lastSearchKey}
            onSelect={handleSelect}
            excludeIds={excludeIds}
            disabled={disabled}
            testIdPrefix="lecture-access-user-search"
          />

          {grantsLoading && (
            <p
              data-testid="lecture-access-loading"
              className="lecture-access-panel__state"
            >
              {t('common.loading', 'Loading…')}
            </p>
          )}
          {grantsError === 'forbidden' && !grantsLoading && (
            <p
              data-testid="lecture-access-forbidden"
              className="lecture-access-panel__state lecture-access-panel__state--error"
            >
              {t(
                'lectureAccess.allowlist.forbidden',
                'Only the lecture owner can manage access.',
              )}
            </p>
          )}
          {grantsError === 'load-failed' && !grantsLoading && (
            <p
              data-testid="lecture-access-load-failed"
              className="lecture-access-panel__state lecture-access-panel__state--error"
            >
              {t(
                'lectureAccess.allowlist.loadFailed',
                'Failed to load access list. Please retry.',
              )}
            </p>
          )}

          {!grantsLoading && !grantsError && grants.length === 0 && (
            <p
              data-testid="lecture-access-empty"
              className="lecture-access-panel__state"
            >
              {t(
                'lectureAccess.allowlist.empty',
                'No one is on the list yet. Search above to add a user.',
              )}
            </p>
          )}

          {!grantsLoading && !grantsError && grants.length > 0 && (
            <ul
              data-testid="lecture-access-chips"
              className="lecture-access-panel__chips"
            >
              {grants.map((g) => (
                <li
                  key={g.grant.id}
                  data-testid={`lecture-access-chip-${g.grant.id}`}
                  data-subject={g.grant.subjectId}
                  className="lecture-access-panel__chip"
                >
                  {g.user.avatarUrl ? (
                    <img
                      src={g.user.avatarUrl}
                      alt=""
                      className="lecture-access-panel__chip-avatar"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="lecture-access-panel__chip-avatar-fallback"
                    >
                      {g.user.username.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="lecture-access-panel__chip-name">
                    {g.user.displayName}
                  </span>
                  <button
                    type="button"
                    aria-label={t(
                      'lectureAccess.allowlist.removeAria',
                      'Remove {{user}}',
                      { user: g.user.displayName },
                    )}
                    disabled={disabled}
                    onClick={() => {
                      void revokeGrant(g.grant.id);
                    }}
                    data-testid={`lecture-access-remove-${g.grant.id}`}
                    className="lecture-access-panel__chip-remove"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lastMutationError && (
            <p
              data-testid="lecture-access-mutation-error"
              data-error-code={lastMutationError.errorCode ?? ''}
              className="lecture-access-panel__state lecture-access-panel__state--error"
            >
              {lastMutationError.errorCode === 'course_access_not_supported'
                ? t(
                    'lectureAccess.errors.courseAccessNotSupported',
                    'Course-based access is not supported yet.',
                  )
                : lastMutationError.message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
