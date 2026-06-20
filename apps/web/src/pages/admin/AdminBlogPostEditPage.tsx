/**
 * KS-4420 / ADR-137 rev2 T11. Создание / правка статьи блога.
 * Маршруты:
 *   `/admin/blog/posts/new`    — режим create;
 *   `/admin/blog/posts/:id`    — режим edit.
 *
 * Источники:
 *   - `GET /admin/blog/posts/:id` (edit) — `BlogPostAdmin`;
 *   - `GET /admin/blog/authors` — выбор автора;
 *   - `POST /admin/blog/posts/preview` (debounce 500ms) — bodyHtml для
 *     предпросмотра. Используем серверный рендер, чтобы превью точно
 *     совпало с публичной страницей (та же `unified + rehype-sanitize`
 *     цепочка, ADR-137 rev2 §1).
 *
 * Сохранение: `POST /admin/blog/posts` или `PUT /admin/blog/posts/:id`.
 * Если `status=published` и `publishedAt` не задан — backend
 * проставит `now()`.
 *
 * slug: при пустом значении в режиме create — автогенерация из
 * `title` (kebab-case, латиница). Пользователь может перезаписать.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  BlogAuthor,
  BlogLocale,
  BlogPostStatus,
} from '@kingside/shared';

import {
  blogAdminApi,
  type CreateBlogPostInput,
  type UpdateBlogPostInput,
} from '../../api/api-blog';

const PREVIEW_DEBOUNCE_MS = 500;

interface FormState {
  slug: string;
  locale: BlogLocale;
  title: string;
  description: string;
  bodyMd: string;
  coverUrl: string;
  coverAlt: string;
  tags: string; // comma-separated в UI; в API уходит string[]
  relatedRoute: string;
  authorId: string;
  status: BlogPostStatus;
  publishedAt: string;
}

const EMPTY: FormState = {
  slug: '',
  locale: 'ru',
  title: '',
  description: '',
  bodyMd: '',
  coverUrl: '',
  coverAlt: '',
  tags: '',
  relatedRoute: '',
  authorId: '',
  status: 'draft',
  publishedAt: '',
};

/** title → slug: латиница из транслитерации сложна, но для простых
 *  английских заголовков и так подходит; пользователь правит вручную
 *  если нужно (ru/en слаги в любом случае пишет редактор). */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 200);
}

function tagsFromString(input: string): string[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function AdminBlogPostEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id && id !== 'new');

  const [form, setForm] = useState<FormState>(EMPTY);
  const [authors, setAuthors] = useState<BlogAuthor[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [slugAutoFromTitle, setSlugAutoFromTitle] = useState(!isEdit);

  // ─── Loaders ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    blogAdminApi
      .listAuthors()
      .then((res) => {
        if (cancelled) return;
        setAuthors(Array.isArray(res) ? res : []);
      })
      .catch(() => {
        /* список авторов не критичен для рендера формы */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    blogAdminApi
      .getPost(id)
      .then((res) => {
        if (cancelled) return;
        setForm({
          slug: res.slug,
          locale: res.locale,
          title: res.title,
          description: res.description,
          bodyMd: res.bodyMd,
          coverUrl: res.coverUrl ?? '',
          coverAlt: res.coverAlt ?? '',
          tags: res.tags.join(', '),
          relatedRoute: res.relatedRoute ?? '',
          authorId: res.authorId,
          status: res.status,
          publishedAt: res.publishedAt ?? '',
        });
        setSlugAutoFromTitle(false);
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

  // ─── Preview (debounce) ────────────────────────────────────────────
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    const body = form.bodyMd;
    if (!body || !body.trim()) {
      setPreviewHtml('');
      setPreviewError(null);
      return;
    }
    setPreviewing(true);
    const handle = window.setTimeout(() => {
      blogAdminApi
        .previewMarkdown(body)
        .then((res) => {
          setPreviewHtml(res.bodyHtml ?? '');
          setPreviewError(null);
        })
        .catch((e) => {
          setPreviewError(e instanceof Error ? e.message : 'Preview failed');
        })
        .finally(() => setPreviewing(false));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [form.bodyMd]);

  // ─── Handlers ──────────────────────────────────────────────────────
  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const onTitleChange = useCallback(
    (value: string) => {
      setForm((prev) => {
        const next = { ...prev, title: value };
        if (slugAutoFromTitle) next.slug = slugifyTitle(value);
        return next;
      });
    },
    [slugAutoFromTitle],
  );

  const onSlugChange = useCallback((value: string) => {
    setSlugAutoFromTitle(false);
    setForm((prev) => ({ ...prev, slug: value }));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setSaveError(null);

      const payload: CreateBlogPostInput = {
        slug: form.slug.trim(),
        locale: form.locale,
        title: form.title.trim(),
        description: form.description.trim(),
        bodyMd: form.bodyMd,
        authorId: form.authorId,
        status: form.status,
        tags: tagsFromString(form.tags),
      };
      if (form.coverUrl.trim()) payload.coverUrl = form.coverUrl.trim();
      if (form.coverAlt.trim()) payload.coverAlt = form.coverAlt.trim();
      if (form.relatedRoute.trim()) payload.relatedRoute = form.relatedRoute.trim();
      if (form.publishedAt.trim()) payload.publishedAt = form.publishedAt.trim();

      try {
        if (isEdit && id) {
          const update: UpdateBlogPostInput = payload;
          await blogAdminApi.updatePost(id, update);
        } else {
          const created = await blogAdminApi.createPost(payload);
          navigate(`/admin/blog/posts/${created.id}`, { replace: true });
          return;
        }
        // на edit — остаёмся, чтобы можно было править дальше
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [form, id, isEdit, navigate],
  );

  const authorOptions = useMemo(
    () =>
      authors.map((a) => ({
        value: a.id,
        label: `${a.nameRu} / ${a.nameEn} (@${a.handle})`,
      })),
    [authors],
  );

  // ─── Render ────────────────────────────────────────────────────────
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
        <p className="error" data-testid="admin-blog-edit-load-error">
          {loadError}
        </p>
        <Link to="/admin/blog/posts" className="play-btn play-btn--compact">
          ← {t('admin.blog.posts.back', 'Back to list')}
        </Link>
      </div>
    );
  }

  return (
    <div className="admin-blog-page admin-blog-edit" data-testid="admin-blog-edit">
      <header className="admin-blog-page__header">
        <div>
          <h1>
            {isEdit
              ? t('admin.blog.edit.titleEdit', 'Edit post')
              : t('admin.blog.edit.titleNew', 'New post')}
          </h1>
          {isEdit && form.slug && (
            <p className="admin-blog-page__subtitle">
              <Link to={`/blog/${form.slug}`} target="_blank" rel="noreferrer">
                /blog/{form.slug}
              </Link>
            </p>
          )}
        </div>
        <Link
          to="/admin/blog/posts"
          className="play-btn play-btn--compact play-btn--ghost"
        >
          ← {t('admin.blog.posts.back', 'Back to list')}
        </Link>
      </header>

      <form
        className="admin-blog-edit__layout"
        onSubmit={(e) => void handleSubmit(e)}
        data-testid="admin-blog-edit-form"
      >
        <div className="admin-blog-edit__fields">
          <label>
            <span>{t('admin.blog.edit.fieldTitle', 'Title')}</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => onTitleChange(e.target.value)}
              required
              maxLength={300}
              data-testid="admin-blog-edit-title"
            />
          </label>

          <div className="admin-blog-edit__row">
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldSlug', 'Slug')}</span>
              <input
                type="text"
                value={form.slug}
                onChange={(e) => onSlugChange(e.target.value)}
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={200}
                data-testid="admin-blog-edit-slug"
              />
            </label>
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldLocale', 'Locale')}</span>
              <select
                value={form.locale}
                onChange={(e) => update('locale', e.target.value as BlogLocale)}
                data-testid="admin-blog-edit-locale"
              >
                <option value="ru">ru</option>
                <option value="en">en</option>
              </select>
            </label>
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldStatus', 'Status')}</span>
              <select
                value={form.status}
                onChange={(e) => update('status', e.target.value as BlogPostStatus)}
                data-testid="admin-blog-edit-status"
              >
                <option value="draft">
                  {t('admin.blog.posts.statusDraft', 'Draft')}
                </option>
                <option value="published">
                  {t('admin.blog.posts.statusPublished', 'Published')}
                </option>
              </select>
            </label>
          </div>

          <label>
            <span>{t('admin.blog.edit.fieldDescription', 'Description')}</span>
            <textarea
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              required
              rows={3}
              maxLength={500}
              data-testid="admin-blog-edit-description"
            />
          </label>

          <label>
            <span>{t('admin.blog.edit.fieldAuthor', 'Author')}</span>
            <select
              value={form.authorId}
              onChange={(e) => update('authorId', e.target.value)}
              required
              data-testid="admin-blog-edit-author"
            >
              <option value="" disabled>
                {t('admin.blog.edit.authorPlaceholder', '— choose —')}
              </option>
              {authorOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <div className="admin-blog-edit__row">
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldCoverUrl', 'Cover URL')}</span>
              <input
                type="text"
                value={form.coverUrl}
                onChange={(e) => update('coverUrl', e.target.value)}
                maxLength={2000}
                data-testid="admin-blog-edit-cover-url"
              />
            </label>
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldCoverAlt', 'Cover alt')}</span>
              <input
                type="text"
                value={form.coverAlt}
                onChange={(e) => update('coverAlt', e.target.value)}
                maxLength={500}
                data-testid="admin-blog-edit-cover-alt"
              />
            </label>
          </div>

          <div className="admin-blog-edit__row">
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldTags', 'Tags (comma-separated)')}</span>
              <input
                type="text"
                value={form.tags}
                onChange={(e) => update('tags', e.target.value)}
                placeholder="analysis, openings, engine"
                data-testid="admin-blog-edit-tags"
              />
            </label>
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldRelated', 'Related route')}</span>
              <input
                type="text"
                value={form.relatedRoute}
                onChange={(e) => update('relatedRoute', e.target.value)}
                placeholder="/critical-moment"
                maxLength={500}
                data-testid="admin-blog-edit-related"
              />
            </label>
            <label className="admin-blog-edit__row-item">
              <span>{t('admin.blog.edit.fieldPublishedAt', 'Published at (ISO)')}</span>
              <input
                type="text"
                value={form.publishedAt}
                onChange={(e) => update('publishedAt', e.target.value)}
                placeholder="2026-06-20T10:00:00Z"
                data-testid="admin-blog-edit-published-at"
              />
            </label>
          </div>

          <div className="admin-blog-edit__markdown">
            <label className="admin-blog-edit__markdown-input">
              <span>{t('admin.blog.edit.fieldBody', 'Body (Markdown)')}</span>
              <textarea
                value={form.bodyMd}
                onChange={(e) => update('bodyMd', e.target.value)}
                required
                rows={20}
                data-testid="admin-blog-edit-body"
              />
            </label>
            <div className="admin-blog-edit__markdown-preview" data-testid="admin-blog-edit-preview">
              <div className="admin-blog-edit__preview-head">
                <span>{t('admin.blog.edit.previewTitle', 'Preview')}</span>
                {previewing && (
                  <span className="admin-blog-edit__preview-status">
                    {t('admin.blog.edit.previewLoading', 'Rendering…')}
                  </span>
                )}
                {previewError && (
                  <span
                    className="admin-blog-edit__preview-error"
                    data-testid="admin-blog-edit-preview-error"
                  >
                    {previewError}
                  </span>
                )}
              </div>
              <div
                className="blog-article__body admin-blog-edit__preview-body"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
              {!previewHtml && !previewing && !previewError && (
                <p className="admin-blog-edit__preview-empty">
                  {t(
                    'admin.blog.edit.previewEmpty',
                    'Start typing Markdown — preview appears here.',
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        <footer className="admin-blog-edit__footer">
          {saveError && (
            <p className="error" data-testid="admin-blog-edit-save-error">
              {saveError}
            </p>
          )}
          <button
            type="submit"
            className="play-btn"
            disabled={saving}
            data-testid="admin-blog-edit-save"
          >
            {saving
              ? t('admin.blog.edit.saving', 'Saving…')
              : isEdit
                ? t('admin.blog.edit.save', 'Save')
                : t('admin.blog.edit.create', 'Create')}
          </button>
        </footer>
      </form>
    </div>
  );
}
