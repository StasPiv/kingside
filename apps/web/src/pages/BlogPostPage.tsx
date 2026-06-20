/**
 * KS-4398 / ADR-137 T4. Страница одной статьи `/blog/:slug`.
 *
 * Контракт:
 *   - slug приходит из URL, локаль — из `i18n.language`.
 *   - findPost из `lib/blog` отдаёт точное попадание или фолбэк на
 *     другую локаль (ADR-137 §2.3).
 *   - Тело подгружается через `loadBlogBody(slug, foundLocale)` —
 *     ленивая chunk-разгрузка `import.meta.glob` (KS-4393).
 *   - Если статьи нет ни в одной локали — 404-блок «Статья не найдена».
 *
 * Контент:
 *   - Хлебные крошки / линк назад в ленту;
 *   - Плашка фолбэка (`.blog-untranslated`) — если показан перевод
 *     на другом языке;
 *   - Cover + title + мета (автор/дата/reading time) + теги;
 *   - Тело через `dangerouslySetInnerHTML` (HTML собрал vite-blog-plugin
 *     из Markdown);
 *   - CTA-блок `.blog-related-cta` под телом — ссылка на `relatedRoute`.
 *
 * SEO — `<BlogPostSeo>` (Article JSON-LD + hreflang + canonical без
 * локали, см. ADR-137 §2.4).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BlogPostSeo } from '../components/seo/BlogPostSeo';
import authors from '../content/blog/_authors.json';
import {
  BLOG_INDEX,
  availableLocalesIn,
  findPost,
  loadBlogBody,
  type BlogAuthor,
  type BlogLocale,
} from '../lib/blog';

const DEFAULT_COVER = '/og/blog-default.png';
const AUTHORS = authors as Record<string, BlogAuthor>;

function asLocale(value: string | undefined): BlogLocale {
  return value === 'ru' ? 'ru' : 'en';
}

function formatDate(iso: string, locale: BlogLocale): string {
  try {
    return new Date(iso).toLocaleDateString(
      locale === 'ru' ? 'ru-RU' : 'en-US',
      { year: 'numeric', month: 'short', day: 'numeric' },
    );
  } catch {
    return iso;
  }
}

function pickAuthorName(author: BlogAuthor | undefined, locale: BlogLocale): string {
  if (!author) return 'Kingside';
  return locale === 'en' && author.name_en ? author.name_en : author.name;
}

function pickAuthorBio(author: BlogAuthor | undefined, locale: BlogLocale): string {
  if (!author) return '';
  return (locale === 'en' ? author.bio_en : author.bio_ru) ?? '';
}

export function BlogPostPage() {
  const { t, i18n } = useTranslation();
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const locale = asLocale(i18n.language);

  const post = useMemo(() => findPost(BLOG_INDEX, slug, locale), [slug, locale]);
  const available = useMemo(
    () => availableLocalesIn(BLOG_INDEX, slug),
    [slug],
  );

  const [bodyHtml, setBodyHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(post));

  useEffect(() => {
    if (!post) {
      setBodyHtml(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const loader = loadBlogBody(post.slug, post.locale);
    if (!loader) {
      setBodyHtml('');
      setLoading(false);
      return;
    }
    loader
      .then((mod) => {
        if (cancelled) return;
        setBodyHtml(mod.body);
      })
      .catch(() => {
        if (cancelled) return;
        setBodyHtml('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [post]);

  const handleBack = useCallback(() => {
    navigate('/blog');
  }, [navigate]);

  // ── 404 ─────────────────────────────────────────────────────────
  if (!post) {
    return (
      <div className="blog-article" data-testid="blog-post" data-state="not-found">
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

  // ── Ready ──────────────────────────────────────────────────────
  const author = AUTHORS[post.author];
  const authorName = pickAuthorName(author, locale);
  const authorBio = pickAuthorBio(author, locale);
  const isFallback = post.locale !== locale;
  const cover = post.cover ?? DEFAULT_COVER;
  const coverAlt = post.coverAlt ?? post.title;
  const updatedAt =
    post.updatedAt && post.updatedAt !== post.publishedAt
      ? post.updatedAt
      : null;

  return (
    <article
      className="blog-article"
      data-testid="blog-post"
      data-slug={post.slug}
      data-locale={post.locale}
      data-fallback={isFallback ? 'true' : 'false'}
    >
      <BlogPostSeo
        post={post}
        availableLocales={available}
        authorName={authorName}
      />

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
        <img
          className="blog-article__cover"
          src={cover}
          alt={coverAlt}
          loading="lazy"
        />
        <h1 className="blog-article__title">{post.title}</h1>
        <p className="blog-article__subtitle">{post.description}</p>
        <div
          className="blog-article__meta"
          data-testid="blog-post-meta"
        >
          <span className="blog-article__meta-author">
            {author?.avatar && (
              <img
                className="blog-article__meta-avatar"
                src={author.avatar}
                alt=""
                loading="lazy"
              />
            )}
            {authorName}
          </span>
          <span className="blog-article__meta-sep" aria-hidden="true">·</span>
          <time dateTime={post.publishedAt}>
            {formatDate(post.publishedAt, locale)}
          </time>
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

      {loading && (
        <p className="blog-article__loading" data-testid="blog-post-loading">
          {t('blog.post.loading', 'Loading the article…')}
        </p>
      )}

      {!loading && bodyHtml && (
        <div
          className="blog-article__body"
          data-testid="blog-post-body"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}

      {authorBio && (
        <aside
          className="blog-article__author"
          data-testid="blog-post-author"
        >
          {authorBio}
        </aside>
      )}

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
