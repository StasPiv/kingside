# ADR-137: Блог Kingside — концепт и архитектура

Связанные тикеты: KS-4392.
Связанные ADR: 128 (PageSeo), KS-4116 (prerender).

## 1. Контекст

На сайте нет раздела блога. Накопились статьи (5 заготовок в `/project/.agent-tmp/seo-texts/`, в т.ч. `05-blog-free-alternatives-to-chesscom.md`), будут ещё. Нужно постоянное место под публикации с поддержкой RU/EN, SEO-индексацией и интеграцией с разделами проекта.

В проекте уже работают:

* `<PageSeo ns="..." path="..." />` — обёртка над `<SeoHelmet>`, читает `seo.<ns>.title|description` из i18n;
* `<SeoHelmet>` — title/description/canonical/og-теги/JSON-LD;
* build-time prerender через Playwright (`apps/web/scripts/prerender.mjs`) — снимает HTML каждого публичного маршрута;
* реестр публичных маршрутов `apps/web/src/config/publicRoutes.ts` (исп. в prerender и sitemap);
* статичный `apps/web/public/sitemap.xml`;
* i18n локали `apps/web/src/i18n/locales/{en,ru}`;
* маркетинговые лендинги (`/analyze-pgn-online`, `/puzzles-from-your-games`, `/play/local-bot`) — другая сущность, не блог.

Блога нет ни как маршрута, ни как контентного слоя.

## 2. Решение

### 2.1. Где живёт контент

**Markdown-файлы в репо** с YAML-фронтматтером. Путь:

```
apps/web/src/content/blog/<slug>.<locale>.md
```

Пример:

```
apps/web/src/content/blog/
  free-alternatives-to-chesscom.ru.md
  free-alternatives-to-chesscom.en.md
  why-maia-puzzles.ru.md
  why-maia-puzzles.en.md
```

Slug — латиница-дефис, lowercase, регистронезависимое сравнение. Locale — двухбуквенный код (`ru`, `en`).

**Сборка индекса.** Vite-плагин (или `glob` + статический импорт через `import.meta.glob`) сканирует папку при build, генерирует `apps/web/src/generated/blog-index.ts` с массивом мета (`slug`, `locale`, `frontmatter`, путь к телу). Рантайм страница `/blog` импортирует этот индекс синхронно; `/blog/:slug` lazy-импортирует тело конкретной статьи (`import.meta.glob` с `eager: false`).

**Парсинг Markdown.** Существующая инфраструктура vite. Достаточно одного из:
* `vite-plugin-md` — простая интеграция, frontmatter через `gray-matter`;
* собственный loader через `unified` + `remark-html` — даёт больше контроля, можно подмешивать кастомные плагины (подсветка кода, шахматные диаграммы из FEN).

В MVP — `vite-plugin-md` (минимум собственного кода). При появлении нужды в кастомных компонентах (шахматный блок прямо в статье) — переходим на MDX (`vite-plugin-mdx`) отдельной задачей.

**Обоснование выбора.**

| Опция | Плюсы | Минусы |
|---|---|---|
| Markdown в репо (выбрано) | Версионирование статей через git, ревью через PR, локально открывается в любом редакторе, не нужен бэкенд | Каждое обновление — деплой. Нет роли «редактор без доступа к репо» |
| MDX в репо | Можно встраивать React-компоненты (шахматные диаграммы, виджеты) | Сложнее парсить, дороже сопровождать |
| Headless CMS (Strapi, Sanity) | Редактор-интерфейс без git | Отдельный сервис + БД, overhead для одного разработчика и редких публикаций |
| Собственная БД-схема + админка | Полный контроль | Нужны: миграция, API, админка-UI, авторизация. Слишком много кода ради 1–2 статей в месяц |

Объём публикаций (несколько статей сейчас + ~1 в месяц прогнозируемо) не оправдывает CMS/БД. Markdown в репо — стандарт для product blog'ов небольших команд (Vercel, Stripe blog, Linear), хорошо ложится на нашу инфру (prerender + i18n уже есть).

### 2.2. Маршруты

```
/blog              — лента (список карточек)
/blog/:slug        — отдельная статья
/blog/tag/:tag     — фильтр по тегу (опционально, MVP без него)
```

**Формат адреса:** латиница-дефис, lowercase, регистронезависимое сравнение. Кириллица в slug — НЕТ (повышает риск ошибок в копировании ссылок, плюс часть ботов не умеет с percent-encoded URL). Заголовок на русском — в frontmatter.

Slug привязан к статье, не к локали. Один slug → две локализации одной статьи (`<slug>.ru.md`, `<slug>.en.md`). Если только одна локаль есть, страница на другой локали показывает плашку «эта статья пока не переведена» + ссылку на доступную версию.

### 2.3. Локализация RU/EN

**Раздельные файлы на статью.** Один `<slug>.ru.md` + один `<slug>.en.md`. Это проще, чем секции внутри одного файла:

* parser не нужен специальный;
* git diff читается линейно для каждой локали;
* можно публиковать только RU или только EN, не блокируя друг друга;
* контент-инженер видит «свой» файл, не путается в чужой локали.

**Какая локаль показывается.** Зависит от `i18n.language` (UI-язык, уже работает в проекте). Если файл для текущей локали отсутствует — fallback на доступную с плашкой.

**Переключатель на странице статьи** — не нужен. Пользователь переключает язык интерфейса в Header, статья переключается вместе.

### 2.4. SEO и prerender

Каждая статья → отдельная страница, prerendered в build:

* `<PageSeo>` использовать нельзя как есть — i18n-ключи у статьи не статичны. Делаем `<BlogPostSeo>` — обёртку над `<SeoHelmet>`, которая берёт title/description из frontmatter статьи.
* `canonical = https://kingside.site/blog/<slug>` (без локали в URL — локаль выбирается языком интерфейса; canonical один на статью, hreflang теги добавляются для RU/EN).
* `og:type = "article"`, `og:image = frontmatter.cover ?? '/og/blog-default.png'`.
* JSON-LD `Article` schema.org с `author`, `datePublished`, `dateModified`, `headline`, `image`.

**Prerender** — в `apps/web/scripts/prerender.mjs` нужна автогенерация маршрутов блога. Сейчас он читает `publicRoutes.ts` через regex (literal-массив). Решение: автогенерировать блог-маршруты в `publicRoutes.ts` через build-step (тот же vite-плагин, что строит `blog-index.ts`, дописывает в файл блок `BLOG_ROUTES`). prerender перечитывает publicRoutes как обычно.

**Sitemap.** Сейчас `public/sitemap.xml` ручной. Отдельный планируемый тикет — автогенерация. Блог в неё добавляется одновременно: блог-плагин при build генерирует sitemap-секцию.

**hreflang.** Добавить теги `<link rel="alternate" hreflang="ru" href=".../blog/<slug>" />` и `hreflang="en"` для всех статей, где есть обе локали (один path, разные hreflang — стандарт для same-URL мультиязыка).

**Robots:** статьи индексируются (без `noindex`). Папка `apps/web/src/content/blog/` через `.gitattributes` помечена `linguist-language=Markdown` — для git-статистики и подсветки.

### 2.5. Метаданные статьи

YAML-фронтматтер:

```yaml
---
title: "Бесплатные альтернативы Chess.com"
description: "Короткий SEO-описательный абзац до 160 символов."
slug: free-alternatives-to-chesscom        # дублирует filename для устойчивости при рефакторинге
locale: ru                                  # дублирует filename, для self-check
publishedAt: 2026-06-20                     # YYYY-MM-DD
updatedAt: 2026-06-20                       # YYYY-MM-DD, не показывается если равен publishedAt
author: kingside                            # ID автора из apps/web/src/content/blog/_authors.json
tags: [seo, marketing, chess-platforms]     # массив, lowercase-дефис
cover: /blog-covers/free-alternatives.jpg   # абсолютный путь от корня сайта
coverAlt: "Скриншот доски Kingside"          # для og:image:alt и <img alt=>
relatedRoute: /puzzles                      # ссылка на раздел проекта (опц.), фронт рендерит CTA-блок
draft: false                                # true → не попадает в build prerender и sitemap
---

# Заголовок статьи

Тело статьи в Markdown.
```

**Поля:**

| Поле | Обязательное | Назначение |
|---|---|---|
| `title` | да | `<title>`, заголовок карточки, og:title |
| `description` | да | meta description, og:description |
| `slug` | да | sanity-check filename |
| `locale` | да | sanity-check filename |
| `publishedAt` | да | сортировка ленты, og `article:published_time`, JSON-LD `datePublished` |
| `updatedAt` | да | JSON-LD `dateModified`, бейдж «обновлено» в карточке если ≠ publishedAt |
| `author` | да | ссылка в `_authors.json` (имя, аватар, био) |
| `tags` | да | массив, фильтр ленты, JSON-LD `keywords` |
| `cover` | нет | дефолт `/og/blog-default.png` |
| `coverAlt` | если есть `cover` | a11y + og:image:alt |
| `relatedRoute` | нет | если задан — рендерится блок «Попробовать в разделе» внизу статьи |
| `draft` | нет, default false | true → исключается из сборки |

**Reading time.** Расчёт автоматически: количество слов / 200 wpm для RU, / 250 wpm для EN, округление вверх. Делается в build-плагине, кладётся в индекс. В frontmatter не хранится.

**Авторы.** `apps/web/src/content/blog/_authors.json`:

```json
{
  "kingside": {
    "name": "Команда Kingside",
    "name_en": "Kingside Team",
    "avatar": "/blog/authors/kingside.png",
    "bio_ru": "Команда платформы.",
    "bio_en": "The platform team."
  }
}
```

MVP — один автор `kingside`. Структура держится на вырост.

### 2.6. Лента `/blog`

**Сортировка:** `publishedAt DESC` (сначала свежие). Дополнительной сортировки в MVP нет.

**Фильтры:**
* по тегу — `/blog/tag/:tag` (опционально, можно отложить);
* по году — `?year=2026` (опционально).

**Пагинация:** числовая, `?page=2`. Размер страницы 12 статей. Infinite scroll **не используем** — он плохо ладит с prerender (нужны отдельные snapshot'ы для каждой пагинированной страницы, lazy-load уводит контент за пределы snapshot).

При первой выкатке (5 статей) пагинация не активируется — все в одной странице.

**RSS-feed:** опционально. `/blog/rss.xml` генерируется тем же vite-плагином в build. MVP — оставляем как T-опциональное.

### 2.7. Связи с разделами

Двусторонняя:

1. **Статья → раздел.** Если у статьи в frontmatter есть `relatedRoute: /puzzles`, в конце статьи рендерится CTA-блок: «Попробовать в разделе „Пазлы"» со ссылкой и краткой иллюстрацией.
2. **Раздел → статьи.** На каталоге раздела (например, `TacticPuzzlesPage`) можно показывать блок «Из блога: [3 последних статьи с tag = puzzles]». Это **не MVP**, отдельной задачей после набора контента.

### 2.8. Что НЕ в MVP

* CMS / админка.
* MDX (только обычный Markdown).
* Шахматные диаграммы прямо в статье — через картинку, не через FEN-компонент.
* Комментарии — нет.
* Поиск по статьям — нет.
* RSS-feed — опционально (отдельная задача).
* Фильтр `/blog/tag/:tag` — опционально.
* Связь «раздел → статьи» — отдельная задача после набора контента.

## 3. Контракты

### 3.1. Типы в `apps/web/src/types/blog.ts`

```ts
export interface BlogPostFrontmatter {
  title: string;
  description: string;
  slug: string;
  locale: 'ru' | 'en';
  publishedAt: string;        // ISO date
  updatedAt: string;
  author: string;             // ID в _authors.json
  tags: string[];
  cover?: string;
  coverAlt?: string;
  relatedRoute?: string;
  draft?: boolean;
}

export interface BlogPost extends BlogPostFrontmatter {
  readingTimeMin: number;     // build-computed
  /** Дин. импорт тела в HTML (`vite-plugin-md` отдаёт компонент). */
  body: React.ComponentType;
}

export interface BlogIndexEntry extends BlogPostFrontmatter {
  readingTimeMin: number;
}

export interface BlogAuthor {
  id: string;
  name: string;
  name_en?: string;
  avatar?: string;
  bio_ru?: string;
  bio_en?: string;
}
```

### 3.2. Build-артефакты

* `apps/web/src/generated/blog-index.ts` — массив `BlogIndexEntry[]`, генерируется vite-плагином;
* `apps/web/src/generated/blog-routes.ts` — массив `string[]` для prerender (дополнение к `publicRoutes.ts`);
* `apps/web/dist/sitemap.xml` — собирается с блог-секцией.

## 4. План задач-наследников

```
T1. devops    vite-plugin-md или собственный loader в vite.config.ts —
              парсинг content/blog/**/*.md, генерация blog-index.ts
              + dynamic-import body-компонента
T2. frontend  Типы apps/web/src/types/blog.ts, утилиты readingTime,
              filter-by-locale fallback
T3. frontend  BlogFeedPage (/blog) — список карточек, пагинация,
              i18n-fallback с плашкой
T4. frontend  BlogPostPage (/blog/:slug) — рендер тела, BlogPostSeo
              (title/description/og/Article JSON-LD/hreflang), блок
              relatedRoute CTA, навигация назад в ленту
T5. frontend  Интеграция в App.tsx, ссылка в Header/Footer
T6. devops    Расширение prerender.mjs/publicRoutes.ts — автодобавление
              блог-маршрутов из generated/blog-routes.ts. Расширение
              sitemap-build на блог-секцию (если автосайтмап ещё не
              реализован — добавить параллельно)
T7. layout    Типографика статьи (puzzle.css аналог для blog.css):
              заголовки, списки, цитаты, код-блоки, изображения,
              читаемая ширина строки, тёмная тема. Карточка ленты:
              cover-image, мета (автор/дата/reading time), бейдж тегов
T8. content   Перенос 5 заготовок из .agent-tmp/seo-texts/ в
              apps/web/src/content/blog/<slug>.ru.md.
              Подготовка EN-версий (опционально, можно поэтапно).
              _authors.json с кингсайд-командой
T9. content   Подготовка cover-обложек 1200×630 для каждой статьи
              (og:image формат)
T10. marketing Финальная вычитка SEO-полей (title ≤ 60 символов,
              description ≤ 160 символов), tagging, расстановка
              relatedRoute, JSON-LD проверка через Rich Results Test
T11. devops   После выкатки — добавить /blog/* в robots.txt allow,
              проверить prerender snapshots в dist/blog/*/index.html
T12. layout   (опц.) Обложка ленты, hero-блок с featured article,
              визуальная связь с brand-цветами Kingside
T13. frontend (опц.) Фильтр /blog/tag/:tag — отдельная страница со
              своим SEO
T14. frontend (опц.) RSS-feed /blog/rss.xml, ссылка в head
T15. frontend (опц.) Блок «Из блога» на каталогах разделов
              (TacticPuzzlesPage, /puzzles, /analysis) — последние
              3 статьи с соответствующим тегом
```

**Точки безопасной остановки:**

* после T7 — техническая база готова, контента нет → блог пуст с заглушкой;
* после T8+T9+T10 — MVP-выкатка, 5 статей опубликованы;
* T11 — финальная проверка и переключение в prod;
* T12–T15 — отдельные итерации после смотра реакции.

**Порядок:** T1 → T2 → T3+T4 (параллельно) + T7 (layout параллельно фронту) → T5 → T6 → T8+T9+T10 (контент параллельно) → T11 → выкатка.

**Откат:** до T11 (включение в robots) — выключаем фича-флаг или убираем маршруты из `publicRoutes.ts`. После выкатки — статья помечается `draft: true` в frontmatter, при следующем build исчезает из ленты и sitemap.

## 5. Последствия

**Плюсы.**

* Никакой новой инфраструктуры — Markdown, vite, существующий prerender и i18n.
* Версионирование через git, ревью статей через PR.
* Полная контролируемость SEO (frontmatter + JSON-LD).
* Низкий порог входа для контент-инженера — `*.md` в редакторе.
* Никаких миграций БД, новых endpoints API, новых таблиц.

**Минусы.**

* Каждая публикация = коммит + деплой. Без редакторской админки.
* Контент-инженер должен уметь работать с git (либо ему помогает координатор).
* Один из путей развития (MDX, шахматные диаграммы) требует ручного перехода — но это обозримая отдельная задача.

## 6. Открытые вопросы

1. **Один автор или несколько.** Сейчас MVP с одним. Если планируем гостевых авторов — `_authors.json` уже готов на это.
2. **Vite-plugin-md vs unified+remark.** Точный выбор парсера — на T1, после смотра требований к подсветке кода и обработке frontmatter.
3. **OG-картинки.** Делать вручную в Figma (требует дизайнерского времени) или автогенерация через скрипт (по образцу `generate-og-images.mjs`, который уже есть для других страниц). MVP — вручную (1–2 в месяц не нагрузка); автогенерацию — отдельной задачей если поток статей вырастет.
4. **Локальная превью.** Нужен ли отдельный dev-URL для черновиков (`/blog/_drafts/:slug` за фича-флагом). Альтернатива — `draft: false` локально перед PR. Решается на T1.
