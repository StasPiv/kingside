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
  { path: '/workshop', priority: 0.6, changefreq: 'weekly' },
  { path: '/broadcasts', priority: 0.6, changefreq: 'daily' },
  { path: '/players', priority: 0.5, changefreq: 'daily' },
  { path: '/feedback', priority: 0.5, changefreq: 'weekly' },
  { path: '/features', priority: 0.4, changefreq: 'monthly' },
  { path: '/login', priority: 0.3, changefreq: 'monthly' },
];
