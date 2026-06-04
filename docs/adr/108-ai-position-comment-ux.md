# ADR-108. UX для кнопки «Оценка позиции от AI» в окне анализа

Статус: предложен (KS-3679).
Дата: 2026-06-04.
Связано:
- KS-3678 (упрощение инструкции для модели на бэке).
- ADR-102 / KS-3615 (LLM-комментарии MVP-1 — пакетный разбор партии).
- ADR-103 rev 3 / KS-3625 (LLM-комментарии MVP-2 — `positional_shifts` через WASM SF 16).
- ADR-107 / KS-3644 (`positional_subterms` через ответвление SF 16 trace).
- KS-3682 / KS-3687 (`window.__sfTrace` / `__sfReviewProbe` — debug-проба).

## 1. Контекст

Конвейер уже работает:
- `evalTrace(fen)` (`apps/web/src/lib/review/stockfishTrace.ts`) — WASM SF 16-trace, отдаёт `PositionalSubterm[]` за ~5–30 мс на позицию.
- `POST /analyses/position/comment` (`apps/api/src/position-comment/position-comment.controller.ts`) принимает `{ fen, factors, eval? }`, отправляет в `AI_CHAT_WEBHOOK_URL`, возвращает `{ comment: string }`. Пустая строка — штатное снижение при сбое/тайм-ауте webhook'а.
- В консоли работает `await window.__sfReviewProbe()` (`apps/web/src/lib/review/__devtools/sfTraceConsole.ts`): собирает subterms по текущему FEN и шлёт точно в этот endpoint. Скриншот пользователя — 568 символов, опирается на поданные критерии.

Нужно вытащить эту пробу в основной UI окна анализа: кнопка → запрос → текст комментария.

## 2. Граница задачи

### Входит

1. Размещение кнопки и панели вывода в `AnalysisPage` (desktop + mobile).
2. Все 5 состояний (idle / loading / success / empty / error) + 6-е (rate-limit).
3. Поведение при смене FEN и in-memory кэш ответов.
4. Сопряжение с пакетным разбором партии (ADR-102): не дублировать.
5. Локализация — `language: 'ru' | 'en'` в DTO бэка + два варианта system-prompt'а.
6. Доступность для гостей.
7. Лимиты — оставляем текущие; UI-обработка 429.

### НЕ входит

- Авто-запрос на каждом ходе. Только по клику (см. §5.3).
- Сохранение AI-комментария в PGN/дубль. Только in-memory кэш сессии.
- Стриминг (`SSE`). Webhook отдаёт ответ целиком за `POSITION_COMMENT_FETCH_TIMEOUT_MS=180000` (3 мин), для одной позиции хватает обычного `fetch`.
- TTS / voice-over.
- Регенерация по сегменту партии. Только одна позиция.
- Серверная персистентность по `(userId, fen)` — отдельный follow-up, если фидбэк подтвердит, что переходы между сессиями нужны.

## 3. Размещение кнопки и панели вывода

### 3.1. Решение

**Кнопка и панель вывода — внутри `analysis-panel` блока engine (`.analysis-panel`/`.analysis-mobile-section--engine`), отдельным под-блоком над списком линий Stockfish.**

Desktop (`AnalysisSidebar.tsx`) — внутри `panelStates.engine === true` блока, в самом верху `.analysis-panel-body`, до `.stockfish-lines-header`:

```
┌─ Engine panel ────────────────────────────────────────┐
│ Header: Stockfish 16 · d=24 · ⚙ … [Start/Stop]        │
├───────────────────────────────────────────────────────┤
│ ┌─ AI оценка позиции ──────────────────────────────┐ │
│ │  [ Получить оценку от AI ]    badge: 12 / 20 мин │ │
│ │  ──────────────────────────────────────────────  │ │
│ │  «Белые имеют решающий материальный перевес…»    │ │
│ │                                                  │ │
│ │  [ Обновить ]   from full review · 16:42         │ │
│ └──────────────────────────────────────────────────┘ │
│                                                       │
│  Eval | Maia% | Line                                  │
│  +0.42  18.3%  Nf3 d5 …                               │
│  …                                                    │
└───────────────────────────────────────────────────────┘
```

Mobile — внутри вкладки `engine`, в `.analysis-mobile-section--engine`, перед `.stockfish-lines-header`. Та же визуальная структура, текст комментария занимает всю ширину.

### 3.2. Почему здесь, а не отдельная панель / не в AnalysisActionsMenu

- **Не в `AnalysisActionsMenu` (⋯).** Меню сейчас содержит ~10 пунктов, среди них «Analyze game» (пакетный разбор). Прячем туда же — пользователь не найдёт. Кнопка одного клика должна быть на виду.
- **Не плавающая кнопка на доске.** Перебивает фигурный drag/drop, ломает mobile-фокус-режим (ADR-073).
- **Не отдельная collapsible-панель между engine и Database.** Лишний `analysis-panel` на узком layout'е, на mobile — четвёртая вкладка. Дороже разработка, дороже поддержка, не лучше с точки зрения discoverability.
- **Внутрь engine-panel — потому что AI-оценка это «другое eval»**, семантически соседствует с движочной оценкой. Это же место уже занимали кнопки KS-3579 / KS-3590 (вырезаны), CSS-каркас остался.

### 3.3. Открытие/сворачивание

Под-блок `AiPositionCommentPanel` собственного `collapsed`-state не имеет. Если пользователь свернул engine-panel — свёрнут и наш под-блок. Это ожидаемо: «не нужен engine — не нужна и AI-оценка».

Если в будущем поднимется фидбэк «хочу видеть AI-комментарий, но скрыть Stockfish-линии» — добавим отдельный collapsed (отдельный тикет, не блокер MVP).

## 4. Состояния

Все states — у хука `useAiPositionComment`, читается из текущего значения по нормализованному FEN (см. §5.1).

| State | Условие | UI |
|---|---|---|
| `unauthenticated` | гость (нет JWT) | кнопка `disabled`, tooltip `analysis.aiComment.guestHint = 'Войдите, чтобы получить AI-оценку'` |
| `unsupported` | `evalTrace` бросил `StockfishTraceEngineError` или WASM не загрузился | плашка `analysis.aiComment.unsupported = 'AI-оценка недоступна в этой сессии: движок-трассировщик не загрузился'`, кнопка `disabled` |
| `idle` | для текущего FEN нет записи в кэше | кнопка `Получить оценку от AI`, под кнопкой — badge `N/20 мин` (если меньше 20 — серый, если ≥ 20 — оранжевый) |
| `loading` | запрос в полёте | кнопка → `Получаю…` (disabled + spinner), под ней — `Отмена`. Время на ответ обычно 5–20 с (одиночная позиция), но webhook timeout — 180 с (см. `POSITION_COMMENT_FETCH_TIMEOUT_MS`). После 30 с — текст «Это занимает дольше обычного, можно отменить» |
| `success` | `comment.length > 0` | текст комментария (читаемый, line-height: 1.4, max-height с overflow-y:auto при > 8 строк). Кнопка → `Обновить`. Подпись — `получено в HH:MM` |
| `empty` | webhook вернул `""` | плашка `analysis.aiComment.empty = 'Модель не выделила позиционных особенностей. Попробуйте позже или другую позицию.'`, кнопка → `Попробовать снова` |
| `error` | 5xx, network, AbortError ≠ от cancel | плашка `analysis.aiComment.error = 'Не удалось получить оценку. Попробуйте ещё раз.'`, кнопка → `Повторить` |
| `rate-limited` | 429 от backend, `retryAfter` приходит в теле | плашка `Лимит превышен. Подождите {sec} сек`, обратный отсчёт, кнопка `disabled`. После 0 — `idle` |

Все строки — через `i18next`, ключи `analysis.aiComment.*`. Подписи времени — через локаль (`new Date().toLocaleTimeString`).

## 5. Поведение при смене позиции

### 5.1. Кэш по FEN

In-memory `Map<NormalizedFen, CacheEntry>` (или маленький LRU на 50 записей, реализация — `frontend` сам решает).

- **Нормализация FEN** — первые 4 поля (placement + side + castling + en passant). Поля 5–6 (halfmove clock, fullmove number) откидываем: они не меняют позицию, но FEN-строка различна, и без нормализации одинаковая позиция в основной линии и в варианте даст два запроса.
- `CacheEntry = { comment: string; receivedAt: number; status: 'success' | 'empty' | 'error' | 'rate-limited' }`.
- TTL — нет; запись живёт до перезагрузки страницы.
- `LRU` — нужен, чтобы при длинной сессии не разрастаться. 50 позиций × ~1 КБ комментария = 50 КБ, при оверфлоу выкидываем самый старый.

### 5.2. Что показывать при смене FEN

- Хук читает запись по новому FEN. Если есть `success`/`empty` — показывает её. Если нет — `idle` (или `unauthenticated`/`unsupported`, если выше).
- При активном `loading` для FEN-A пользователь меняет позицию на FEN-B → `AbortController.abort()` для FEN-A, состояние FEN-A в кэше не пишется. Для FEN-B — `idle`.
- НЕ показываем комментарий FEN-A под FEN-B ни при каких условиях (источник недоразумений и ложных выводов).

### 5.3. Автозапрос на каждом ходе — НЕТ

Аргументы:
- Лимит 20/мин на пользователя. Пользователь активно ходит по дереву партии — 20+ переключений за минуту обычны. Автозапрос мгновенно упирается в 429.
- Стоимость в webhook'е реальная (Pro/Max OAuth). 200/день общего лимита для одного пользователя — мало, если каждую позицию автозапрашивать.
- Комментарий полезен в *избранной* позиции, не в каждой проходной. Один клик не нагрузка для UX.

Дефолт MVP — manual only. После сбора фидбэка можно добавить toggle «авто-комментарий при выборе хода» в настройках (отдельный follow-up, не MVP).

## 6. Лимиты

### 6.1. Текущие значения

`apps/api/src/position-comment/position-comment.service.ts`:

```
POSITION_COMMENT_RATE_LIMIT_PER_MIN     = 20    (на пользователя)
POSITION_COMMENT_RATE_LIMIT_PER_DAY     = 200   (на пользователя)
POSITION_COMMENT_GLOBAL_DAILY_LIMIT     = 2000  (на весь сервис)
POSITION_COMMENT_FETCH_TIMEOUT_MS       = 180000 (3 мин)
```

Менять не нужно. 20/мин достаточно при manual-режиме. 200/день — комфортно (это ~ 5 партий по 40 уникальных позиций каждая, что больше реального паттерна работы с анализом). 2000/день global — защита от взрыва.

### 6.2. UI на 429

Backend отдаёт `{ error: 'rate_limit', retryAfter: <sec>, limits: { perMinute, perDay, globalDaily? } }`. Frontend разбирает, переводит в state `rate-limited` (§4), показывает обратный отсчёт.

Тексты:
- per-min: `Лимит 20 запросов/мин исчерпан. Попробуйте через {sec} сек.`
- per-day: `Лимит 200 запросов/день исчерпан. Попробуйте завтра.`
- global: `Лимит сервиса исчерпан. Попробуйте позже.`

### 6.3. Soft-counter на фронте

Под кнопкой — `N/20 мин` (использовано в текущей минуте). Считаем локально в хуке: `Date.now() - 60_000`, фильтр по `cacheEntry.receivedAt`. Это hint для пользователя, чтобы не упереться в стену; реальный gate — на бэке.

## 7. Сопряжение с пакетным разбором партии

### 7.1. Что есть сейчас

Пакетный разбор (ADR-102) пишет текст в `comment`-поле PGN-узла для каждого хода с NAG-меткой. Это persistent (сохранено в дубле), читается через `history[currentGlobalIndex].comment` (тип `ChessMove`).

### 7.2. Что показываем

Если **в текущем ply есть непустой `move.comment`**:

- В `AiPositionCommentPanel` в success-зоне рендерим этот текст с лейблом «Из полного разбора партии» (ключ `analysis.aiComment.fromGameReview`).
- Под текстом — кнопка `Перегенерировать` (`analysis.aiComment.regenerate`).
- При клике `Перегенерировать` хук уходит в `loading`, дёргает `/analyses/position/comment`, ответ пишет в **кэш** (не в `move.comment`). Дальше показываем кэш-запись, а лейбл «из полного разбора» заменяется на «Получено сейчас» (с timestamp).

Это даёт пользователю:
- Бесшовное переиспользование труда, который уже сделал «Разобрать партию».
- Видно происхождение текста (это важно для доверия — пакетный разбор делается с большим контекстом всей партии, single-shot — без него).
- Возможность освежить комментарий, если первый показался слабым.

### 7.3. Чего НЕ делаем

- Не перезаписываем `move.comment` в PGN при `Перегенерировать`. Это разрушит дубль и собьёт ожидание «я сохранил комментарий, он остался». Свежий комментарий живёт в RAM до перезагрузки.
- Не показываем обе версии одновременно (избыточная плашка, шум).
- Не пытаемся определить, «из разбора ли» данный `comment` или пользователь вписал его руками — у нас нет маркера. Принимаем pragma: любой непустой `move.comment` рендерим под лейблом «Из полного разбора». В будущем — отдельное поле `commentSource` (отдельный тикет).

## 8. Локализация

### 8.1. Текущее состояние

`PositionCommentService.buildSystemPrompt()` хардкодит RU:

```ts
return 'Прокомментируй пожалуйста позицию человеческим языком на основании факторов';
```

Модель отвечает на языке промпта. Для англоязычного интерфейса это даёт RU-ответ — багообразное поведение.

### 8.2. Решение

Расширить контракт.

- Frontend `POST /analyses/position/comment` передаёт `language: 'ru' | 'en'` (из `i18n.language`).
- Backend `PositionCommentDto` — `@IsOptional() @IsIn(['ru','en']) language?: 'ru' | 'en'`. По умолчанию `'ru'`.
- `buildSystemPrompt(language)` — две версии:
  - `ru`: «Прокомментируй пожалуйста позицию человеческим языком на основании факторов»;
  - `en`: «Please comment on this chess position in plain language using the given positional factors».
- Серверный текст — одна короткая фраза в каждой локали, чтобы не размножать ADR-103-style few-shot prompts.
- Тесты сервиса покрывают обе ветки.

### 8.3. Что НЕ делаем

- Не подставляем `user_elo` / уровень адаптации в prompt (ADR-102 §5.3) — это в пакетном разборе; в single-position MVP оставляем нейтральный регистр. Открытый вопрос на §10.
- Не пытаемся принудительно переводить уже полученный комментарий — закэшированная RU-запись остаётся как есть. После смены языка пользователь нажмёт `Обновить` — придёт EN-вариант.

## 9. Доступность для анонимов

Endpoint требует JWT (`@UseGuards(JwtAuthGuard)`). Снимать guard не имеет смысла:
- Webhook расходует Pro/Max-квоту пользователя; без identification нечем считать `userId` для rate-limit'а.
- Global daily limit 2000 — слишком мало, чтобы открывать анонимный доступ.

UX для гостей — state `unauthenticated` (§4): кнопка `disabled`, tooltip `Войдите, чтобы получить AI-оценку`. По клику тултип ведёт на `/login` (через `<Link>`). Это унифицировано с паттерном KS-3421 (ADR-087) — там же дисейблятся owner-only пункты гостям.

## 10. Открытые вопросы

1. **Адаптация под уровень.** Передавать ли `user_elo` (как в ADR-102 §5.3) в single-shot prompt'е? Дефолт MVP — НЕ передавать. Текст и так короткий (~500 символов), сегментировать по силе игрока на одиночном запросе избыточно. Если по фидбэку выяснится, что новички не понимают терминов — добавить параметр. Не блокер MVP.
2. **Видимость лейбла «Из полного разбора».** Возможно, лейбл стоит не показывать, если пользователь сам открыл анализ-дубль (originalAnalysisId != null означает дубль с пакетным разбором). Дефолт MVP — всегда показывать; в дубле это даже полезно, видно, что текст — машинная аннотация, а не комментарий тренера. Перепроверить на фидбэке.

Остальные развилки решены выше.

## 11. Декомпозиция

### F1 (frontend, ~1.5 дня) — Hook + UI

`apps/web/src/hooks/useAiPositionComment.ts`:
- API: `useAiPositionComment({ fen, language, isAuthenticated })` → `{ status, comment, ratePerMin, request(), cancel(), retryAfter? }`.
- LRU кэш на 50 записей по нормализованному FEN (поля 1–4).
- AbortController при unmount и при смене `fen`.
- Парсинг 429 (`error: 'rate_limit', retryAfter`), таймер обратного отсчёта.
- Soft-counter «использовано в этой минуте».
- Перед запросом: `evalTrace(fen)` → если ошибка/пусто → state `unsupported`/idle с подсказкой.

`apps/web/src/components/analysis/AiPositionCommentPanel.tsx`:
- Все 7 состояний (§4), кнопки CTA, бейджи.
- Лейбл «Из полного разбора» при `currentMove.comment !== ''`. Кнопка `Перегенерировать` — `request()` хука, в кэш записывается свежий ответ.
- i18n keys: `analysis.aiComment.title`, `cta.get`, `cta.regenerate`, `cta.retry`, `cta.update`, `cta.cancel`, `state.loading`, `state.empty`, `state.error`, `state.rate-limit-min`, `state.rate-limit-day`, `state.rate-limit-global`, `guestHint`, `unsupported`, `fromGameReview`, `receivedAt`, `counter.minute`.

Интеграция в `apps/web/src/pages/analysis/AnalysisSidebar.tsx`:
- Внутрь desktop `analysis-panel` (engine), `panelStates.engine && (<AiPositionCommentPanel … />)` — ДО `.stockfish-lines-header`.
- Внутрь mobile `analysis-mobile-section--engine`, ДО `.stockfish-lines-header`.
- Новые props: `currentMoveComment: string | null`, `currentFen` (уже есть), `userIsAuthenticated`.

`AnalysisPage.tsx` — пробрасывает `history[currentGlobalIndex]?.comment ?? null` как `currentMoveComment` и `!!user` как `userIsAuthenticated`.

Тесты:
- `useAiPositionComment.test.ts` — cache hit/miss, abort на смене FEN, 429-обработка, retryAfter countdown.
- `AiPositionCommentPanel.test.tsx` — рендер каждого state'а, клик CTA, локализация двух языков.

Метки: `analysis`, `chat`, `stockfish`.

### F2 (frontend, ~0.5 дня) — CSS / layout

Стили `AiPositionCommentPanel`:
- Контейнер с фоном чуть отличным от engine-panel body (для визуального обособления).
- Текст комментария: line-height 1.4, padding, max-height ~160px с overflow-y:auto на desktop; на mobile без max-height (вкладка скроллится сама).
- Кнопка CTA — стиль `analysis-toggle-btn` (уже есть в проекте, см. AnalysisSidebar §449).
- Бейдж счётчика — мелкий шрифт, цвет по порогам.
- В `apps/web/src` найти существующий примерный паттерн «inline-panel + cta + text» (например `EngineLoader`, `bridge-promo`) и переиспользовать наследие стилей.

Метки: `analysis`, `mobile`.

### B1 (backend, ~0.5 дня) — `language` + graceful empty factors

`apps/api/src/position-comment/dto/position-comment.dto.ts`:
- Добавить `@IsOptional() @IsIn(['ru', 'en']) language?: 'ru' | 'en'`.
- Ослабить `@ArrayMinSize(1)` → убрать ограничение или `@ArrayMinSize(0)`. Сейчас фронт сам проверит и не пошлёт пустой массив, но защита бэка не должна падать на крайних случаях.

`apps/api/src/position-comment/position-comment.service.ts`:
- `buildSystemPrompt(language: 'ru' | 'en' = 'ru')` — две короткие версии (§8.2).
- В `comment()` — если `dto.factors.length === 0`, сразу возвращаем `""` без вызова webhook'а (экономия квоты).
- Прокидываем `dto.language` в `buildSystemPrompt`.

Тесты:
- `review-comment.service.spec.ts` — purposed «position-comment» (или отдельный spec в position-comment) — две ветки prompt'а, early-return на пустых factors.

Метки: `analysis`, `chat`, `i18n`.

### Q1 (QA, ~0.5 дня) — приёмка

- Desktop + mobile визуальная проверка размещения.
- Перекидывание по дереву: 3 раза туда-сюда через одну позицию → 1 запрос (cache hit на повторах). Проверить в Network.
- Гость: кнопка disabled, tooltip ведёт на /login.
- Ошибка 429 (искусственно ставится через `redis-cli` накачкой `position-comment:rate:min:<userId>` до 20) — UI показывает обратный отсчёт.
- Пустой ответ webhook (mock) → state `empty`, кнопка retry.
- Network error → state `error`, retry.
- Дубль анализа (пакетный разбор уже отработал): на ply с непустым `comment` появляется лейбл «Из полного разбора», `Перегенерировать` свежим ответом.
- Смена языка ru→en + `Обновить` → ответ приходит на EN (требует B1).
- WASM SF 16 не загрузился (через mocked `evalTrace` reject) — state `unsupported`.

Метки: `analysis`, `tests`.

### Зависимости

```
F1 ──> Q1
B1 ──> Q1
F2 (параллельно F1)
```

F1 и B1 идут параллельно. F2 (CSS) — после F1. Срок до прода ~2 рабочих дня.

## 12. Резюме

**Размещение** — внутри engine-panel сверху, отдельным под-блоком над списком линий Stockfish. И desktop, и mobile. Не отдельная панель, не AnalysisActionsMenu, не floating.

**Состояния** — 7: idle / loading / success / empty / error / rate-limited / unauthenticated. Дополнительное `unsupported` — когда WASM-трассировщик не доступен в сессии. UI каждого состояния — см. §4.

**Кэш** — in-memory LRU на 50 записей по нормализованному FEN (поля 1–4, без halfmove/fullmove counters). При смене FEN — не показывать комментарий чужой позиции. Активный `loading` отменяется через AbortController. Автозапроса при смене FEN нет; только manual.

**Лимиты** — текущие (20/мин, 200/день на пользователя, 2000/день global) оставляем. UI обрабатывает 429 с обратным отсчётом по `retryAfter`. Soft-counter `N/20 мин` под кнопкой как подсказка.

**Связь с пакетным разбором** — если `history[ply].comment` непустой, рендерим его в success-зоне с лейблом «Из полного разбора». `Перегенерировать` дёргает single-shot endpoint, ответ кладётся в RAM-кэш, в PGN не пишется.

**Локализация** — backend получает `language: 'ru' | 'en'` в DTO, две версии короткого system-prompt'а. По умолчанию — RU (как сейчас).

**Гости** — кнопка disabled с tooltip'ом на login. Endpoint остаётся за JwtAuthGuard.

**Объём** — F1 ~1.5 дня, F2 ~0.5 дня, B1 ~0.5 дня, Q1 ~0.5 дня. Срок до прода — ~2 рабочих дня.
