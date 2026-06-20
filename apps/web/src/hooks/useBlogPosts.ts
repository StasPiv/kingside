/**
 * KS-4413 / ADR-137 rev2. Хук-обёртка над `GET /blog/posts`.
 *
 * Состояния: loading / ready / error / empty. Гонок при быстрой смене
 * (locale/page/tag) избегаем счётчиком `reqIdRef` — отбрасываем ответы
 * устаревших запросов. AbortController закрывает зависший сетевой вызов
 * при размонтировании или новом запросе.
 *
 * Контракт ответа — `BlogPostListPage` из `@kingside/shared`
 * (KS-4408): `{items, total, page, totalPages}`. Размер страницы
 * фиксирован на backend (PAGE_SIZE=12) — не дублируем константой здесь.
 */
import { useEffect, useRef, useState } from 'react';

import { blogApi } from '../api/api-blog';
import type {
  BlogLocale,
  BlogPostListItem,
  BlogPostListPage,
} from '@kingside/shared';

export type UseBlogPostsError = 'load_failed';

export interface UseBlogPostsState {
  items: BlogPostListItem[];
  total: number;
  page: number;
  totalPages: number;
  loading: boolean;
  error: UseBlogPostsError | null;
}

const EMPTY: BlogPostListPage = {
  items: [],
  total: 0,
  page: 1,
  totalPages: 1,
};

/**
 * Загружает страницу ленты. Перезапускается при изменении любого
 * аргумента. `tag` пустая строка трактуется как «без фильтра».
 */
export function useBlogPosts(
  locale: BlogLocale,
  page: number,
  tag?: string,
): UseBlogPostsState {
  const [data, setData] = useState<BlogPostListPage>(EMPTY);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<UseBlogPostsError | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const query = {
      locale,
      page,
      ...(tag && tag.trim() ? { tag: tag.trim() } : {}),
    };

    blogApi
      .listPosts(query, controller.signal)
      .then((res) => {
        if (reqId !== reqIdRef.current) return;
        // Защитное приведение — если backend вдруг отдал кривой ответ
        // (например, в prerender-моке), не падаем на `.map`.
        setData({
          items: Array.isArray(res?.items) ? res.items : [],
          total: Number.isFinite(res?.total) ? res.total : 0,
          page: Number.isFinite(res?.page) ? res.page : page,
          totalPages: Number.isFinite(res?.totalPages) ? res.totalPages : 1,
        });
        setLoading(false);
      })
      .catch((e) => {
        if (reqId !== reqIdRef.current) return;
        // AbortError — нормальный сигнал отмены при смене query, не ошибка.
        if (e?.name === 'AbortError' || e?.code === 'ERR_CANCELED') return;
        setError('load_failed');
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [locale, page, tag]);

  return {
    items: data.items,
    total: data.total,
    page: data.page,
    totalPages: data.totalPages,
    loading,
    error,
  };
}
