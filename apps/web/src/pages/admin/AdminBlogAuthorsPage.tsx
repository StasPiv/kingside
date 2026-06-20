/**
 * KS-4420 / ADR-137 rev2 T11. Список авторов блога
 * `/admin/blog/authors`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { BlogAuthor } from '@kingside/shared';

import { blogAdminApi } from '../../api/api-blog';

export function AdminBlogAuthorsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [items, setItems] = useState<BlogAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    blogAdminApi
      .listAuthors()
      .then((res) => {
        if (cancelled) return;
        setItems(Array.isArray(res) ? res : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const handleDelete = useCallback(
    async (a: BlogAuthor) => {
      const confirmText = t(
        'admin.blog.authors.deleteConfirm',
        'Delete author «{{name}}»? Articles with this author must be reassigned first.',
        { name: a.nameRu },
      );
      if (!window.confirm(confirmText)) return;
      setDeletingId(a.id);
      try {
        await blogAdminApi.deleteAuthor(a.id);
        setReloadKey((k) => k + 1);
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'Delete failed');
      } finally {
        setDeletingId(null);
      }
    },
    [t],
  );

  return (
    <div className="admin-blog-page" data-testid="admin-blog-authors">
      <header className="admin-blog-page__header">
        <div>
          <h1>{t('admin.blog.authors.title', 'Blog · Authors')}</h1>
          <p className="admin-blog-page__subtitle">
            {t(
              'admin.blog.authors.subtitle',
              'Profiles shown next to articles and in JSON-LD Author.',
            )}
          </p>
        </div>
        <div className="admin-blog-page__actions">
          <Link
            to="/admin/blog/authors/new"
            className="play-btn play-btn--compact"
            data-testid="admin-blog-authors-new"
          >
            + {t('admin.blog.authors.new', 'New author')}
          </Link>
          <Link
            to="/admin/blog/posts"
            className="play-btn play-btn--compact play-btn--ghost"
          >
            {t('admin.blog.authors.openPosts', 'Manage posts')}
          </Link>
        </div>
      </header>

      {loading && <p className="loading">{t('common.loading')}</p>}
      {error && (
        <p className="error" data-testid="admin-blog-authors-error">
          {error}
        </p>
      )}

      {!loading && !error && items.length === 0 && (
        <p data-testid="admin-blog-authors-empty">
          {t('admin.blog.authors.empty', 'No authors yet.')}
        </p>
      )}

      {items.length > 0 && (
        <table className="admin-blog-table" data-testid="admin-blog-authors-table">
          <thead>
            <tr>
              <th>{t('admin.blog.authors.colHandle', 'Handle')}</th>
              <th>{t('admin.blog.authors.colNameRu', 'Name (ru)')}</th>
              <th>{t('admin.blog.authors.colNameEn', 'Name (en)')}</th>
              <th>{t('admin.blog.authors.colAvatar', 'Avatar')}</th>
              <th aria-label={t('admin.blog.authors.colActions', 'Actions')}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} data-testid={`admin-blog-authors-row-${a.id}`}>
                <td>
                  <code>@{a.handle}</code>
                </td>
                <td>{a.nameRu}</td>
                <td>{a.nameEn}</td>
                <td>
                  {a.avatarUrl ? (
                    <img
                      src={a.avatarUrl}
                      alt=""
                      className="admin-blog-table__avatar"
                      loading="lazy"
                    />
                  ) : (
                    '—'
                  )}
                </td>
                <td className="admin-blog-table__row-actions">
                  <button
                    type="button"
                    className="play-btn play-btn--compact"
                    onClick={() => navigate(`/admin/blog/authors/${a.id}`)}
                  >
                    {t('admin.blog.authors.edit', 'Edit')}
                  </button>
                  <button
                    type="button"
                    className="play-btn play-btn--compact play-btn--danger"
                    disabled={deletingId === a.id}
                    onClick={() => void handleDelete(a)}
                  >
                    {deletingId === a.id
                      ? t('admin.blog.authors.deleting', '…')
                      : t('admin.blog.authors.delete', 'Delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
