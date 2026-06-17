/**
 * KS-4116 — реестр публичных маршрутов.
 *
 * Единый источник правды для:
 *  - prerender при `vite build` (scripts/prerender.mjs),
 *  - будущей автогенерации `public/sitemap.xml` (отдельный тикет).
 *
 * Сюда добавляются ТОЛЬКО маршруты, которые открыты гостю без
 * редиректа и без авторизации, либо публично-смешанные (ProtectedRoute
 * редиректит на /login — это допустимо, prerender снимет страницу
 * логина с метатегами, что лучше, чем пустой div#root).
 *
 * Защищённые / приватные маршруты (например `/settings`, `/messages`,
 * `/friends`, `/profile`, `/dev-bypass`, любой `/game/:id`) сюда не
 * добавляются — там нет публичного контента для индексации.
 *
 * При добавлении новой публичной страницы в `App.tsx` обновить этот
 * список — иначе она не попадёт ни в prerender, ни в sitemap.
 */
export interface PublicRoute {
  /** Абсолютный путь маршрута (с ведущим слешем). */
  path: string;
  /** Приоритет для sitemap.xml (0.0–1.0). По умолчанию 0.5. */
  priority?: number;
  /** Частота обновления для sitemap.xml. */
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
}

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { path: '/', priority: 1.0, changefreq: 'daily' },
  { path: '/play', priority: 0.9, changefreq: 'daily' },
  { path: '/lobby', priority: 0.8, changefreq: 'daily' },
  { path: '/tournaments', priority: 0.8, changefreq: 'daily' },
  { path: '/puzzles', priority: 0.8, changefreq: 'daily' },
  { path: '/daily', priority: 0.7, changefreq: 'daily' },
  { path: '/puzzle-rush', priority: 0.7, changefreq: 'weekly' },
  { path: '/analysis', priority: 0.7, changefreq: 'weekly' },
  // KS-4320: публичный SEO-лендинг игры с ботом — длинный контентный
  // блок + per-page SeoHelmet, рендерятся в prerender'е как HTML.
  { path: '/play/local-bot', priority: 0.6, changefreq: 'weekly' },
  // KS-4325: маркетинговые long-tail SEO-лендинги (заменяют KS-4320
  // `/analysis/import`). Длинные тексты из `/tmp/seo-texts/02..03.md`
  // на отдельных публичных URL.
  { path: '/analyze-pgn-online', priority: 0.8, changefreq: 'monthly' },
  { path: '/puzzles-from-your-games', priority: 0.8, changefreq: 'monthly' },
  { path: '/workshop', priority: 0.6, changefreq: 'weekly' },
  { path: '/broadcasts', priority: 0.6, changefreq: 'daily' },
  { path: '/players', priority: 0.5, changefreq: 'daily' },
  // KS-4192: гостевой каталог `/lectures` — открыт без логина.
  { path: '/lectures', priority: 0.6, changefreq: 'daily' },
  { path: '/feedback', priority: 0.5, changefreq: 'weekly' },
  { path: '/features', priority: 0.4, changefreq: 'monthly' },
  { path: '/login', priority: 0.3, changefreq: 'monthly' },
  // KS-4222: PF-тренажёры и продуктовые лендинги — открыты гостям,
  // имеют per-page SeoHelmet (см. PageSeo и i18n seo.<ns>.*).
  // prerender кладёт статичные snapshot'ы в `dist/<route>/index.html`
  // — Telegram/Google читают их без выполнения JS.
  { path: '/blind-board', priority: 0.6, changefreq: 'weekly' },
  { path: '/guess', priority: 0.5, changefreq: 'weekly' },
  { path: '/opening-trainer', priority: 0.6, changefreq: 'weekly' },
  { path: '/drills', priority: 0.5, changefreq: 'weekly' },
  { path: '/lessons', priority: 0.7, changefreq: 'daily' },
  { path: '/precision', priority: 0.6, changefreq: 'weekly' },
  { path: '/games/live', priority: 0.5, changefreq: 'daily' },
  // KS-4272: страницы inline-footer на гостевом лендинге. Без prerender
  // CloudFront/S3 отдавал `dist/index.html` (снимок главной с тем же
  // inline-footer) — при прямом заходе пользователь видел не правила,
  // а главную, и клик по «Внешний движок» уводил его на
  // `/help/external-engine`. Snapshot'ы фиксят это: каждый URL отдаёт
  // свою страницу без необходимости ждать hydrate.
  { path: '/terms', priority: 0.3, changefreq: 'monthly' },
  { path: '/help/external-engine', priority: 0.3, changefreq: 'monthly' },
  { path: '/credits', priority: 0.3, changefreq: 'monthly' },
];
