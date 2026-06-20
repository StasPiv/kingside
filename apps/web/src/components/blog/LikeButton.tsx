/**
 * KS-4475 / ADR-140 §2.1 T9. Кнопка «лайк» статьи блога.
 *
 * Контракт:
 *   - Иконка-сердце + число `likesCount`.
 *   - Состояние «лайкнул»/«не лайкнул» приходит пропсом из API
 *     (`BlogPostDetail.likedByMe`) и далее живёт локально — родитель
 *     при ремаунте передаёт новые initial-значения.
 *   - Авторизованный: оптимистичный toggle, POST/DELETE на бэке.
 *     Backend идемпотентен (см. `api-blog.likePost/unlikePost`); если
 *     запрос упал — откатываем UI и показываем toast.
 *   - Гость: `useRequireAuth` открывает существующую модалку логина
 *     с описанием «войдите, чтобы поставить лайк». Никакого собственного
 *     модала — переиспользуем общий компонент.
 *   - Дебаунс 300мс между кликами: запрет повторного клика, пока
 *     запрос в полёте. Без этого пользователь может натыкать N лайков —
 *     UI рассинхронизируется с бэком до следующего GET.
 *
 * Источник данных счётчика: всегда последний успешный ответ бэка
 * (`BlogLikeResponse.likesCount`/`likedByMe`). Это новый источник правды
 * — фронт не считает арифметически после ответа, а заменяет state
 * целиком. Оптимистичное состояние во время полёта запроса — наша
 * локальная экстраполяция.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { blogApi } from '../../api/api-blog';
import { useRequireAuth } from '../../context/RequireAuthContext';

export interface LikeButtonProps {
  postId: string;
  /** Стартовое `likedByMe` из `BlogPostDetail`. */
  initialLikedByMe: boolean;
  /** Стартовый `likesCount` из `BlogPostDetail`. */
  initialLikesCount: number;
  /**
   * Опц. колбэк после успешного toggle — родитель может обновить
   * собственный кэш (BlogPostPage не использует, оставляем хук
   * на будущее: лента/виджеты).
   */
  onChange?: (next: { likedByMe: boolean; likesCount: number }) => void;
}

const TOAST_AUTO_DISMISS_MS = 5000;

export function LikeButton({
  postId,
  initialLikedByMe,
  initialLikesCount,
  onChange,
}: LikeButtonProps) {
  const { t } = useTranslation();
  const requireAuth = useRequireAuth();
  const [liked, setLiked] = useState<boolean>(initialLikedByMe);
  const [count, setCount] = useState<number>(initialLikesCount);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // KS-4475. Защита от двойного клика: пока запрос в полёте, второй
  // клик ничего не делает (кнопка disabled). 300мс — на случай если
  // ответ пришёл мгновенно: всё равно небольшая пауза перед
  // следующим действием, иначе пользователь может тапнуть дважды
  // подряд и натыкать N лайков (бэк идемпотентен, но UI бы прыгал).
  const cooldownUntilRef = useRef<number>(0);

  const showError = useCallback((message: string) => {
    setError(message);
    setTimeout(() => {
      setError((current) => (current === message ? null : current));
    }, TOAST_AUTO_DISMISS_MS);
  }, []);

  const toggle = useCallback(() => {
    if (pending) return;
    if (Date.now() < cooldownUntilRef.current) return;

    // Снимаем мгновенный slice UI'а — он откатится в catch.
    const prevLiked = liked;
    const prevCount = count;
    const nextLiked = !prevLiked;
    // Защитная арифметика: счётчик не может уйти в минус.
    const nextCount = nextLiked ? prevCount + 1 : Math.max(0, prevCount - 1);
    setLiked(nextLiked);
    setCount(nextCount);
    setPending(true);
    setError(null);

    const request = nextLiked
      ? blogApi.likePost(postId)
      : blogApi.unlikePost(postId);

    request
      .then((res) => {
        // Источник правды — ответ бэка. Заменяем state целиком,
        // включая `likedByMe` (на случай если бэк решил иначе:
        // повторный POST уже-лайкнутого вернёт `likedByMe:true`).
        setLiked(res.likedByMe);
        setCount(res.likesCount);
        onChange?.({ likedByMe: res.likedByMe, likesCount: res.likesCount });
      })
      .catch((e) => {
        // Откат UI к состоянию до клика.
        setLiked(prevLiked);
        setCount(prevCount);
        // 401 у нас не должен прийти (gating через useRequireAuth выше),
        // но если пришёл — это уже отработает global guest-401 handler
        // из RequireAuthProvider (там и модалка, и логирование).
        showError(
          t(
            'blog.post.likeError',
            'Could not update the like. Please try again.',
          ),
        );
        // eslint-disable-next-line no-console
        console.warn('[blog] like toggle failed', e);
      })
      .finally(() => {
        setPending(false);
        cooldownUntilRef.current = Date.now() + 300;
      });
  }, [pending, liked, count, postId, onChange, showError, t]);

  const handleClick = useCallback(() => {
    // useRequireAuth: гостю откроет общую модалку логина, авторизованного
    // пропустит сразу в `toggle`. `description` локализован под
    // конкретное действие (по образцу `auth.loginRequired.descriptionPlayer`
    // и подобных в проекте).
    requireAuth(toggle, {
      description: t(
        'blog.post.likeLoginRequired',
        'Sign in to like Kingside blog posts.',
      ),
    });
  }, [requireAuth, toggle, t]);

  const label = liked
    ? t('blog.post.unlike', 'Unlike')
    : t('blog.post.like', 'Like');

  return (
    <>
      <button
        type="button"
        className={`blog-like-btn${liked ? ' blog-like-btn--liked' : ''}`}
        onClick={handleClick}
        disabled={pending}
        aria-pressed={liked}
        aria-label={`${label} · ${count}`}
        data-testid="blog-like-btn"
        data-liked={liked ? 'true' : 'false'}
        data-count={count}
        title={label}
      >
        <span className="blog-like-btn__icon" aria-hidden="true">
          {liked ? '♥' : '♡'}
        </span>
        <span className="blog-like-btn__count" data-testid="blog-like-count">
          {count}
        </span>
      </button>
      {error && (
        <div
          className="api-notice-toast"
          role="status"
          aria-live="polite"
          data-testid="blog-like-error-toast"
        >
          {error}
        </div>
      )}
    </>
  );
}
