import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext';
import { studiesApi } from '../../api/studiesApi';
import type { ToggleLikeResponse } from '@kingside/shared';
import { setAuthReturnUrl } from '../../utils/authReturnUrl';

/**
 * KS-2888 / ADR-060 §3.4 K4 (FC3) — кнопка лайка студии.
 *
 * Поведение:
 *   • аутентифицированный клик → POST `/studies/:slug/like` (toggle);
 *   • оптимистический UI: счётчик и сердечко переключаются мгновенно,
 *     при ошибке — откат к prev-значению;
 *   • анонимный клик → sessionStorage.returnUrl=<текущая страница>,
 *     navigate('/login'); после успешного логина юзер вернётся сюда
 *     (см. `consumeAuthReturnUrl` в auth-обработчиках).
 *
 * Используется на `StudyCatalogCard` (внутри `<Link>`, поэтому клик
 * вызывает `preventDefault + stopPropagation`, чтобы не уйти на страницу
 * студии) и на `StudyPage`.
 *
 * `liked` приходит из API родителем; если он не уверен (например, list-
 * эндпоинт ещё не отдаёт флаг — ADR-060 backend в B5/FC1) — пробрасывает
 * `false`. После первого toggleLike сервер вернёт актуальное состояние,
 * `onChange` сообщит родителю.
 */

export interface LikeButtonProps {
  /** slug нужен для POST URL; studyId — для data-атрибута/тестов. */
  slug: string;
  studyId?: string;
  likes: number;
  liked: boolean;
  /**
   * Колбэк родителю — получает свежее `{liked, likes}` после успешного
   * сервер-ответа (после оптимизма уже подтверждено). Не вызывается при
   * откате (ошибке).
   */
  onChange?: (state: ToggleLikeResponse) => void;
  /**
   * Компактный режим (без счётчика рядом). По умолчанию `false` — обычная
   * кнопка с цифрой. Не используется в текущих местах, оставлено как
   * расширение для возможной floating-toolbar UI.
   */
  compact?: boolean;
  /**
   * `aria-label` override. Если не задан, используются дефолты
   * `Like` / `Unlike` (заведены в i18n позже layout-агентом — здесь
   * текстовые, потому что компонент находится глубоко по DOM и
   * меняется редко).
   */
  ariaLabel?: string;
}

export function LikeButton({
  slug,
  studyId,
  likes,
  liked,
  onChange,
  compact = false,
  ariaLabel,
}: LikeButtonProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Локальное состояние, чтобы не дёргать parent на каждый optimistic
  // тик. После успешного response — синхронизируем оба.
  const [stateLiked, setStateLiked] = useState<boolean>(liked);
  const [stateLikes, setStateLikes] = useState<number>(likes);
  const [pending, setPending] = useState<boolean>(false);
  // Защита от race: если props сменились во время pending — после
  // запроса не перезаписывать свежие server-данные старыми.
  const pendingRef = useRef<boolean>(false);

  // Sync с props: если родитель получил новое значение (например,
  // refetch студии), отражаем — но только когда мы НЕ в середине
  // оптимистического запроса.
  useEffect(() => {
    if (pendingRef.current) return;
    setStateLiked(liked);
    setStateLikes(likes);
  }, [liked, likes]);

  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      // Внутри `<Link>` (карточка) preventDefault обязателен — иначе
      // click пробулькает и роутер уведёт на /studies/:slug.
      e.preventDefault();
      e.stopPropagation();

      if (!user) {
        // Anon flow: пишем returnUrl и уходим на /login.
        setAuthReturnUrl(location.pathname + location.search);
        navigate('/login');
        return;
      }

      if (pending) return;

      // Optimistic toggle.
      const prevLiked = stateLiked;
      const prevLikes = stateLikes;
      const nextLiked = !prevLiked;
      const nextLikes = Math.max(0, prevLikes + (nextLiked ? 1 : -1));
      setStateLiked(nextLiked);
      setStateLikes(nextLikes);
      setPending(true);
      pendingRef.current = true;

      try {
        const resp = await studiesApi.toggleLike(slug);
        // Сервер-truth: даже если оптимизм угадал, перезаписываем
        // ответом (счётчик мог уйти у других юзеров параллельно).
        setStateLiked(resp.liked);
        setStateLikes(resp.likes);
        onChange?.(resp);
      } catch {
        // Откат: возвращаемся к prev-значениям. Родителю не сообщаем —
        // у него не должно меняться состояние при ошибке.
        setStateLiked(prevLiked);
        setStateLikes(prevLikes);
      } finally {
        setPending(false);
        pendingRef.current = false;
      }
    },
    [user, pending, stateLiked, stateLikes, slug, onChange, navigate, location],
  );

  const label =
    ariaLabel ?? (stateLiked ? 'Unlike study' : 'Like study');

  return (
    <button
      type="button"
      className={`study-like-btn${stateLiked ? ' study-like-btn--liked' : ''}`}
      data-testid="study-like-button"
      data-study-id={studyId}
      data-study-slug={slug}
      data-liked={stateLiked ? 'true' : 'false'}
      aria-pressed={stateLiked}
      aria-label={label}
      onClick={handleClick}
      disabled={pending}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill={stateLiked ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        data-testid="study-like-button-icon"
      >
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
      {!compact && (
        <span data-testid="study-like-button-count">{stateLikes}</span>
      )}
    </button>
  );
}
