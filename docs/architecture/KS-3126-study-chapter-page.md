# KS-3126 — страница прохождения главы студии

Связано: KS-3014 (4092dd97), KS-2815 / ADR-059, ADR-060, KS-3125.

## Проблема

`ChapterList.tsx` (строки 209, 258) рендерит `<Link to="/studies/<slug>/<chapterId>">`. Коммит `4092dd97` (KS-3014) удалил соответствующие роуты `/studies/:slug/:chapterId` и `/studies/c/:chapterId` вместе со страницами `GamebookReaderPage` / `StudyEmbedPage` и study-веткой `AnalysisPage`. Заявленное в KS-3014 «Studies переезжают на отдельную страницу прохождения» в коде не реализовано — страницы нет, а ссылки остались. В результате клик по главе попадает в wildcard `*` и редиректится на `/` → `<HomePage>` → авторизованного уносит на `/play`.

KS-3125 закрыла соседний случай (кнопка «+ Новая глава»), но клик по существующей главе из списка по-прежнему ведёт в лобби.

## Альтернативы

| # | Вариант | Решение | Аргументация |
|---|---------|---------|--------------|
| 1 | Отдельная страница прохождения главы | **Принято** | Доводим до конца то, что обещано KS-3014. Shareable URL, корректный history.back/forward, естественный путь поэтапного развития (read-only → mode-specific интерактив). Бэкенд готов целиком — поверх него собирается single-page компонент. |
| 2 | Inline-раскрытие главы в `StudyPage` | Отклонено | Каждый из 4 режимов (analysis/practice/conceal/gamebook) требует крупного UI: доска, варианты, evaluation, gamebook-nodes, conceal-slider. Втиснуть это в правую колонку списка — ломать существующие компоненты. Нет shareable URL на конкретную главу, deep-link не работает. |
| 3 | Открытие главы в `AnalysisPage` с параметром источника | Отклонено | Прямо обращает KS-3014, который специально разделил эти страницы. Возврат `kind='study'` ветки — это reverts только что закрытой работы. Если этот путь нужен — это отдельная архитектурная дискуссия, не патч к регрессии. |

## Решение

Возвращаем роут `/studies/:slug/:chapterId` и создаём новый компонент `StudyChapterPage` — единая точка входа для всех 4 режимов, развиваем поэтапно.

### Phase 1 (закрывает KS-3126): MVP-просмотр

Минимальный read-only viewer, который снимает регрессию и даёт пользователю увидеть содержимое главы.

**Роут (apps/web/src/App.tsx):**

```tsx
const StudyChapterPage = lazy(() =>
  import('./pages/StudyChapterPage').then((m) => ({
    default: m.StudyChapterPage,
  })),
);

// ...внутри <Route element={<MainLayout />}> блока studies-роутов:
// Размещается ПОД `/studies/by/:userId`, `/studies/invites/:token`,
// `/studies/:slug` — порядок матчинга react-router уже корректен
// благодаря явным префиксам выше.
<Route
  path="/studies/:slug/:chapterId"
  element={
    <Suspense fallback={<LazyFallback />}>
      <StudyChapterPage />
    </Suspense>
  }
/>
```

URL-форма выбрана идентичной удалённой в 4092dd97: `ChapterList.tsx` уже формирует именно её, изменение URL потребовало бы лишних правок. Если в будущем понадобятся `/studies/:slug/members` / `/settings` / т.п. — добавляются ВЫШЕ по тем же правилам, что `by/:userId` и `invites/:token`.

**Компонент (apps/web/src/pages/StudyChapterPage.tsx):**

- `useParams<{ slug, chapterId }>()`.
- `studiesApi.getChapter(slug, chapterId)` при mount. Бэкенд endpoint `GET /studies/:slug/chapters/:chapterId` уже работает и проверяет доступ по `OptionalJwtAuthGuard` + `viewerRole`. Дополнительный fetch родительской студии не нужен — для UI достаточно `chapter` + `slug` (имя студии в крошке можно подтянуть отдельным lightweight-запросом `studiesApi.getBySlug(slug)`, либо передать через `<Link state={{ studyName }}>` из StudyPage — выбор за реализацией, но рекомендую отдельный fetch, чтобы deep-link от внешней ссылки работал так же).
- Состояния: `loading`, `error` (404/403), `ready`.
- Layout:
  - Breadcrumb: `Studies / {study.name} / {chapter.name}`.
  - Бейдж режима главы (`chapter.mode`).
  - Доска `react-chessboard` с `chapter.orientation`, `chapter.startFen`.
  - PGN-навигатор: парсинг `chapter.pgn` через `chess.js`, список ходов справа/снизу, кнопки prev/next/start/end + клик по ходу. Используем существующие компоненты `AnalysisPage`-наследников, если их можно безопасно извлечь без тянутья за study-логикой; иначе минимальный собственный movetext-list.
  - Action-кнопка «Скачать PGN» → `studiesApi.exportChapterPgn(slug, chapterId)`.
  - Если `chapter.mode !== 'analysis'` — показать info-баннер: «Интерактив режима «{mode}» появится позже; сейчас доступен просмотр ходов». Бэкенд при этом продолжает возвращать `gamebook`/`concealPly` — Phase 2 их подключит.
- Edit-режим, Stockfish-анализ, gamebook-editor, conceal-slider, practice-feedback — **вне scope Phase 1**.

**Доступ:**

- Owner / contributor / viewer (public/unlisted) — видят страницу в одинаковом read-only режиме (для них Phase 1 одинаков). Различение для UI рисуется через `study.viewerRole`, но в Phase 1 управляет только баннером и (опционально) кнопкой «Открыть в редакторе» (заглушка-tooltip «скоро»).
- Anon на public-студии — должен получить главу. Бэкенд уже это поддерживает через `OptionalJwtAuthGuard`. Если фактически 403 для anon — fallback на `studiesApi.getPublicChapter(chapterId)` (этот endpoint работает без auth, отдаёт chapter + минимальную метаинфу студии).
- Private / нет доступа — `error`-state с CTA «Назад к студиям».

**Тесты:**

- `apps/web/src/pages/StudyChapterPage.test.tsx`:
  - render с моком `studiesApi.getChapter` — отображаются name, breadcrumb, доска, movetext, кнопка download.
  - loading / error / not-found states.
  - переход по ходам prev/next, клик по ходу.
  - info-баннер для mode !== 'analysis'.
- e2e (Playwright, регрессионный для KS-3126): авторизованный юзер на `/studies/:slug` → клик по строке главы → URL сменился на `/studies/:slug/:chapterId`, виден `data-testid="study-chapter-name"` с именем главы (а не PlayPage).

### Phase 2 (отдельный эпик): mode-specific интерактив

После Phase 1 закрывает регрессию, постепенно подключаем функциональность по режимам. Не блокирует KS-3126 и согласуется отдельно. Предлагаемая декомпозиция:

| Подзадача | Скоп |
|-----------|------|
| Phase 2A — edit-режим для owner/contributor | Кнопка «Редактировать», переключение в edit-state, PGN-edit, варианты, auto-save через `studiesApi.updateChapter`. |
| Phase 2B — Stockfish toggle (mode='analysis') | Локальный Stockfish 18 WASM на read-only странице, eval-bar, top-3 lines. |
| Phase 2C — gamebook viewer + editor (mode='gamebook') | Рендер `gamebook.intro`, hint/success/failure по UCI, в edit — формы для author. |
| Phase 2D — conceal-режим | UI-slider для `concealPly`, скрытие ходов после ply, reveal-кнопка. |
| Phase 2E — practice-режим | Попытка ходов с feedback против правильной линии (как было в `GamebookReaderPage`, но переосмысленно). |

Phase 2 ВНУТРИ `StudyChapterPage` — без возврата к `AnalysisPage`-обвязке, без `studyMode`-пропа. Это сохраняет архитектурное разделение, заявленное KS-3014.

## Контракт

**Frontend:**
- Новый файл: `apps/web/src/pages/StudyChapterPage.tsx` (+ `.test.tsx`).
- Правка `apps/web/src/App.tsx`: добавить lazy-import и `<Route path="/studies/:slug/:chapterId">`; удалить комментарий-«временно отключены» с строк 431-433 (или заменить на актуальное описание ссылки на эту страницу).
- `ChapterList.tsx` — **не трогать**: формат ссылки совпадает с целевым.

**Backend:** изменений нет. Используются существующие endpoints:
- `GET /studies/:slug/chapters/:chapterId` — основной источник данных.
- `GET /studies/public/c/:chapterId` — fallback для anon на public/unlisted.
- `GET /studies/:slug/chapters/:chapterId/export.pgn` — скачивание PGN.

**Shared types (`packages/shared/src/types/studies.ts`):** изменений нет. `StudyChapterDto` уже содержит все нужные поля.

## Что НЕ делаем

- Не реверсим KS-3014: study-логика в `AnalysisPage` не возвращается.
- Не правим `ChapterList.tsx`: ссылка остаётся прежней, мы её «оживляем» восстановлением роута и страницы.
- Не вводим новый shared-DTO, не меняем бэкенд.
- В Phase 1 не делаем edit-режим — пользователь видит главу, но не редактирует. Editor — Phase 2A.

## Открытый вопрос для координатора

Phase 2 — это один большой эпик или 5 отдельных задач (2A–2E)? Рекомендую 5 задач: каждая 1–2 дня frontend-работы, легче приоритизировать. Решение по этому пункту не блокирует Phase 1.
