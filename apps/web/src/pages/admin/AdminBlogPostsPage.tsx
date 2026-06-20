/**
 * KS-4420 / ADR-137 rev2 T11. Админ-список статей блога
 * `/admin/blog/posts`.
 *
 * Источник — `GET /admin/blog/posts` (backend, KS-4410). Защита
 * маршрута — `<AdminRoute>` в `App.tsx` + `AdminUserGuard` на бэке.
 *
 * UI:
 *   - таблица: title, locale, status, publishedAt, updatedAt, tags;
 *   - фильтры: status, locale, tag (tag-фильтр на стороне API не
 *     поддержан — фильтруем массив `tags` после ответа);
 *   - кнопка «Создать статью» → `/admin/blog/posts/new`;
 *   - клик по строке → `/admin/blog/posts/:id`;
 *   - кнопка «Удалить» с подтверждением → `DELETE /admin/blog/posts/:id`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  BlogLocale,
  BlogPostAdmin,
  BlogPostStatus,
} from '@kingside/shared';

import { blogAdminApi } from '../../api/api-blog';

type StatusFilter = '' | BlogPostStatus;
type LocaleFilter = '' | BlogLocale;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminBlogPostsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [items, setItems] = useState<BlogPostAdmin[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusF, setStatusF] = useState<StatusFilter>('');
  const [localeF, setLocaleF] = useState<LocaleFilter>('');
  const [tagF, setTagF] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    blogAdminApi
      .listPosts({
        status: statusF || undefined,
        locale: localeF || undefined,
        page,
      })
      .then((res) => {
        if (cancelled) return;
        setItems(Array.isArray(res?.items) ? res.items : []);
        setTotalPages(Number.isFinite(res?.totalPages) ? res.totalPages : 1);
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
  }, [statusF, localeF, page, reloadKey]);

  // Tag-фильтр клиентский (backend не принимает).
  const filteredItems = useMemo(() => {
    const tag = tagF.trim().toLowerCase();
    if (!tag) return items;
    return items.filter((it) =>
      it.tags.some((x) => x.toLowerCase() === tag),
    );
  }, [items, tagF]);

  const handleDelete = useCallback(
    async (post: BlogPostAdmin) => {
      const confirmText = t(
        'admin.blog.posts.deleteConfirm',
        'Delete article «{{title}}»? This cannot be undone.',
        { title: post.title },
      );
      if (!window.confirm(confirmText)) return;
      setDeletingId(post.id);
      try {
        await blogAdminApi.deletePost(post.id);
        setReloadKey((k) => k + 1);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Delete failed';
        window.alert(msg);
      } finally {
        setDeletingId(null);
      }
    },
    [t],
  );

  return (
    <div className="admin-blog-page" data-testid="admin-blog-posts">
      <header className="admin-blog-page__header">
        <div>
          <h1>{t('admin.blog.posts.title', 'Blog · Posts')}</h1>
          <p className="admin-blog-page__subtitle">
            {t(
              'admin.blog.posts.subtitle',
              'Create, edit and publish articles. Source of truth — the database.',
            )}
          </p>
        </div>
        <div className="admin-blog-page__actions">
          <Link
            to="/admin/blog/posts/new"
            className="play-btn play-btn--compact"
            data-testid="admin-blog-posts-new"
          >
            + {t('admin.blog.posts.new', 'New article')}
          </Link>
          <Link
            to="/admin/blog/authors"
            className="play-btn play-btn--compact play-btn--ghost"
          >
            {t('admin.blog.posts.openAuthors', 'Manage authors')}
          </Link>
        </div>
      </header>

      <div className="admin-blog-page__filters">
        <label>
          <span>{t('admin.blog.posts.filterStatus', 'Status')}</span>
          <select
            value={statusF}
            onChange={(e) => {
              setStatusF(e.target.value as StatusFilter);
              setPage(1);
            }}
            data-testid="admin-blog-posts-filter-status"
          >
            <option value="">{t('admin.blog.posts.filterAll', 'All')}</option>
            <option value="draft">{t('admin.blog.posts.statusDraft', 'Draft')}</option>
            <option value="published">
              {t('admin.blog.posts.statusPublished', 'Published')}
            </option>
          </select>
        </label>
        <label>
          <span>{t('admin.blog.posts.filterLocale', 'Locale')}</span>
          <select
            value={localeF}
            onChange={(e) => {
              setLocaleF(e.target.value as LocaleFilter);
              setPage(1);
            }}
            data-testid="admin-blog-posts-filter-locale"
          >
            <option value="">{t('admin.blog.posts.filterAll', 'All')}</option>
            <option value="ru">ru</option>
            <option value="en">en</option>
          </select>
        </label>
        <label>
          <span>{t('admin.blog.posts.filterTag', 'Tag')}</span>
          <input
            type="text"
            value={tagF}
            onChange={(e) => setTagF(e.target.value)}
            placeholder={t('admin.blog.posts.filterTagPlaceholder', 'e.g. analysis')}
            data-testid="admin-blog-posts-filter-tag"
          />
        </label>
      </div>

      {loading && (
        <p className="loading" data-testid="admin-blog-posts-loading">
          {t('common.loading')}
        </p>
      )}

      {error && (
        <p className="error" data-testid="admin-blog-posts-error">
          {error}
        </p>
      )}

      {!loading && !error && filteredItems.length === 0 && (
        <p data-testid="admin-blog-posts-empty">
          {t('admin.blog.posts.empty', 'No posts match the filters.')}
        </p>
      )}

      {filteredItems.length > 0 && (
        <table
          className="admin-blog-table"
          data-testid="admin-blog-posts-table"
        >
          <thead>
            <tr>
              <th>{t('admin.blog.posts.colTitle', 'Title')}</th>
              <th>{t('admin.blog.posts.colLocale', 'Locale')}</th>
              <th>{t('admin.blog.posts.colStatus', 'Status')}</th>
              <th>{t('admin.blog.posts.colPublishedAt', 'Published')}</th>
              <th>{t('admin.blog.posts.colUpdatedAt', 'Updated')}</th>
              <th>{t('admin.blog.posts.colTags', 'Tags')}</th>
              <th aria-label={t('admin.blog.posts.colActions', 'Actions')}></th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((post) => (
              <tr
                key={post.id}
                data-testid={`admin-blog-posts-row-${post.id}`}
                data-status={post.status}
              >
                <td>
                  <Link
                    to={`/admin/blog/posts/${post.id}`}
                    className="admin-blog-table__title-link"
                  >
                    {post.title}
                  </Link>
                  <div className="admin-blog-table__slug">/{post.slug}</div>
                </td>
                <td>{post.locale}</td>
                <td>
                  <span
                    className={`admin-blog-status admin-blog-status--${post.status}`}
                  >
                    {post.status === 'published'
                      ? t('admin.blog.posts.statusPublished', 'Published')
                      : t('admin.blog.posts.statusDraft', 'Draft')}
                  </span>
                </td>
                <td>{formatDate(post.publishedAt)}</td>
                <td>{formatDate(post.updatedAt)}</td>
                <td>
                  {post.tags.length > 0 ? (
                    <div className="admin-blog-table__tags">
                      {post.tags.map((tag) => (
                        <span key={tag} className="admin-blog-table__tag">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="admin-blog-table__row-actions">
                  <button
                    type="button"
                    className="play-btn play-btn--compact"
                    onClick={() => navigate(`/admin/blog/posts/${post.id}`)}
                  >
                    {t('admin.blog.posts.edit', 'Edit')}
                  </button>
                  <button
                    type="button"
                    className="play-btn play-btn--compact play-btn--danger"
                    disabled={deletingId === post.id}
                    onClick={() => void handleDelete(post)}
                    data-testid={`admin-blog-posts-delete-${post.id}`}
                  >
                    {deletingId === post.id
                      ? t('admin.blog.posts.deleting', '…')
                      : t('admin.blog.posts.delete', 'Delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <nav
          className="admin-blog-page__pagination"
          aria-label={t('admin.blog.posts.paginationLabel', 'Pagination')}
        >
          <button
            type="button"
            className="play-btn play-btn--compact"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← {t('admin.blog.posts.prev', 'Prev')}
          </button>
          <span>
            {t('admin.blog.posts.pageOf', 'Page {{page}} of {{total}}', {
              page,
              total: totalPages,
            })}
          </span>
          <button
            type="button"
            className="play-btn play-btn--compact"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            {t('admin.blog.posts.next', 'Next')} →
          </button>
        </nav>
      )}
    </div>
  );
}
