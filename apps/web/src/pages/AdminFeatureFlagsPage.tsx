import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AdminFeatureFlagItem, FeatureFlags } from '@kingside/shared';

import { configApi } from '../api/configApi';
import { useAdminStatus } from '../hooks/useAdminStatus';
import { useFeatureFlags } from '../context/FeatureFlagsContext';

/**
 * KS-2109 — страница `/admin/feature-flags` для админов.
 *
 * Данные грузим из `GET /admin/feature-flags` (KS-2108). Тумблер
 * вызывает `PATCH /admin/feature-flags/:key`, после успеха обновляем
 * локальный список (берём `value`/`updatedAt` из ответа PATCH) и
 * дёргаем `useFeatureFlags().refresh()` — чтобы остальное приложение
 * сразу подхватило новое значение из публичного `/config`.
 *
 * # Защита
 *
 * Маршрут уже завёрнут в `<AdminRoute>` в `App.tsx` — не-админу
 * страница не показывается. Здесь оставлен ещё один guard на случай
 * прямого монтирования компонента (storybook / e2e). Дёргаем тот же
 * хук — лишних запросов не будет, useAdminStatus мемо'и́рует через
 * Auth + один запрос.
 */
export function AdminFeatureFlagsPage() {
  const { t } = useTranslation();
  const { isAdmin, loading: adminStatusLoading } = useAdminStatus();
  const { refresh: refreshPublicFlags } = useFeatureFlags();

  const [items, setItems] = useState<AdminFeatureFlagItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<keyof FeatureFlags | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOkKey, setSaveOkKey] = useState<keyof FeatureFlags | null>(null);

  // ─── Loader ───────────────────────────────────────────────────────
  const loadItems = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await configApi.listAdminFeatureFlags();
      setItems(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load';
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadItems();
  }, [isAdmin, loadItems]);

  // ─── Toggle ───────────────────────────────────────────────────────
  const toggle = useCallback(
    async (item: AdminFeatureFlagItem) => {
      setSavingKey(item.key);
      setSaveError(null);
      setSaveOkKey(null);
      try {
        const res = await configApi.updateFeatureFlag(item.key, {
          value: !item.value,
        });
        // Локально обновляем строку — без релоада всего списка.
        setItems((prev) =>
          prev
            ? prev.map((i) =>
                i.key === res.key
                  ? { ...i, value: res.value, updatedAt: res.updatedAt }
                  : i,
              )
            : prev,
        );
        setSaveOkKey(res.key);
        // Public `/config` тоже мог измениться → обновляем глобальный
        // FeatureFlagsContext (Sidebar/App увидят сразу).
        void refreshPublicFlags();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'PATCH failed';
        setSaveError(message);
      } finally {
        setSavingKey(null);
      }
    },
    [refreshPublicFlags],
  );

  // ─── Guards (страница) ────────────────────────────────────────────
  if (adminStatusLoading) {
    return (
      <div className="admin-feature-flags-page" data-testid="admin-feature-flags-page">
        <p className="loading">{t('common.loading')}</p>
      </div>
    );
  }

  if (!isAdmin) {
    // Прямое монтирование без AdminRoute → редирект.
    return <Navigate to="/" replace />;
  }

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="admin-feature-flags-page" data-testid="admin-feature-flags-page">
      <header className="admin-feature-flags-page__header">
        <h1>{t('admin.featureFlags.title', 'Feature Flags')}</h1>
        <p className="admin-feature-flags-page__subtitle">
          {t(
            'admin.featureFlags.subtitle',
            'Toggle runtime flags. Changes take effect without redeploy.',
          )}
        </p>
      </header>

      {loading && (
        <div className="loading" data-testid="admin-feature-flags-loading">
          {t('common.loading')}
        </div>
      )}

      {loadError && (
        <div className="error" data-testid="admin-feature-flags-load-error">
          {loadError}
        </div>
      )}

      {saveError && (
        <div className="error" data-testid="admin-feature-flags-save-error">
          {saveError}
        </div>
      )}

      {!loading && !loadError && items && items.length === 0 && (
        <div data-testid="admin-feature-flags-empty">
          {t('admin.featureFlags.empty', 'No feature flags configured.')}
        </div>
      )}

      {items && items.length > 0 && (
        <table
          className="admin-feature-flags-table"
          data-testid="admin-feature-flags-table"
        >
          <thead>
            <tr>
              <th>{t('admin.featureFlags.col.key', 'Key')}</th>
              <th>{t('admin.featureFlags.col.description', 'Description')}</th>
              <th>{t('admin.featureFlags.col.value', 'Value')}</th>
              <th>{t('admin.featureFlags.col.default', 'Default')}</th>
              <th>{t('admin.featureFlags.col.updatedAt', 'Updated at')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const saving = savingKey === item.key;
              const justSaved = saveOkKey === item.key;
              return (
                <tr
                  key={item.key}
                  data-testid={`admin-feature-flag-row-${item.key}`}
                >
                  <td>
                    <code>{item.key}</code>
                  </td>
                  <td>{item.description ?? '—'}</td>
                  <td>
                    <label className="admin-feature-flags-toggle">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={item.value}
                        disabled={saving}
                        onChange={() => void toggle(item)}
                        data-testid={`admin-feature-flag-toggle-${item.key}`}
                      />
                      <span aria-hidden="true">
                        {saving
                          ? t('admin.featureFlags.saving', '…')
                          : item.value
                            ? t('admin.featureFlags.on', 'On')
                            : t('admin.featureFlags.off', 'Off')}
                      </span>
                    </label>
                    {justSaved && (
                      <span
                        className="admin-feature-flags-saved"
                        data-testid={`admin-feature-flag-saved-${item.key}`}
                      >
                        ✓ {t('admin.featureFlags.saved', 'Saved')}
                      </span>
                    )}
                  </td>
                  <td>{String(item.defaultValue)}</td>
                  <td>{item.updatedAt ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
