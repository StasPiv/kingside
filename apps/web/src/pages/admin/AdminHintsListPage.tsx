/**
 * KS-4706 / ADR-147 §3.3. Админ-список подсказок `/admin/hints`.
 *
 * UI:
 *   - таблица: key, enabled (toggle), anchor, targetActorTypes,
 *     priority, обновлено;
 *   - фильтры: enabled (any/on/off), anchor (select из HINT_ANCHORS),
 *     actorType (any/user/guest), поиск по key/title;
 *   - чекбокс «Показать удалённые»;
 *   - действия: «Редактировать», переключение enabled, «Удалить»
 *     с confirm; для soft-deleted — «Восстановить».
 *
 * Защита маршрута — `<AdminRoute>` в `App.tsx`. Тот же `AdminRoute`,
 * что используют /admin/blog и /admin/feature-flags.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HINT_ANCHORS } from '@kingside/shared';
import {
  hintsAdminApi,
  type AdminHintSummary,
  type AdminHintsListQuery,
  type HintActorType,
} from '../../api/api-hints-admin';

type EnabledFilter = 'any' | 'on' | 'off';
type ActorFilter = 'any' | HintActorType;

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminHintsListPage(): ReactElement {
  const { t } = useTranslation();

  const [items, setItems] = useState<AdminHintSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledF, setEnabledF] = useState<EnabledFilter>('any');
  const [anchorF, setAnchorF] = useState<string>('');
  const [actorF, setActorF] = useState<ActorFilter>('any');
  const [search, setSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<AdminHintSummary | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const query = useMemo<AdminHintsListQuery>(
    () => ({
      enabled:
        enabledF === 'any' ? undefined : enabledF === 'on' ? true : false,
      anchor: anchorF || undefined,
      actorType: actorF === 'any' ? undefined : actorF,
      search,
      includeDeleted,
    }),
    [enabledF, anchorF, actorF, search, includeDeleted],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    hintsAdminApi
      .list(query)
      .then((rows) => {
        if (cancelled) return;
        setItems(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'load failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const toggleEnabled = useCallback(
    async (row: AdminHintSummary) => {
      setActionId(row.id);
      try {
        await hintsAdminApi.setStatus(row.id, !row.enabled);
        reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'toggle failed');
      } finally {
        setActionId(null);
      }
    },
    [reload],
  );

  const restoreDeleted = useCallback(
    async (row: AdminHintSummary) => {
      setActionId(row.id);
      try {
        // PATCH status { enabled: true } по контракту KS-4702 auto-сбрасывает
        // deletedAt — это и есть restore.
        await hintsAdminApi.setStatus(row.id, true);
        reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'restore failed');
      } finally {
        setActionId(null);
      }
    },
    [reload],
  );

  const doDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setActionId(confirmDelete.id);
    try {
      await hintsAdminApi.delete(confirmDelete.id);
      setConfirmDelete(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed');
    } finally {
      setActionId(null);
    }
  }, [confirmDelete, reload]);

  return (
    <div className="admin-page" data-testid="admin-hints-page">
      <header className="admin-page__header">
        <h1>{t('adminHints.title', 'Hints')}</h1>
        <Link
          to="/admin/hints/new"
          className="admin-page__create-btn"
          data-testid="admin-hints-create"
        >
          {t('adminHints.create', 'New hint')}
        </Link>
      </header>

      <div className="admin-hints__filters" data-testid="admin-hints-filters">
        <label>
          {t('adminHints.filter.enabled', 'Enabled')}
          <select
            value={enabledF}
            onChange={(e) => setEnabledF(e.currentTarget.value as EnabledFilter)}
            data-testid="admin-hints-filter-enabled"
          >
            <option value="any">{t('adminHints.filter.any', 'Any')}</option>
            <option value="on">{t('adminHints.filter.on', 'On')}</option>
            <option value="off">{t('adminHints.filter.off', 'Off')}</option>
          </select>
        </label>
        <label>
          {t('adminHints.filter.anchor', 'Anchor')}
          <select
            value={anchorF}
            onChange={(e) => setAnchorF(e.currentTarget.value)}
            data-testid="admin-hints-filter-anchor"
          >
            <option value="">{t('adminHints.filter.any', 'Any')}</option>
            {HINT_ANCHORS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('adminHints.filter.actor', 'Actor')}
          <select
            value={actorF}
            onChange={(e) => setActorF(e.currentTarget.value as ActorFilter)}
            data-testid="admin-hints-filter-actor"
          >
            <option value="any">{t('adminHints.filter.any', 'Any')}</option>
            <option value="user">user</option>
            <option value="guest">guest</option>
          </select>
        </label>
        <label>
          {t('adminHints.filter.search', 'Search')}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            data-testid="admin-hints-filter-search"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.currentTarget.checked)}
            data-testid="admin-hints-filter-include-deleted"
          />
          {t('adminHints.filter.includeDeleted', 'Show deleted')}
        </label>
      </div>

      {error && (
        <p className="admin-page__error" data-testid="admin-hints-error">
          {error}
        </p>
      )}

      {loading ? (
        <div className="admin-page__loading" data-testid="admin-hints-loading">
          {t('common.loading', 'Loading…')}
        </div>
      ) : items.length === 0 ? (
        <p className="admin-page__empty" data-testid="admin-hints-empty">
          {t('adminHints.empty', 'No hints')}
        </p>
      ) : (
        <table className="admin-table" data-testid="admin-hints-table">
          <thead>
            <tr>
              <th>{t('adminHints.col.key', 'Key')}</th>
              <th>{t('adminHints.col.enabled', 'Enabled')}</th>
              <th>{t('adminHints.col.anchor', 'Anchor')}</th>
              <th>{t('adminHints.col.actors', 'Actors')}</th>
              <th>{t('adminHints.col.priority', 'Priority')}</th>
              <th>{t('adminHints.col.updatedAt', 'Updated')}</th>
              <th>{t('adminHints.col.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const isDeleted = Boolean(row.deletedAt);
              return (
                <tr
                  key={row.id}
                  data-testid={`admin-hints-row-${row.key}`}
                  className={isDeleted ? 'admin-table__row--deleted' : undefined}
                >
                  <td>
                    <Link to={`/admin/hints/${row.id}`}>{row.key}</Link>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={actionId === row.id || isDeleted}
                      onChange={() => void toggleEnabled(row)}
                      data-testid={`admin-hints-toggle-${row.key}`}
                      aria-label={t('adminHints.toggleEnabled', 'Toggle enabled')}
                    />
                  </td>
                  <td>{row.anchor}</td>
                  <td>{row.targetActorTypes.join(', ')}</td>
                  <td>{row.priority}</td>
                  <td>{formatDate(row.updatedAt)}</td>
                  <td>
                    <Link
                      to={`/admin/hints/${row.id}`}
                      data-testid={`admin-hints-edit-${row.key}`}
                    >
                      {t('adminHints.edit', 'Edit')}
                    </Link>
                    {isDeleted ? (
                      <button
                        type="button"
                        onClick={() => void restoreDeleted(row)}
                        disabled={actionId === row.id}
                        data-testid={`admin-hints-restore-${row.key}`}
                      >
                        {t('adminHints.restore', 'Restore')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(row)}
                        disabled={actionId === row.id}
                        data-testid={`admin-hints-delete-${row.key}`}
                      >
                        {t('adminHints.delete', 'Delete')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {confirmDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-hints-delete-title"
          className="admin-modal"
          data-testid="admin-hints-delete-confirm"
        >
          <h2 id="admin-hints-delete-title">
            {t('adminHints.deleteConfirmTitle', 'Delete hint?')}
          </h2>
          <p>
            {t(
              'adminHints.deleteConfirmBody',
              'Soft-delete: the record will be hidden but can be restored later.',
            )}
            {' '}
            <strong>{confirmDelete.key}</strong>
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => void doDelete()}
              disabled={actionId === confirmDelete.id}
              data-testid="admin-hints-delete-confirm-yes"
            >
              {t('adminHints.deleteConfirmYes', 'Yes, delete')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              data-testid="admin-hints-delete-confirm-no"
            >
              {t('adminHints.deleteConfirmNo', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
