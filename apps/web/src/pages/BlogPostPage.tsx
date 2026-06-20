/**
 * KS-4398 → KS-4414 / ADR-137 rev2 T8. Страница одной статьи
 * `/blog/:slug`.
 *
 * Источник данных — публичный API `GET /blog/posts/:slug?locale=...`
 * через хук `useBlogPost` (KS-4414). До rev2 страница читала статичный
 * `BLOG_INDEX` и парсила markdown на клиенте; теперь источник правды —
 * БД, тело уже подготовлено сервером (sanitized `bodyHtml`).
 *
 * Состояния:
 *   - `loading` — серверный запрос в полёте;
 *   - `not_found` — backend вернул 404 или пустой ответ;
 *   - `error` — сетевая ошибка / 5xx; пользователь видит блок «Не
 *     удалось загрузить статью», ссылку «Назад в блог»;
 *   - `ready` — статья загружена. Если `isLocaleFallback=true` — над
 *     телом плашка «не переведено».
 */
import { useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BlogPostSeo } from '../components/seo/BlogPostSeo';
import { useBlogPost } from '../hooks/useBlogPost';
import type {
  BlogLocale,
  BlogPostDetail,
} from '@kingside/shared';

// KS-4438: дефолтный путь `/og/blog-default.png` убран — файла такого
// в проекте нет (и не будет, см. тикет). Если у статьи нет `coverUrl`,
// картинку в шапке не рендерим вовсе.

function asLocale(value: string | undefined): BlogLocale {
  return value === 'ru' ? 'ru' : 'en';
}

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

function pickAuthorName(
  author: BlogPostDetail['author'],
  locale: BlogLocale,
): string {
  if (!author) return 'Kingside';
  return locale === 'en' ? author.nameEn : author.nameRu;
}

export function BlogPostPage() {
  const { t, i18n } = useTranslation();
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const locale = asLocale(i18n.language);

  const { post, status } = useBlogPost(slug, locale);

  const handleBack = useCallback(() => {
    navigate('/blog');
  }, [navigate]);

  // ── loading ────────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div
        className="blog-article"
        data-testid="blog-post"
        data-state="loading"
      >
        <p
          className="blog-article__loading"
          data-testid="blog-post-loading"
        >
          {t('blog.post.loading', 'Loading the article…')}
        </p>
      </div>
    );
  }

  // ── error ──────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div
        className="blog-article"
        data-testid="blog-post"
        data-state="error"
      >
        <section
          className="blog-article__not-found"
          data-testid="blog-post-error"
        >
          <h1>{t('blog.post.errorTitle', 'Failed to load the article')}</h1>
          <p>
            {t(
              'blog.post.errorMessage',
              'Please try again in a moment.',
            )}
          </p>
          <button
            type="button"
            className="play-btn play-btn--compact"
            onClick={handleBack}
          >
            ← {t('blog.post.backToFeed', 'Back to the blog')}
          </button>
        </section>
      </div>
    );
  }

  // ── 404 ────────────────────────────────────────────────────────
  if (status === 'not_found' || !post) {
    return (
      <div
        className="blog-article"
        data-testid="blog-post"
        data-state="not-found"
      >
        <section
          className="blog-article__not-found"
          data-testid="blog-post-not-found"
        >
          <h1>{t('blog.post.notFoundTitle', 'Article not found')}</h1>
          <p>
            {t(
              'blog.post.notFoundMessage',
              'The link may be outdated, or the article has not been published yet.',
            )}
          </p>
          <button
            type="button"
            className="play-btn play-btn--compact"
            onClick={handleBack}
          >
            ← {t('blog.post.backToFeed', 'Back to the blog')}
          </button>
        </section>
      </div>
    );
  }

  // ── ready ──────────────────────────────────────────────────────
  const authorName = pickAuthorName(post.author, locale);
  const isFallback = Boolean(post.isLocaleFallback);
  const coverAlt = post.coverAlt ?? post.title;
  // KS-4434. Сравниваем по календарной дате, а не по полной ISO-строке:
  // `updatedAt` и `publishedAt` могут различаться секундами (бэкенд
  // ставит `now()` отдельно), но визуально это «тот же день» — пользователь
  // тогда видит «20 июн. 2026 г. · обновлено 20 июн. 2026 г.», что мусор.
  // В JSON-LD `dateModified` оставляем полный ISO как был (см. BlogPostSeo).
  const sameDay = (a: string | null, b: string | null): boolean => {
    if (!a || !b) return false;
    return a.slice(0, 10) === b.slice(0, 10);
  };
  const updatedAt =
    post.updatedAt && !sameDay(post.updatedAt, post.publishedAt)
      ? post.updatedAt
      : null;

  return (
    <article
      className="blog-article"
      data-testid="blog-post"
      data-state="ready"
      data-slug={post.slug}
      data-locale={post.locale}
      data-fallback={isFallback ? 'true' : 'false'}
    >
      <BlogPostSeo post={post} authorName={authorName} />

      <nav
        className="blog-article__breadcrumbs"
        aria-label={t('breadcrumbs.label', 'Breadcrumbs')}
      >
        <Link to="/blog" className="blog-article__breadcrumb-link">
          ← {t('blog.post.backToFeed', 'Back to the blog')}
        </Link>
      </nav>

      {isFallback && (
        <div
          className="blog-untranslated"
          data-testid="blog-post-untranslated"
          role="note"
        >
          <span className="blog-untranslated__icon" aria-hidden="true">
            🌐
          </span>
          <span>
            {t(
              'blog.post.untranslatedText',
              'This article is not translated yet. Showing the original.',
            )}
          </span>
        </div>
      )}

      <header className="blog-article__header">
        {/* KS-4438: рендерим обложку только при наличии coverUrl. */}
        {post.coverUrl && (
          <img
            className="blog-article__cover"
            src={post.coverUrl}
            alt={coverAlt}
            loading="lazy"
          />
        )}
        <h1 className="blog-article__title">{post.title}</h1>
        <p className="blog-article__subtitle">{post.description}</p>
        <div
          className="blog-article__meta"
          data-testid="blog-post-meta"
        >
          <span className="blog-article__meta-author">{authorName}</span>
          {post.publishedAt && (
            <>
              <span className="blog-article__meta-sep" aria-hidden="true">
                ·
              </span>
              <time dateTime={post.publishedAt}>
                {formatDate(post.publishedAt, locale)}
              </time>
            </>
          )}
          {updatedAt && (
            <>
              <span className="blog-article__meta-sep" aria-hidden="true">
                ·
              </span>
              <span>
                {t('blog.post.updatedAt', 'updated {{date}}', {
                  date: formatDate(updatedAt, locale),
                })}
              </span>
            </>
          )}
          <span className="blog-article__meta-sep" aria-hidden="true">·</span>
          <span>
            {t('blog.post.readingTime', '{{count}} min read', {
              count: post.readingTimeMin,
            })}
          </span>
        </div>
        {post.tags.length > 0 && (
          <div className="blog-article__tags">
            {post.tags.map((tag) => (
              <span key={tag} className="blog-article__tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* bodyHtml уже прошёл `unified + remark + rehype-sanitize` на
          сервере (KS-4406/T1). Клиентский Markdown-парсер не нужен. */}
      <div
        className="blog-article__body"
        data-testid="blog-post-body"
        dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
      />

      {post.relatedRoute && (
        <aside
          className="blog-related-cta"
          data-testid="blog-post-related-cta"
        >
          <div className="blog-related-cta__text">
            <div className="blog-related-cta__title">
              {t('blog.post.relatedCtaTitle', 'Try it in the section')}
            </div>
            <div className="blog-related-cta__route">{post.relatedRoute}</div>
          </div>
          <Link
            to={post.relatedRoute}
            className="blog-related-cta__button"
            data-testid="blog-post-related-cta-button"
          >
            {t('blog.post.relatedCtaButton', 'Open section')} →
          </Link>
        </aside>
      )}
    </article>
  );
}
