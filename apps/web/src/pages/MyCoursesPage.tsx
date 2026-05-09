import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UserCourseDto } from '@kingside/shared';

import { userCoursesApi } from '../api/userCoursesApi';
import { useAuth } from '../context/AuthContext';
import { useDelayedFlag } from '../hooks/useDelayedFlag';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { formatRelativeActivity } from '../utils/relativeTime';

/**
 * `MyCoursesPage` — страница `/lessons/my` (ADR-052 §3.3, KS-2620 +
 * KS-2621).
 *
 * Полный список собственных курсов автора: Public/Private бейдж, title,
 * meta «N lessons · updated <relative>», stats для владельца
 * (`enrolled / completed (%)`), опциональное описание (truncate 2 lines).
 *
 * Per-card actions (KS-2621 / ADR-052 §3.3.2 #2):
 *   - **Open**     — `navigate('/lessons/my/:slug')`.
 *   - **Edit**     — `navigate('/lessons/my/:slug/edit')`.
 *   - **Copy link** — `${origin}/lessons/my/:slug` в clipboard;
 *     `navigator.clipboard.writeText` + execCommand-fallback (см.
 *     `useCopyToClipboard`). Toast: для public — «Link copied», для
 *     private — «Link copied. Publish to share with others».
 *   - **Make public/private** — `userCoursesApi.update({ isPublic })`
 *     с **оптимистичным обновлением** локального состояния и откатом
 *     при ошибке (toast).
 *   - **Delete** — `window.confirm` с подстановкой `title` и
 *     `enrolledCount` → `userCoursesApi.delete` → удаление из списка
 *     + toast.
 *
 * Toast — простой floating-блок в правом нижнем углу страницы
 * (success/error tone), авто-скрывается через ~3 сек.
 *
 * Источник данных — `userCoursesApi.list({ scope: 'own' })`.
 * Маршрут под `<ProtectedRoute>` (см. App.tsx).
 */

type ToastTone = 'success' | 'error' | 'info';

interface ToastState {
  /** Монотонный счётчик — нужен чтобы повторный одинаковый текст
   * перезапустил таймер автоскрытия. */
  id: number;
  message: string;
  tone: ToastTone;
}

const TOAST_AUTO_HIDE_MS = 3000;

export function MyCoursesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const copyToClipboard = useCopyToClipboard();

  const [courses, setCourses] = useState<UserCourseDto[] | null>(null);
  const [errored, setErrored] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // KS-2621: locked'и нужны чтобы при двойном клике по «Make public»
  // не уйти в дубль-PATCH'и или DELETE; на каждый курс держим bool.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastIdRef = useRef(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setErrored(false);
    setCourses(null);
    userCoursesApi
      .list({ scope: 'own' })
      .then((res) => {
        if (cancelled) return;
        setCourses(res.data ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Закрытие overflow-меню по клику вне или по Escape.
  useEffect(() => {
    if (!openMenuId) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-my-courses-menu-root]')) return;
      setOpenMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenuId]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const showToast = useCallback((message: string, tone: ToastTone) => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToast({ id, message, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      // Скрываем только если не пришёл другой toast (id совпадает).
      setToast((prev) => (prev && prev.id === id ? null : prev));
    }, TOAST_AUTO_HIDE_MS);
  }, []);

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      const created = await userCoursesApi.create({
        title: t('lessons.my.editor.defaultCourseTitle', 'New course'),
      });
      navigate(`/lessons/my/${created.slug}/edit`);
    } catch {
      setCreateError(
        t('lessons.my.createModal.error', 'Failed to create the course'),
      );
    } finally {
      setCreating(false);
    }
  };

  // ─── per-card actions ────────────────────────────────────────────

  const handleOpen = useCallback(
    (course: UserCourseDto) => {
      navigate(`/lessons/my/${course.slug}`);
    },
    [navigate],
  );

  const handleEdit = useCallback(
    (course: UserCourseDto) => {
      navigate(`/lessons/my/${course.slug}/edit`);
    },
    [navigate],
  );

  const handleCopyLink = useCallback(
    async (course: UserCourseDto) => {
      const origin =
        typeof window !== 'undefined' ? window.location.origin : '';
      const url = `${origin}/lessons/my/${course.slug}`;
      const ok = await copyToClipboard(url);
      if (!ok) {
        showToast(
          t('lessons.my.toasts.linkCopyError', 'Failed to copy link'),
          'error',
        );
        return;
      }
      const message = course.isPublic
        ? t('lessons.my.toasts.linkCopied', 'Link copied')
        : t(
            'lessons.my.toasts.linkCopiedPrivate',
            'Link copied. Publish to share with others.',
          );
      showToast(message, course.isPublic ? 'success' : 'info');
    },
    [copyToClipboard, showToast, t],
  );

  /**
   * KS-2621: оптимистично переключаем `isPublic` в локальном state,
   * шлём PATCH; на ошибке — откатываем и показываем error-toast.
   * `pendingId` гарантирует, что повторный клик во время запроса
   * не уйдёт в дубль-PATCH (button disabled).
   */
  const handleToggleVisibility = useCallback(
    async (course: UserCourseDto) => {
      if (pendingId === course.id) return;
      setOpenMenuId(null);
      setPendingId(course.id);
      const next = !course.isPublic;
      const prevList = courses;
      setCourses((cur) =>
        cur
          ? cur.map((c) =>
              c.id === course.id ? { ...c, isPublic: next } : c,
            )
          : cur,
      );
      try {
        await userCoursesApi.update(course.id, { isPublic: next });
        showToast(
          next
            ? t('lessons.my.toasts.coursePublished', 'Course published')
            : t('lessons.my.toasts.courseHidden', 'Course hidden'),
          'success',
        );
      } catch {
        // Откат — возвращаем прежнее состояние.
        setCourses(prevList);
        showToast(
          t(
            'lessons.my.toasts.visibilityError',
            'Failed to update visibility',
          ),
          'error',
        );
      } finally {
        setPendingId((cur) => (cur === course.id ? null : cur));
      }
    },
    [courses, pendingId, showToast, t],
  );

  const handleDelete = useCallback(
    async (course: UserCourseDto) => {
      if (pendingId === course.id) return;
      setOpenMenuId(null);
      const enrolled = course.stats?.enrolledCount ?? 0;
      const confirmText = t('lessons.my.deleteConfirm.body', {
        title: course.title,
        count: enrolled,
        defaultValue:
          'Delete course "{{title}}"? {{count}} students will lose progress.',
      });
      if (typeof window !== 'undefined' && !window.confirm(confirmText)) {
        return;
      }
      setPendingId(course.id);
      try {
        await userCoursesApi.delete(course.id);
        setCourses((cur) =>
          cur ? cur.filter((c) => c.id !== course.id) : cur,
        );
        showToast(
          t('lessons.my.toasts.courseDeleted', 'Course deleted'),
          'success',
        );
      } catch {
        showToast(
          t('lessons.my.toasts.deleteError', 'Failed to delete the course'),
          'error',
        );
      } finally {
        setPendingId((cur) => (cur === course.id ? null : cur));
      }
    },
    [pendingId, showToast, t],
  );

  const isLoading = courses === null && !errored;
  const isEmpty = courses !== null && courses.length === 0;
  const showSkeleton = useDelayedFlag(isLoading, 200);
  const coursesLen = courses?.length ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [coursesLen]);

  return (
    <div
      className="my-courses-page"
      data-testid="my-courses-page"
      data-state={
        isLoading ? 'loading' : errored ? 'error' : isEmpty ? 'empty' : 'ready'
      }
    >
      <nav
        aria-label={t('lessons.my.breadcrumbLabel', 'breadcrumb')}
        className="my-courses-page__breadcrumb"
        data-testid="my-courses-breadcrumb"
      >
        <Link to="/lessons">{t('lessons.title', 'Lessons')}</Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">
          {t('lessons.my.pageTitle', 'My courses')}
        </span>
      </nav>

      <header className="my-courses-page__header">
        <div className="my-courses-page__title-block">
          <h1>{t('lessons.my.pageTitle', 'My courses')}</h1>
          <p className="my-courses-page__subtitle">
            {t(
              'lessons.my.subtitle',
              'Manage your custom courses',
            )}
          </p>
        </div>
        {/* KS-2623: на mobile (<560px) header-кнопка «+ Create»
            скрывается, вместо неё внизу экрана видна sticky-CTA. */}
        <button
          type="button"
          className="my-courses-block__create my-courses-page__create-header"
          onClick={handleCreate}
          disabled={creating}
          data-testid="my-courses-create"
        >
          {creating
            ? t('lessons.my.createModal.submitting', 'Creating…')
            : t('lessons.my.create', '+ Create my course')}
        </button>
      </header>

      {createError && (
        <p
          className="my-courses-block__error"
          data-testid="my-courses-create-error"
          role="status"
        >
          {createError}
        </p>
      )}

      {errored && (
        <div
          className="my-courses-block__error"
          data-testid="my-courses-load-error"
          role="status"
        >
          {t('lessons.my.loadError', 'Failed to load your courses.')}
        </div>
      )}

      {isLoading && showSkeleton && (
        <ul
          className="my-courses-block__grid my-courses-block__grid--skeleton"
          data-testid="my-courses-skeleton"
          aria-busy="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li
              key={i}
              className="my-courses-block__card my-courses-block__card--skeleton"
              aria-hidden="true"
            >
              <div className="my-courses-block__skeleton-title" />
              <div className="my-courses-block__skeleton-line" />
              <div className="my-courses-block__skeleton-line my-courses-block__skeleton-line--short" />
            </li>
          ))}
        </ul>
      )}

      {isEmpty && (
        <div
          className="my-courses-block__empty"
          data-testid="my-courses-empty"
        >
          <p>
            {t(
              'lessons.my.emptyHeading',
              "You haven't created any courses yet.",
            )}
          </p>
          <button
            type="button"
            className="my-courses-block__create"
            onClick={handleCreate}
            disabled={creating}
            data-testid="my-courses-empty-cta"
          >
            {creating
              ? t('lessons.my.createModal.submitting', 'Creating…')
              : t('lessons.my.empty.cta', '+ Create your first course')}
          </button>
        </div>
      )}

      {!isLoading && !isEmpty && courses && courses.length > 0 && (
        <ul
          className="my-courses-block__grid"
          data-testid="my-courses-grid"
        >
          {courses.map((c) => {
            const relative = formatRelativeActivity(
              c.updatedAt,
              now,
              t,
              i18n.language || 'en',
            );
            const stats = c.stats;
            const percent =
              stats && stats.enrolledCount > 0
                ? Math.round((stats.completedCount / stats.enrolledCount) * 100)
                : null;
            const menuOpen = openMenuId === c.id;
            const isPending = pendingId === c.id;
            return (
              <li
                key={c.id}
                className={`my-courses-block__card my-courses-page__card${menuOpen ? ' my-courses-page__card--menu-open' : ''}`}
                data-testid={`my-courses-card-${c.id}`}
              >
                {/* Заголовочная зона как ссылка — оставляем удобную
                    «click anywhere on header → open» семантику.
                    Кнопки действий вынесены в footer, чтобы их клики
                    не пробрасывались на ссылку. */}
                <Link
                  to={`/lessons/my/${c.slug}`}
                  className="my-courses-block__link"
                >
                  <header className="my-courses-block__card-header">
                    <h3 className="my-courses-block__card-title">{c.title}</h3>
                    <div className="my-courses-block__card-badges">
                      <span
                        className={`my-courses-block__badge my-courses-block__badge--${c.isPublic ? 'public' : 'private'}`}
                        data-testid={`my-courses-badge-${c.id}`}
                      >
                        {c.isPublic
                          ? t('lessons.my.publicBadge', 'Public')
                          : t('lessons.my.privateBadge', 'Private')}
                      </span>
                    </div>
                  </header>
                  {c.description && (
                    <p
                      className="my-courses-block__card-description my-courses-page__card-description--clamp"
                      data-testid={`my-courses-desc-${c.id}`}
                    >
                      {c.description}
                    </p>
                  )}
                  <footer className="my-courses-block__card-footer">
                    <span data-testid={`my-courses-meta-${c.id}`}>
                      {t('lessons.my.lessonsCount', {
                        count: c.lessonCount,
                        defaultValue: '{{count}} lessons',
                      })}
                      {' · '}
                      {t('lessons.my.updatedRelative', {
                        relative,
                        defaultValue: 'updated {{relative}}',
                      })}
                    </span>
                    {stats && (
                      <span
                        className="my-courses-block__card-stats"
                        data-testid={`my-courses-stats-${c.id}`}
                      >
                        {percent !== null
                          ? t('lessons.my.stats.percent', {
                              enrolled: stats.enrolledCount,
                              completed: stats.completedCount,
                              percent,
                              defaultValue:
                                '{{enrolled}} enrolled · {{completed}} completed ({{percent}}%)',
                            })
                          : t('lessons.my.stats.compact', {
                              enrolled: stats.enrolledCount,
                              completed: stats.completedCount,
                              defaultValue:
                                '{{enrolled}} enrolled · {{completed}} completed',
                            })}
                      </span>
                    )}
                  </footer>
                </Link>

                <div
                  className="my-courses-page__actions"
                  data-testid={`my-courses-actions-${c.id}`}
                >
                  <button
                    type="button"
                    className="my-courses-page__action"
                    onClick={() => handleOpen(c)}
                    data-testid={`my-courses-action-open-${c.id}`}
                  >
                    {t('lessons.my.actions.open', 'Open')}
                  </button>
                  <button
                    type="button"
                    className="my-courses-page__action"
                    onClick={() => handleEdit(c)}
                    data-testid={`my-courses-action-edit-${c.id}`}
                  >
                    {t('lessons.my.actions.edit', 'Edit')}
                  </button>
                  {/* KS-2623: Copy link на desktop остаётся в строке;
                      на <560px скрыт CSS'ом и доступен из меню «⋮ Ещё»
                      ниже (в JSX продублирован, чтобы не разводить
                      параллельные деревья под media-query). */}
                  <button
                    type="button"
                    className="my-courses-page__action my-courses-page__action--copy"
                    onClick={() => handleCopyLink(c)}
                    data-testid={`my-courses-action-copy-${c.id}`}
                  >
                    {t('lessons.my.actions.copyLink', 'Copy link')}
                  </button>
                  <div
                    className="my-courses-page__menu-root"
                    data-my-courses-menu-root="true"
                  >
                    <button
                      type="button"
                      className="my-courses-page__action my-courses-page__action--more"
                      onClick={() =>
                        setOpenMenuId((cur) => (cur === c.id ? null : c.id))
                      }
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      data-testid={`my-courses-action-more-${c.id}`}
                    >
                      {t('lessons.my.actions.more', '⋮ More')}
                    </button>
                    {menuOpen && (
                      <div
                        className="my-courses-page__menu"
                        role="menu"
                        data-testid={`my-courses-menu-${c.id}`}
                      >
                        {/* KS-2623: «Copy link» в меню — основной
                            способ копирования на mobile (<560px).
                            На desktop этот пункт скрыт CSS'ом, потому
                            что есть отдельная кнопка в строке. */}
                        <button
                          type="button"
                          role="menuitem"
                          className="my-courses-page__menu-item my-courses-page__menu-item--mobile-only"
                          onClick={() => {
                            setOpenMenuId(null);
                            void handleCopyLink(c);
                          }}
                          data-testid={`my-courses-menu-copy-${c.id}`}
                        >
                          {t('lessons.my.actions.copyLink', 'Copy link')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="my-courses-page__menu-item"
                          onClick={() => handleToggleVisibility(c)}
                          disabled={isPending}
                          data-testid={`my-courses-menu-visibility-${c.id}`}
                        >
                          {c.isPublic
                            ? t(
                                'lessons.my.actions.makePrivate',
                                'Make private',
                              )
                            : t(
                                'lessons.my.actions.makePublic',
                                'Make public',
                              )}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="my-courses-page__menu-item my-courses-page__menu-item--danger"
                          onClick={() => handleDelete(c)}
                          disabled={isPending}
                          data-testid={`my-courses-menu-delete-${c.id}`}
                        >
                          {t('lessons.my.actions.delete', 'Delete')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* KS-2623: sticky `+ Create` для mobile. На desktop скрыта;
          на <560px пинуется к низу экрана с safe-area, не закрывая
          контент (нижний padding у grid'а уже есть от MobileBottomBar
          через layout.css). Empty-state не комбинируется со sticky:
          там сама кнопка стоит в центре блока, sticky прячется в CSS
          через `.my-courses-page[data-state="empty"]`. */}
      <div
        className="my-courses-page__create-sticky"
        data-testid="my-courses-create-sticky"
      >
        <button
          type="button"
          className="my-courses-block__create my-courses-page__create-sticky-btn"
          onClick={handleCreate}
          disabled={creating}
          data-testid="my-courses-create-sticky-btn"
        >
          {creating
            ? t('lessons.my.createModal.submitting', 'Creating…')
            : t('lessons.my.create', '+ Create my course')}
        </button>
      </div>

      {toast && (
        <div
          className={`my-courses-page__toast my-courses-page__toast--${toast.tone}`}
          role="status"
          aria-live="polite"
          data-testid="my-courses-toast"
          data-tone={toast.tone}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
