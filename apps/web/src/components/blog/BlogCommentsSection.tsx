/**
 * KS-4476 / ADR-140 §3 T10. Лента комментариев под телом статьи блога.
 *
 * Содержит:
 *   - первичный `GET /blog/posts/:id/comments?limit=20` при mount;
 *   - cursor-пагинация через «Показать ещё» (если `nextCursor != null`);
 *   - форму создания (Textarea 2..2000 символов + счётчик; гостю —
 *     CTA с приглашением залогиниться через `useRequireAuth`);
 *   - inline-edit по кнопке «Edit» в окне 15 мин (`canEdit` приходит
 *     от бэка); 403 на `PATCH` → toast «Время редактирования истекло»;
 *   - soft-delete с confirm-диалогом (`canDelete` приходит от бэка),
 *     удалённая запись остаётся в ленте плашкой «Комментарий удалён».
 *
 * Гостю кнопки Edit/Delete не приходят — фронт ничего не гейтит сам:
 * флаги `canEdit/canDelete` уже учитывают и авторство, и окно 15 мин,
 * и роль админа. Дублировать те же проверки на фронте смысла нет.
 *
 * Тосты внутри компонента (не общий `RequireAuth`-toast): отказы
 * специфичны для комментариев (403 «окно закрылось», ошибка
 * отправки и т. п.), общий guest-401-canal сюда не подходит.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { blogApi } from '../../api/api-blog';
import { ApiError } from '../../ApiError';
import { useAuth } from '../../context/AuthContext';
import { useRequireAuth } from '../../context/RequireAuthContext';
import type { BlogComment, BlogLocale } from '@kingside/shared';

export interface BlogCommentsSectionProps {
  postId: string;
  /** Стартовый счётчик из `BlogPostDetail.commentsCount` (для заголовка). */
  initialCommentsCount: number;
  /** Локаль страницы (для форматирования дат, ссылок). */
  locale: BlogLocale;
}

// KS-4476. Валидация совпадает с backend DTO (`CreateBlogCommentDto`,
// `UpdateBlogCommentDto`): 2..2000 символов. Дублируем константой, а
// не импортируем из shared — длины не меняются и не нужны бекенду
// клиенту общим источником.
const MIN_LEN = 2;
const MAX_LEN = 2000;
const PAGE_SIZE = 20;
const TOAST_DISMISS_MS = 5000;

/* ── относительная дата (минуты/часы/дни/абс. дата) ──────────────── */

const MS_IN_MIN = 60 * 1000;
const MS_IN_HOUR = 60 * MS_IN_MIN;
const MS_IN_DAY = 24 * MS_IN_HOUR;

function formatRelative(
  iso: string,
  now: number,
  locale: BlogLocale,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Math.max(0, now - ts);
  if (diff < MS_IN_MIN) {
    return t('blog.comments.justNow', { defaultValue: 'just now' });
  }
  if (diff < MS_IN_HOUR) {
    return t('blog.comments.minutesAgo', {
      count: Math.floor(diff / MS_IN_MIN),
      defaultValue: '{{count}} min ago',
    });
  }
  if (diff < MS_IN_DAY) {
    return t('blog.comments.hoursAgo', {
      count: Math.floor(diff / MS_IN_HOUR),
      defaultValue: '{{count}}h ago',
    });
  }
  const days = Math.floor(diff / MS_IN_DAY);
  if (days <= 30) {
    return t('blog.comments.daysAgo', {
      count: days,
      defaultValue: '{{count}}d ago',
    });
  }
  try {
    return new Date(ts).toLocaleDateString(
      locale === 'ru' ? 'ru-RU' : 'en-US',
      { day: 'numeric', month: 'short', year: 'numeric' },
    );
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/* ── автолинки + перевод строк → JSX ─────────────────────────────── */

const URL_REGEX = /(https?:\/\/[^\s<]+)/gi;

/**
 * Превращает `body` (plain text после backend-санитации) в массив
 * JSX-нод: `\n` → `<br/>`, http(s)-URL'ы → `<a>`. Без `dangerouslySet
 * InnerHTML` — экранирование делает React сам, инъекция невозможна.
 */
function renderBody(body: string): React.ReactNode[] {
  const lines = body.split('\n');
  const nodes: React.ReactNode[] = [];
  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) nodes.push(<br key={`br-${lineIdx}`} />);
    const parts = line.split(URL_REGEX);
    parts.forEach((part, partIdx) => {
      if (URL_REGEX.test(part)) {
        nodes.push(
          <a
            key={`a-${lineIdx}-${partIdx}`}
            href={part}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {part}
          </a>,
        );
        URL_REGEX.lastIndex = 0; // глобал regex держит state — сброс
      } else if (part) {
        nodes.push(part);
      }
    });
  });
  return nodes;
}

/* ── основной компонент ──────────────────────────────────────────── */

export function BlogCommentsSection({
  postId,
  initialCommentsCount,
  locale,
}: BlogCommentsSectionProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const requireAuth = useRequireAuth();

  // Лента. Источник правды — bъ̈кенд: каждый ответ заменяет соответст-
  // вующую запись целиком (включая `canEdit/canDelete`).
  const [items, setItems] = useState<BlogComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Счётчик в заголовке — показываем initial (из `BlogPostDetail`)
  // плюс/минус локальные правки. Backend-счётчик `comments_count` от
  // момента загрузки страницы не апдейтит лента, поэтому корректнее
  // считать локально: +1 на каждый созданный, -1 на каждое успешное
  // удаление НЕ-удалённого. Если придёт несоответствие из-за гонок
  // — не страшно, число информационное.
  const [count, setCount] = useState<number>(initialCommentsCount);

  // Форма
  const [draft, setDraft] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Inline-edit и delete-confirm
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string>('');
  const [editSaving, setEditSaving] = useState<boolean>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Тост (локальный): «Время редактирования истекло» и т. п.
  const [toast, setToast] = useState<string | null>(null);
  const toastSeqRef = useRef(0);
  const showToast = useCallback((message: string) => {
    toastSeqRef.current += 1;
    const id = toastSeqRef.current;
    setToast(message);
    setTimeout(() => {
      // Гасим, только если за время задержки не пришёл новый
      // toast — иначе перезапись затёрла бы новое сообщение.
      if (toastSeqRef.current === id) setToast(null);
    }, TOAST_DISMISS_MS);
  }, []);

  // Первичная загрузка + abort при размонтировании/смене postId.
  //
  // Депы намеренно зависят только от `postId` — `t` сюда брать нельзя:
  // BlogPostPage синхронно делает `i18n.changeLanguage(locale)` на
  // mount'е (KS-4460), это меняет ref `t` и форсит ре-ран эффекта;
  // прежний запрос отменяется через cleanup, что у нашего `api.ts`
  // нормализуется в `ApiError(..., 'REQUEST_TIMEOUT', 0)` (см.
  // `fetchWithTimeout` — DOMException AbortError → ApiError). Поэтому
  // выше в `.catch` проверяем `controller.signal.aborted` вместо
  // `e.name === 'AbortError'`: после нашей собственной отмены
  // оригинальный AbortError уже потерян.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    blogApi
      .listComments(postId, { limit: PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(
          t('blog.comments.loadFailed', 'Could not load comments.'),
        );
        setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    blogApi
      .listComments(postId, { cursor, limit: PAGE_SIZE })
      .then((page) => {
        // Дедуп по id на случай гонок/перекрытия cursor'ов.
        setItems((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          const next = page.items.filter((c) => !seen.has(c.id));
          return prev.concat(next);
        });
        setCursor(page.nextCursor);
        setLoadingMore(false);
      })
      .catch(() => {
        showToast(
          t('blog.comments.loadFailed', 'Could not load comments.'),
        );
        setLoadingMore(false);
      });
  }, [cursor, loadingMore, postId, showToast, t]);

  // ── создание нового комментария ────────────────────────────────
  const trimmed = draft.trim();
  const canSubmit =
    !submitting && trimmed.length >= MIN_LEN && trimmed.length <= MAX_LEN;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    setSubmitting(true);
    blogApi
      .createComment(postId, trimmed)
      .then((created) => {
        // Бэк возвращает уже актуальный объект с `canEdit:true`
        // (свежий комментарий, окно открыто). Кладём в начало.
        setItems((prev) => [created, ...prev]);
        setCount((c) => c + 1);
        setDraft('');
      })
      .catch((e) => {
        const msg =
          e instanceof ApiError && e.status === 429
            ? t(
                'blog.comments.rateLimited',
                'Please wait a moment before posting again.',
              )
            : t(
                'blog.comments.submitFailed',
                'Could not post the comment. Please try again.',
              );
        showToast(msg);
      })
      .finally(() => setSubmitting(false));
  }, [canSubmit, postId, trimmed, showToast, t]);

  const handleSubmitClick = useCallback(() => {
    // Авторизованного пропускаем, гостя — в общую модалку логина.
    requireAuth(handleSubmit, {
      description: t(
        'blog.comments.loginRequired',
        'Sign in to comment on Kingside blog posts.',
      ),
    });
  }, [requireAuth, handleSubmit, t]);

  // ── inline-edit ────────────────────────────────────────────────
  const startEdit = useCallback((c: BlogComment) => {
    setEditingId(c.id);
    setEditDraft(c.body ?? '');
  }, []);
  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft('');
  }, []);
  const saveEdit = useCallback(() => {
    if (!editingId) return;
    const trimmedEdit = editDraft.trim();
    if (trimmedEdit.length < MIN_LEN || trimmedEdit.length > MAX_LEN) return;
    setEditSaving(true);
    blogApi
      .updateComment(editingId, trimmedEdit)
      .then((updated) => {
        setItems((prev) =>
          prev.map((c) => (c.id === updated.id ? updated : c)),
        );
        setEditingId(null);
        setEditDraft('');
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) {
          // Окно редактирования закрылось — закрываем редактор и
          // подмешиваем актуальный canEdit=false на эту запись.
          setItems((prev) =>
            prev.map((c) =>
              c.id === editingId ? { ...c, canEdit: false } : c,
            ),
          );
          setEditingId(null);
          setEditDraft('');
          showToast(
            t(
              'blog.comments.editWindowClosed',
              'Edit window has expired. You can no longer edit this comment.',
            ),
          );
          return;
        }
        showToast(
          t(
            'blog.comments.editFailed',
            'Could not save the changes. Please try again.',
          ),
        );
      })
      .finally(() => setEditSaving(false));
  }, [editingId, editDraft, showToast, t]);

  // ── delete ─────────────────────────────────────────────────────
  const requestDelete = useCallback((id: string) => setConfirmDeleteId(id), []);
  const cancelDelete = useCallback(() => setConfirmDeleteId(null), []);
  const confirmDelete = useCallback(() => {
    if (!confirmDeleteId) return;
    setDeleting(true);
    blogApi
      .deleteComment(confirmDeleteId)
      .then((deleted) => {
        // Backend отдаёт soft-deleted запись — заменяем целиком.
        setItems((prev) =>
          prev.map((c) => (c.id === deleted.id ? deleted : c)),
        );
        setCount((c) => Math.max(0, c - 1));
        setConfirmDeleteId(null);
      })
      .catch(() => {
        showToast(
          t(
            'blog.comments.deleteFailed',
            'Could not delete the comment. Please try again.',
          ),
        );
      })
      .finally(() => setDeleting(false));
  }, [confirmDeleteId, showToast, t]);

  // ── рендер ─────────────────────────────────────────────────────
  const now = useMemo(() => Date.now(), [items.length, loading]);

  return (
    <section
      className="blog-comments"
      data-testid="blog-comments"
      aria-labelledby="blog-comments-title"
    >
      <h2 id="blog-comments-title" className="blog-comments__title">
        {t('blog.comments.title', 'Comments')}{' '}
        <span
          className="blog-comments__count"
          data-testid="blog-comments-count"
        >
          ({count})
        </span>
      </h2>

      {loading && (
        <p
          className="blog-comments__status"
          data-testid="blog-comments-loading"
        >
          {t('blog.comments.loading', 'Loading comments…')}
        </p>
      )}

      {!loading && error && (
        <p
          className="blog-comments__status blog-comments__status--error"
          data-testid="blog-comments-error"
        >
          {error}
        </p>
      )}

      {!loading && !error && items.length === 0 && (
        <p
          className="blog-comments__status"
          data-testid="blog-comments-empty"
        >
          {t('blog.comments.empty', 'No comments yet. Be the first.')}
        </p>
      )}

      {!loading && !error && items.length > 0 && (
        <ul className="blog-comments__list" data-testid="blog-comments-list">
          {items.map((c) => (
            <li
              key={c.id}
              className={`blog-comment${c.deleted ? ' blog-comment--deleted' : ''}`}
              data-testid="blog-comment"
              data-comment-id={c.id}
              data-deleted={c.deleted ? 'true' : 'false'}
            >
              {c.deleted ? (
                <p
                  className="blog-comment__deleted"
                  data-testid="blog-comment-deleted"
                >
                  {t('blog.comments.deletedPlaceholder', 'Comment removed.')}
                </p>
              ) : (
                <>
                  <header className="blog-comment__header">
                    <span className="blog-comment__author">
                      {c.authorUsername}
                    </span>
                    <span
                      className="blog-comment__sep"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <time
                      dateTime={c.createdAt}
                      className="blog-comment__date"
                    >
                      {formatRelative(c.createdAt, now, locale, t)}
                    </time>
                  </header>

                  {editingId === c.id ? (
                    <div className="blog-comment__edit">
                      <textarea
                        className="blog-comment__textarea"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        maxLength={MAX_LEN}
                        rows={4}
                        data-testid="blog-comment-edit-textarea"
                      />
                      <div className="blog-comment__edit-actions">
                        <span
                          className="blog-comments__counter"
                          aria-live="polite"
                        >
                          {editDraft.length}/{MAX_LEN}
                        </span>
                        <button
                          type="button"
                          className="play-btn play-btn--compact"
                          onClick={cancelEdit}
                          disabled={editSaving}
                          data-testid="blog-comment-edit-cancel"
                        >
                          {t('common.cancel', 'Cancel')}
                        </button>
                        <button
                          type="button"
                          className="play-btn play-btn--compact play-btn--primary"
                          onClick={saveEdit}
                          disabled={
                            editSaving ||
                            editDraft.trim().length < MIN_LEN ||
                            editDraft.trim().length > MAX_LEN
                          }
                          data-testid="blog-comment-edit-save"
                        >
                          {t('common.save', 'Save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p
                        className="blog-comment__body"
                        data-testid="blog-comment-body"
                      >
                        {renderBody(c.body ?? '')}
                      </p>
                      {(c.canEdit || c.canDelete) && (
                        <div className="blog-comment__actions">
                          {c.canEdit && (
                            <button
                              type="button"
                              className="blog-comment__action-btn"
                              onClick={() => startEdit(c)}
                              data-testid="blog-comment-edit-btn"
                            >
                              {t('common.edit', 'Edit')}
                            </button>
                          )}
                          {c.canDelete && (
                            <button
                              type="button"
                              className="blog-comment__action-btn blog-comment__action-btn--danger"
                              onClick={() => requestDelete(c.id)}
                              data-testid="blog-comment-delete-btn"
                            >
                              {t('common.delete', 'Delete')}
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && cursor && (
        <div className="blog-comments__more">
          <button
            type="button"
            className="play-btn play-btn--compact"
            onClick={loadMore}
            disabled={loadingMore}
            data-testid="blog-comments-load-more"
          >
            {loadingMore
              ? t('blog.comments.loadingMore', 'Loading…')
              : t('blog.comments.loadMore', 'Show more')}
          </button>
        </div>
      )}

      {/* ── форма ─────────────────────────────────────────────── */}
      <div className="blog-comments__form" data-testid="blog-comments-form">
        {user ? (
          <>
            <textarea
              className="blog-comments__textarea"
              placeholder={t(
                'blog.comments.placeholder',
                'Share your thoughts about this article…',
              )}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_LEN}
              rows={3}
              data-testid="blog-comments-textarea"
            />
            <div className="blog-comments__form-row">
              <span
                className="blog-comments__counter"
                aria-live="polite"
                data-testid="blog-comments-counter"
              >
                {draft.length}/{MAX_LEN}
              </span>
              <button
                type="button"
                className="play-btn play-btn--primary play-btn--compact"
                onClick={handleSubmitClick}
                disabled={!canSubmit}
                data-testid="blog-comments-submit"
              >
                {submitting
                  ? t('blog.comments.submitting', 'Posting…')
                  : t('blog.comments.submit', 'Post comment')}
              </button>
            </div>
          </>
        ) : (
          <div
            className="blog-comments__guest"
            data-testid="blog-comments-guest"
          >
            <span>
              {t(
                'blog.comments.guestPrompt',
                'Sign in to leave a comment.',
              )}
            </span>{' '}
            <Link to="/login" className="blog-comments__guest-link">
              {t('blog.comments.guestLogin', 'Sign in')}
            </Link>
          </div>
        )}
      </div>

      {/* ── confirm delete ────────────────────────────────────── */}
      {confirmDeleteId && (
        <div
          className="blog-comments__confirm-backdrop"
          data-testid="blog-comments-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="blog-comments-confirm-title"
        >
          <div className="blog-comments__confirm-modal">
            <h3 id="blog-comments-confirm-title">
              {t('blog.comments.deleteConfirmTitle', 'Delete this comment?')}
            </h3>
            <p>
              {t(
                'blog.comments.deleteConfirmText',
                'It will be marked as deleted and the text will be hidden from other readers.',
              )}
            </p>
            <div className="blog-comments__confirm-actions">
              <button
                type="button"
                className="play-btn play-btn--compact"
                onClick={cancelDelete}
                disabled={deleting}
                data-testid="blog-comments-confirm-cancel"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="play-btn play-btn--compact play-btn--danger"
                onClick={confirmDelete}
                disabled={deleting}
                data-testid="blog-comments-confirm-ok"
              >
                {deleting
                  ? t('blog.comments.deleting', 'Deleting…')
                  : t('common.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── локальный toast ───────────────────────────────────── */}
      {toast && (
        <div
          className="api-notice-toast"
          role="status"
          aria-live="polite"
          data-testid="blog-comments-toast"
        >
          {toast}
        </div>
      )}
    </section>
  );
}
