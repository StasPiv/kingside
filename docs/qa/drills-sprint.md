# QA — Drill Sprint Mode (Drills E4)

KS-2244 (ADR-035 §11). Карта тест-кейсов sprint-режима для ручного прогона и разбора e2e-отчётов. E2E автоматизированы в `apps/web/tests/e2e/drills-sprint.spec.ts` — 10 кейсов × 2 проекта (desktop + mobile) = 20/20 ✅.

## 1. Контекст

- **Sprint mode** — серия drill-задач на ограниченное время; UI считает решённые, backend ведёт session по `sessionId`.
- **3 страницы**:
  - `/drills/sprint` — `DrillSprintSetupPage` (KS-2241): выбор типов + длительность.
  - `/drills/sprint/play` — `DrillSprintPlayPage` (KS-2241): gameplay с таймером и счётчиком.
  - `/drills/sprint/results` — `DrillSprintResultsPage` (KS-2241): итоги (score/accuracy/avgPrecision).
  - `/drills/sprint/leaderboard` — `DrillLeaderboardPage` (KS-2242): топ по фильтрам mode×period.
- **API** (`apps/api/tactic-drill`):
  - `POST /tactic-drill/sprint/start` — `{durationMs, types[]}` → `{sessionId, drill, startedAt, durationMs}`.
  - `POST /tactic-drill/sprint/submit` — `{drillId, userAnswer, timeMs, mode:'sprint', sessionId}` → `{attempt, next|null, final?}`.
  - `POST /tactic-drill/sprint/finish` — `{sessionId}` → `{scoreId, score, accuracy, avgPrecision}`.
  - `GET /tactic-drill/sprint/leaderboard?mode=&period=` → `{mode, entries[]}`.

## 2. Окружение прогона

- Frontend: `npm run dev` в `apps/web` (vite на `:5173`).
- Backend: `npm run dev` в `apps/api` (NestJS на `:3001`).
- E2E: `/project/node_modules/.bin/playwright test apps/web/tests/e2e/drills-sprint.spec.ts`.
- На проде `drillsEnabled=false`, admin-API закрыт (см. KS-2232 коммент). Spec мокает `/config` и `/tactic-drill/sprint/*` через `page.route`. Selectors — только `data-testid` (CSS из KS-2243 в работе у layout, BEM-классы могут поменяться).

## 3. Тест-кейсы (Given/When/Then)

### TC-1. Setup: default duration + select-all/clear

- **Given** drillsEnabled=true, юзер открывает `/drills/sprint`.
- **When** ничего не делает; затем нажимает «Все типы»; затем «Очистить».
- **Then**:
  - radio `duration-180000` отмечен по умолчанию (3 минуты).
  - после «Все типы» атрибут `data-selected-count="8"` на `[data-testid="drill-sprint-setup-types"]`.
  - после «Очистить» — `data-selected-count="0"`.

### TC-2. Sprint flow: setup → play → results (1 drill, правильный ответ)

- **Given** mock `/sprint/start` отдаёт session с одним drill'ом; mock `/sprint/submit` возвращает `next:null` + `final` после первого submit.
- **When** юзер на setup нажимает «Начать спринт» → попадает на play; отвечает правильно (для count-attackers — клик «2»).
- **Then**:
  - play mountится с `data-state="idle"`; `data-score="0"`, `data-attempted="0"`.
  - после submit — переход на results с `data-state="loaded"`, `data-ended="submitted"`.
  - на results: `score=1`, `accuracy=100%`.

### TC-3. Несколько submit подряд: счётчик score/attempted растёт

- **Given** mock возвращает `next` непустым 3 раза (до final).
- **When** юзер делает submit #1 (правильный — «2») → ждёт следующий drill → submit #2 (неправильный — «4»).
- **Then** после каждого submit `data-attempted` инкрементируется (`1`, потом `2`); `data-score` растёт только после правильных (`1`, `1`).

### TC-4. Timeout: sprint завершается по таймеру

- **Given** mock `/sprint/start` отдаёт `durationMs=2000`; `/sprint/finish` отдаёт `{score:0, accuracy:0, avgPrecision:0}`.
- **When** юзер не отвечает; таймер дотикивает 0.
- **Then**:
  - frontend дёргает `POST /tactic-drill/sprint/finish` через ~2 сек.
  - переход на results с `data-state="loaded"`, `data-ended="expired"`.
  - score/accuracy показаны из ответа `/finish`.

### TC-5. Edge — прямой URL `/drills/sprint/play` без state

- **Given** юзер набирает URL вручную (или приходит по reload).
- **When** страница mountится с `location.state === null`.
- **Then** редирект на `/drills/sprint` (setup), play не рендерится.

### TC-6. Edge — `/drills/sprint/results` без state → missing-баннер

- **Given** юзер открывает results без прохождения.
- **When** страница mountится без state.
- **Then**:
  - `[data-testid="drill-sprint-results"]` имеет `data-state="missing"`.
  - кнопка `drill-sprint-results-play-again` видна и при click ведёт на `/drills/sprint`.

### TC-7. Leaderboard — переключение фильтров отправляет запросы

- **Given** на проде/моке доступны записи лидерборда.
- **When** юзер на `/drills/sprint/leaderboard` переключает фильтры по очереди: duration `5min`, set `overview`, period `day`.
- **Then**:
  - после каждого изменения `data-mode` и `data-period` на root меняются.
  - наблюдаемые сетевые запросы: минимум один `mode=5min-overview&period=day` (комбинация из всех изменений).
  - default — `mode=3min-mixed`, `period=allTime`.

### TC-8. Leaderboard ranking — таблица из ответа в порядке

- **Given** mock возвращает 3 записи (Alice 30, Bob 22, Carol 11).
- **When** страница загружается с default-фильтрами.
- **Then** в `[data-testid="drill-leaderboard-table"] tbody` — 3 `<tr>`. Первая ячейка первой строки = `1` (rank).

### TC-9. Leaderboard — empty-state

- **Given** mock возвращает `entries: []`.
- **When** страница загружается.
- **Then** виден `[data-testid="drill-leaderboard-empty"]`, таблица не рендерится.

### TC-10. Mobile portrait sprint flow

- **Given** viewport 390×844, `hasTouch=true`, `isMobile=true`.
- **When** юзер делает tap-и: «Начать спринт» → «2».
- **Then** flow завершается результатом (results `data-state="loaded"`). Drag не требуется — все взаимодействия через tap.

## 4. Edge-кейсы вне scope spec'а

| TC | Описание | Почему не в e2e |
|---|---|---|
| TC-11 | disconnect: сетевая ошибка `/sprint/submit` | Логика «retry submit» не реализована в KS-2241 (фича отложена). При ошибке submit feedback просто очищается и юзер может ответить заново. Покрыто инспекцией кода. |
| TC-12 | offline → onsubmit | Фронт не имеет offline-state механизма. Покрытие через ручное тестирование (выключить сеть, нажать submit). |
| TC-13 | sessionId expired (sprint протух на сервере) | Backend возвращает 404; UI показывает feedback=null, юзер редиректится на setup при следующем submit. Edge-кейс задокументирован в комментарии PlayPage. |
| TC-14 | Параллельные сессии (юзер открыл sprint в 2 вкладках) | Backend серриализует session по userId — перебивает старую. UX: вторая вкладка отдаст 404 при первом submit. Не критично для MVP. |
| TC-15 | Visual-регрессии (overlay-цвета, layout) | Зависят от KS-2243 (CSS у layout-агента). После KS-2243 — отдельный visual-screenshot pipeline. |

## 5. Что покрыто spec'ом

`apps/web/tests/e2e/drills-sprint.spec.ts` (10 кейсов × 2 проекта = 20 ✅):

| TC из этого doc | Spec block |
|---|---|
| TC-1 | `KS-2244 — sprint setup` |
| TC-2 | `sprint flow setup → play → results (1 drill, правильный ответ)` |
| TC-3 | `несколько submit подряд: счётчик score/attempted растёт` |
| TC-4 | `timeout: durationMs=2s → /finish вызывается → results` |
| TC-5 | `/drills/sprint/play без state → редирект на /drills/sprint (setup)` |
| TC-6 | `/drills/sprint/results без state → missing-баннер с Play again` |
| TC-7 | `sprint leaderboard › переключение duration/set/period → каждое отправляет новый запрос` |
| TC-8 | `sprint leaderboard › таблица заполняется entries из ответа, ранг 1..N` |
| TC-9 | `sprint leaderboard › пустой leaderboard → empty-state` |
| TC-10 | `mobile portrait sprint flow › mobile: setup → play → results через tap` |

## 6. Известные ограничения

1. **Mock `/config` + `/tactic-drill/sprint/*`**: drillsEnabled=false на проде + admin закрыт. Spec работает на mock-данных. После реального индексa drill-позиций (KS-DRILL-INDEX) и включения флага — мок снимать.
2. **CSS не готов** (KS-2243 у layout-агента). Selectors намеренно через `data-testid`. Visual-скрины — после KS-2243.
3. **Mode-string** для leaderboard собирается на клиенте (`<duration>min-<set>`). Если backend изменит формат — обновить `buildMode` в `DrillLeaderboardPage` и spec.

## 7. Связанные задачи

- KS-2240 — backend sprint API.
- KS-2241 — sprint setup/play/results pages.
- KS-2242 — sprint leaderboard page.
- KS-2243 — CSS-стилизация sprint pages (layout-agent, в работе).
- KS-DRILL-INDEX — генерация позиций в БД (backend).
