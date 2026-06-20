/**
 * KS-4396 / ADR-137 T3. Лента блога `/blog`.
 *
 * Источник данных: `BLOG_INDEX` из `lib/blog` (генерируется на сборке
 * `vite-blog-plugin.mjs`, KS-4393). По текущей локали `i18n.language`
 * выбираем по одной карточке на slug через `filterByLocale` (KS-4394),
 * фолбэки помечаются плашкой «не переведено».
 *
 * Пагинация числовая `?page=N`, 12 статей на страницу — без infinite
 * scroll, чтобы prerender (статичный) гарантированно покрывал каждую
 * страницу (см. ADR-137 §2.6).
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { PageSeo } from '../components/seo/PageSeo';
import {
  BLOG_INDEX,
  filterByLocale,
  type BlogListEntry,
  type BlogLocale,
} from '../lib/blog';

const PAGE_SIZE = 12;
const DEFAULT_COVER = '/og/blog-default.png';

function isLocale(value: string | undefined): BlogLocale {
  return value === 'ru' ? 'ru' : 'en';
}

function formatDate(iso: string, locale: BlogLocale): string {
  try {
    return new Date(iso).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function BlogFeedPage() {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const locale = isLocale(i18n.language);

  const entries = useMemo<BlogListEntry[]>(
    () => filterByLocale(BLOG_INDEX, locale),
    [locale],
  );

  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage)
    ? Math.min(Math.max(1, rawPage), totalPages)
    : 1;
  const start = (page - 1) * PAGE_SIZE;
  const slice = entries.slice(start, start + PAGE_SIZE);

  const goToPage = (next: number) => {
    const sp = new URLSearchParams(searchParams);
    if (next <= 1) sp.delete('page');
    else sp.set('page', String(next));
    setSearchParams(sp, { replace: false });
  };

  const isEmpty = entries.length === 0;

  return (
    <div
      className="blog-feed"
      data-testid="blog-feed"
      data-state={isEmpty ? 'empty' : 'ready'}
    >
      <PageSeo ns="blog.feed" path="/blog" />

      <header className="blog-feed__header">
        <h1>{t('blog.feed.title', 'Blog')}</h1>
        <p className="blog-feed__intro">
          {t(
            'blog.feed.intro',
            'Stories, technical write-ups and updates from Kingside.',
          )}
        </p>
      </header>

      {isEmpty && (
        <p
          className="blog-feed__status blog-feed__status--empty"
          data-testid="blog-feed-empty"
        >
          {t('blog.feed.empty', 'No posts yet. Stay tuned.')}
        </p>
      )}

      {!isEmpty && (
        <ul className="blog-feed__list" data-testid="blog-feed-list">
          {slice.map((post) => {
            const cover = post.cover ?? DEFAULT_COVER;
            const coverAlt = post.coverAlt ?? post.title;
            return (
              <li
                key={`${post.slug}-${post.locale}`}
                className="blog-feed__card"
                data-testid="blog-feed-card"
                data-slug={post.slug}
                data-fallback={post.isLocaleFallback ? 'true' : 'false'}
              >
                <Link
                  to={`/blog/${post.slug}`}
                  className="blog-feed__card-link"
                  aria-label={post.title}
                >
                  <div className="blog-feed__card-cover-wrap">
                    <img
                      className="blog-feed__card-cover"
                      src={cover}
                      alt={coverAlt}
                      loading="lazy"
                    />
                  </div>
                  <div className="blog-feed__card-body">
                    {post.isLocaleFallback && (
                      <span
                        className="blog-feed__card-fallback"
                        data-testid="blog-feed-card-fallback"
                      >
                        {t(
                          'blog.feed.fallbackBadge',
                          'Not translated yet',
                        )}
                      </span>
                    )}
                    <h2 className="blog-feed__card-title">{post.title}</h2>
                    <p className="blog-feed__card-description">
                      {post.description}
                    </p>
                    <div className="blog-feed__card-meta">
                      <time
                        dateTime={post.publishedAt}
                        className="blog-feed__card-date"
                      >
                        {formatDate(post.publishedAt, locale)}
                      </time>
                      <span className="blog-feed__card-reading">
                        {t(
                          'blog.feed.readingTime',
                          '{{count}} min',
                          { count: post.readingTimeMin },
                        )}
                      </span>
                    </div>
                    {post.tags.length > 0 && (
                      <div className="blog-feed__card-tags">
                        {post.tags.map((tag) => (
                          <span key={tag} className="blog-feed__card-tag">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 && (
        <nav
          className="blog-feed__pagination"
          aria-label={t('blog.feed.paginationLabel', 'Pagination')}
          data-testid="blog-feed-pagination"
        >
          <button
            type="button"
            className="blog-feed__page-btn"
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1}
            data-testid="blog-feed-prev"
          >
            ← {t('blog.feed.prev', 'Previous')}
          </button>
          <span className="blog-feed__page-status">
            {t('blog.feed.pageOf', 'Page {{page}} of {{total}}', {
              page,
              total: totalPages,
            })}
          </span>
          <button
            type="button"
            className="blog-feed__page-btn"
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages}
            data-testid="blog-feed-next"
          >
            {t('blog.feed.next', 'Next')} →
          </button>
        </nav>
      )}
    </div>
  );
}
