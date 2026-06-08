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
 * Layout (KS-3982) позже превратит панель в bottom-sheet на mobile;
 * сейчас разметка осознанно flow-я с inline-стилями, чтобы не
 * блокировать прогресс эпика. Все ключевые элементы помечены
 * `data-testid`.
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
        style={{ border: 'none', padding: 0, margin: 0 }}
        data-testid="lecture-access-visibility-group"
      >
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>
          {t('lectureAccess.heading', 'Who can see this lecture')}
        </legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {VISIBILITY_OPTIONS.map((opt) => {
            const id = `${radioGroupId}-${opt.value}`;
            return (
              <label
                key={opt.value}
                htmlFor={id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  padding: 8,
                  borderRadius: 6,
                  background: visibility === opt.value ? '#f0f4ff' : 'transparent',
                }}
                data-testid={`lecture-access-visibility-${opt.value}`}
              >
                <input
                  id={id}
                  type="radio"
                  name={radioGroupId}
                  value={opt.value}
                  checked={visibility === opt.value}
                  onChange={() => onVisibilityChange(opt.value)}
                  disabled={disabled}
                  style={{ marginTop: 3 }}
                />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500 }}>
                    {t(opt.labelKey, opt.fallback)}
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>
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
          style={{ marginTop: 16 }}
        >
          <h3
            id={`${radioGroupId}-allowlist`}
            style={{ margin: '0 0 8px', fontSize: 14 }}
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
            <div
              data-testid="lecture-access-loading"
              style={{ opacity: 0.7, fontSize: 13, marginTop: 8 }}
            >
              {t('common.loading', 'Loading…')}
            </div>
          )}
          {grantsError === 'forbidden' && !grantsLoading && (
            <div
              className="error"
              data-testid="lecture-access-forbidden"
              style={{ marginTop: 8 }}
            >
              {t(
                'lectureAccess.allowlist.forbidden',
                'Only the lecture owner can manage access.',
              )}
            </div>
          )}
          {grantsError === 'load-failed' && !grantsLoading && (
            <div
              className="error"
              data-testid="lecture-access-load-failed"
              style={{ marginTop: 8 }}
            >
              {t(
                'lectureAccess.allowlist.loadFailed',
                'Failed to load access list. Please retry.',
              )}
            </div>
          )}

          {!grantsLoading && !grantsError && grants.length === 0 && (
            <div
              data-testid="lecture-access-empty"
              style={{ opacity: 0.7, fontSize: 13, marginTop: 8 }}
            >
              {t(
                'lectureAccess.allowlist.empty',
                'No one is on the list yet. Search above to add a user.',
              )}
            </div>
          )}

          {!grantsLoading && !grantsError && grants.length > 0 && (
            <ul
              data-testid="lecture-access-chips"
              style={{
                listStyle: 'none',
                padding: 0,
                margin: '12px 0 0',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              {grants.map((g) => (
                <li
                  key={g.grant.id}
                  data-testid={`lecture-access-chip-${g.grant.id}`}
                  data-subject={g.grant.subjectId}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: '#eef0f3',
                    fontSize: 13,
                  }}
                >
                  {g.user.avatarUrl ? (
                    <img
                      src={g.user.avatarUrl}
                      alt=""
                      width={20}
                      height={20}
                      style={{ borderRadius: '50%', objectFit: 'cover' }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: '#ccd1d9',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                      }}
                    >
                      {g.user.username.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span>{g.user.displayName}</span>
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
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      padding: 0,
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lastMutationError && (
            <div
              className="error"
              data-testid="lecture-access-mutation-error"
              data-error-code={lastMutationError.errorCode ?? ''}
              style={{ marginTop: 8 }}
            >
              {lastMutationError.errorCode === 'course_access_not_supported'
                ? t(
                    'lectureAccess.errors.courseAccessNotSupported',
                    'Course-based access is not supported yet.',
                  )
                : lastMutationError.message}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
