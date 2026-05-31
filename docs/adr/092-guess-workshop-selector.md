# ADR-092. Guess — выбор партии из мастерской (по аналогии с ADR-091)

Статус: предложен (2026-05-31) — аналитический документ
Связано: KS-3502 (этот ADR), ADR-091 (Guess из архива — родитель
паттерна), ADR-086 (Guess-the-Move), ADR-078 (multi-source
репертуары), KS-3293 (родственная конверсия Analysis→Repertoire).

## 1. Контекст

Пользователь просит на лендинге Guess добавить кнопку «Выбрать из
мастерской» рядом с уже спроектированной «Выбрать из архива»
(ADR-091). Источник — список своих анализов пользователя в
мастерской `/workshop`.

## 2. Проверено по коду

- **«Мастерская» = `/workshop`**, страница `apps/web/src/pages/
  WorkshopPage.tsx` (153 строки), основная вкладка
  `WorkshopAnalysisList` (`apps/web/src/components/workshop/
  WorkshopAnalysisList.tsx`, 693 строки).
- **UX**: список карточек-анализов; фильтры (категория/поиск/
  теги); инфинит-скролл серверной пагинации (batch 100);
  операции — открыть, удалить, batch-export PGN.
- **API**:
  - `GET /analyses?limit&offset&withPgn&search` (`apps/api/src/
    analysis/analysis.controller.ts`, JwtAuthGuard, KS-2948) —
    список СВОИХ анализов (фильтры на сервере; ILIKE по
    `headline|title|opening|event|white|black|site|tags`).
  - `GET /analyses/:id` (JwtAuthGuard) — полный анализ с PGN.
- **`AnalysisListItem`** (shared `api-contracts.ts`, line ~1598)
  содержит всё нужное для карточки в selection-mode:
  `id, title, headline, opening, event, white, black, result,
  category, tags, createdAt`. PGN опц. через `?withPgn=true` —
  для selection-mode нам **не нужен** в листинге (грузим по id
  при выборе).
- **DTO `StartGuessSessionDto.gameSource`** уже поддерживает
  `'own'` (ADR-086, проверено в ADR-089/091) — нет новых backend
  изменений.
- **Гость** в мастерской — пустой список + prompt войти. На
  Guess-лендинге кнопка «Выбрать из мастерской» — disabled с
  подсказкой.
- **AnalysisActionsMenu** (ADR-087) уже содержит «Использовать
  как новый репертуар» (KS-3293) — родственный паттерн «из
  анализа в другую фичу».

## 3. Применяем паттерн ADR-091

UX-flow зеркальный к ADR-091 (Guess из архива):

### 3.1 На лендинге Guess

Добавляется ещё одна alternative-action кнопка рядом с уже
существующей (ADR-091):

```
PGN партии
┌─────────────────────────────┐
│  Вставьте PGN сюда…         │
└─────────────────────────────┘
       — или —
[🔍 Выбрать из архива →]  [📂 Выбрать из мастерской →]
```

- «📂 Выбрать из мастерской» — `enabledFor: 'auth'` (гостю
  disabled + подсказка «Войдите, чтобы увидеть свои анализы»).
- Click → `navigate('/workshop', { state: { returnTo: '/guess',
  returnLabel: 'Угадай ход' }})`.

### 3.2 На странице мастерской в режиме selection

WorkshopPage / WorkshopAnalysisList обнаруживает
`location.state.returnTo` → **sticky-баннер сверху** (тот же
паттерн что ADR-091 §4.2):

```
┌──────────────────────────────────────────────┐
│ ⓘ Выберите анализ для «Угадай ход»  [✕ Отмена]│
└──────────────────────────────────────────────┘
```

На каждой карточке анализа — **новая кнопка «✓ Выбрать»**
(дополнительно к существующим actions). В обычном режиме скрыта.

Click → `GET /analyses/:id` для полного PGN → `navigate('/guess',
{ state: { source: 'own', refId: analysisId, pgn, title, white,
black, event }})`.

Существующие фильтры мастерской (категория, поиск, теги, batch-
выбор) продолжают работать. В selection-mode batch-action
«Экспорт PGN» можно скрыть (не путать с одиночным «Выбрать»).

### 3.3 На лендинге после возврата

GuessLandingPage парсит `location.state` — единая логика для
обоих источников (archive + own):
- Заполняет textarea PGN.
- Показывает превью «<title>» (или fallback «<white> vs
  <black> · <event>») + бейдж источника («📂 из мастерской» /
  «🔍 из архива») + кнопка «Изменить выбор» (→ обратно в
  /workshop или /archive по флагу).

Submit: `gameSource='own'`, `gameRef=analysisId` (для archive —
`gameSource='archive'`, `gameRef=archiveGameId`).

### 3.4 Унификация state-shape (важно)

Чтобы лендинг не имел двух разных state-парсеров, ADR-091 + 092
вводят **единый shape state**:

```ts
interface GuessLandingFromExternalState {
  source: 'archive' | 'own';   // gameSource в DTO
  refId: string;                // archiveGameId или analysisId
  pgn: string;                  // full PGN
  // Метаданные для превью:
  title?: string;               // для own — Analysis.title
  white?: string;
  black?: string;
  event?: string;
}
```

`GuessLandingPage` обрабатывает оба типа через `state.source`.
ArchiveGamesPage и WorkshopPage кладут в state одинаковую
структуру (без `title`-поля для archive — у партий нет title;
fallback на «<white> vs <black>»).

Это **расширение F1 из ADR-091** — общая утилита парсинга state.
В F1 ADR-092 расширяем существующий F1 ADR-091 (если он уже
сделан), не создаём отдельную ветку.

## 4. Гость

Так же как archive (ADR-091) — кнопка на лендинге disabled с
подсказкой «Войдите, чтобы увидеть свои анализы». Если гость
случайно зайдёт на `/workshop` с state — sticky-баннер
показывается, но список пустой → toast «Войдите, чтобы выбрать
анализ».

## 5. API — изменений нет

Все нужные endpoints уже есть:
- `GET /analyses?limit&offset&search` — список своих.
- `GET /analyses/:id` — полный с PGN.
- `POST /guess/sessions { gameSource: 'own', gameRef:
  <analysisId>, pgn, side }` — старт сессии (DTO поддерживает).

## 6. Что НЕ делаем (M1)

- **НЕ дублируем** WorkshopAnalysisList в модалке (используем
  переход, как в ADR-091).
- **НЕ persist** selection-state в БД — только в `location.state`.
- **НЕ предлагаем** автосайд (как в ADR-091 — оставляем выбор
  пользователю).
- **НЕ добавляем** action «Использовать в Guess» в
  AnalysisActionsMenu конкретного анализа в M1 — это
  альтернативная точка входа, может быть M2 (Open Q5).

## 7. Реализация — follow-up задачи

Frontend-only. Зависимости: F1 расширяет существующий F1 ADR-091
(после/вместе); F2 — новый компонент-режим; L1 — минимальное
расширение CSS L1 ADR-091.

### KS (F1-ext) — расширение GuessLandingPage state-shape + новая кнопка

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** ADR-091 F1 (или совмещается).
- Добавить кнопку «📂 Выбрать из мастерской →» рядом с
  «🔍 Выбрать из архива» (ADR-091).
- Auth-gating: для гостя disabled + подсказка.
- Унифицировать парсинг `location.state` на shape
  `GuessLandingFromExternalState` (см. §3.4).
- Submit: `gameSource = state.source === 'own' ? 'own' :
  'archive'`, `gameRef = state.refId`.
- Превью с бейджем источника + кнопка «Изменить выбор» (→
  обратно в /workshop или /archive в зависимости от source).
- Acceptance:
  - Обе кнопки видны; для гостя обе disabled.
  - State из мастерской → превью «📂 из мастерской: <title>».
  - State из архива → превью «🔍 из архива: <white> vs <black>».
  - Submit отправляет правильный gameSource.

### KS (F2) — WorkshopPage selection-mode + кнопка «Выбрать»

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
- В `WorkshopAnalysisList` при `location.state.returnTo` —
  sticky-баннер «Выберите анализ для <returnLabel> [✕ Отмена]».
- На карточке анализа — кнопка «✓ Выбрать» (только в
  selection-режиме).
- Click → `GET /analyses/:id` → navigate с state по схеме §3.4.
- Batch-actions (export-PGN, delete) скрываются в
  selection-режиме (не путать с одиночным выбором).
- Отмена → `navigate(returnTo)` без state.
- Acceptance: баннер видим при entry с state; «Выбрать»
  работает; обычный режим — без баннера/кнопки/изменений
  batch-actions.

### KS (L1-ext) — CSS кнопок мастерской

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F1-ext, F2, ADR-091 L1.
- Кнопка «📂 Выбрать из мастерской» — единый стиль с «🔍
  Выбрать из архива» (на лендинге).
- Кнопка «✓ Выбрать» на карточке анализа — единый стиль с
  кнопкой на карточке партии архива.
- Превью с бейджами источника (📂 / 🔍).
- Mobile-адаптив (обе кнопки альтернатив на лендинге не съедают
  много места, могут перенестись на 2 строки).
- Acceptance: viewport 360×844 — обе кнопки помещаются; превью
  с бейджами читаемо.

Backend — НЕТ задач (API готов).

## 8. Открытые вопросы

1. **Порядок кнопок на лендинге** — `[📂 мастерская]` `[🔍 архив]`
   (своё → чужое, моё) vs `[🔍 архив]` `[📂 мастерская]`
   (классика → личное)?
2. **Default-режим** — если у пользователя есть анализы в
   мастерской, делать ли «📂 Выбрать из мастерской» более
   заметной (primary-кнопка) vs equal alternative?
3. **WorkshopPage табы** (если есть «Игры/Пазлы/Анализы»
   разделение по category) — в selection-режиме показывать все
   категории или только `category='analysis' | null`? Категория
   `'puzzle'` (короткий PGN из 1-2 ходов) обычно бесполезна для
   Guess.
4. **Batch-actions в selection-режиме** — скрыть (моё, чтобы не
   путать) или оставить?
5. **F5 в selection-режиме** — теряем `location.state` (как в
   ADR-091, моё). Подтвердить.
6. **AnalysisActionsMenu** конкретного анализа (ADR-087) —
   добавить пункт «Использовать в Guess» (альтернативная точка
   входа)? M1 (моё «нет, только из лендинга») vs сразу.
7. **Side hint** после выбора (как в ADR-091 §6) — не
   подсвечивать (моё, симметрично ADR-091).

## 9. Откат

- Frontend changes за feature-flag `guessWorkshopSelectEnabled`
  (или общий с ADR-091 `guessExternalSourcesEnabled`).
- Backend без изменений.
- Существующий PGN-flow работает как раньше; ADR-091 archive-
  flow независим.
