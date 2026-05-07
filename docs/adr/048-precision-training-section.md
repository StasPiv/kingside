# ADR-048 — Вынести play-vs-engine в самостоятельный раздел «Тренировка точности»

- Статус: Proposed
- Дата: 2026-05-07
- Связанные задачи: KS-2536
- Связанные ADR: ADR-044 (puzzle play-vs-engine pivot), ADR-046 (puzzle stats redesign)
- Связанные тикеты: KS-2484 (страница списка), KS-2485 (вкладка на /puzzles), KS-2495 (modes breakdown), KS-2497 (legacy redirect mistakes-practice)
- Авторы: architect

---

## 1. Контекст

`/puzzles/play-vs-engine` (KS-2484) сейчас живёт внутри namespace «Пазлы». Точка входа — вкладка «Play vs Engine» рядом с «All puzzles» / «My puzzles» / «Statistics» в `PuzzleBrowserPage`. UX-обоснование пользователя: режим **не является пазлом** в классическом смысле — это интерактивная игра против Stockfish из выигранной позиции с критерием «удержать преимущество N полуходов» (ADR-044 §2.4). Размещение в «Пазлах» путает: нет «правильного хода», нет линии, есть открытая позиция и таймлайн.

Цель ADR — вынести продукт в самостоятельный раздел верхнего уровня с собственным именем и URL, перевести точку входа в основную навигацию (sidebar + mobile bottom bar), мигрировать legacy-ссылки и переосмыслить блок modes-breakdown в `/puzzles/stats`.

Внутренние идентификаторы (`solutionMode='play-vs-engine'` в БД, тех.тег `playVsEngine` в `Puzzle.themes`, `PuzzleDto.solutionMode`) **остаются как есть** — это технические маркеры, пользователь их не видит.

### 1.1 Что есть сейчас

| Точка | Файл | Состояние |
|-------|------|-----------|
| Вход — вкладка | `apps/web/src/pages/PuzzleBrowserPage.tsx:97-104` | `<Link to="/puzzles/play-vs-engine">` со строкой `puzzles.playVsEngine.navLink` («Play vs Engine» / «Против движка») |
| Страница списка | `apps/web/src/pages/PlayVsEnginePuzzlesPage.tsx` | Тянет `GET /puzzles?solutionMode=play-vs-engine`, рендерит карточки |
| Решение | `apps/web/src/pages/PuzzlePage.tsx:455` | Branch на `puzzle.solutionMode === 'play-vs-engine'` → рендерит `<PlayVsEngineRunner>` (KS-2466) |
| Роуты | `apps/web/src/App.tsx:299` | `<Route path="/puzzles/play-vs-engine" element={<PlayVsEnginePuzzlesPage />}>` под `puzzlesEnabled` flag |
| Stats breakdown | `apps/web/src/pages/PuzzleStatsPage.tsx:123-128` | `<ModesBreakdown byMode={stats.byMode}>` — две карточки forced-line / play-vs-engine, обе живут в namespace puzzles-stats |
| Legacy redirect | `apps/web/src/pages/PuzzleMistakesPracticePage.tsx:42` | KS-2497: `theme === 'playVsEngine'` → `<Navigate to="/puzzles/play-vs-engine" replace />` |
| i18n | `apps/web/src/i18n/locales/{ru,en}/translation.json` | namespace `puzzles.playVsEngine.{title, intro, navLink, …}` |
| Внутренние identifiers | DB `puzzles.solution_mode='play-vs-engine'`, `Puzzle.themes` строка с тегом `playVsEngine` | **Не меняем** |

### 1.2 Где живёт основная навигация

- **Desktop**: `apps/web/src/components/Sidebar.tsx`, статичный массив `NAV_ITEMS` (строки 27-95). 12 пунктов: lobby, play, tournaments, **puzzles**, puzzle-rush, drills, lessons, workshop, archive, broadcasts, divider, feedback/features/friends/settings/admin. Каждый пункт может иметь `featureFlag` и `adminOnly`.
- **Mobile**: `apps/web/src/components/MobileBottomBar.tsx` — динамический top-3 через `useTopNavStats` + кнопка «Ещё». Whitelist routes — `apps/web/src/hooks/useNavStats.ts:60-133` (`NAV_ROUTES`), 9 ключей. Backend поддерживает `POST /user/nav-stats/increment {route}` и `GET /user/nav-stats/top` — whitelist дублируется на бэкенде.

---

## 2. Решение

### 2.1 Имя продукта

**RU**: «Тренировка точности» (как просил пользователь — оставляем).

**EN**: «Precision training».

Альтернативы рассмотрены:
- «Defend the advantage» / «Удержание перевеса» — точнее семантически, но длиннее и менее маркетингово-удобно;
- «Endgame practice» / «Эндшпильная практика» — неточно (позиции не только эндшпильные);
- «Play vs Engine» / «Игра против движка» — текущее имя, отвергнуто пользователем как непонятное.

«Precision training» / «Тренировка точности» — удерживаем фокус на UX-метафоре «играть точно, чтобы не упустить шансы», что соответствует механике (cp-loss/winChance в KS-2521). Совпадает с терминологией lichess «Accuracy» в Insights и chess.com «Precision».

Иконка в навигации: 🎯 уже занята «Тренажёрами» (`drills`). Используем 🎓 («graduation cap», тренинг) или 📈 («growth/precision»). Решение в layout-тикете; ADR фиксирует имя, не иконку.

### 2.2 URL-схема

**Выбор: `/precision`** (один сегмент, без дефиса).

Альтернативы:
- `/precision-training` — длиннее, ничего не добавляет.
- `/training` — слишком общий (могут появиться другие тренинги).
- `/precision-puzzles` — намекает на puzzle, противоречит самому решению вынести из Пазлов.

Маршруты:

| Старый | Новый | Поведение |
|--------|-------|-----------|
| `/puzzles/play-vs-engine` | `/precision` | редирект через `<Navigate replace>` |
| (нет) | `/precision/:id` (опц) | прямая ссылка на конкретный пазл — алиас `/puzzle/:id` (опц, см. §2.4) |

Решение пазла остаётся через `/puzzle/:id?source=precision` (раньше был `?source=play-vs-engine` — переименовываем; legacy-значение `play-vs-engine` тоже принимаем silently для bookmark'ов).

### 2.3 Точка входа в навигации

**Desktop sidebar**: добавляем пункт в `NAV_ITEMS` после «Puzzles» / «Puzzle Rush» / «Drills» — это семантически близкий блок «тренировок».

```ts
{
  path: '/precision',
  icon: '🎓',
  i18nKey: 'nav.precision',
  match: ['/precision'],
  // По аналогии с puzzlesEnabled — гейтим за тем же runtime feature-flag.
  // Раздел использует puzzle backend (puzzles.solution_mode), пока он
  // выключен — раздел тоже скрываем.
  featureFlag: 'puzzlesEnabled',
}
```

Альтернатива — отдельный feature-flag `precisionEnabled`. Не делаем: продукт зависит от puzzle-backend (та же таблица `puzzles`, тот же ratingPuzzle, те же миграции). Когда `puzzlesEnabled=false` — pipeline генерации тоже выключен, в `/precision` показывать нечего. Удобство админа: один свитч; если потом нужно включить precision без puzzles — добавим flag отдельным тикетом.

**Mobile bottom bar**: добавляем `precision` как новый ключ в `NAV_ROUTES` (whitelist `useNavStats.ts:60-133`):

```ts
precision: {
  to: '/precision',
  matches: ['/precision'],
  icon: '🎓',
  labelKey: 'nav.precision',
  labelFallback: 'Precision',
  flag: 'puzzlesEnabled',
},
```

Backend whitelist (для `POST /user/nav-stats/increment`) — синхронно добавить `precision`. Если backend whitelist строгий — нужно убедиться что фронтенд не валит запрос когда серверный whitelist ещё не релизнут. Сейчас `useNavStats` сам пропускает routes не из локального whitelist (строка 240 — `if (!(item.route in NAV_ROUTES)) continue`), значит в обратную сторону — отправит `route='precision'` на бэк, который вернёт 400/422 если не в whitelist. Релиз: сначала backend, потом frontend. См. порядок в декомпозиции.

**Удалить** вкладку «Play vs Engine» из `PuzzleBrowserPage.tsx:97-104` — точка входа в новой навигации, в Пазлах больше не нужна.

### 2.4 Legacy redirects

Все legacy-ссылки делаем через `<Navigate to="..." replace />` (без записи в history):

| От | Куда |
|----|------|
| `/puzzles/play-vs-engine` | `/precision` |
| `/puzzles/play-vs-engine?...` | `/precision?...` (query сохраняем) |
| `/puzzles/mistakes-practice?theme=playVsEngine` | `/precision` (KS-2497 уже редиректит, апдейтим target) |
| `/puzzle/:id?source=play-vs-engine` | оставить как есть (path остался `/puzzle/:id`, source-параметр — техника, см. §2.5) |

Legacy-redirect-роуты — отдельным `<Route path="/puzzles/play-vs-engine" element={<Navigate to="/precision" replace />} />` в `App.tsx`, **до** wildcard-guard'а `/puzzles/*` под выключенным `puzzlesEnabled` (строки 311-313 — иначе при выключенном флаге redirect не сработает, ссылка уйдёт в `/lobby`). Решение: redirect ставить **выше** условного `puzzlesEnabled`, как уже сделано для `/puzzles/rush` (строка 293).

`?source=play-vs-engine` query-парам в `/puzzle/:id` — внутренний маркер для `PlayVsEngineRunner` чтобы знать «откуда пришёл пользователь». Переименуем на `?source=precision` для нового кода, но `play-vs-engine` принимаем silently (читаем оба значения, поведение одинаковое). Это не break-change для bookmark'ов.

### 2.5 Решение пазла остаётся в /puzzle/:id

Сам runner (`PlayVsEngineRunner`) и страница `PuzzlePage` branching по `puzzle.solutionMode` — **не меняются**. Маршрут `/puzzle/:id` универсальный для обоих режимов. Это устоявшееся решение из ADR-044 §5.1, ADR не пересматривает.

Опциональный алиас `/precision/:id` — предмет для отдельного тикета, не критичен. Если делаем — это тонкая обёртка `<Navigate to={`/puzzle/${id}?source=precision`} replace />`. На MVP не делаем.

### 2.6 Stats breakdown — куда переносить

`PuzzleStatsPage:123-128` сейчас рендерит `<ModesBreakdown byMode={stats.byMode}>` — две карточки на одной странице. После выноса есть три варианта:

**(A) Оставить обе карточки на `/puzzles/stats`, но переименовать вторую**: «Forced-line» и «Тренировка точности». Кликом на «Тренировка точности» — переход на `/precision` (а не на `/puzzles/play-vs-engine`).

**(B) Перенести вторую карточку на новый отдельный экран `/precision/stats`**, на `/puzzles/stats` оставить только forced-line.

**(C) Не дублировать**: добавить блок «Stats» прямо на `/precision` (главная страница раздела) с тремя цифрами «attempted / solved / lastAt», без отдельного экрана.

**Решение: (A)+(C)**.

- (A) на `/puzzles/stats` — оставляем, потому что пользователь всё равно может туда зайти и хочет видеть **общую** картину по всем своим тренировкам. Переименовываем UI-надпись «Play vs Engine» → «Тренировка точности», кнопка «Решать» ведёт на `/precision`.
- (C) — на `/precision` (страница списка пазлов) добавляем top-блок со встроенными метриками из `byMode['play-vs-engine']`. Пользователь, который зашёл напрямую в раздел, сразу видит свои цифры и не должен переходить в `/puzzles/stats`.
- (B) **отвергнут** — лишний экран, дублирующий функциональность.

### 2.7 i18n переключение

| Ключ | Старая RU/EN | Новая RU/EN |
|------|--------------|-------------|
| `nav.precision` (новый) | — | «Тренировка точности» / «Precision training» |
| `puzzles.playVsEngine.title` | «Play vs Engine puzzles» / «Пазлы Play vs Engine» (или аналог) | «Тренировка точности» / «Precision training» |
| `puzzles.playVsEngine.navLink` (на удаляемой вкладке) | — | (удалить ключ или оставить если ещё где-то используется) |
| `puzzles.playVsEngine.intro` | старый текст про «Stockfish-strong engine punishes mistakes» | актуализировать на «Удерживайте преимущество против сильного движка. Тренируйте точность игры в выигранных позициях.» / «Hold your advantage against a strong engine. Train precision play in won positions.» |
| `nav.precision` mobile | — | «Точность» (лимит ширины кнопки в bottom bar — 8-10 символов) / «Precision» |
| `puzzleStats.modes.playVsEngine` (карточка modes-breakdown) | «Play vs Engine» | «Тренировка точности» / «Precision training» |
| `puzzle.engine.summary.*` (preserved/lost), терминология после партии | без изменений | без изменений (продукт тот же, как просил пользователь) |
| Тема `playVsEngine` в `puzzleBrowser.themes.playVsEngine` | «Против движка» / «Play vs Engine» | оставить — это название тех.тега, **не показывается** пользователю после KS-2496 (фильтр в дневнике); сохраняем для обратной совместимости JSON-snapshot теста |

`puzzles.playVsEngine.*` namespace либо переименовываем в `precision.*`, либо оставляем как есть (внутренние ключи, пользователь не видит). **Решение**: переименовываем в `precision.*` для согласованности кодовой базы — название продукта меняется, легче читать. Тикет на rename — отдельным шагом, можно сделать одной заменой в JSON.

### 2.8 Что НЕ делаем

- **НЕ меняем** `Puzzle.solutionMode='play-vs-engine'` в БД, тех.тег `playVsEngine` в `Puzzle.themes`, `PuzzleSolutionMode` тип в shared. Это технические marker'ы, пользователь не видит. Backend API остаётся стабильным.
- **НЕ меняем** PostGameReview / WDL summary / preserved/lost терминологию — продукт тот же, только название и расположение.
- **НЕ меняем** Glicko-2 рейтинг (общий ratingPuzzle на оба режима, как в ADR-044 §5.4).
- **НЕ создаём** отдельный feature-flag (`precisionEnabled`) — пока используем `puzzlesEnabled`. Если потом понадобится разделять — отдельный тикет.

---

## 3. Декомпозиция на тикеты

Все тикеты в **To Do**. Префикс `[Precision training]`.

| # | Тема | Исполнитель | Размер | Зависит от |
|---|------|-------------|--------|------------|
| 1 | Backend: расширить whitelist `nav-stats` route'ов на бэке — добавить `precision`. Юнит-тест `POST /user/nav-stats/increment {route:'precision'}` → 204 | backend | XS | — |
| 2 | Frontend (router): новый роут `/precision` → `<PlayVsEnginePuzzlesPage />` (имя компонента пока сохраняем; rename — #6). Legacy redirect `/puzzles/play-vs-engine` → `/precision` через `<Navigate replace>` ВЫШЕ wildcard-guard'а (как `/puzzles/rush`). Сохранение query-string при redirect — через враппер-компонент с `useSearchParams` | frontend | S | — |
| 3 | Frontend (sidebar): добавить пункт `nav.precision` в `Sidebar.NAV_ITEMS` после `puzzles`/`puzzle-rush`/`drills`; iconize 🎓; gate за `puzzlesEnabled` | frontend | XS | #1, #2 |
| 4 | Frontend (mobile): добавить `precision` ключ в `NAV_ROUTES` (`useNavStats.ts`); flag = `puzzlesEnabled`; matches `['/precision']`. Юнит-тест `resolveNavRoute('/precision')` → `'precision'` | frontend | XS | #1 |
| 5 | Frontend: убрать вкладку «Play vs Engine» из `PuzzleBrowserPage.tsx:97-104` (KS-2485 откат); обновить тест `PuzzleBrowserPage.test.tsx` — больше нет элемента `puzzle-browser-tab-play-vs-engine` | frontend | XS | #2 |
| 6 | Frontend: переименовать `PlayVsEnginePuzzlesPage` → `PrecisionPage` (файл, имя компонента, тесты, импорты в App.tsx); обновить data-testid'ы (`play-vs-engine-puzzles` → `precision-page`, `play-vs-engine-card` → `precision-card`); сохранить старые testid'ы как алиасы НЕ нужно — компонентные тесты обновляются вместе | frontend | S | #2 |
| 7 | Frontend: обновить `PuzzleMistakesPracticePage:42` — KS-2497 редирект `theme=playVsEngine` теперь на `/precision` (а не `/puzzles/play-vs-engine`); тест на новый таргет | frontend | XS | #2 |
| 8 | Frontend: i18n RU/EN — ключ `nav.precision` («Тренировка точности» / «Precision training», mobile `«Точность»` / `«Precision»`); rename namespace `puzzles.playVsEngine.*` → `precision.*` (включая title/intro/navLink/empty/loadError); обновить все импорты в коде | frontend | S | #6 |
| 9 | Frontend: на `/precision` (главная страница раздела) — top-блок «Stats» с метриками `byMode['play-vs-engine']` (totalAttempted/totalSolved/lastAttemptAt), self-fetch `/puzzles/stats/me` и условный рендер только для авторизованных. Спрятать если totalAttempted=0 | frontend | S | #6 |
| 10 | Frontend (stats): в `ModesBreakdown` (PuzzleStatsPage:123-128) переименовать карточку «Play vs Engine» → «Тренировка точности»; кнопка «Решать» теперь ведёт на `/precision` (а не `/puzzles/play-vs-engine`); тест на href | frontend | XS | #2 |
| 11 | Frontend: внутренние source-маркеры — принимать оба значения `?source=play-vs-engine` и `?source=precision` (silent backward compat). Новые ссылки используют `precision`. Минимально: одна точка в `PlayVsEnginePuzzlesPage` (теперь `PrecisionPage`) — `navigate('/puzzle/:id?source=precision')` | frontend | XS | #6 |
| 12 | Layout: иконка для пункта «Тренировка точности» (🎓 или альтернатива); CSS на новый `puzzle-browser-tab--precision` если ещё пишется (вряд ли); смоук на mobile bottom bar — кнопка читается на узких экранах | layout | XS | #3, #4 |
| 13 | QA: e2e — переход через sidebar на `/precision`, mobile bottom bar (если в top-3); legacy URL `/puzzles/play-vs-engine` редиректит; mistakes-practice?theme=playVsEngine редиректит; modes-breakdown в /puzzles/stats показывает «Тренировка точности» и кликом ведёт на /precision | qa | S | #2-#11 |

### Граф зависимостей

```
#1 (backend nav-stats whitelist) ──► #4 (frontend NAV_ROUTES)
                                         │
#2 (router /precision + redirect) ───────┼──► #3 (sidebar NAV_ITEMS)
                                         │
                                         ├──► #5 (remove tab)
                                         │
                                         ├──► #6 (rename component) ──► #8 (i18n)
                                         │                            ├──► #9 (stats on /precision)
                                         │                            ├──► #11 (source maybe-precision)
                                         │
                                         └──► #7 (mistakes redirect)
                                              │
                                              ├──► #10 (modes-breakdown link)
                                              ▼
                                            #12 (layout/iconography)
                                              ▼
                                            #13 (qa e2e)
```

Параллелизм: #1 + #2 + #6 + #7 могут стартовать одновременно (#1 вообще backend-only). #3, #4, #5, #11 ждут #2. #8, #9 ждут #6. #10 ждёт #2. #12 — параллельно #3/#4 (только иконка/CSS). #13 — финальный.

### Релиз-порядок

Backend (#1) релизим **первым**. Иначе frontend будет слать `route='precision'` на whitelist, который ещё не знает такое имя — backend вернёт 422, mobile bottom bar статистика будет ругаться в логах.

После backend — frontend пакет: всё остальное можно собрать в одну выкладку (бекенд уже принимает).

---

## 4. Риски / открытые вопросы

1. **Иконка**. 🎓 / 📈 / 🎯 (занята drills) / 📊. Решит layout (#12). На MVP — любой emoji, не блокирует.
2. **Алиас `/precision/:id`** для прямой ссылки на пазл (опц). Откладываем.
3. **`puzzlesEnabled=false` + `/precision`**. Сейчас выключение `puzzlesEnabled` уводит `/puzzles/*` в `/lobby` (App.tsx:311-313). Аналогично сделаем для `/precision/*` — wildcard под условием, ниже redirect для legacy. Если решим что precision видим даже при выключенных puzzles — отдельный feature-flag.
4. **i18n `puzzles.playVsEngine.*` → `precision.*`** rename рискует разъехаться, если где-то остался hardcoded ключ. Тикет #8 включает grep по обеим строкам и проверку что snapshot-тест `puzzleThemes.i18n.test.ts` обновлён.
5. **Mobile bottom bar top-3** — новый раздел появится в top-3 только когда наберёт `nav-stats` посещений. До этого виден только в «Ещё». Для phasing-релиза это ок.

---

## 5. Последствия

**Плюсы**:
- Раздел получает каноническое имя и URL, отвязывается от «Пазлов» концептуально.
- Точка входа — основная навигация (sidebar + mobile), пользователь находит без захода в Пазлы.
- Legacy-ссылки не ломаются, редиректы прозрачные.
- Внутренние идентификаторы и API не меняются — backend проблем не приобретает.

**Минусы / риски**:
- Релиз требует синхронизации backend (#1) и frontend (всё остальное). Митигация — backend выкатываем первым, frontend следом одной выкладкой.
- Имя «Тренировка точности» / «Precision training» может слабо ассоциироваться с шахматами для новичков. Митигация — intro-текст на `/precision` объясняет «удержите преимущество против движка».
- Ещё один пункт в sidebar — список длинный (12 → 13). Митигация: divider после `broadcasts` уже есть, новый пункт логично встаёт в группе тренировок (puzzles, puzzle-rush, drills, **precision**, lessons).
