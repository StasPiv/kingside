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
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { BlogPostSeo } from '../components/seo/BlogPostSeo';
import { blogApi } from '../api/api-blog';
import { useBlogPost } from '../hooks/useBlogPost';
import {
  DEFAULT_BLOG_LOCALE,
  blogFeedPath,
  toBlogLocale,
} from '../utils/blogUrl';
import type {
  BlogLocale,
  BlogPostDetail,
} from '@kingside/shared';

// KS-4474 / ADR-140 §2.2 T8. Задержка между моментом готовности статьи
// и `POST /view` — отсекает скан-проходы по ленте (пользователь открыл,
// сразу нажал «назад»), оставляет реальные просмотры.
const VIEW_DELAY_MS = 5000;

// KS-4474. Префикс ключа `sessionStorage` для фронт-дедупа. Полный ключ:
// `blog:view:<slug>:<locale>`. На back/forward в той же вкладке не
// шлём повторный POST — backend и так дедупит в окне 24ч, но это
// экономит сетевой round-trip.
const VIEW_SESSION_PREFIX = 'blog:view';

function makeViewKey(slug: string, locale: BlogLocale): string {
  return `${VIEW_SESSION_PREFIX}:${slug}:${locale}`;
}

// KS-4438: дефолтный путь `/og/blog-default.png` убран — файла такого
// в проекте нет (и не будет, см. тикет). Если у статьи нет `coverUrl`,
// картинку в шапке не рендерим вовсе.

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
  const { slug = '', lang } = useParams<{ slug: string; lang: string }>();
  const navigate = useNavigate();
  // KS-4460. Локаль страницы — из URL (`/:lang/blog/:slug`), а не из
  // `i18n.language`. Гость, попавший на `/ru/blog/<slug>` с дефолтным
  // английским UI, должен увидеть русскую статью. См. BlogFeedPage с
  // тем же контрактом.
  const locale = toBlogLocale(lang ?? DEFAULT_BLOG_LOCALE);

  // KS-4460. Подгоняем глобальный `i18n.language` под URL, чтобы шапка/
  // меню/футер сразу показывались на нужном языке. Не откатываем на
  // unmount — пользователь после статьи остаётся в выбранной локали.
  useEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [i18n, locale]);

  const { post, status } = useBlogPost(slug, locale);

  // KS-4474 / ADR-140 T8. Локальный счётчик просмотров. Источник —
  // `post.viewsCount` при первой загрузке; после успешного
  // `POST /view` обновляется значением из ответа (`viewsCount` уже
  // инкрементированный, см. `BlogViewResponse`). Хранится как
  // `null` пока статья не загружена — UI рендерит 0 в этот момент
  // не нужно, мета-блок появляется уже на ready.
  const [viewsCount, setViewsCount] = useState<number | null>(null);

  // Синхронизация локального счётчика с серверным значением при
  // (пере)загрузке статьи. Делаем явный effect, а не инициализируем в
  // useState — `post` приходит не сразу, а при смене slug/locale
  // компонент остаётся смонтированным.
  useEffect(() => {
    if (post) setViewsCount(post.viewsCount);
  }, [post]);

  // KS-4474. Отправка `POST /view` через 5с после загрузки статьи.
  // Дедуп через `sessionStorage:blog:view:<slug>:<locale>` — повторный
  // вход в той же вкладке не шлёт повторный запрос. Backend всё равно
  // дедупит в окне 24ч (Redis), фронт-дедуп — экономия round-trip.
  useEffect(() => {
    if (!post) return;
    const sessionKey = makeViewKey(slug, locale);
    let storage: Storage | null = null;
    try {
      storage = typeof window !== 'undefined' ? window.sessionStorage : null;
    } catch {
      // Может выбросить в режимах с заблокированным storage (Safari
      // private + ITP). Считаем, что дедупа нет, но запрос отправим
      // — backend всё равно справится.
      storage = null;
    }
    if (storage?.getItem(sessionKey)) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      // Ставим маркер ДО POST: если пользователь обновит страницу пока
      // запрос в полёте — лишний запрос не пойдёт. Backend дедупит
      // в любом случае, но без маркера могли бы шлёпнуться два POST
      // подряд при быстром F5.
      try {
        storage?.setItem(sessionKey, '1');
      } catch {
        // ignore: см. catch выше.
      }
      blogApi
        .recordView(post.id)
        .then((res) => {
          if (cancelled) return;
          setViewsCount(res.viewsCount);
        })
        .catch((e) => {
          // 429/5xx не должны валить страницу. Маркер уже стоит — не
          // снимаем, чтобы не зацикливать ретраи. Следующая сессия
          // (новая вкладка) попробует снова.
          console.warn('[blog] POST /view failed', e);
        });
    }, VIEW_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [post, slug, locale]);

  const handleBack = useCallback(() => {
    navigate(blogFeedPath(locale));
  }, [navigate, locale]);

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
      <BlogPostSeo post={post} authorName={authorName} pageLocale={locale} />

      <nav
        className="blog-article__breadcrumbs"
        aria-label={t('breadcrumbs.label', 'Breadcrumbs')}
      >
        <Link
          to={blogFeedPath(locale)}
          className="blog-article__breadcrumb-link"
        >
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
          {/* KS-4474 / ADR-140 T8. Иконка просмотров. Рендерим всегда,
              даже при 0 — мета-блок должен быть стабильным, чтобы при
              успешном POST /view число не «прыгало» в виде нового
              разделителя. Источник числа — локальный state
              `viewsCount` (синхронизируется с `post.viewsCount` на
              load и обновляется из ответа POST /view). */}
          <span className="blog-article__meta-sep" aria-hidden="true">·</span>
          <span
            className="blog-article__meta-views"
            data-testid="blog-post-views"
            data-count={viewsCount ?? post.viewsCount}
            title={t('blog.post.viewsTitle', 'Views')}
          >
            <span
              className="blog-article__meta-views-icon"
              aria-hidden="true"
            >
              👁
            </span>{' '}
            {viewsCount ?? post.viewsCount}
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
