# ADR-133 — Динамические og:image превью для prerender-страниц

- Статус: **Proposed** (2026-06-16)
- Задача: KS-4266
- Закрывает: ADR-128 §17 (открытый вопрос «статичные vs динамические og:image»).
- Связанные ADR / задачи:
  - ADR-128 §7.3 — pipeline prerender-service.
  - ADR-132 §7.3 — зависимость для качества share-preview (кнопка
    «Поделиться»).
  - KS-4194 — Playwright prerender воркер.
  - KS-4205 / KS-4214 / KS-4253 — mutation hooks (broadcast / lecture /
    analysis-public).
  - KS-4262 — текущий статичный `/og/analysis.png`.
- Авторы: architect.

---

## 1. Контекст и проблема

Сейчас все публичные страницы используют **статичные** og:image из
`apps/web/public/og/<section>.png` (`analysis.png`, `lecture.png`,
`broadcast.png`, `coach.png`, `tournament.png`, `player.png`,
`archive.png`, `default.png`, `landing.png`). 9 файлов, 60-440 KB
каждый.

При шеринге партии Magnus vs Carlsen в Telegram пользователь видит
generic-обложку «Kingside Analysis», а не FEN-доску с реальной
позицией. То же самое для лекций (общая обложка «Lectures» вместо
имени тренера и названия), турниров, профилей.

ADR-128 §17 оставил открытым: статика или динамика per-entity.
Пользователь выбрал динамику.

Цель: для каждой публичной сущности (`analysis-public`, `lecture`,
`broadcast`, `tournament`, `coach`, `player`, `archive-game`,
`archive-player`) генерируется индивидуальный PNG 1200×630 с данными
конкретной сущности.

### Существующая инфраструктура (важно для выбора техники)

- **`apps/prerender-service`** — Playwright (headless Chromium)
  обрабатывает 18+ типов публичных страниц. Pipeline:
  `SQS → resolvePrerenderRoute(task) → page.goto(url) → wait
  __PRERENDER_READY__ → outerHTML → s3.putHtml(key, html)`.
- **`<SeoHelmet>`** уже принимает prop `ogImage`. Некоторые страницы
  (`BroadcastTournamentPage`) уже используют динамический URL
  условно: `broadcast.imageUrl ?? '/og/broadcast.png'`. Контракт
  расширяемый.
- **S3 bucket** `kingside-prerender-store` со схемой ключей
  `<kind>/<id>.html`, дедупликация по md5.
- **CloudFront** distribution с lim 25/25 behaviors (после KS-4234 —
  заполнен под завязку). Это **ограничение** для добавления новых
  routes — см. §7.

---

## 2. Выбор техники генерации

### Сводная сравнительная таблица

| Критерий | (a) Playwright screenshot | (b) Canvas в Node (node-canvas / sharp) | (c) Cloud-сервис (Cloudinary / og.gg) |
|----------|---------------------------|-------------------------------------------|----------------------------------------|
| Новая инфраструктура | 🟢 нет (Playwright уже в воркере) | 🟡 node-canvas: libpng/libcairo системные deps; sharp + SVG — деп проще | 🔴 внешний SaaS-аккаунт |
| Стоимость runtime | 🟡 +100-500 мс на рендер страницы | 🟢 +20-50 мс (pixel ops без JS) | 🔴 платный план Cloudinary (~$0.05-0.10 / 1K transformations свыше free 25 GB) |
| Стоимость поддержки | 🟢 шаблон = React-компонент, один источник правды | 🔴 дублирование UI-логики (React + Canvas/SVG шаблоны) | 🔴 Cloudinary template ИЛИ дублирование |
| Шахматные доски (`FEN → image`) | 🟢 готовый `react-chessboard` | 🔴 свой SVG-рендерер досок или sprite-sheet | 🟡 overlay через Cloudinary с custom URL |
| Шрифты / локализация | 🟢 браузер берёт из CSS | 🟡 явно подкладывать .ttf | 🟡 загружать в Cloudinary |
| WYSIWYG (соответствие тому, что в UI) | 🟢 точное | 🔴 расхождения | 🔴 расхождения |
| Зависимости от стороны | 🟢 internal | 🟢 internal | 🔴 SaaS uptime + privacy |
| Privacy (имена игроков, FEN на сторонний сервер) | 🟢 не уходит | 🟢 не уходит | 🔴 уходит |
| Latency end-to-end | 🟢 in-process | 🟢 in-process | 🔴 HTTP к Cloudinary |

### Рекомендация

🎯 **Вариант (a) — Playwright screenshot конкретной области.**

Обоснование:
1. **Нулевая новая инфра.** Playwright + Chromium уже работает в
   воркере. Никаких новых пакетов, Dockerfile, системных deps.
2. **WYSIWYG.** Превью буквально снимает то, что фронт уже умеет
   рендерить. Дизайнер видит результат в браузере, без отдельного
   просмотра «как это выглядит в Canvas».
3. **Шахматные доски** — самый сложный кейс — рендерятся через тот же
   `react-chessboard`, что и на странице. Не нужно изобретать
   SVG-генератор досок повторно.
4. **Один источник правды.** Шаблон карточки — React-компонент.
   Изменения дизайна — задача frontend, не специальная work на
   Canvas/SVG.
5. **Регенерация бесплатна** — встраивается в существующий
   prerender-pipeline (HTML и PNG одним проходом). Никаких отдельных
   SQS-tasks, новых очередей.

Минусы вариант (a) — приемлемы:
- +100-500 мс на рендер: prerender async, не задерживает пользователя.
- Лишний скрытый DOM 1200×630 на каждой публичной странице: память
  Chromium — десятки KB, не критично.
- PNG больше, чем canvas-генерация (~100-400 KB vs ~50-150 KB):
  CloudFront-кэш отдаёт за копейки, S3-storage тоже копеечный.

Варианты (b) и (c) рекомендую отклонить — см. таблицу.

---

## 3. Архитектура

### 3.1. Frontend: `<OgPreviewSlot>` + per-kind cards

Каждая публичная страница рендерит **дополнительный скрытый блок**:

```tsx
<OgPreviewSlot>
  <OgPreviewLecture lecture={lecture} coach={lecture.owner} />
</OgPreviewSlot>
```

Компоненты:

- `apps/web/src/components/og/OgPreviewSlot.tsx` — обёртка с
  фиксированными размерами 1200×630, абсолютным
  позиционированием за viewport (`position: fixed; left: -9999px;`
  или `top: -10000px`), `data-og-preview` атрибут для Playwright
  locator. Не influence layout, не visible пользователю.
- `apps/web/src/components/og/OgPreviewLecture.tsx`,
  `OgPreviewBroadcast.tsx`, `OgPreviewCoach.tsx`,
  `OgPreviewPlayer.tsx`, `OgPreviewTournament.tsx`,
  `OgPreviewAnalysisPublic.tsx`, `OgPreviewArchiveGame.tsx`,
  `OgPreviewArchivePlayer.tsx` — **8 per-kind карточек** (по числу
  типов в §4).
- `apps/web/src/components/og/OgPreviewBrand.tsx` — общий
  под-компонент с логотипом Kingside, цветами фирменного стиля.
  Унифицирует branding.

CSS: отдельный `og-preview.css` с фиксированной палитрой и шрифтами
(не зависящими от user dark/light mode — превью должно быть
консистентным на всех клиентах).

### 3.2. Сигнал готовности

Воркер сейчас ждёт `window.__PRERENDER_READY__ === true`. Расширяем
семантику: фронт выставляет флаг, когда И страница, И og-блок
готовы (данные подгружены, доска отрендерена, шрифты применены).
Шахматная доска асинхронна (`react-chessboard` рендерит после mount
+ FEN parse) — нужен дополнительный `await` на её ready-state.

Альтернатива (если разводить семантику): отдельный
`__PRERENDER_OG_READY__`, воркер ждёт оба. Это сложнее, не оправдано.
Объединяем в один флаг.

### 3.3. Воркер: screenshot после render

Расширение `render(url)` в `apps/prerender-service/src/render.ts`:

```ts
// после получения html:
const ogPng = await page
  .locator('[data-og-preview]')
  .screenshot({ type: 'png', omitBackground: false });
return { html, ogPng };
```

Если `[data-og-preview]` отсутствует на странице (например, у
листинга) — возвращаем `ogPng: null`, воркер не делает PUT PNG в S3
(остаётся статичный fallback из CloudFront 404 → default, см. §3.6).

`page.locator('[data-og-preview]').screenshot()` опционально с
`clip: {x:0, y:0, width:1200, height:630}` если нужно зафиксировать.
По умолчанию Playwright снимает bounding box локатора — этого
достаточно при фиксированных размерах слота.

### 3.4. S3 ключи

Текущая схема HTML: `<kind>/<id>.html` (см.
`resolvePrerenderRoute`). Расширяем `packages/shared/src/types/prerender-task.ts`:

```ts
export interface PrerenderRouteInfo {
  url: string;
  s3HtmlKey: string;   // переименовать с s3Key для ясности
  s3OgKey: string;     // новое — для PNG
}
```

Ключи рядом, по тому же шаблону:

| Kind | s3HtmlKey | s3OgKey |
|------|-----------|---------|
| `lecture` | `lectures/<id>.html` | `og-d/lectures/<id>.png` |
| `broadcast` (tid) | `broadcasts/<tid>.html` | `og-d/broadcasts/<tid>.png` |
| `broadcast` (tid+rid+gid) | `broadcasts/<tid>/<rid>/<gid>.html` | `og-d/broadcasts/<tid>/<rid>/<gid>.png` |
| `tournament` | `tournaments/<id>.html` | `og-d/tournaments/<id>.png` |
| `coach` | `coach/<u>.html` | `og-d/coach/<u>.png` |
| `player` | `player/<u>.html` | `og-d/player/<u>.png` |
| `archive-game` | `archive/games/<id>.html` | `og-d/archive/games/<id>.png` |
| `archive-player` | `archive/players/<slug>.html` | `og-d/archive/players/<slug>.png` |
| `analysis-public` | `analysis/public/<id>.html` | `og-d/analysis/public/<id>.png` |
| `list` | `list/<slug>.html` | — (листинги используют статичный fallback) |

Префикс **`og-d/`** (от og-dynamic) выбран чтобы:
- Не пересекаться с `/og/<section>.png` фронтового статичного bundle
  (`apps/web/public/og/`), который обслуживается тем же CloudFront
  но из другого origin.
- Один общий префикс — упрощает CloudFront behavior (один
  path-pattern `/og-d/*` → S3 prerender bucket).

### 3.5. Контракт с фронтом — `<SeoHelmet>` API

Расширение:

```tsx
interface SeoHelmetProps {
  // ... existing
  /**
   * Динамический URL og:image. Если задан — перекрывает `ogImage`.
   * Дефолтит на статичный fallback из аргумента `ogImage`.
   */
  dynamicOgUrl?: string;
  ogImage?: string;  // fallback, остаётся прежним контрактом
}
```

Каждая публичная страница (из ADR-132 §2.1) выбирает по типу:

```tsx
<SeoHelmet
  title={lecture.title}
  dynamicOgUrl={`https://kingside.site/og-d/lectures/${lecture.id}.png`}
  ogImage="/og/lecture.png"  // fallback
  // ...
/>
```

Логика SeoHelmet: `<meta property="og:image" content={dynamicOgUrl ??
ogImage ?? DEFAULT_OG_IMAGE}>`. То же для `twitter:image`.

**Утилита расчёта URL:**
`apps/web/src/utils/ogImage.ts` — функция `resolveOgImageUrl(kind,
id)` → возвращает абсолютный URL. Использует ту же логику, что
`packages/shared/.../resolvePrerenderRoute(...).s3OgKey`, превращая
её в публичный URL через `OG_IMAGE_BASE_URL` env (например
`https://kingside.site/og-d`).

### 3.6. Fallback (когда динамический PNG ещё не сгенерирован)

Гонка: пользователь публикует лекцию → backend ставит prerender task
→ фронт уже отдаёт страницу с `dynamicOgUrl` → пока воркер не
обработал task, в S3 нет `og-d/lectures/<id>.png`. Telegram
дёрнет URL и получит 404.

Решение: **CloudFront CustomErrorResponses**:
- `404` на `/og-d/*` → серверный response `200` с body
  `/og/<inferred-kind>.png` или просто `/og/default.png`.
- На стороне социальной сети — она получит валидный PNG, просто
  generic.

Implementation: либо одна общая 404-rule на distribution → `/og/default.png`
(простой, но все секции получат одну заглушку), либо CloudFront
Function (viewer-request) детектит kind из URL `/og-d/<kind>/...`
и переписывает 404 в соответствующий `/og/<kind>.png`. **Рекомендую
простой вариант** — один default на старте, после реализации можно
прокачать функцией если важно.

### 3.7. Регенерация

**Без новых SQS task'ов** — переиспользуем существующие mutation
hooks (`KS-4205/4214/4253` и др.). Воркер при обработке любого
`PrerenderTask` (HTML) после рендера также делает screenshot и
кладёт в S3 под `s3OgKey`. Один task → два S3 PUT'а.

Дедуп по md5 как для HTML (`s3.putPng(key, buffer)` симметрично
`putHtml`). Если PNG не изменился — skip, нет invalidation.

CloudFront cache invalidation: на регенерацию HTML существующая
схема (4205/4214) уже инвалидирует `/lectures/<id>` пути. Нужно
дополнить — также инвалидировать `/og-d/<...>`. Это backend-pull в
КС-4205/4214/etc или общий wrapper.

---

## 4. Композиция per-entity (контент карточек)

Минимальный набор. Конкретный дизайн (шрифты, цвета, layout) — за
дизайнером в рамках F1; здесь — содержимое.

| Kind | Элементы карточки 1200×630 |
|------|----------------------------|
| `analysis-public` | FEN-доска текущей/последней позиции (~600×600 слева), справа — имена игроков (white/black), результат (1-0 / ½-½ / 0-1), ECO + opening name, дата. Внизу — Kingside-brand-line. |
| `lecture` | Слева — аватар тренера (круглый ~280×280) + его username, справа — название лекции, статус (Live / Scheduled / Recorded) с цветовым бейджем, длительность или дата начала. Внизу — Kingside-brand. |
| `broadcast` (tid only) | Название турнира (большой шрифт), формат («14-round Swiss»), даты (start–end), число игроков, флаг места проведения (если есть в БД). Brand. |
| `broadcast` (tid+rid+gid) | FEN-доска текущей/последней позиции партии (слева), имена игроков (white/black) с ELO, название турнира + раунд, результат если завершена. Brand. |
| `tournament` (arena) | Название, формат (rapid/blitz/bullet), дата старта, число участников, prize-pool (если есть). Brand. |
| `coach` | Аватар (большой ~400×400), имя, рейтинг (по основному типу), специализация (теги типа «Sicilian Defense», «endgames»), число лекций. Brand. |
| `player` | Аватар, никнейм, рейтинги по 4 типам (bullet/blitz/rapid/classical) в виде сетки, число партий. Brand. |
| `archive-game` | FEN последней позиции, имена игроков, ELO обоих, результат, ECO, событие + год. Brand. |
| `archive-player` | Имя, число партий в архиве, peak ELO, последняя партия (год), top-3 ECO в репертуаре. Brand. |

Branding (общая нижняя полоска):
- Kingside-logo + домен `kingside.site`.
- Цвета: фирменная палитра (передаст дизайнер; пока — placeholder).

---

## 5. Декомпозиция задач

Каждая задача — в зоне ответственности одного агента.

### F1 — Frontend: компоненты `<OgPreviewSlot>` + per-kind cards + размещение

**Scope:** только `apps/web/src/components/og/*`,
`apps/web/src/components/seo/SeoHelmet.tsx`,
`apps/web/src/utils/ogImage.ts`, изменения на 16 страницах из ADR-132
§2.1.

**Что сделать:**
1. Создать `apps/web/src/components/og/OgPreviewSlot.tsx` — скрытый
   контейнер 1200×630 с `data-og-preview` атрибутом.
2. Создать 8 per-kind компонентов (`OgPreviewLecture`,
   `OgPreviewBroadcast` (с двумя вариантами: tournament-level и
   game-level), `OgPreviewTournament`, `OgPreviewCoach`,
   `OgPreviewPlayer`, `OgPreviewAnalysisPublic`,
   `OgPreviewArchiveGame`, `OgPreviewArchivePlayer`) — содержимое по
   §4.
3. Создать `OgPreviewBrand.tsx` (общий branding).
4. `og-preview.css` — фиксированные стили, шрифты, цвета (вне
   dark/light mode).
5. Расширить `SeoHelmet`: prop `dynamicOgUrl?: string`,
   приоритет над `ogImage`. Сохранить обратную совместимость.
6. `apps/web/src/utils/ogImage.ts` — функция `resolveOgImageUrl(kind,
   id)`. Use env `VITE_OG_IMAGE_BASE_URL` дефолт `/og-d`.
7. На каждой из 16 страниц (ADR-132 §2.1) добавить:
   - `<OgPreviewSlot><OgPreview<Kind> ... /></OgPreviewSlot>` в JSX.
   - `dynamicOgUrl={resolveOgImageUrl(...)}` в `<SeoHelmet>`.
8. Расширить логику `window.__PRERENDER_READY__`: фронт ставит
   `true` после того как страница И og-блок (включая
   шахматную доску, если есть) полностью отрендерены. Тонкость с
   `react-chessboard` — дождаться `onPieceDrop` ready / `key` change.
   Если не получается надёжно — добавить `setTimeout(0)` после
   data-load и установки FEN.
9. Юнит-тесты на каждый per-kind компонент (snapshot).
10. Юнит-тест `resolveOgImageUrl`.

**DoD:**
- На всех 16 страницах из ADR-132 §2.1 в DOM есть скрытый
  og-блок с `data-og-preview`.
- `<SeoHelmet>` отдаёт `og:image` = dynamic URL.
- `npm test @kingside/web` зелёный.
- Визуальная проверка: открыть страницу `/lectures/<id>` в браузере,
  убедиться что og-блок присутствует в DOM (через DevTools), но не
  visible пользователю.

**Не входит:**
- Изменения в prerender-service (PS1).
- CloudFront конфигурация (DO1).
- Backend данные (B1 — только если F1 найдёт пробелы).

**Блокирует:** PS1 (воркер должен видеть `[data-og-preview]` в DOM).

### PS1 — Prerender-service: screenshot + S3 PUT PNG

**Scope:** только `apps/prerender-service/src/render.ts`, `s3.ts`,
`index.ts` + тесты.

**Что сделать:**
1. `render.ts`: после получения HTML — дополнительно
   `page.locator('[data-og-preview]').screenshot()`. Возвращать
   `{ html: string, ogPng: Buffer | null }`. `null` если локатор
   не найден (`.count() === 0` за 100мс) — для листингов и
   неподдерживаемых типов.
2. `s3.ts`: добавить `putPng(key: string, body: Buffer):
   Promise<boolean>` симметрично `putHtml`. Дедуп по md5.
3. `index.ts`: после `putHtml(htmlKey, html)` — если `ogPng !==
   null`, вызвать `putPng(ogKey, ogPng)`. Структурированный лог
   `og_bytes=<size> og_put=<yes|skip>`.
4. `resolvePrerenderRoute` в `packages/shared/src/types/prerender-task.ts`
   — расширить return на `{url, s3HtmlKey, s3OgKey}`. **Это
   формально SH1, но компактно объединяется с PS1.** Альтернатива —
   вынести в SH1.
5. Тесты:
   - `render.test.ts`: возврат `{html, ogPng}` при наличии локатора;
     `null` при отсутствии.
   - `s3.test.ts`: `putPng` дедуп.
   - `index.test.ts`: pipeline — два PUT'а, оба учтены.

**DoD:**
- Воркер при обработке task'а с известным kind:
  - Рендерит HTML (как раньше).
  - Делает screenshot локатора → PNG → S3 под `og-d/<kind>/...`.
- При отсутствии локатора (legacy task, list-route) — PNG не
  делается, HTML работает как раньше.
- Logs показывают оба PUT'а.

**Не входит:**
- Frontend компонент (F1).
- CloudFront (DO1).

**Блокирует:** DO1 (для smoke-теста).
**Блокируется:** F1 (на страницах должны появиться локаторы).

### SH1 — Shared (опционально, можно слить с PS1)

**Scope:** только `packages/shared/src/types/prerender-task.ts` +
`.test.ts`.

**Что сделать:**
1. Расширить `PrerenderRouteInfo` — поля `s3HtmlKey` и `s3OgKey`.
2. Обновить тесты `prerender-task.test.ts`: для каждого kind
   проверить корректный `s3OgKey` префикс.

**DoD:** функция возвращает оба ключа, тесты зелёные.

**Блокирует:** PS1 (использует обновлённый тип).

> Если PS1 и SH1 делает один backend-agent в рамках одного коммита
> — лучше объединить, сложность минимальная.

### DO1 — DevOps: CloudFront behavior для `/og-d/*` + CustomErrorResponses

**Scope:** только AWS CloudFront конфигурация. НЕ трогает код.

**Что сделать:**
1. ⚠ **Проверить лимит behaviors.** По состоянию KS-4234 distribution
   E1ECCUC177NSGI заполнен 25/25. Перед добавлением `/og-d/*` —
   либо запросить лимит у AWS support, либо консолидировать
   существующие (см. §7 открытый вопрос).
2. CloudFront behavior `/og-d/*` → origin S3 prerender bucket
   (`kingside-prerender-store`), TTL — Cache-Policy с
   `max-age=300, must-revalidate` (как у HTML).
3. CloudFront CustomErrorResponses: для path-pattern `/og-d/*` ответ
   404 от S3 → переписать на `200 /og/default.png` от фронтового
   origin. **Альтернативно** (рекомендую как первый шаг): глобальная
   default-rule 404 → `/og/default.png`, действует на весь
   distribution (если другие 404 не страдают от такой замены —
   уточнить).
4. Smoke-тест:
   - `curl -I https://kingside.site/og-d/lectures/<real-id>.png` →
     200 после реализации F1+PS1.
   - `curl -I https://kingside.site/og-d/lectures/non-existent.png` →
     200 с body `/og/default.png` (fallback).
   - Open Graph debug (например через https://opengraph.dev/) на
     `https://kingside.site/lectures/<real-id>` — preview корректный.

**DoD:**
- CloudFront behavior работает, smoke-тесты проходят.
- Социальные сети (Telegram / Twitter / Facebook) показывают
  динамический PNG.

**Не входит:** код F1/PS1.
**Блокируется:** F1 + PS1 (без них PNG в S3 не появляется).

### B1 — Backend (опционально, по факту из F1)

**Scope:** только новые поля API, если F1 выявит пробелы.

**Что сделать:** на момент написания этого ADR — я не нашёл явных
пробелов по данным (всё что нужно для карточек уже подгружается на
страницы). Но конкретные кейсы могут всплыть:
- `archive-player` — peak ELO / top-3 ECO в одном endpoint'е (сейчас,
  возможно, отдельные запросы).
- `coach` — специализация / число лекций в одном endpoint'е.

Если F1 найдёт — отдельные backend-задачи на расширение
endpoint'ов. Не блокирует F1 (можно начать с тем, что есть; данных,
которых не хватает — оставить заглушки в карточке).

### A2 — Architect: финализация

**Scope:** `docs/adr/133-*.md`, `docs/adr/128-*.md` (§17 закрыть),
`docs/adr/132-*.md` (§7.3 закрыть зависимость).

После F1+PS1+DO1 — Proposed → Accepted. Если что-то реализовано
иначе — зафиксировать факт (как сделано в ADR-131 §8 «Уроки»).

---

## 6. План отката

| Этап | Откат |
|------|-------|
| F1 | redeploy предыдущего фронта. Старый код не вызывает `data-og-preview`, воркер вернётся к HTML-only режиму естественно. |
| PS1 | redeploy предыдущего prerender-service. PNG перестанут обновляться, старые останутся в S3 — социалки получат stale (но работающий) preview. Через 1 неделю можно очистить S3 префикс `og-d/`. |
| DO1 | вернуть CloudFront конфигурацию через сохранённый snapshot (как в ADR-131 §4 A2 описано для archive). Без behavior `/og-d/*` URL'ы будут отдавать 404 — социалки fallback на статичные `/og/<section>.png` через CustomErrorResponses (если она настроена) или на «нет картинки». |
| SH1 | revert типа, redeploy зависимых сервисов. Совместим с PS1 (если PS1 уже использует — нужен в обратном порядке: revert PS1 → revert SH1). |

Окно отката: каждый этап безопасен независимо (фронт работает без
динамических og — просто статичный fallback).

---

## 7. Открытые вопросы

1. 🔴 **CloudFront лимит behaviors 25/25.** По состоянию KS-4234 уже
   заполнен. Добавление `/og-d/*` требует:
   - либо запросить увеличение лимита у AWS support (займёт 1-3
     рабочих дня),
   - либо консолидировать существующие behaviors (например, объединить
     `/sitemap-*.xml` в один path-pattern вместо 9 отдельных, как
     отмечал devops в KS-4234).
   Решение — за devops в рамках DO1.
2. **Дизайн карточек.** Конкретный layout, шрифты, цвета — за
   дизайнером. В F1 фиксируются только структура (что показывается)
   и размеры. Дизайнер может работать параллельно с F1, обновлять
   CSS итеративно — это не блокирует.
3. **`og-d/` vs другой префикс.** Альтернативы: `og/dynamic/`,
   `og/d/`, `prerender-og/`. Если уже занят `og/` фронтовым bundle —
   нельзя `og/dynamic/` без конфликта на CDN. `og-d/` — мой выбор
   как самый короткий и без конфликта.
4. **Регенерация при backend mutation.** В ADR-132 §3 я зафиксировал
   3 пробела mutation hooks (player / archive-player / tournament
   create+update). Эти пробелы влияют **и** на динамический og:
   при изменении рейтинга игрока png в `og-d/player/<u>.png`
   устаревает. Решение по закрытию пробелов — отдельный путь.
5. **Локализация карточек.** Сейчас фронт — RU + EN. Какой язык
   рендерить на og-image? Решение: язык по `?lang=` параметру URL,
   который prerender передаёт. Если задача SQS не содержит lang —
   по умолчанию EN (нейтральный для шеринга). Уточняется в F1.
6. **Listings (`/lectures`, `/tournaments`, `/broadcasts` и
   листинговые leaderboard'ы) — нужен ли og?** На них показывать
   сложнее (нет одной сущности). По умолчанию — оставить статичный
   `/og/<section>.png` для них. Если пользователь захочет
   collage-карточки — отдельный путь.
7. **Размер PNG.** Playwright PNG обычно 100-400 KB. Telegram /
   Facebook рекомендуют ≤ 5 MB, но мобильные клиенты любят
   ≤ 300 KB. Опция: после screenshot — прогнать через `sharp` /
   `imagemin` для compress (доп. dep). Решение — отложить до
   замеров после реализации.

---

## 8. Не в scope

- Динамический og:image для feed-сущностей (`/feedback/:id`,
  `/puzzle/:id`, `/games/:id/watch`). Их nature — динамическая,
  prerender может не делаться. Если в будущем — отдельный ADR.
- Анимированные og (WEBP / MP4) — не делаем, многие соцсети
  фолбэчат к первому кадру или не поддерживают.
- A/B-тестирование разных дизайнов карточек — отдельная маркетинговая
  работа, не архитектурная.
