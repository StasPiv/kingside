import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../context/AuthContext';
import { api } from '../../../api';
import { ApiError } from '../../../ApiError';
import { getUserConsent } from '../../../components/cookie-banner/consentTypes';

const API_BASE =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

type ExportState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ratelimited' }
  | { kind: 'error'; message: string };

type DeleteState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'loading' }
  | { kind: 'done'; eventsDeleted: number }
  | { kind: 'error'; message: string };

/**
 * KS-4698 / ADR-147 §6.3. Privacy-вкладка в /settings:
 *   - переключатель `analyticsConsent` (PATCH /me/consent),
 *   - кнопка «Скачать мои данные» (GET /me/analytics-export, 1/24ч),
 *   - кнопка «Удалить мои данные» (DELETE /me/analytics-data) с подтверждением.
 *
 * Guest-варианты (/guest/analytics-data, /guest/analytics-export) пока
 * не подключены: их использование требует guest-консент-cookies,
 * которые backend выпишет в отдельном тикете (см. комментарий
 * координатора по KS-4698).
 */
export function PrivacyTab(): ReactElement {
  const { t } = useTranslation();
  const { user, refreshUser, token } = useAuth();
  const consent = useMemo(() => getUserConsent(user), [user]);

  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: 'idle' });

  const handleToggleConsent = useCallback(
    async (next: boolean) => {
      if (!user) return;
      setConsentSaving(true);
      setConsentError(null);
      try {
        await api.patch('/me/consent', { analytics: next });
        await refreshUser();
      } catch (err) {
        setConsentError(err instanceof Error ? err.message : 'error');
      } finally {
        setConsentSaving(false);
      }
    },
    [user, refreshUser],
  );

  const handleExport = useCallback(async () => {
    if (!user || !token) return;
    setExportState({ kind: 'loading' });
    try {
      // Прямой fetch (минуя api-хелпер) — endpoint отдаёт stream JSON,
      // а api.get<T> парсит ответ как JSON-объект целиком (для больших
      // экспортов это лишний buffer + потеря attachment-режима).
      const res = await fetch(`${API_BASE}/me/analytics-export`, {
        method: 'GET',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 403) {
        setExportState({ kind: 'ratelimited' });
        return;
      }
      if (!res.ok) {
        setExportState({
          kind: 'error',
          message: `HTTP ${res.status}`,
        });
        return;
      }
      const blob = await res.blob();
      triggerDownload(blob, `analytics-export-${user.id}.json`);
      setExportState({ kind: 'idle' });
    } catch (err) {
      setExportState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network',
      });
    }
  }, [user, token]);

  const handleAskDelete = useCallback(() => {
    setDeleteState({ kind: 'confirm' });
  }, []);

  const handleCancelDelete = useCallback(() => {
    setDeleteState({ kind: 'idle' });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!user) return;
    setDeleteState({ kind: 'loading' });
    try {
      const res = await api.delete<{ eventsDeleted: number; aggKeysDeleted: number }>(
        '/me/analytics-data',
      );
      setDeleteState({ kind: 'done', eventsDeleted: res.eventsDeleted });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.status} ${err.message}`
          : err instanceof Error
            ? err.message
            : 'error';
      setDeleteState({ kind: 'error', message });
    }
  }, [user]);

  if (!user) {
    return (
      <section className="settings-section" data-testid="settings-privacy-tab">
        <h2>{t('settings.privacy.title', 'Privacy & data')}</h2>
        <p>
          {t(
            'settings.privacy.notLoggedIn',
            'Sign in to manage your analytics consent and personal data.',
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="settings-section" data-testid="settings-privacy-tab">
      <h2>{t('settings.privacy.title', 'Privacy & data')}</h2>

      {/* Toggle consent */}
      <div className="settings-field" data-testid="settings-privacy-consent">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="analytics-consent-toggle"
            data-testid="settings-privacy-consent-toggle"
            type="checkbox"
            checked={consent === true}
            disabled={consentSaving}
            onChange={(e) => void handleToggleConsent(e.target.checked)}
          />
          <label htmlFor="analytics-consent-toggle">
            {t('settings.privacy.consentLabel', 'Analytics for personalised hints')}
          </label>
        </div>
        <p className="settings-hint">
          {t(
            'settings.privacy.consentHint',
            'When enabled, the site records high-level actions (page views, idle time, game/puzzle starts) to suggest contextual hints. No move data or messages are tracked.',
          )}
        </p>
        {consentError && (
          <p
            className="settings-hint"
            style={{ color: 'var(--color-danger, #c33)' }}
            data-testid="settings-privacy-consent-error"
          >
            {t(
              'settings.privacy.consentError',
              'Could not update your choice. Try again.',
            )}
          </p>
        )}
      </div>

      {/* Export */}
      <div className="settings-field" data-testid="settings-privacy-export">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exportState.kind === 'loading'}
          data-testid="settings-privacy-export-button"
        >
          {exportState.kind === 'loading'
            ? t('settings.privacy.exportLoading', 'Preparing download…')
            : t('settings.privacy.exportButton', 'Download my data')}
        </button>
        <p className="settings-hint">
          {t(
            'settings.privacy.exportHint',
            'Get a JSON file with the last 90 days of your analytics events. Limited to one download per 24 hours.',
          )}
        </p>
        {exportState.kind === 'ratelimited' && (
          <p
            className="settings-hint"
            style={{ color: 'var(--color-warning, #b67d00)' }}
            data-testid="settings-privacy-export-ratelimited"
          >
            {t(
              'settings.privacy.exportRateLimited',
              'You already downloaded your data today. Try again in 24 hours.',
            )}
          </p>
        )}
        {exportState.kind === 'error' && (
          <p
            className="settings-hint"
            style={{ color: 'var(--color-danger, #c33)' }}
            data-testid="settings-privacy-export-error"
          >
            {t('settings.privacy.exportError', 'Download failed: {{message}}', {
              message: exportState.message,
            })}
          </p>
        )}
      </div>

      {/* Delete */}
      <div className="settings-field" data-testid="settings-privacy-delete">
        {deleteState.kind !== 'confirm' && (
          <button
            type="button"
            onClick={handleAskDelete}
            disabled={deleteState.kind === 'loading'}
            data-testid="settings-privacy-delete-button"
          >
            {t('settings.privacy.deleteButton', 'Delete my data')}
          </button>
        )}
        <p className="settings-hint">
          {t(
            'settings.privacy.deleteHint',
            'Permanently removes all analytics events and hint history we have stored for your account. Your account and games stay intact.',
          )}
        </p>

        {deleteState.kind === 'confirm' && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-privacy-delete-confirm-title"
            className="settings-modal"
            data-testid="settings-privacy-delete-confirm"
          >
            <h3 id="settings-privacy-delete-confirm-title">
              {t('settings.privacy.deleteConfirmTitle', 'Delete analytics data?')}
            </h3>
            <p>
              {t(
                'settings.privacy.deleteConfirmBody',
                'This action cannot be undone. Your analytics history will be removed immediately.',
              )}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                data-testid="settings-privacy-delete-confirm-yes"
              >
                {t('settings.privacy.deleteConfirmYes', 'Yes, delete')}
              </button>
              <button
                type="button"
                onClick={handleCancelDelete}
                data-testid="settings-privacy-delete-confirm-no"
              >
                {t('settings.privacy.deleteConfirmNo', 'Cancel')}
              </button>
            </div>
          </div>
        )}

        {deleteState.kind === 'loading' && (
          <p
            className="settings-hint"
            data-testid="settings-privacy-delete-loading"
          >
            {t('settings.privacy.deleteLoading', 'Deleting…')}
          </p>
        )}
        {deleteState.kind === 'done' && (
          <p
            className="settings-hint"
            data-testid="settings-privacy-delete-done"
          >
            {t(
              'settings.privacy.deleteDone',
              'Deleted {{count}} events. Done.',
              { count: deleteState.eventsDeleted },
            )}
          </p>
        )}
        {deleteState.kind === 'error' && (
          <p
            className="settings-hint"
            style={{ color: 'var(--color-danger, #c33)' }}
            data-testid="settings-privacy-delete-error"
          >
            {t('settings.privacy.deleteError', 'Delete failed: {{message}}', {
              message: deleteState.message,
            })}
          </p>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function triggerDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Освобождение Blob URL: не сразу — Safari иногда отменяет загрузку,
  // если объект убран до окончания download-handshake.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
