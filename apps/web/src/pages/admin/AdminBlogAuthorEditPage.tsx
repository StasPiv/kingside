/**
 * KS-4420 / ADR-137 rev2 T11. Создание / правка автора блога.
 * Маршруты:
 *   `/admin/blog/authors/new`
 *   `/admin/blog/authors/:id`
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  blogAdminApi,
  type CreateBlogAuthorInput,
  type UpdateBlogAuthorInput,
} from '../../api/api-blog';

interface AuthorFormState {
  handle: string;
  nameRu: string;
  nameEn: string;
  avatarUrl: string;
  bioRu: string;
  bioEn: string;
}

const EMPTY: AuthorFormState = {
  handle: '',
  nameRu: '',
  nameEn: '',
  avatarUrl: '',
  bioRu: '',
  bioEn: '',
};

export function AdminBlogAuthorEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id && id !== 'new');

  const [form, setForm] = useState<AuthorFormState>(EMPTY);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    blogAdminApi
      .getAuthor(id)
      .then((res) => {
        if (cancelled) return;
        setForm({
          handle: res.handle,
          nameRu: res.nameRu,
          nameEn: res.nameEn,
          avatarUrl: res.avatarUrl ?? '',
          bioRu: res.bioRu ?? '',
          bioEn: res.bioEn ?? '',
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isEdit]);

  const update = useCallback(
    <K extends keyof AuthorFormState>(key: K, value: AuthorFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setSaveError(null);
      const payload: CreateBlogAuthorInput = {
        handle: form.handle.trim(),
        nameRu: form.nameRu.trim(),
        nameEn: form.nameEn.trim(),
      };
      if (form.avatarUrl.trim()) payload.avatarUrl = form.avatarUrl.trim();
      if (form.bioRu.trim()) payload.bioRu = form.bioRu.trim();
      if (form.bioEn.trim()) payload.bioEn = form.bioEn.trim();
      try {
        if (isEdit && id) {
          const update: UpdateBlogAuthorInput = payload;
          await blogAdminApi.updateAuthor(id, update);
        } else {
          const created = await blogAdminApi.createAuthor(payload);
          navigate(`/admin/blog/authors/${created.id}`, { replace: true });
          return;
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [form, id, isEdit, navigate],
  );

  if (loading) {
    return (
      <div className="admin-blog-page">
        <p className="loading">{t('common.loading')}</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="admin-blog-page">
        <p className="error">{loadError}</p>
        <Link to="/admin/blog/authors" className="play-btn play-btn--compact">
          ← {t('admin.blog.authors.back', 'Back to list')}
        </Link>
      </div>
    );
  }

  return (
    <div className="admin-blog-page admin-blog-edit" data-testid="admin-blog-author-edit">
      <header className="admin-blog-page__header">
        <h1>
          {isEdit
            ? t('admin.blog.authors.titleEdit', 'Edit author')
            : t('admin.blog.authors.titleNew', 'New author')}
        </h1>
        <Link
          to="/admin/blog/authors"
          className="play-btn play-btn--compact play-btn--ghost"
        >
          ← {t('admin.blog.authors.back', 'Back to list')}
        </Link>
      </header>

      <form
        className="admin-blog-edit__layout"
        onSubmit={(e) => void handleSubmit(e)}
        data-testid="admin-blog-author-edit-form"
      >
        <div className="admin-blog-edit__fields">
          <label>
            <span>{t('admin.blog.authors.fieldHandle', 'Handle (slug)')}</span>
            <input
              type="text"
              value={form.handle}
              onChange={(e) => update('handle', e.target.value)}
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              maxLength={100}
              data-testid="admin-blog-author-handle"
            />
          </label>
          <div className="admin-blog-edit__row">
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.authors.fieldNameRu', 'Name (ru)')}</span>
              <input
                type="text"
                value={form.nameRu}
                onChange={(e) => update('nameRu', e.target.value)}
                required
                maxLength={200}
                data-testid="admin-blog-author-name-ru"
              />
            </label>
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.authors.fieldNameEn', 'Name (en)')}</span>
              <input
                type="text"
                value={form.nameEn}
                onChange={(e) => update('nameEn', e.target.value)}
                required
                maxLength={200}
                data-testid="admin-blog-author-name-en"
              />
            </label>
          </div>
          <label>
            <span>{t('admin.blog.authors.fieldAvatar', 'Avatar URL')}</span>
            <input
              type="text"
              value={form.avatarUrl}
              onChange={(e) => update('avatarUrl', e.target.value)}
              maxLength={2000}
              data-testid="admin-blog-author-avatar"
            />
          </label>
          <label>
            <span>{t('admin.blog.authors.fieldBioRu', 'Bio (ru)')}</span>
            <textarea
              value={form.bioRu}
              onChange={(e) => update('bioRu', e.target.value)}
              rows={3}
              maxLength={2000}
              data-testid="admin-blog-author-bio-ru"
            />
          </label>
          <label>
            <span>{t('admin.blog.authors.fieldBioEn', 'Bio (en)')}</span>
            <textarea
              value={form.bioEn}
              onChange={(e) => update('bioEn', e.target.value)}
              rows={3}
              maxLength={2000}
              data-testid="admin-blog-author-bio-en"
            />
          </label>
        </div>
        <footer className="admin-blog-edit__footer">
          {saveError && (
            <p className="error" data-testid="admin-blog-author-edit-save-error">
              {saveError}
            </p>
          )}
          <button
            type="submit"
            className="play-btn"
            disabled={saving}
            data-testid="admin-blog-author-edit-save"
          >
            {saving
              ? t('admin.blog.authors.saving', 'Saving…')
              : isEdit
                ? t('admin.blog.authors.save', 'Save')
                : t('admin.blog.authors.create', 'Create')}
          </button>
        </footer>
      </form>
    </div>
  );
}
