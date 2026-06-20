/**
 * KS-4396 → KS-4413 / ADR-137 rev2. Лента блога `/blog`.
 *
 * Источник данных — публичный API `GET /blog/posts` (хук
 * `useBlogPosts`, KS-4413). До rev2 страница читала статичный
 * локальный markdown-индекс, собранный на сборке; теперь источник
 * правды — БД через API (см. ADR-137 rev2 §1).
 *
 * Пагинация числовая `?page=N`, 12 статей на страницу (фиксировано
 * backend'ом, см. PAGE_SIZE в `apps/api/src/blog/blog.service.ts`).
 * Этого хватает для статичного prerender'а — каждая страница имеет
 * стабильный URL (ADR-137 §2.6).
 *
 * Фильтр по тегу через `?tag=<name>`. Сейчас единственный способ
 * выставить тег — внешняя ссылка/перезапись URL; кнопок-фильтров
 * на ленте пока нет (могут появиться в отдельной задаче — карточки
 * статей уже рендерят `tags` ссылками).
 */
import { useCallback, useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { PageSeo } from '../components/seo/PageSeo';
import { useBlogPosts } from '../hooks/useBlogPosts';
import {
  DEFAULT_BLOG_LOCALE,
  blogFeedPath,
  blogPostPath,
  toBlogLocale,
} from '../utils/blogUrl';
// KS-4477 / ADR-140 T11. Компактный формат `1.2k` для счётчиков
// вовлечённости в карточке фида. Базовый `formatCompact` уже
// используется в AnalysisPage для статистики движка (без знаков
// после запятой); для блога просим одну десятичную.
import { formatCompact } from '../utils/chessFormat';
import type { BlogLocale } from '@kingside/shared';

// KS-4438: дефолтную картинку-плашку для карточки без обложки не
// рендерим — файла `/og/blog-default.png` в проекте нет и заводить его
// не будем. Когда у поста `coverUrl=null`, обёртка `.blog-feed__card-cover-wrap`
// остаётся пустой (CSS даёт нейтральный фон-плейсхолдер, см. blog.css).

function formatDate(iso: string | null, locale: BlogLocale): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(
      locale === 'ru' ? 'ru-RU' : 'en-US',
      { year: 'numeric', month: 'short', day: 'numeric' },
    );
  } catch {
    return iso;
  }
}

export function BlogFeedPage() {
  const { t, i18n } = useTranslation();
  const { lang } = useParams<{ lang: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // KS-4460. Источник правды по локали страницы — URL (`/:lang/blog`),
  // а не глобальный `i18n.language`. Это нужно, чтобы:
  //   1) при заходе на `/ru/blog` гость с дефолтным `en`-UI всё равно
  //      получал русскую ленту (а не пустую/английскую);
  //   2) prerender каждой локали снимал стабильный snapshot независимо
  //      от языковой эвристики `i18n/index.ts`.
  // `BlogLangGuard` в App.tsx гарантирует, что сюда придёт только
  // валидное значение `lang`, но `toBlogLocale` даёт safe-fallback на
  // случай ручного захода в обход guard'а (например, в тестах).
  const locale = toBlogLocale(lang ?? DEFAULT_BLOG_LOCALE);

  // KS-4460. Синхронизация i18n с URL: подменяем `i18n.language` под
  // локаль маршрута, чтобы шапка/меню/футер тут же показывались на
  // выбранном языке. На размонтировании язык не откатываем —
  // пользователь, перешедший с `/ru/blog` куда-то ещё, ожидает
  // оставаться в `ru` (тот же контракт, что у `SettingsPage`).
  useEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [i18n, locale]);

  const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const tag = searchParams.get('tag') ?? '';

  const { items, totalPages, loading, error } = useBlogPosts(
    locale,
    page,
    tag,
  );

  const goToPage = useCallback(
    (next: number) => {
      const sp = new URLSearchParams(searchParams);
      if (next <= 1) sp.delete('page');
      else sp.set('page', String(next));
      setSearchParams(sp, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const clearTag = useCallback(() => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('tag');
    sp.delete('page');
    setSearchParams(sp, { replace: false });
  }, [searchParams, setSearchParams]);

  const state = loading
    ? 'loading'
    : error
      ? 'error'
      : items.length === 0
        ? 'empty'
        : 'ready';

  return (
    <div
      className="blog-feed"
      data-testid="blog-feed"
      data-state={state}
    >
      {/* KS-4460. Canonical/URL — на конкретную языковую версию ленты,
          у каждой локали свой URL. hreflang передаём явно: на ленте две
          языковые версии + `x-default` → дефолтная локаль. */}
      <PageSeo
        ns="blog.feed"
        path={blogFeedPath(locale)}
        hreflang={[
          { lang: 'en', href: `https://kingside.site${blogFeedPath('en')}` },
          { lang: 'ru', href: `https://kingside.site${blogFeedPath('ru')}` },
          {
            lang: 'x-default',
            href: `https://kingside.site${blogFeedPath(DEFAULT_BLOG_LOCALE)}`,
          },
        ]}
        lang={locale}
      />

      <header className="blog-feed__header">
        <h1>{t('blog.feed.title', 'Blog')}</h1>
        <p className="blog-feed__intro">
          {t(
            'blog.feed.intro',
            'Stories, technical write-ups and updates from Kingside.',
          )}
        </p>
        {tag && (
          <div
            className="blog-feed__tag-filter"
            data-testid="blog-feed-tag-filter"
          >
            <span className="blog-feed__tag-filter-label">
              {t('blog.feed.tagFilter', 'Tag: #{{tag}}', { tag })}
            </span>
            <button
              type="button"
              className="blog-feed__tag-filter-clear"
              onClick={clearTag}
              data-testid="blog-feed-tag-clear"
            >
              {t('blog.feed.tagFilterClear', 'Clear')}
            </button>
          </div>
        )}
      </header>

      {state === 'loading' && (
        <p
          className="blog-feed__status blog-feed__status--loading"
          data-testid="blog-feed-loading"
        >
          {t('blog.feed.loading', 'Loading…')}
        </p>
      )}

      {state === 'error' && (
        <p
          className="blog-feed__status blog-feed__status--error"
          data-testid="blog-feed-error"
        >
          {t('blog.feed.error', 'Failed to load posts. Please try again later.')}
        </p>
      )}

      {state === 'empty' && (
        <p
          className="blog-feed__status blog-feed__status--empty"
          data-testid="blog-feed-empty"
        >
          {tag
            ? t('blog.feed.emptyTag', 'No posts with this tag.')
            : t('blog.feed.empty', 'No posts yet. Stay tuned.')}
        </p>
      )}

      {state === 'ready' && (
        <ul className="blog-feed__list" data-testid="blog-feed-list">
          {items.map((post) => {
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
                  to={blogPostPath(locale, post.slug)}
                  className="blog-feed__card-link"
                  aria-label={post.title}
                >
                  {/* KS-4438: `<img>` рендерим только при наличии coverUrl.
                      Без обложки оставляем пустую обёртку — CSS-плейсхолдер
                      (`.blog-feed__card-cover-wrap`) даёт нейтральный фон,
                      битой иконки нет. */}
                  {post.coverUrl && (
                    <div className="blog-feed__card-cover-wrap">
                      <img
                        className="blog-feed__card-cover"
                        src={post.coverUrl}
                        alt={coverAlt}
                        loading="lazy"
                      />
                    </div>
                  )}
                  <div className="blog-feed__card-body">
                    {post.isLocaleFallback && (
                      <span
                        className="blog-feed__card-fallback"
                        data-testid="blog-feed-card-fallback"
                      >
                        {t('blog.feed.fallbackBadge', 'Not translated yet')}
                      </span>
                    )}
                    <h2 className="blog-feed__card-title">{post.title}</h2>
                    <p className="blog-feed__card-description">
                      {post.description}
                    </p>
                    <div className="blog-feed__card-meta">
                      <time
                        dateTime={post.publishedAt ?? undefined}
                        className="blog-feed__card-date"
                      >
                        {formatDate(post.publishedAt, locale)}
                      </time>
                      <span className="blog-feed__card-reading">
                        {t('blog.feed.readingTime', '{{count}} min', {
                          count: post.readingTimeMin,
                        })}
                      </span>
                    </div>
                    {/* KS-4477 / ADR-140 T11. Три счётчика
                        вовлечённости в нижней мета-строке. Иконки —
                        те же, что используются на странице статьи
                        (LikeButton: ♥, BlogPostPage: 👁), плюс 💬
                        для комментариев. Числа — компактным форматом
                        `1.2k` от 1000; всегда отрисовываем три блока
                        (включая 0), чтобы карточка имела стабильную
                        высоту независимо от вовлечённости статьи. */}
                    <div
                      className="blog-feed__card-stats"
                      data-testid="blog-feed-card-stats"
                    >
                      <span
                        className="blog-feed__card-stat"
                        data-testid="blog-feed-card-views"
                        title={t('blog.feed.viewsTitle', 'Views')}
                      >
                        <span
                          className="blog-feed__card-stat-icon"
                          aria-hidden="true"
                        >
                          👁
                        </span>{' '}
                        {formatCompact(post.viewsCount, { decimals: 1 })}
                      </span>
                      <span
                        className="blog-feed__card-stat"
                        data-testid="blog-feed-card-likes"
                        title={t('blog.feed.likesTitle', 'Likes')}
                      >
                        <span
                          className="blog-feed__card-stat-icon"
                          aria-hidden="true"
                        >
                          ♥
                        </span>{' '}
                        {formatCompact(post.likesCount, { decimals: 1 })}
                      </span>
                      <span
                        className="blog-feed__card-stat"
                        data-testid="blog-feed-card-comments"
                        title={t('blog.feed.commentsTitle', 'Comments')}
                      >
                        <span
                          className="blog-feed__card-stat-icon"
                          aria-hidden="true"
                        >
                          💬
                        </span>{' '}
                        {formatCompact(post.commentsCount, { decimals: 1 })}
                      </span>
                    </div>
                    {post.tags.length > 0 && (
                      <div className="blog-feed__card-tags">
                        {post.tags.map((entry) => (
                          <span
                            key={entry}
                            className="blog-feed__card-tag"
                          >
                            #{entry}
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

      {state === 'ready' && totalPages > 1 && (
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
