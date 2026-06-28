# ADR-148 — Контекстные подсказки: добавление правила без правок кода и без деплоя

- Статус: **Proposed** (2026-06-28)
- Дата: 2026-06-28
- Связанные задачи: KS-4730 (этот ADR), KS-4699..KS-4713 (реализация ADR-147), KS-4727 / KS-4728 / KS-4729 (триггерный случай — рассматриваются под отмену/переписывание по миграционному плану §6)
- Связанные ADR: ADR-147 (контекстные подсказки — родительский), ADR-128 (public routes / guest)
- Автор: architect

---

## 0. TL;DR

Текущая реализация (ADR-147) требует для нового правила: правки `packages/shared/src/types/hint-anchors.ts` (union `HINT_ANCHORS_USER` + валидатор `isHintAnchor`), сборки shared-пакета и тройного деплоя (api + frontend + shared). Делаем data-driven: **anchor — свободная строка**, валидируется только через `document.querySelector` на клиенте (как уже сделано в `<HintHost>` §4.2 ADR-147); **события** — generic `track()` уже generic, к нему добавляем **декларативные DOM-триггеры** через `data-track-click` / `data-track-view` атрибуты + один global delegating listener, чтобы 80% новых событий заводились без правок TS-кода компонентов; **реестр anchors/events** в админ-UI — справочный (autocomplete по `SELECT DISTINCT`), не валидирующий. Результат: новое правило — один `POST /admin/hints` без правок shared, без сборки, без деплоя; новый anchor — один атрибут `data-hint-anchor="..."` в JSX (одной строкой через PR без обновления контрактов); новое событие через DOM — один атрибут `data-track-click="..."` без TS.

---

## 1. Текущее состояние (как делается новое правило сейчас)

По следам KS-4727 / KS-4728 / KS-4729 (пользовательский кейс «3 запуска wasm-движка → подсказка про подключение bridge») цена нового правила:

| Что | Где | Кто меняет | Деплой |
|-----|-----|-----------|--------|
| 1. Добавить event_type `engine_started` в hook `useEngine` | `apps/web/src/hooks/useEngine.ts` — `track('engine_started', { source })` | frontend | apps/web |
| 2. Добавить anchor `analysis-bridge-promo` в shared union | `packages/shared/src/types/hint-anchors.ts` — `HINT_ANCHORS_USER` | backend или frontend | сборка shared + apps/api + apps/web |
| 3. Расставить `data-hint-anchor="analysis-bridge-promo"` в JSX | `apps/web/src/components/AnalysisSidebar.tsx` (например) | frontend | apps/web |
| 4. Завести правило в БД через admin API | POST `/admin/hints { rule, anchor, copy, ... }` | admin (продукт/маркетинг) | без деплоя |

Шаги 1–3 — деплой кода. Шаг 4 — конфигурация. **Все четыре** требуются для каждого правила, использующего новое событие или новый anchor.

### 1.1. Что уже сделано правильно

- `track(type: string, payload?)` в `apps/web/src/lib/events.ts` — **уже generic**, принимает любую строку. Не нужно расширять контракт shared при добавлении нового `event_type`.
- Backend: `event_type` в `actor_events` — свободная строка с регулярным валидатором; в `Hint.rule` DSL ссылается на любые `event_type` без перечисления.
- HintHost уже делает `document.querySelector('[data-hint-anchor="..."]')` и при отсутствии узла шлёт `hint:no-anchor` (ADR-147 §4.2 п.2). То есть рантайм anchor-резолва уже работает по строке.

### 1.2. Что мешает (точки трения)

| Трение | Файл | Тип |
|--------|------|-----|
| **T1. Anchor — закрытый TS union** | `packages/shared/src/types/hint-anchors.ts` (HINT_ANCHORS_GUEST + HINT_ANCHORS_USER) | контракт |
| **T2. Runtime-валидатор `isHintAnchor`** в backend DTO и в shared | `apps/api/src/hints/admin/hints-admin.service.ts` использует `isHintAnchor` | контракт |
| **T3. Каждое новое событие** требует места вызова `track()` в TS-коде хука/компонента | `apps/web/src/hooks/*.ts`, конкретные компоненты | TS-код |
| **T4. Расстановка `data-hint-anchor`** в JSX тоже требует правки кода (хотя одна строка) | компоненты | JSX |

T1/T2 — главное: они **завязаны на сборку shared-пакета** и блокируют чисто-data-driven сценарий «admin зашёл, ввёл правило, оно начало работать».

T3/T4 — правки кода, но они **локальные** и не требуют контрактов; можно частично заменить декларативными DOM-атрибутами.

---

## 2. Болевые точки (примеры с тикетами)

| Кейс | Что случилось | Кол-во тикетов | Кол-во деплоев |
|------|---------------|----------------|----------------|
| KS-4727 + KS-4728 + KS-4729 «engine started → bridge promo» | track в `useEngine`, новый anchor в shared, правило в admin API | **3** (frontend + backend + admin) | shared + api + web |
| Гипотетический кейс «пользователь открыл `/analysis` 5+ раз — подсказать save» | analysis-open уже трекается; новый anchor `analysis-save-button` — правка shared, JSX | 2 | shared + web |
| Гипотетический «гость скроллил лендинг до низа» | новое событие `landing_scroll_bottom` — правка хука, новый anchor `landing-cta-bottom` — правка shared | 3 | shared + web |

Тренд: **каждое новое правило ≈ 2–3 тикета, как минимум один деплой кода**. Это противоречит изначальной идее «правила — данные».

Дополнительная проблема: эти тикеты часто не координируются (один человек думает про правило, другой реально делает деплой shared). Между ними проходят дни.

---

## 3. Варианты решения

Три варианта с разной степенью «data-driven». Сравниваются по: цена реализации, цена нового правила после внедрения, риск.

### 3.1. Вариант A — Минимальный: только anchor становится свободной строкой

**Что меняется.**
- `HINT_ANCHORS_GUEST/USER/HINT_ANCHORS` удаляются. Тип `HintAnchor = string`.
- `isHintAnchor` удаляется. Backend DTO: `anchor: string` 1..64, regex `[a-z][a-z0-9-]*` (тот же, что для `key`).
- Frontend `<HintHost>` — без правок (уже использует `querySelector`).
- Backend hints-admin.service.ts — убрать вызов `isHintAnchor`.

**Что НЕ меняется.**
- `track(type, payload)` — уже generic.
- Расстановка `data-hint-anchor=...` в JSX — по-прежнему code-change для новых точек, но без касания shared.

**Цена реализации.**
- 1 backend-тикет (убрать isHintAnchor в DTO + переписать тест admin-DTO).
- 1 frontend-тикет (удалить HINT_ANCHORS_*, обновить типы в `<HintHost>`).
- 1 shared-тикет (удалить файл `hint-anchors.ts`, заменить `HintAnchor` на `type HintAnchor = string`).
- Можно объединить в один общий тикет на 1 день.

**Цена нового правила после внедрения.**
| Кейс | Правок кода | Деплоев |
|------|-------------|---------|
| Новое правило на существующих событиях + существующем anchor | **0** | 0 |
| Новое правило, нужен новый anchor (узел уже есть в DOM или ставится одной строкой в JSX) | 1 строка JSX | apps/web только |
| Новое правило, нужно новое событие | 1 место `track()` в TS | apps/web только |

**Плюсы.**
- Минимальная переделка, низкий риск.
- Сразу убирает главное трение T1/T2 (сборка shared).
- Backend становится полностью data-driven для anchor.

**Минусы.**
- Не решает T3/T4 — новые события и расстановка anchor всё равно требуют PR в `apps/web`. Один деплой frontend.

### 3.2. Вариант B — A + декларативные DOM-триггеры событий

**Дополнительно к A.**

В `apps/web/src/main.tsx` добавляется один global delegating listener (~30 строк), который слушает:

- `click` на любом элементе → если есть атрибут `data-track-click="<event_type>"` → `track(event_type, parsePayload(el))`.
- `IntersectionObserver` на элементы с `data-track-view="<event_type>"` (`threshold: 0.5`) → один раз за life-cycle компонента шлёт `track`.
- Опц. `data-track-payload='{"k":"v"}'` — JSON, парсится в payload.

Пример. Старый код:
```jsx
<button onClick={() => { track('analysis_save_attempted'); save(); }}>Сохранить</button>
```
Становится:
```jsx
<button data-track-click="analysis_save_attempted" onClick={save}>Сохранить</button>
```

Покрытие: оценочно **60–70% новых событий** — это click на конкретном элементе или показ блока. Сложные триггеры (timer, sequence, кастомная логика) остаются как явный `track()` в TS.

**Цена реализации.**
- Вариант A: 1 день.
- Доп. для B: новый файл `apps/web/src/lib/domEventsTracking.ts` (~80 строк с тестами) + интеграция в `main.tsx`. ~1 день frontend.
- Документация для разработчиков в `docs/dev/` (как добавлять `data-track-*`).

**Цена нового правила после внедрения.**
| Кейс | Правок кода |
|------|-------------|
| Новое правило, событие — click/view на существующей кнопке | **1 атрибут в JSX** (`data-track-click="..."`) |
| Новое правило, событие — кастомный триггер | 1 место `track()` в TS (как в A) |
| Новый anchor | 1 атрибут в JSX (`data-hint-anchor="..."`) |

**Плюсы.**
- Снимает T3 для большинства новых событий.
- Делает фронт-код более «декларативным» — поведение видно в DOM.
- Атрибуты безопасны (только metadata, никакого выполняемого кода).
- Совместимо: явные `track()` в коде остаются.

**Минусы.**
- Слабое дублирование подходов: одни события через атрибуты, другие через явный `track()`. Нужна документация когда что.
- IntersectionObserver добавляет небольшой runtime overhead (~0.1 мс/элемент при монтировании, пренебрежимо).
- Глобальный click listener: фильтрация по `closest('[data-track-click]')`, не вмешивается в существующие onClick.

### 3.3. Вариант C — A + B + admin-управляемые DOM-триггеры (полный zero-code)

**Дополнительно к B.**

Backend хранит таблицу `event_specs` (admin-управляемая):
```
selector text,        -- CSS-селектор, напр. "#analysis-save-btn"
trigger  text,        -- 'click' | 'view' | 'timer:<ms>' | 'idle:<sec>'
event_type text       -- что эмитить
payload_template json  -- статический payload
```

Frontend подтягивает `GET /events/specs` раз в 5 мин, делегатно навешивает листенеры. Admin добавляет новый «инструментированный элемент» через `POST /admin/events/specs` — никаких правок кода вообще.

**Плюсы.**
- Полный zero-code для новых событий: даже атрибут в JSX не нужен.
- Соответствует образцу Google Tag Manager, Mixpanel autocapture, PostHog Toolbar.

**Минусы.**
- **Хрупкость CSS-селекторов.** Любая правка вёрстки/Tailwind-классов ломает спеки молча. Селектор `.btn-primary:nth-child(2)` живёт неделю — потом всё переломалось при рефакторе.
- **Селекторы не версионируются вместе с кодом.** При откате deploy frontend селекторы могут указывать на DOM, которого больше нет.
- **Сложность реализации.** Делегированный обработчик `click` + IntersectionObserver на динамически меняющемся списке селекторов; нужно навешивать/снимать при смене страницы; нужно тестировать.
- **Безопасность.** Произвольные селекторы в БД — это вектор для XSS через CSS-инъекции в админ-UI (если кто-то напишет `<style>` через payload_template). Защита через sanitize, но это дополнительная поверхность атаки.
- **Время реализации.** ~5–8 дней backend + frontend.

**Где оправдан C.** Когда есть аналитическая команда, которая тегирует продукт независимо от инженерии. У нас этого процесса нет — атрибуты добавляются теми же разработчиками, что пишут компонент. Тогда атрибут в JSX дешевле, понятнее и безопаснее, чем удалённая привязка по селектору.

---

## 4. Сравнительная таблица

| Критерий | Вариант A (anchor-string) | Вариант B (A + DOM-триггеры) | Вариант C (A + B + admin-spec) |
|----------|---------------------------|------------------------------|-------------------------------|
| Цена реализации | ~1 дн | ~2 дн | ~5–8 дн |
| Новое правило на сущ. событиях/anchor | 0 правок кода | 0 | 0 |
| Новое правило, нужно новое событие через click/view | 1 строка TS | **1 атрибут JSX** | 0 (POST в админку) |
| Новое правило, нужен новый anchor | 1 строка JSX | 1 строка JSX | 1 строка JSX (anchor remains в DOM) |
| Деплой shared | **нет никогда** | нет | нет |
| Деплой apps/web для новых событий | да (минимально) | да (минимально) | нет |
| Риск хрупкости | низкий | низкий | **высокий** (CSS-селекторы в БД) |
| Безопасность | нет новых рисков | нет новых рисков | XSS-поверхность через селекторы |
| Соответствие текущему процессу команды | да | да | требует отдельной роли «тегер событий» |

---

## 5. Рекомендуемый вариант — B

**Гибрид A + декларативные DOM-триггеры.**

Цена реализации ~2 дня (1 день на A + 1 день на DOM-triggers). Покрывает заявленное требование «новое правило — один `POST /admin/hints` без правок кода» **для большинства реальных кейсов**:

| Сценарий нового правила | Действия после миграции |
|--------------------------|-------------------------|
| Правило на event'ах, которые уже трекаются, и anchor на существующем элементе | **1 шаг**: `POST /admin/hints` |
| Правило требует новое событие = click/view на конкретном элементе | **2 шага**: добавить `data-track-click="X"` в JSX (1 строка) + `POST /admin/hints`. Frontend-PR — одна строка, ревью 5 мин. |
| Правило требует новый anchor на новом узле DOM | **2 шага**: `data-hint-anchor="X"` в JSX (1 строка) + `POST /admin/hints`. Аналогично. |
| Правило требует кастомный триггер события (timer, sequence, business-logic) | **3 шага**: `track('X', payload)` в нужном хуке + `POST /admin/hints`. Это редкий кейс, и здесь правки кода уместны. |

**Вариант C не выбран** — хрупкость CSS-селекторов в БД и отсутствие у нас процесса «тегер событий, отделённый от разработчика» делает его дороже A+B по совокупности.

**Анти-вариант — оставить как есть** (вариант 0): продолжать заводить новое правило тремя тикетами. Уже видно по KS-4727..KS-4729, что это создаёт реальные задержки и противоречит явной директиве пользователя.

---

## 6. Миграционный план

### 6.1. Тикеты (предлагаются взамен KS-4727 / KS-4728 / KS-4729)

| # | Тикет | Кто | Содержание | Зависимости |
|---|-------|-----|------------|-------------|
| M1 | **shared: убрать union `HINT_ANCHORS_*` и `isHintAnchor`** | backend (владеет shared) | `packages/shared/src/types/hint-anchors.ts`: удалить константы, оставить `export type HintAnchor = string`. Обновить `hint-payload.ts` (`anchor: string`). Обновить экспорты пакета. Bump версии shared. | — |
| M2 | **backend: data-driven anchor в admin-DTO** | backend | `apps/api/src/hints/admin/admin-hint.dto.ts`: убрать import `isHintAnchor`, оставить `@IsString @Length(1, 64) @Matches(/^[a-z][a-z0-9-]*$/) anchor!: string`. `hints-admin.service.ts`: убрать вызов `isHintAnchor`. Обновить `hints-admin.service.spec.ts` и `admin-hint.dto.spec.ts`. | M1 |
| M3 | **frontend: убрать ссылки на `HINT_ANCHORS_*`** | frontend | `apps/web/src/components/hints/HintHost.tsx` и тесты — заменить `HintAnchor` на `string`, оставить runtime `querySelector` как есть. | M1 |
| M4 | **frontend: декларативные DOM-триггеры событий** | frontend | Новый файл `apps/web/src/lib/domEventsTracking.ts`: один `useEffect`-mount в `App.tsx` (или `EventsBootstrap`), который вешает делегированный `click` listener на `document` (фильтр `closest('[data-track-click]')`), и `MutationObserver`-driven `IntersectionObserver` на `[data-track-view]`. Payload — из `data-track-payload` (JSON, безопасный parse через try/catch). Тесты на каждый случай. Документация в `docs/dev/events-tracking.md`. | — (независим от M1–M3) |
| M5 | **backend + frontend: справочный реестр anchors/events в админ-UI** | backend + frontend | `GET /admin/hints/anchors-seen` (DISTINCT anchor из `hints` за всё время + DISTINCT из последних `hint_no_anchor` reasons за 7 дней) и `GET /admin/hints/events-seen` (DISTINCT type из `actor_events` за 7 дней). Frontend: autocomplete в форме создания/редактирования hint (поле anchor, поле триггера событий в DSL). Это **UX админки**, не валидация — admin может ввести любую строку и сохранить. | M2 (для events-seen используется существующая таблица) |
| M6 | **content/docs: обновить материалы для маркетинга** | content + architect | Короткий гайд «как завести новое правило подсказки» — теперь это про POST в админку и (опц.) одну строку JSX. Заменить упоминания о правке shared. | M2, M5 |

Все 6 тикетов укладываются в ~3–4 дня суммарно. Можно параллелить M1+M2 и M4.

### 6.2. Что делать с уже-открытыми тикетами KS-4727 / KS-4728 / KS-4729

Эти тикеты заводились под старую модель (правка shared + frontend track + backend rule). После принятия этого ADR:

- **KS-4729** (backend: правка shared под `analysis-bridge-promo`) — **отменяется**: после M1/M2 любой anchor валиден без правки shared. Правило `analysis-bridge-promo` создаётся обычным `POST /admin/hints` (M5 даст автодополнение).
- **KS-4728** (backend: правило в admin API) — **сводится к одной команде**: после M1/M2 это просто `curl -X POST /admin/hints -d @rule.json` или клик в админке. Закрыть как «выполнено через единый процесс M2/M5».
- **KS-4727** (frontend: `data-track-click="engine_started"` + `data-hint-anchor="analysis-bridge-promo"`) — **остаётся**, но в новой формулировке: вместо отдельного `track('engine_started')` в `useEngine` используется атрибут `data-track-click="engine_started"` на UI-кнопке запуска движка (если такая есть) **или** остаётся как есть (явный `track()` в `useEngine.ts:195` уже работает). Анкор `data-hint-anchor="analysis-bridge-promo"` — одна строка в `AnalysisSidebar.tsx`.

Координатор по итогам ADR решает: закрыть KS-4727..4729 и завести M1..M6, либо переписать существующие в M1..M6.

### 6.3. Совместимость и поэтапность

M1–M3 совместимы с running production: до развёртывания M3 во фронте — backend всё ещё принимает любой anchor, фронт ищет по querySelector. Промежуточное состояние «backend без isHintAnchor, frontend ещё на union» — безопасное (новые anchors просто не будут отображаться, пока deploy frontend не доедет).

M4 — изолированная фича, можно деплоить независимо.

M5 — UX-улучшение, не блокирует основной workflow.

---

## 7. Что НЕ меняется (стабильные контракты)

- **DSL правил** (`Hint.rule` jsonb, операторы `count`/`exists`/`timeSince`/`actorType`/`page`/`all`/`any`/`not`) — без правок. Любые `event_type` и `anchor` уже свободные строки в DSL.
- **`actor_events`** — без правок. `type` уже свободная строка с regex.
- **`hints` таблица и REST** (`POST /admin/hints`, `PATCH /admin/hints/:id`, lifecycle endpoints, pull `/hints/pending`) — без правок схемы и поведения.
- **WS-канал `hint:show`** и frontend `<HintHost>` рендеринг — без правок логики (только тип anchor становится `string`).
- **GDPR endpoints, consent, throttle/session-лимиты** (ADR-147 §5.2, §6) — без правок.
- **Метрики Prometheus / Grafana dashboard** — без правок.

Изменения **точечные** и затрагивают только контракт anchor и опциональные DOM-триггеры событий.

---

## 8. Открытые вопросы (вне scope этого ADR)

1. **Версионирование anchor-ов.** Сейчас при удалении anchor из JSX (рефакторинг компонента) старые правила в БД продолжают ссылаться на несуществующий ключ — будут получать `no_anchor` события. Это видно в Grafana (`hint_dismissed{reason='no_anchor'}` rate), но не блокируется на стадии PR. Если станет проблемой — отдельная задача «pre-deploy check: какие anchors из активных правил не находятся в собранном frontend bundle» (статический grep по `data-hint-anchor=` в `apps/web/src` + сравнение с `SELECT DISTINCT anchor FROM hints WHERE enabled`). Не сейчас.
2. **Audit-trail изменений в админке.** Соответствует §3.3 ADR-147 (soft-delete по `deleted_at` уже есть), но history каждой правки текста — отдельная задача.
3. **Toolbar/inspector в админке для подсветки доступных anchors на странице.** PostHog-стиль «откройте сайт в режиме разметки, кликните на элемент — увидите его anchor». Полезно при росте числа правил. Отдельный ADR, не сейчас.

---

## 9. Резюме

- **Anchor становится свободной строкой** (вариант A) — закрывает главное трение (правка shared при каждом правиле).
- **Декларативные DOM-триггеры событий** (вариант B-инкремент) — `data-track-click` / `data-track-view` атрибуты + один global listener, чтобы 60–70% новых событий заводились без TS-кода в хуках.
- **Реестр anchors/events в админ-UI справочный** (autocomplete, не валидация) — `SELECT DISTINCT` из существующих таблиц, отдельная таблица не нужна.
- **Полный admin-driven c CSS-селекторами в БД** (вариант C) **отвергнут** — хрупкость и риски не оправданы при нашем процессе.
- **Миграционный план — 6 тикетов на ~3–4 дня**. KS-4727/4728/4729 пересматриваются: KS-4729 отменяется, KS-4728 сводится к одному POST, KS-4727 остаётся с новой формулировкой.
- **Результат:** новое правило hints — один `POST /admin/hints` (если событие и anchor уже есть), либо POST + 1–2 атрибута в JSX без касания shared, без сборки, без деплоя backend.
