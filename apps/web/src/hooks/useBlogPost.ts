/**
 * KS-4414 / ADR-137 rev2 T8. Хук-обёртка над `GET /blog/posts/:slug`.
 *
 * Состояния: loading / ready / not_found / error. 404 от backend'а
 * (нет статьи ни в `locale`, ни в фолбэке) — это `not_found`,
 * пользователю показываем «Статья не найдена», а не «Ошибка сервера».
 * Прочие сетевые/5xx — `error`, чтобы можно было предложить повтор.
 *
 * Гонки: счётчик `reqIdRef` отбрасывает устаревшие ответы при быстрой
 * смене slug/locale. `AbortController` гасит зависший запрос.
 *
 * Контракт ответа — `BlogPostDetail` из `@kingside/shared` (KS-4408).
 * При фолбэке локали backend ставит `isLocaleFallback=true` — страница
 * показывает плашку, но рендерит контент.
 */
import { useEffect, useRef, useState } from 'react';

import { blogApi } from '../api/api-blog';
import { ApiError } from '../ApiError';
import type { BlogLocale, BlogPostDetail } from '@kingside/shared';

export type UseBlogPostStatus =
  | 'loading'
  | 'ready'
  | 'not_found'
  | 'error';

export interface UseBlogPostState {
  post: BlogPostDetail | null;
  status: UseBlogPostStatus;
}

export function useBlogPost(
  slug: string,
  locale: BlogLocale,
): UseBlogPostState {
  const [post, setPost] = useState<BlogPostDetail | null>(null);
  const [status, setStatus] = useState<UseBlogPostStatus>('loading');
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!slug) {
      setPost(null);
      setStatus('not_found');
      return;
    }
    const reqId = ++reqIdRef.current;
    const controller = new AbortController();
    setStatus('loading');
    setPost(null);

    blogApi
      .getPost(slug, locale, controller.signal)
      .then((res) => {
        if (reqId !== reqIdRef.current) return;
        if (!res || typeof res !== 'object' || !res.slug) {
          setStatus('not_found');
          setPost(null);
          return;
        }
        setPost(res);
        setStatus('ready');
      })
      .catch((e) => {
        if (reqId !== reqIdRef.current) return;
        if (e?.name === 'AbortError' || e?.code === 'ERR_CANCELED') return;
        // ApiError со статусом 404 — статьи нет (ни в нужной локали,
        // ни в фолбэке). Это не «ошибка», а корректный негативный
        // ответ — рендерим «Статья не найдена».
        if (e instanceof ApiError && e.status === 404) {
          setStatus('not_found');
          setPost(null);
          return;
        }
        setStatus('error');
        setPost(null);
      });

    return () => {
      controller.abort();
    };
  }, [slug, locale]);

  return { post, status };
}
