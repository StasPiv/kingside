# ADR-091. Guess — выбор партии из архива вместо ручного PGN

Статус: предложен (2026-05-31) — аналитический документ
Связано: KS-3497 (этот ADR), ADR-086 (Guess-the-Move),
ADR-090 (репертуар из архива — родственная архитектура),
ADR-087 (AnalysisActionsMenu).

## 1. Контекст

Скриншот `/tmp/telegram/326131126_0.jpg`: лендинг Guess имеет
textarea для ручной вставки PGN + выбор стороны. Пользователь
хочет альтернативу — выбрать партию из архива с фильтрами
(рейтинг, контроль, дата, игроки, дебют).

## 2. Проверено по коду

- **`GuessLandingPage.tsx`** уже содержит **частично заложенный
  паттерн** приёма partии извне: комментарий в шапке —
  «PGN (вставка вручную или передан из ArchiveGamePage через
  `location.state.pgn`)». DTO `StartGuessSessionDto`
  (`apps/api/src/guess/dto/guess.dto.ts`) поддерживает
  `gameSource: 'archive'|'pgn'|'own'|'broadcast'` + `gameRef`,
  но активно только `pgn`.
- **ArchiveGamesPage** (1456 строк, 9 фильтров: players, event,
  eco, result, minElo, ply-range, date-range, timeControlCategory,
  sort). Фильтры в `ArchiveFiltersForm` (472 строки) с
  переиспускаемыми компонентами (PlayerAutocomplete,
  EventAutocomplete, TimeControlChips, DateRangePicker). URL-state
  как единый источник истины (ADR-033 §4).
- **archive-service `/games`** — public (без auth, гость
  доступен). `GET /games/:id` — полный PGN.
- **Guess-controller** под `JwtAuthGuard` (гость 401 на старт
  сессии). Это не новая проблема — она была и при PGN-вставке.
- **Стандартного Modal-компонента нет** — есть 5 специализированных
  (SetPositionModal, ChallengeModal, etc.) с общим паттерном
  overlay+stopPropagation.

## 3. Сравнение UX-вариантов

### A. Модалка с фильтрами архива
- **+** Остаёмся на лендинге, без navigate-цикла.
- **−** ArchiveFiltersForm + ArchiveGamesPage = ~1900 строк
  компонентов, не положить «как есть» — придётся собрать
  упрощённую копию (дублирование) либо открывать full-screen
  модалку (= по сути page). 9 фильтров на mobile не помещаются.

### B. Переход в `/archive` с return-навигацией (выбран)
- **+** Используем ВСЁ существующее (все фильтры, URL-state,
  cursor-pagination). Ноль дублирования.
- **+** Заготовка `location.state.pgn` уже есть в
  GuessLandingPage (см. §2).
- **+** Естественный UX: «Выбрать из архива» = открыть архив,
  отфильтровать как обычно, выбрать → вернуться.
- **−** Navigate-цикл (но это просто два перехода через
  react-router state, не SSR).
- **−** При F5 в режиме selection `location.state` теряется
  (open Q3).

### C. Встроенный компонент-список на лендинге
- **+** Без navigate.
- **−** Удвоение длины лендинга. Дублирование UX с /archive.
  Усложняет primary-режим (PGN-вставка).

**Выбран B** — минимум кода, переиспользование, естественный flow.

## 4. UX-флоу выбранного варианта

### 4.1 На лендинге Guess

Между textarea «PGN партии» и кнопками «Угадываем за…» добавляется
кнопка-action:

```
PGN партии
┌─────────────────────────────┐
│  Вставьте PGN сюда…         │
│                             │
└─────────────────────────────┘
       — или —
[🔍 Выбрать из архива →]
```

Click → `navigate('/archive', { state: { returnTo: '/guess',
returnLabel: 'Угадай ход' }})`. URL не меняется глобально —
ArchiveGamesPage сам реагирует на `location.state.returnTo`.

### 4.2 На странице архива в режиме selection

ArchiveGamesPage обнаруживает `location.state.returnTo` →
**sticky-баннер сверху**:

```
┌──────────────────────────────────────────────┐
│ ⓘ Выберите партию для «Угадай ход»  [✕ Отмена]│
└──────────────────────────────────────────────┘
```

На каждой карточке партии — **новая кнопка «✓ Выбрать»**
(дополнительно к существующим actions «Открыть»). В обычном
режиме (без selection-state) кнопка скрыта.

Click «Выбрать» → fetch `GET /games/:id` для полного PGN →
`navigate('/guess', { state: { archiveGameId, pgn,
white, black, event }})`.

Click «Отмена» на баннере → `navigate('/guess')` без state.

Все существующие фильтры и URL-state архива продолжают
работать как обычно. Пользователь может фильтровать, листать,
менять страницы — состояние selection-режима остаётся
(в `location.state`).

### 4.3 На лендинге после возврата

GuessLandingPage парсит `location.state`:
- Есть `pgn` → заполняет textarea + показывает превью «<White>
  vs <Black> (<Event>)» рядом + кнопка «Изменить выбор» (→
  обратно в архив).
- Опц. (Q4) автоматически подсветить кнопку стороны (по
  рейтингу, по случайному выбору, оставить пустой).

Дальше — обычный flow: «Начать» → Guess-сессия с
`gameSource='archive'`, `gameRef=archiveGameId`.

## 5. Гость

archive-service публичный — гость может фильтровать/выбирать.
GuessLandingPage гостем показывает обычный flow, но при «Начать»
— login-redirect (как и при PGN-вставке, поведение не меняется).
Опц.: дизейблить «Начать» с подсказкой «войдите» для гостя — это
не наш scope (общее поведение Guess-лендинга).

## 6. Side hint (опц., Q4)

После выбора партии можно автоматически предложить сторону.
Варианты:
- (а) По рейтингу — за сильнейшего игрока (тренируемся
  как «гроссмейстер»).
- (б) По рейтингу — за слабейшего (тренируемся «отвечать
  гроссмейстеру»).
- (в) По стороне с большей долей побед в архиве (агрегат).
- (г) Случайно.
- (д) Не подсвечивать, ждать выбора игрока.

Решение M1: **(д) не подсвечивать** — простая реализация, нет
методически спорных предположений. M2 — опц. preset «играть
слабейшей стороной» (Q4).

## 7. Что НЕ делаем (M1)

- **НЕ дублируем** ArchiveFiltersForm в модалке (используем
  переход).
- **НЕ добавляем** новые backend endpoints — переиспользуем
  `GET /games` и `GET /games/:id`.
- **НЕ persist** selection-state в БД — только в `location.state`
  (теряется при F5 — open Q3).
- **НЕ меняем** Guess-сервис (DTO `gameSource='archive'` уже
  есть).
- **НЕ добавляем** other-sources (own/broadcast) в этой
  итерации — отдельный feature-запрос.
- **НЕ делаем** auto-side hint в M1 (open Q4).

## 8. API — изменений нет

Все нужные endpoints уже есть:
- `GET /games?<фильтры>` — список с фильтрами.
- `GET /games/:id` — полный PGN.
- `POST /guess/sessions { gameSource: 'archive', gameRef:
  <archiveGameId>, pgn, side }` — старт сессии (DTO
  поддерживает 'archive', сервис может потребовать минорной
  проверки — см. §10 backend-check).

## 9. Реализация — follow-up задачи

Frontend-only, без backend новых endpoint'ов. Зависимости:
F1 + F2 → L1.

### KS (F1) — Guess-лендинг: кнопка «Выбрать из архива» + приём state

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
- В `GuessLandingPage.tsx` добавить кнопку-action между
  textarea и side-выбором: «🔍 Выбрать из архива →».
  onClick → `navigate('/archive', { state: { returnTo:
  '/guess', returnLabel: 'Угадай ход' }})`.
- При mount страницы парсить `location.state`: если есть
  `pgn`+`archiveGameId` → заполнить textarea, показать
  превью «<white> vs <black> · <event>» + кнопку
  «Изменить выбор» (→ снова `/archive` с state).
- При submit формы: если `archiveGameId` есть — `gameSource=
  'archive'`, `gameRef=archiveGameId`, иначе `gameSource='pgn'`.
- Acceptance: кнопка работает; после возврата с архива
  textarea заполнена + превью; submit отправляет правильный
  gameSource.

### KS (F2) — ArchiveGamesPage: selection-режим + кнопка «Выбрать»

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
- В `ArchiveGamesPage.tsx` при `location.state.returnTo` —
  показать sticky-баннер сверху: «Выберите партию для
  <returnLabel> [✕ Отмена]». Отмена → `navigate(returnTo)`
  без state.
- На карточке партии — новая кнопка «✓ Выбрать»
  (рендерится только в selection-режиме). Click → fetch
  `GET /games/:id` для полного PGN → `navigate(returnTo,
  { state: { archiveGameId, pgn, white, black, event }})`.
- Все существующие фильтры/URL-state работают как обычно.
- Acceptance: баннер появляется при entry с state; кнопка
  «Выбрать» работает; обычный режим (без state) баннер/
  кнопка скрыты.

### KS (L1) — CSS sticky-баннера + кнопки «Выбрать» + превью на лендинге

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F1, F2.
- CSS sticky-баннера (top: 0, z-index, цвет привлекающий
  внимание).
- Кнопка «Выбрать» на карточке — accent color, рядом с
  «Открыть».
- Превью выбранной партии на Guess-лендинге — компактная
  карточка «<white> vs <black> · <event>» + edit-кнопка.
- Mobile-адаптив (баннер не съедает много места).
- Acceptance: на viewport 360×844 — баннер + кнопки читаются;
  превью на лендинге не ломает layout.

### KS (B-check, опц.) — Guess-сервис: проверка `gameSource='archive'`

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
- Если сейчас `GuessService.startSession` не обрабатывает
  явно `gameSource='archive'` — добавить branch: принимать
  `gameRef` (archiveGameId) + сохранять в `GuessSession.
  gameRef`, `gameSource='archive'` без дополнительных
  fetch'ей (PGN уже пришёл от клиента).
- Acceptance: старт сессии с `gameSource='archive'`
  записывается корректно; `gameRef` сохраняется.

(Если уже работает — задача snimable.)

Backend нагрузка минимальная (опц. 1 задача). Layout
небольшой. Основная работа — frontend (2 задачи).

## 10. Открытые вопросы

1. **Список фильтров в архиве в selection-режиме** — все 9
   доступны (моё) или скрываем некоторые (например, `fen` /
   `move` имеют мало смысла для выбора партии для Guess)?
2. **Sticky-баннер на mobile** — фиксированный сверху (моё)
   или скрывается при скролле вниз и появляется при скролле
   вверх (auto-hide)?
3. **`location.state` теряется при F5** в selection-режиме —
   приемлемо (моё, простая реализация) или нужно
   sessionStorage для resilience?
4. **Side hint после выбора партии** — не подсвечивать (M1,
   моё) vs auto-preset (рейтинг/случайно/победы)?
5. **Кнопка «Выбрать» на карточке** — рядом с «Открыть» (моё)
   или заменяет «Открыть» в selection-режиме (только выбор,
   не просмотр)?
6. **Owned games / broadcast** как альтернативные источники —
   в этой итерации НЕТ (моё). Подтвердить.
7. **Существующая логика `gameSource='archive'`** в
   `GuessService.startSession` — работает ли уже или нужен
   B-check?

## 11. Откат

- Frontend changes за feature-flag `guessArchiveSelectEnabled` —
  выключение скрывает кнопку «Выбрать из архива» на лендинге +
  selection-баннер на архиве. Все changes additive.
- Существующий PGN-flow работает как раньше.
- Backend без изменений (или минимальная B-check).
