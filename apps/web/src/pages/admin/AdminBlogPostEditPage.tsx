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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// KS-4447 / ADR-138 T9. Клиентская валидация обложки. Серверный
// whitelist (BlogMediaService) шире не делаем — должен совпадать.
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
const COVER_ACCEPT = COVER_ALLOWED_MIME.join(',');

interface FormState {
  slug: string;
  locale: BlogLocale;
  title: string;
  description: string;
  bodyMd: string;
  // KS-4447. Текущая обложка статьи (присылается с GET и обновляется
  // ответом T10). Просто URL — отображается как `<img src>` рядом с
  // file-input.
  coverUrl: string;
  // KS-4447. Новый файл, выбранный пользователем в этой сессии. Если
  // не `null` — отправляется в FormData (логика отправки — T10).
  coverFile: File | null;
  // KS-4447. Флаг «убрать текущую обложку» (без замены). Ставится
  // кнопкой «Убрать обложку»; обнуляется выбором нового файла.
  // T10 передаст его на бэк как отдельное поле формы.
  coverReset: boolean;
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
  coverFile: null,
  coverReset: false,
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
          coverFile: null,
          coverReset: false,
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

  // ─── Cover (KS-4447) ───────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  // Объект-URL живёт пока выбран coverFile. На смене файла (или при
  // размонтировании) обязательно revoke — иначе утечка blob в памяти.
  const coverPreviewUrl = useMemo<string | null>(() => {
    if (!form.coverFile) return null;
    return URL.createObjectURL(form.coverFile);
  }, [form.coverFile]);
  useEffect(() => {
    if (!coverPreviewUrl) return;
    return () => {
      URL.revokeObjectURL(coverPreviewUrl);
    };
  }, [coverPreviewUrl]);

  const validateCoverFile = useCallback(
    (file: File): string | null => {
      if (!(COVER_ALLOWED_MIME as readonly string[]).includes(file.type)) {
        return t(
          'admin.blog.edit.coverInvalidMime',
          'Only PNG, JPEG, WebP supported',
        );
      }
      if (file.size > COVER_MAX_BYTES) {
        return t('admin.blog.edit.coverTooLarge', 'File larger than 5 MB');
      }
      return null;
    },
    [t],
  );

  const onCoverFileSelected = useCallback(
    (file: File | null) => {
      if (!file) {
        setForm((prev) => ({ ...prev, coverFile: null }));
        setCoverError(null);
        return;
      }
      const err = validateCoverFile(file);
      if (err) {
        setCoverError(err);
        setForm((prev) => ({ ...prev, coverFile: null }));
        // Сбрасываем сам инпут, чтобы повторный выбор того же файла
        // снова срабатывал.
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      setCoverError(null);
      // Выбор нового файла снимает «убрать обложку» и заменит старую.
      setForm((prev) => ({ ...prev, coverFile: file, coverReset: false }));
    },
    [validateCoverFile],
  );

  const onCoverPickClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onCoverClear = useCallback(() => {
    setCoverError(null);
    setForm((prev) => ({ ...prev, coverFile: null }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const onCoverRemoveExisting = useCallback(() => {
    setCoverError(null);
    setForm((prev) => ({
      ...prev,
      coverFile: null,
      coverReset: true,
    }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const onCoverUndoRemove = useCallback(() => {
    setForm((prev) => ({ ...prev, coverReset: false }));
  }, []);

  const hasExistingCover = Boolean(form.coverUrl) && !form.coverReset;
  const hasNewCover = Boolean(form.coverFile);
  const coverAltRequired = hasNewCover || hasExistingCover;

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

          {/* KS-4447 / ADR-138 T9. Обложка статьи. Состояния:
              — нет старой / новой → только кнопка выбора файла;
              — есть только сохранённая (`coverUrl`) → её img + «Заменить»/«Убрать»;
              — выбрана новая (`coverFile`) → её предпросмотр + «Удалить выбор»;
              — стоит `coverReset` (старую убрали, новой нет) → плашка
                «обложка будет удалена» + кнопка «Отменить».
              Сама отправка multipart — T10. */}
          <div
            className="admin-blog-edit__cover"
            data-testid="admin-blog-edit-cover"
          >
            <div className="admin-blog-edit__cover-label">
              <span>{t('admin.blog.edit.fieldCover', 'Cover image')}</span>
              <span className="admin-blog-edit__cover-hint">
                {t(
                  'admin.blog.edit.coverHint',
                  'PNG / JPEG / WebP, up to 5 MB',
                )}
              </span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={COVER_ACCEPT}
              hidden
              onChange={(e) =>
                onCoverFileSelected(e.target.files?.[0] ?? null)
              }
              data-testid="admin-blog-edit-cover-file"
            />

            {hasNewCover && coverPreviewUrl && (
              <div
                className="admin-blog-edit__cover-preview"
                data-testid="admin-blog-edit-cover-preview-new"
              >
                <img
                  src={coverPreviewUrl}
                  alt={
                    form.coverAlt ||
                    t('admin.blog.edit.coverPreviewAlt', 'Cover preview')
                  }
                />
                <div className="admin-blog-edit__cover-actions">
                  <button
                    type="button"
                    className="play-btn play-btn--compact"
                    onClick={onCoverPickClick}
                  >
                    {t('admin.blog.edit.coverReplace', 'Replace')}
                  </button>
                  <button
                    type="button"
                    className="play-btn play-btn--compact play-btn--ghost"
                    onClick={onCoverClear}
                    data-testid="admin-blog-edit-cover-clear-new"
                  >
                    {t('admin.blog.edit.coverClearNew', 'Discard selection')}
                  </button>
                </div>
              </div>
            )}

            {!hasNewCover && hasExistingCover && (
              <div
                className="admin-blog-edit__cover-preview"
                data-testid="admin-blog-edit-cover-preview-existing"
              >
                <img
                  src={form.coverUrl}
                  alt={
                    form.coverAlt ||
                    t('admin.blog.edit.coverCurrentAlt', 'Current cover')
                  }
                />
                <div className="admin-blog-edit__cover-actions">
                  <button
                    type="button"
                    className="play-btn play-btn--compact"
                    onClick={onCoverPickClick}
                  >
                    {t('admin.blog.edit.coverReplace', 'Replace')}
                  </button>
                  <button
                    type="button"
                    className="play-btn play-btn--compact play-btn--danger"
                    onClick={onCoverRemoveExisting}
                    data-testid="admin-blog-edit-cover-remove"
                  >
                    {t('admin.blog.edit.coverRemove', 'Remove cover')}
                  </button>
                </div>
              </div>
            )}

            {!hasNewCover && !hasExistingCover && form.coverReset && (
              <div
                className="admin-blog-edit__cover-reset-notice"
                data-testid="admin-blog-edit-cover-reset-notice"
              >
                <span>
                  {t(
                    'admin.blog.edit.coverResetNotice',
                    'Cover will be removed on save.',
                  )}
                </span>
                <button
                  type="button"
                  className="play-btn play-btn--compact play-btn--ghost"
                  onClick={onCoverUndoRemove}
                >
                  {t('admin.blog.edit.coverResetUndo', 'Undo')}
                </button>
              </div>
            )}

            {!hasNewCover && !hasExistingCover && !form.coverReset && (
              <button
                type="button"
                className="play-btn play-btn--compact"
                onClick={onCoverPickClick}
                data-testid="admin-blog-edit-cover-pick"
              >
                {t('admin.blog.edit.coverPick', 'Choose file')}
              </button>
            )}

            {coverError && (
              <p
                className="admin-blog-edit__cover-error"
                data-testid="admin-blog-edit-cover-error"
              >
                {coverError}
              </p>
            )}

            <label className="admin-blog-edit__cover-alt">
              <span>
                {t('admin.blog.edit.fieldCoverAlt', 'Cover alt')}
                {coverAltRequired && ' *'}
              </span>
              <input
                type="text"
                value={form.coverAlt}
                onChange={(e) => update('coverAlt', e.target.value)}
                maxLength={500}
                required={coverAltRequired}
                data-testid="admin-blog-edit-cover-alt"
              />
              <span className="admin-blog-edit__cover-hint">
                {coverAltRequired
                  ? t(
                      'admin.blog.edit.coverAltRequired',
                      'Alt text is required when an image is attached.',
                    )
                  : t(
                      'admin.blog.edit.coverAltOptional',
                      'Optional when there is no image.',
                    )}
              </span>
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
