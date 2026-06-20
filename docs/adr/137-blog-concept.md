# ADR-137: Блог Kingside — концепт и архитектура (rev2: БД-хранилище)

Связанные тикеты: KS-4392 (исходный концепт), KS-4405 (пересмотр на БД).
Связанные ADR: 128 (PageSeo), KS-4116 (prerender).
Связанные тикеты-реализация: KS-4393 — KS-4404 (первая версия инфраструктуры на Markdown в репо).

## 1. Контекст

Первая редакция ADR-137 (Markdown в репо, vite-plugin-md, `blog-index.ts`) реализована в KS-4393..KS-4404. На практике обнаружились архитектурные ограничения:

* каждая публикация требует PR + сборку + деплой фронта;
* нет редакторского интерфейса для контент-инженера / маркетолога без доступа к репо;
* нет нормального процесса публикации (draft → review → publish);
* sitemap-блога зависит от посредника `blog-sitemap-data.json` в S3, который синхронизируется отдельным шагом deploy (KS-4403/KS-4404);
* контент перемешан с кодом, нагрузка на CI.

Пользователь принял решение: статьи живут в БД, редактируются через админ-интерфейс, публикуются без деплоя.

В проекте уже работают (rev1, остаются полезными):

* `<PageSeo>` / `<SeoHelmet>` — title/description/canonical/og/JSON-LD;
* build-time prerender через Playwright (`apps/web/scripts/prerender.mjs`);
* реестр публичных маршрутов `apps/web/src/config/publicRoutes.ts`;
* backend-sitemap (`apps/api/src/sitemap/sitemap.service.ts`) с динамической сборкой `sitemap-blog.xml`;
* админ-модуль `apps/api/src/admin/` с `AdminApiKeyGuard`;
* CSS-стили карточек/типографики из KS-4396, KS-4398, KS-4399 (T7 первой редакции).

## 2. Решение

### 2.1. Хранилище — Prisma в основной БД

Новые модели в `packages/db/prisma/schema.prisma`:

```prisma
/// KS-4405 / ADR-137 rev2. Автор статьи. MVP — один автор «kingside»,
/// структура поддерживает несколько (гостевые посты, разные редакторы).
model BlogAuthor {
  id        String   @id @default(uuid()) @db.Uuid
  /// Slug-имя автора (`kingside`, `john-doe`). Lowercase-дефис, для URL.
  handle    String   @unique
  nameRu    String   @map("name_ru")
  nameEn    String   @map("name_en")
  /// URL аватара (S3-bucket для изображений или внешний CDN).
  avatarUrl String?  @map("avatar_url")
  bioRu     String?  @map("bio_ru")  @db.Text
  bioEn     String?  @map("bio_en")  @db.Text
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt       @map("updated_at")

  posts BlogPost[]

  @@map("blog_authors")
}

/// KS-4405 / ADR-137 rev2. Статья блога. Одна запись = одна локализация
/// одной статьи; пара RU+EN одной статьи связана общим `slug`.
model BlogPost {
  id          String   @id @default(uuid()) @db.Uuid
  /// Slug статьи (латиница-дефис, lowercase). Один slug → до двух локалей.
  /// Уникальность — пара (slug, locale).
  slug        String
  /// `'ru' | 'en'`.
  locale      String

  title       String
  description String   @db.Text
  /// Тело статьи в Markdown. Render-в-HTML делает backend через
  /// унифицированный pipeline (см. §2.3).
  bodyMd      String   @db.Text @map("body_md")
  /// Render-кэш HTML. Обновляется при каждом save. Опционально (UI
  /// может рендерить сам, но prerender и SEO снимок берут готовый).
  bodyHtml    String?  @db.Text @map("body_html")

  /// URL обложки (1200×630). NULL → дефолт `/og/blog-default.png`.
  coverUrl    String?  @map("cover_url")
  coverAlt    String?  @map("cover_alt")

  /// Теги (lowercase-дефис), массив строк.
  tags        String[] @default([])

  /// Маршрут для CTA-блока «Попробовать в разделе» (опц.).
  relatedRoute String? @map("related_route")

  /// Расчётное время чтения, минуты. Считается при save из body_md
  /// (200 wpm RU / 250 wpm EN).
  readingTimeMin Int  @map("reading_time_min")

  /// Статус публикации: `'draft' | 'published'`. Только `published`
  /// возвращается публичным API; обе видимы админу.
  status      String   @default("draft")
  /// Момент перевода в `published`. NULL у черновиков.
  publishedAt DateTime? @map("published_at")

  authorId    String   @map("author_id") @db.Uuid
  author      BlogAuthor @relation(fields: [authorId], references: [id], onDelete: Restrict)

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt       @map("updated_at")

  @@unique([slug, locale])
  @@index([status, publishedAt(sort: Desc)])
  @@index([slug])
  @@index([tags], type: Gin)
  @@map("blog_posts")
}
```

**Решения:**

* **Одна строка на локаль** (а не JSON-поля внутри одной записи). Это даёт независимое редактирование RU/EN, простые индексы по `(status, publishedAt)`, естественный fallback запросом «найти запись с тем же `slug` в другой локали».
* **Markdown в `body_md`**, HTML-кэш в `body_html`. Render — на backend (см. §2.3). Это позволяет: единый источник истины, безопасная санитизация, переключение на MDX/другой парсер без миграции данных.
* **Без отдельной таблицы тегов.** Postgres `String[]` + GIN-индекс хватает для фильтра `tags && '{seo,puzzle}'`. Отдельная нормализация — только при появлении тег-страниц с собственной мета.
* **`status` enum как строка**, не enum-тип Prisma. Меньше миграционной возни при добавлении статусов (`scheduled`, `archived`) позже.
* **`onDelete: Restrict` для автора** — нельзя удалить автора с публикациями; админка показывает счётчик и требует переноса.

### 2.2. Что выкидывается из rev1

Деинсталлируется полностью:

* `apps/web/src/content/blog/*.md` (кроме `_authors.json` — переезжает в БД через seeder);
* `apps/web/src/content/blog/.gitkeep` — больше не нужен;
* vite-plugin-md (зависимость + конфиг в `vite.config.ts`) — KS-4393;
* `apps/web/src/generated/blog-index.ts` (build artifact);
* `apps/web/src/generated/blog-routes.ts` (расширение `publicRoutes.ts` из KS-4400);
* `apps/web/src/lib/blog/filterByLocale.ts` и `findPost.ts` — их роль переходит к API; `readingTime.ts` — остаётся как утилита (используется backend через shared);
* публикация `blog-sitemap-data.json` в S3 (KS-4403 — frontend-часть, KS-4404 — devops-часть);
* чтение `blog-sitemap-data.json` из S3 в `apps/api/src/sitemap/sitemap.service.ts:fetchBlogArticles` — заменяется прямым запросом к БД.

Остаётся:

* `BlogFeedPage.tsx`, `BlogPostPage.tsx` — UI компоненты;
* CSS-стили карточек и типографики (`blog.css`, классы `.blog-card`, `.blog-untranslated`, `.blog-related-cta` и т.д.);
* `<BlogPostSeo>` (SEO-компонент) — продолжает работу, источник данных меняется;
* ссылка `/blog` в навигации (KS-4399);
* sitemap-индекс `sitemap-blog.xml` (KS-4402) — генерация остаётся, но источник меняется (из БД, без S3).

### 2.3. API

Модуль `apps/api/src/blog/`:

```
blog.module.ts
blog.controller.ts          — публичные маршруты
blog-admin.controller.ts    — админ-маршруты (AdminApiKeyGuard)
blog.service.ts             — выборки, фильтры, render Markdown→HTML
markdown-renderer.ts        — обёртка над unified + remark-html + sanitize
blog.dto.ts                 — DTOs (входные и выходные)
blog.seeder.ts              — однократный seeder из .agent-tmp/seo-texts/
                              и существующих apps/web/src/content/blog/*.md
                              (если они уже наполнены — KS-4390)
```

**Публичные маршруты:**

```
GET  /blog/posts?locale=&page=&tag=
        → 200 { items: BlogPostListItem[], total: number, page: number, pageSize: number }
        — публичная лента. status='published' only.
        Фильтр по tag — exact match в массиве tags.
        Сортировка publishedAt DESC. Размер страницы 12.

GET  /blog/posts/:slug?locale=
        → 200 BlogPostDetail
        — одна статья. Если у запрошенной локали нет — fallback на
          существующую с пометкой isLocaleFallback=true;
          если статьи нет вообще → 404.
        Render: backend отдаёт body_html (из кэша).

GET  /blog/authors/:handle
        → 200 BlogAuthor
        — публичный профиль автора (для будущей страницы /blog/by/:author).
```

**Админ-маршруты** (под `AdminApiKeyGuard`):

```
GET    /admin/blog/posts?status=&locale=&q=
            → admin-лента. Видит draft и published.
POST   /admin/blog/posts
            → создать статью (черновик).
GET    /admin/blog/posts/:id
            → получить статью по id (включая body_md).
PUT    /admin/blog/posts/:id
            → редактировать (slug/locale можно менять с проверкой
              UNIQUE; body_md → пересчёт body_html и reading_time_min).
PATCH  /admin/blog/posts/:id/status
            → перевод между draft ↔ published; при переходе в published
              записываем publishedAt=now (если ещё null).
DELETE /admin/blog/posts/:id
            → удаление (soft через status='archived' планируется отд.;
              MVP — hard delete с подтверждением в UI).

POST   /admin/blog/posts/:id/preview
            → рендер body_md без сохранения, возвращает HTML.

GET    /admin/blog/authors
POST   /admin/blog/authors
PUT    /admin/blog/authors/:id
DELETE /admin/blog/authors/:id
            → CRUD для авторов.

POST   /admin/blog/sitemap/regenerate
            → дёрнуть пересборку `sitemap-blog.xml`. Уже существует
              похожий маршрут — переиспользовать SitemapService.
```

**Render Markdown → HTML.**

Backend использует `unified` + `remark-parse` + `remark-gfm` + `remark-rehype` + `rehype-sanitize` + `rehype-stringify`. Sanitize-схема разрешает: заголовки, абзацы, списки, цитаты, инлайн-код, code-блоки, ссылки (target=_blank rel=noopener для внешних), `<img>` с ограничением src по разрешённым хостам (kingside-frontend bucket + CDN). Скрипты и iframe запрещены. Кастомные классы — только белый список (`.blog-callout`, `.blog-quote`).

Render выполняется на каждом save (`bodyHtml` обновляется). Публичный `GET /blog/posts/:slug` отдаёт готовый HTML без рендера в каждом запросе.

**Sitemap из БД:**

`SitemapService.fetchBlogArticles` (apps/api/src/sitemap/sitemap.service.ts:310) переключается с чтения S3-JSON на `prisma.blogPost.findMany({ where: { status: 'published' }, select: { slug, updatedAt }, distinct: ['slug'] })`. Прежний механизм с `blog-sitemap-data.json` удаляется.

### 2.4. Админ-интерфейс

Маршрут `/admin/blog` на фронтенде. Гард — admin-only (по тому же ключу, что используют другие админ-страницы — там сейчас `AdminApiKeyGuard` на backend; на фронте проверка роли).

Страницы:

```
/admin/blog/posts            — таблица статей (status, locale, title, author, updatedAt)
/admin/blog/posts/new        — создать черновик
/admin/blog/posts/:id/edit   — редактор + предпросмотр
/admin/blog/authors          — таблица авторов
/admin/blog/authors/:id/edit — редактор автора
```

**Редактор статьи.** Markdown-textarea + live-предпросмотр справа. Компонент `<BlogMarkdownEditor>`:

* левая колонка — `<textarea>` с подсветкой через `react-simplemde-editor` или просто моноширинная textarea + кнопки шорткатов (bold/italic/link/heading/list);
* правая колонка — `<BlogPostBody html={previewHtml} />` (тот же компонент рендера, что на публичной странице);
* предпросмотр обновляется с debounce 500 мс через `POST /admin/blog/posts/:id/preview`;
* отдельная панель frontmatter-полей (title, description, slug, locale, tags, cover, related_route, status).

Решение по парадигме редактора: **Markdown + live-предпросмотр**, а не WYSIWYG. Контент-инженер уже работает с Markdown (KS-4390 готовился в Markdown), нет смысла строить WYSIWYG для одного редактора в месяц.

### 2.5. Импорт существующих статей

Однократный seeder `blog.seeder.ts`:

1. Читает `apps/web/src/content/blog/*.{ru,en}.md` (созданные KS-4390 и при разработке).
2. Парсит frontmatter (`gray-matter` или собственный — той же зависимостью, что использовал rev1 vite-plugin).
3. Создаёт автора `kingside` из `_authors.json`, если отсутствует.
4. Для каждой статьи создаёт `BlogPost` с `status='published'`, `publishedAt=frontmatter.publishedAt`, `body_md=raw markdown`, рендерит `body_html`.
5. Идемпотентность — `INSERT ... ON CONFLICT (slug, locale) DO UPDATE` (или Prisma upsert).

Запуск — CLI `apps/api/src/blog/blog.seeder.ts` через `nest run`. После переноса данных файлы `.md` удаляются из репо (это T в декомпозиции).

Для будущих миграций (если придётся ещё что-то залить) — этот же seeder с параметром `--source <path>`.

### 2.6. Frontend — переход на API

* `BlogFeedPage.tsx` — вместо импорта `BLOG_INDEX` теперь `useBlogPosts({locale, page, tag})` через `useQuery` (react-query) к `GET /blog/posts`. Пагинация по `?page=N` остаётся. Пустое состояние и плашка fallback остаются.
* `BlogPostPage.tsx` — вместо `loadBlogBody(slug, locale)` теперь `useBlogPost(slug, locale)` к `GET /blog/posts/:slug`. Если в ответе `isLocaleFallback=true` — рендерится плашка «не переведено». `body_html` приходит готовым из API, рендерится через `dangerouslySetInnerHTML` (HTML уже санитизирован backend).
* Кэш на клиенте — стандартный react-query (staleTime 60s для ленты, 5min для статьи). Сторонний CDN-кэш не вводим (БД в той же сети, латентность копеечная).
* SEO — `<BlogPostSeo>` берёт данные из ответа API, остальное без изменений.

### 2.7. Prerender

`prerender.mjs` сейчас читает `publicRoutes.ts` + `generated/blog-routes.ts`. В rev2:

* `generated/blog-routes.ts` удаляется;
* `prerender.mjs` перед запуском получает список slug из API (`GET /blog/posts?page=1&pageSize=10000`) или из БД напрямую (если build-сервер имеет доступ);
* для каждого `/blog/<slug>` снимается snapshot;
* `/blog` (лента) снимается как обычно.

Конкретный механизм (HTTP к staging-API vs прямой Prisma в build) — на T6 (devops). По умолчанию HTTP — проще и не требует доступа к БД на frontend-build-step.

### 2.8. Совместимость с KS-4393..KS-4404

| Задача | Что делать |
|---|---|
| KS-4393 (T1, vite-plugin-md) | Откатить: удалить плагин, конфиг, generated/blog-index.ts |
| KS-4394 (T2, типы + утилиты) | Частично откатить: `filterByLocale`, `findPost` удалить; типы `BlogPostFrontmatter`, `BlogIndexEntry` заменить на `BlogPostListItem`/`BlogPostDetail` из API; `readingTime` оставить как утилиту |
| KS-4396 (T3, BlogFeedPage) | Перевести на API (см. §2.6). Базовый UI оставить |
| KS-4398 (T4, BlogPostPage) | Перевести на API (см. §2.6). Базовый UI и SEO оставить |
| KS-4399 (T5, ссылка в навигации) | Оставить как есть |
| KS-4400 (T6, prerender + sitemap) | Изменить: prerender-источник → API/БД (§2.7); sitemap-blog.xml → БД (§2.3) |
| KS-4402 (sitemap backend) | Переписать `SitemapService.fetchBlogArticles` на чтение из БД, убрать S3 |
| KS-4403 (frontend → S3 blog-sitemap-data.json) | Полностью откатить — больше не нужно |
| KS-4404 (devops sync в bucket) | Полностью откатить (если уже сделано, удалить шаг из deploy-aws.sh) |
| KS-4390 (статья «Критический момент») | Перенести через seeder. После переноса — удалить `.md` файлы |

## 3. Контракты типов (API)

```ts
// shared/src/types/blog.ts (новый)

export type BlogLocale = 'ru' | 'en';
export type BlogPostStatus = 'draft' | 'published';

export interface BlogAuthor {
  id: string;
  handle: string;
  nameRu: string;
  nameEn: string;
  avatarUrl?: string | null;
  bioRu?: string | null;
  bioEn?: string | null;
}

export interface BlogPostListItem {
  id: string;
  slug: string;
  locale: BlogLocale;
  title: string;
  description: string;
  coverUrl: string | null;
  coverAlt: string | null;
  tags: string[];
  readingTimeMin: number;
  publishedAt: string | null;
  updatedAt: string;
  author: Pick<BlogAuthor, 'handle' | 'nameRu' | 'nameEn' | 'avatarUrl'>;
}

export interface BlogPostDetail extends BlogPostListItem {
  bodyHtml: string;
  relatedRoute: string | null;
  /** В какой локали реально пришёл ответ (если запрашивали другую — fallback). */
  isLocaleFallback: boolean;
  /** Список локалей, в которых статья существует (для hreflang-тегов). */
  availableLocales: BlogLocale[];
}

export interface BlogPostsPage {
  items: BlogPostListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// Admin-only:
export interface BlogPostAdmin extends BlogPostDetail {
  bodyMd: string;
  status: BlogPostStatus;
}
```

## 4. Что делаем и в каком порядке

### Шаг 1. Backend (создание)

| T | Кому | Задача |
|---|---|---|
| T1 | backend | Prisma миграция: `blog_posts`, `blog_authors`, индексы. Сидовый `BlogAuthor` `kingside` (через миграцию или seeder) |
| T2 | backend | `apps/api/src/blog/` — модуль с публичными маршрутами `GET /blog/posts`, `GET /blog/posts/:slug`, `GET /blog/authors/:handle`. Markdown-render через unified+rehype-sanitize, кэш `body_html` на save |
| T3 | backend | Админ-контроллер `BlogAdminController` под `AdminApiKeyGuard`: CRUD статей, CRUD авторов, `POST /admin/blog/posts/:id/preview`, перевод status |
| T4 | backend | `blog.seeder.ts` — однократный импорт из `apps/web/src/content/blog/*.md` и `.agent-tmp/seo-texts/`. CLI-команда, идемпотентная (upsert по `(slug, locale)`) |
| T5 | backend | `SitemapService.fetchBlogArticles` → БД. Удалить S3-чтение `blog-sitemap-data.json`. `sitemap-blog.xml` теперь генерится из `prisma.blogPost.findMany(status='published')` |
| T6 | shared | Типы в `packages/shared/src/types/blog.ts` (см. §3). Контракты доступны фронту и backend |

### Шаг 2. Frontend (переключение)

| T | Кому | Задача |
|---|---|---|
| T7 | frontend | `BlogFeedPage` → `useBlogPosts` через `GET /blog/posts`. Удалить импорт `BLOG_INDEX`. Пагинация остаётся, плашка fallback остаётся |
| T8 | frontend | `BlogPostPage` → `useBlogPost` через `GET /blog/posts/:slug`. `body_html` из API через `dangerouslySetInnerHTML`. `<BlogPostSeo>` берёт данные из ответа |
| T9 | frontend | Удалить `apps/web/src/lib/blog/filterByLocale.ts`, `findPost.ts`. Утилита `readingTime.ts` остаётся, но больше не вызывается на клиенте — переезжает в shared при необходимости backend (см. T2) |
| T10 | frontend | Удалить `apps/web/src/generated/blog-index.ts`, `blog-routes.ts`. Удалить ссылку из `publicRoutes.ts` на `blog-routes` |
| T11 | frontend | Админ-страницы `/admin/blog/posts`, `/admin/blog/posts/new`, `/admin/blog/posts/:id/edit`, `/admin/blog/authors*`. Markdown-редактор с live-предпросмотром (см. §2.4) |

### Шаг 3. Инфраструктура

| T | Кому | Задача |
|---|---|---|
| T12 | devops | Удалить шаг `aws s3 cp blog-sitemap-data.json ...` из `scripts/deploy-aws.sh` (KS-4404). Удалить файл из bucket `kingside-prerender-store` |
| T13 | devops | `prerender.mjs` — источник списка slug из API (`GET /blog/posts`), не из generated/blog-routes |
| T14 | frontend | Удалить vite-plugin-md из `vite.config.ts` + `package.json`. Удалить `apps/web/scripts/sitemap-build.mjs` или обновить (без блог-секции — он теперь у backend) |

### Шаг 4. Контент и cleanup

| T | Кому | Задача |
|---|---|---|
| T15 | backend | Запустить `blog.seeder.ts` на прод-БД. Подтвердить наличие KS-4390 «Критический момент» в новой таблице |
| T16 | content | Перенести оставшиеся заготовки из `.agent-tmp/seo-texts/` в админку через `/admin/blog/posts/new` — это вместо seeder для будущих публикаций |
| T17 | frontend | Удалить `apps/web/src/content/blog/*.md` и `_authors.json` (после успешного T15) |
| T18 | marketing | Финальная вычитка перенесённых статей в админке, проставление tags и `relatedRoute` |

### Точки безопасной остановки

* **После T2+T6** — публичные маршруты API готовы, фронт ещё на старой реализации (`BLOG_INDEX`). Откат: удалить модуль на backend.
* **После T8** — фронт уже на API, контента нет (если миграции T15 не было) — лента пустая.
* **После T15** — статья переехала, фронт показывает её через API. Старые `.md` ещё в репо как страховка.
* **После T17** — Markdown-репо удалён, точка невозврата к rev1.

### Порядок

T1 → T2+T6 (shared параллельно) → T3 → T4 → T5 (backend готов) → T7+T8+T9+T10 (frontend параллельно после T6) → T15 → T11 (админка) → T12+T13+T14 (cleanup) → T17 → T16+T18 (контент).

### Откат

* До T15 — реверт-коммитом всех изменений; данные в БД пусты, пользователю показывается rev1 как раньше.
* После T15 (данные в БД) — можно откатить только фронт (вернуть rev1 `BLOG_INDEX`), оставив таблицы в БД. Контент-инженер сможет работать через rev1 до повторной попытки.
* После T17 (удаление `.md`) — точка невозврата к rev1, откат означает экспорт из БД обратно в Markdown через утилиту-обратку.

## 5. Последствия

**Плюсы.**

* Публикация без деплоя — редактор работает в UI.
* Версионирование через `updatedAt` + (опционально позже) отдельная таблица `BlogPostRevision`.
* SEO/sitemap — динамически из БД, без посредников в S3.
* Единый процесс для всех типов контента (привычная для команды БД-схема).
* Возможность будущих фич (комментарии, лайки, аналитика) без структурной перестройки.

**Минусы / риски.**

* Текущая Markdown-инфраструктура (KS-4393..KS-4404) частично выбрасывается. Это работа, которая уже сделана; чтобы её обнулить осознанно — оформляется как декомпозиция.
* Backend становится зависим от блога: статья без API недоступна. Раньше fallback был «vite build снимает snapshot». Теперь — кэш фронта (react-query) + prerender-snapshot. Полный outage API → невозможность открыть новую статью; уже снятые prerender-snapshot выживают.
* Markdown-редактор и live-предпросмотр — новый компонент, требует тестов и UX-итераций.
* Sanitize-схема — критична для безопасности. XSS через сохранённый markdown-контент админом — единственный реальный риск; sanitize обязателен.

## 6. Открытые вопросы

1. **Многоверсионность статей** — нужна ли таблица `BlogPostRevision` (для отката правок)? MVP — нет, `updatedAt` на одной записи. Решается по запросу.
2. **Расписание публикации** (`scheduled`-статус с `publishAt > now`) — нужен ли cron-апдейтер. MVP — нет, переход в `published` ручной.
3. **Загрузка обложек** — пока через прямой URL в `cover_url` (картинку загружает сам редактор куда-то и вставляет). Полноценный uploader в админку (с S3-bucket для blog-images) — отдельной задачей.
4. **Аналитика просмотров** — отдельная таблица `BlogPostView` или внешний инструмент (Plausible/Yandex.Metrica). MVP — внешний.
5. **Комментарии** — не в MVP. Если появятся — отдельная таблица `BlogComment` + модерация.
