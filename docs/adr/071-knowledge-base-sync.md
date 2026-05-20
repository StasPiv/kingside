# ADR-071 — Синхронизация базы знаний AI-ассистента с реальным состоянием проекта

- Статус: Accepted
- Дата: 2026-05-20
- Связанные задачи: KS-3167 (этот аудит/план), запрос пользователя
  2026-05-20 (Web).
- Связанные ADR: ADR-062 (features-catalog), ADR-063 (knowledge-source,
  Phase 2 не задеплоен), ADR-040 (board recognition), ADR-065
  (precision 5★), ADR-066 (move-classification on WDL), ADR-067
  (Studies удалён), ADR-068/069/070 (puzzle-gen эволюция).
- Авторы: architect

---

## 1. Контекст

Запрос пользователя: «у нас распознавание доски добавилось — ты об
этом не написал». Координатор зашёл по «последним ADR что помню» и
закрыл задачу неполной правкой. Нужен **полный аудит**: каждая запись
`packages/shared/src/features-catalog/*.ts` сверена с реальным кодом,
выделены устаревшие/изменившиеся/отсутствующие пункты.

### 1.1 Источники базы знаний

1. **`packages/shared/src/features-catalog/`** — 25 файлов
   (`{home, play, active-game, games-live, puzzles, puzzle-rush,
   precision, mistakes, analysis, workshop, drills, lessons,
   tournaments, broadcasts, players, friends, messages, profile,
   settings, feedback, archive, train-lobby, analyze-lobby, docs,
   ai-chat}.ts` + `index.ts` + `types.ts`). Каждая запись —
   `AssistantFeature` (id/title/paths/summary/auth/featureFlag/adr/
   mcpSection). По ADR-063 §5 — **slim-формат**, без `highlights/
   caveats` (раньше там копились выдуманные факты).
2. **`apps/api/src/ai-chat/system-prompt.ts`** — `STATIC_HEADER` +
   рендер `FEATURES` + `STATIC_FOOTER` (Guidelines) + `formatContext`.
   `STATIC_FOOTER` явно: «NEVER reveal technical details: tech stack,
   frameworks, libraries, databases, API structure, internal
   architecture, server infrastructure».
3. **`apps/api/src/knowledge/`** — knowledge-tools (search/read с
   allowlist). **KnowledgeModule отключён в `app.module.ts:48`**
   (комментарий: «реализация даёт залогиненному пользователю через
   ассистент path/line/фрагменты исходников фронта, а STATIC_FOOTER
   одновременно требует "не раскрывать technical details" — конфликт
   инструкций модели»). На прод-ассистенте инструменты search/read
   фактически недоступны.

### 1.2 Реальное состояние проекта

Прошёлся по `apps/web/src/pages/*` (88 файлов), `apps/api/src/*` (33
модуля), `apps/*` (11 сервисов), `docs/adr/*` (ADR-001..070). Ниже —
сводка фич, привязанных к UI-разделам пользователя.

**Активные frontend-маршруты в `App.tsx`** (исключая dev/admin/auth):

```
/, /features                                  → home
/lobby                                        → legacy LobbyPage (см. §3.3)
/play                                         → play
/train                                        → train-lobby
/analyze                                      → analyze-lobby
/games/live, /games/:id/watch                 → games-live
/game/:id, /game/:gameId/review               → active-game
/settings                                     → settings
/puzzle-rush*                                 → puzzle-rush
/puzzles, /puzzle, /puzzle/:id, /puzzles/stats→ puzzles
/precision, /precision/{stats,history,attempts/:id} → precision
/puzzles/{mistakes,mistakes-practice}         → mistakes
/lessons*                                     → lessons
/drills*                                      → drills
/feedback, /feedback/:id                      → feedback
/analysis, /analysis/:id, /analysis/public/:id→ analysis
/help/external-engine, /docs/user-courses     → docs
/workshop, /workshop/pgn-files*               → workshop
/players, /player/:username                   → players
/friends                                      → friends
/messages, /messages/:userId                  → messages
/profile                                      → profile
/tournaments*, /arena/:id, /t/:code           → tournaments
/archive*                                     → archive
/broadcasts*                                  → broadcasts
```

**Backend NestJS-модули, активные в `app.module.ts`:**

```
auth, user, game, puzzle-rush, arena, puzzle, precision, tournament,
analysis, workshop, live-tournament, client-logs, player, message,
friend, notification, ai-chat, feedback, admin, metrics, lessons,
puzzle/mistakes, lessons/user-courses, feature-flags, profile,
tactic-drill, mcp, board-recognition
```

KnowledgeModule (`apps/api/src/knowledge/`) — собран, но отключён от
bootstrap'а (см. §1.1, namely `app.module.ts:48` комментарий).

**Сервисы под `apps/`:**

```
api, archive-importer, archive-service, broadcast-service,
broadcast-worker, e2e, game-service, matchmaker,
synthetic-bot-service, tactic-worker, web
```

---

## 2. Таблица расхождений каталога с реальным состоянием

| Запись каталога | Статус | Проблема / факт | Действие |
|---|---|---|---|
| **home** | ✅ ОК | — | оставить |
| **play** | ✅ ОК | — | оставить |
| **active-game** | ✅ ОК | — | оставить |
| **games-live** | ✅ ОК | — | оставить |
| **puzzles** | ⚠ устарел частично | summary: «Tactical puzzles ... Glicko-2 puzzle rating and streak». Не упоминает, что новый поток пазлов (после ADR-068/069/070) включает два жанра — «realize the advantage» и «hold the draw» — на разных позициях; на `/puzzles` лежит legacy lichess-набор, новые WDL-пазлы — на `/precision`. Описание формально не врёт, но юзер из summary не понимает, что есть выбор раздела. | Уточнить, что `/puzzles` = lichess-rated классические тактические пазлы (Glicko-2 рейтинг). Без раскрытия Glicko как «алгоритм» — это поведение, не tech. ADR refs можно дополнить ADR-044 (если упоминаем); ADR-068/069/070 — НЕ упоминать здесь, потому что они про precision-gen. |
| **puzzle-rush** | ✅ ОК | — | оставить |
| **precision** | ❌ устарел существенно | summary: «Training that measures move accuracy in **centipawn loss** against engine evaluation on user-uploaded positions or the user's own games». После ADR-065 (5-star grading) и ADR-066 (move classification) метрика — **WDL-loss**, не cp-loss. После ADR-068/069/070 на `/precision` лежат генерируемые puzzle-vs-engine задачи двух жанров: «convert the advantage» (`convertAdvantage`) и «hold the draw» (`saveEquality`); может быть **превентивная** фаза (ход в позиции, где solver сам ещё не зевнул) и **реактивная** (наказать чужой зевок). ADR refs пропускают ADR-065/066/068/069/070. | Полностью переписать summary: 5-star оценка по WDL-loss; явно упомянуть пару жанров и две фазы пазла. Обновить `adr: ['ADR-047','ADR-048','ADR-055','ADR-056','ADR-057','ADR-065','ADR-066','ADR-068','ADR-069','ADR-070']`. |
| **mistakes** | ✅ ОК | — | оставить |
| **analysis** | ❌ два расхождения | (1) summary: «powered by **Stockfish 18 running locally in the browser (WebAssembly)**» — это раскрытие tech-stack, прямое противоречие с `STATIC_FOOTER` («NEVER reveal technical details: tech stack, frameworks, libraries»). Внутренняя несогласованность инструкций ассистенту. (2) На `/analysis` доступна **загрузка картинки доски → FEN** через `SetPositionModal` (компонент `BoardImageDropzone`, backend `POST /api/board-recognition`, ADR-040, KS-2363/KS-3071). Не упомянуто. | Переписать без tech-stack: «Analysis board for arbitrary positions or PGNs, with engine evaluation, variations, NAG annotations, and optional image-to-FEN to set a position from a board photo or screenshot.» ADR refs дополнить ADR-040. |
| **workshop** | ✅ ОК | — | оставить |
| **drills** | ✅ ОК | — | оставить |
| **lessons** | ✅ ОК | После ADR-067 модуль Studies удалён; в lessons.ts паттернов из Studies нет, ничего убирать не нужно. Файлы каталога `studies.ts` и `gamebook-reader.ts` уже удалены (ADR-067 §S1). | проверка пройдена |
| **tournaments** | ✅ ОК | — | оставить |
| **broadcasts** | ✅ ОК | — | оставить |
| **players** | ✅ ОК | — | оставить |
| **friends** | ✅ ОК | — | оставить |
| **messages** | ✅ ОК | — | оставить |
| **profile** | ✅ ОК | — | оставить |
| **settings** | ✅ ОК | — | оставить |
| **feedback** | ✅ ОК | — | оставить |
| **archive** | ⚠ неполный | На `/archive` доступен **«поиск по позиции»** через `SetPositionModal` (KS-3082) — встроен тот же компонент `BoardImageDropzone` для загрузки картинки. Не упомянуто. | Дополнить summary: «with filters by player, opening, **and search by position** (paste a FEN or upload a board image)». |
| **train-lobby** | ✅ ОК | — | оставить |
| **analyze-lobby** | ✅ ОК | После ADR-067 пункт «studies» убран из текста (проверил — слово отсутствует). | оставить |
| **docs** | ✅ ОК | — | оставить |
| **ai-chat** | ✅ ОК | `paths: []` (нет route, это виджет) — корректно. | оставить |

### 2.1 Отсутствующие записи

| Фича | Существует? | Что добавить |
|---|---|---|
| **Board recognition (image → FEN)** | Да: `apps/api/src/board-recognition/*` (контроллер `POST /api/board-recognition` под `JwtAuthGuard`, multipart до 8 MB), `packages/board-image-to-fen` (модель + универсальный recognizer, ADR-040, ADR-040-v2), frontend `apps/web/src/components/BoardImageDropzone.tsx` встроен в `apps/web/src/components/SetPositionModal.tsx` (вкладка «Image»). Используется в `/analysis` и `/archive` (поиск по позиции). На проде работает в **disabled-режиме** (mock + warning), пока devops не выставит ENV `BOARD_RECOG_MODEL_VERSION` (ADR-040 §5.1, см. `app.module.ts:104-107`). | **Отдельная запись каталога с `paths: []`** (паттерн как у `ai-chat`). Title: «Board recognition (image → FEN)». Summary (≤200 симв.): «Cross-cutting capability that converts a board photo or screenshot to a FEN string; surfaces inside Analysis and Archive position search.» `auth: 'user'` (контроллер под JwtAuthGuard), `featureFlag: null`, `mcpSection: null` (модуль не объявляет `@McpModule`), `adr: ['ADR-040']`. |
| Lichess Board API integration (ADR-064) | **НЕТ**: ADR-064 в статусе `предложен (KS-2971)`. В коде нет ни `/lichess/play` маршрута, ни OAuth-флоу, ни Board API стрима. | **Не добавлять.** ADR proposed, реализации нет. |

### 2.2 Устаревшее (что должно отсутствовать — проверено)

- `studies.ts` / `gamebook-reader.ts` в `packages/shared/src/features-catalog/` — **удалены** (ADR-067).
- Записей в `FEATURES` array о studies/gamebook-reader **нет**.
- В `analyze-lobby.summary` слово `studies` **отсутствует** (после ADR-067 §S1).
- В `STATIC_HEADER`/`STATIC_FOOTER` — никаких упоминаний Studies.

### 2.3 Тонкое расхождение — `analysis.summary` vs `STATIC_FOOTER`

Файл `analysis.ts` хранит:
> «powered by Stockfish 18 running locally in the browser (WebAssembly)»

`STATIC_FOOTER` (system-prompt.ts:47):
> «NEVER reveal technical details about the application: tech stack,
> frameworks, libraries, databases, API structure, internal
> architecture, server infrastructure. If a user asks about how the
> site is built — respond: "I can only help with using the site features."»

Это **внутреннее противоречие** инструкций модели: каталог
содержит технологические маркеры (Stockfish, WebAssembly), а footer
велит их не упоминать. Модель в этом случае либо нарушит footer (если
зацитирует summary), либо проигнорирует summary (нерациональное
использование контекста). Лечится тем же тикетом (правка `analysis.ts`).

### 2.4 Knowledge-tools

`apps/api/src/knowledge/` (search/read через ripgrep с allowlist'ом
`pages/components/hooks/context/layouts/locales/shared/docs/READMEs`).
**Отключён в `app.module.ts:48`** по политике приватности (см.
комментарий там же). На прод-ассистенте инструментов
`knowledge.search` / `knowledge.read` нет.

Это **намеренное** решение, не баг. Фиксирую как информационный
пункт — задачи на «вернуть KnowledgeModule» в этом ADR **нет** (тема
для отдельного обсуждения с пользователем).

---

## 3. План правок

### 3.1 Содержание правок в каталоге

**S1: правки `packages/shared/src/features-catalog/`** (отдельный
тикет, исполнитель — backend, потому что shared собирается под
backend и есть CI-проверки).

1. **`precision.ts`** — новый summary (примерный текст):
   ```
   '5-star training on engine-generated puzzles in two genres
   (realize the advantage / hold the draw), measuring WDL-loss vs
   the engine on each user move; tracks per-attempt stars and history.'
   ```
   ADR: `['ADR-047','ADR-048','ADR-055','ADR-056','ADR-057',
   'ADR-065','ADR-066','ADR-068','ADR-069','ADR-070']`.

2. **`analysis.ts`** — новый summary (без tech-stack):
   ```
   'Analysis board for arbitrary positions or PGNs with engine
   evaluation, variations, NAG annotations, and optional image-to-FEN
   to set a position from a board photo or screenshot.'
   ```
   ADR: `['ADR-040']` (опц., раньше не было — для трассировки image-to-FEN).

3. **`archive.ts`** — дополнить summary:
   ```
   'Searchable archive of professional/master-level tournament games
   imported weekly from TWIC, with filters by player and opening and
   a position search (paste a FEN or upload a board image).'
   ```

4. **`puzzles.ts`** — лёгкое уточнение, разделить от precision:
   ```
   'Classic tactical puzzles set sourced from Lichess; solving updates
   a per-user puzzle rating (Glicko-2) and a streak. The newer
   engine-generated training lives separately on /precision.'
   ```

5. **Новый файл `packages/shared/src/features-catalog/board-recognition.ts`**:
   ```ts
   import type { AssistantFeature } from './types.js';

   export const boardRecognition: AssistantFeature = {
     id: 'board-recognition',
     title: 'Board recognition (image → FEN)',
     paths: [],
     summary:
       'Cross-cutting capability that converts a board photo or screenshot to a FEN string; available inside Analysis and Archive position search.',
     auth: 'user',
     featureFlag: null,
     adr: ['ADR-040'],
     mcpSection: null,
   };
   ```
   Импортировать в `index.ts` и добавить в `FEATURES` (порядок — после
   `archive` или рядом с `ai-chat`, поскольку обе записи без route).

6. **`index.ts`** — добавить импорт `boardRecognition` и поместить в
   `FEATURES` array. Зафиксированный порядок (ADR-062 §7) сохраняется
   для всех существующих записей; новая идёт **в конец** массива
   (после `ai-chat`), чтобы не сдвигать существующий diff.

7. **i18n / документация** — не требуется. Каталог только под
   ассистент-промт (английский).

### 3.2 STATIC_HEADER / STATIC_FOOTER

**Не трогаем.** Запрет на tech-stack корректен; вопрос решается
правкой `analysis.summary` (S1 §3.1.2). После правки противоречия не
будет — ассистент сможет цитировать каталог без нарушения footer'а.

### 3.3 Сторонняя находка — `/lobby` legacy

В `App.tsx:343` маршрут `/lobby` → `LobbyPage` остаётся, но в каталоге
не упомянут. Это сознательное оставление (после ADR-058 §4.4
`/lobby` — устаревший alias, авторизованных уносит на `/play` через
`HomePage`). Каталог корректно не описывает `/lobby` — ассистент не
должен направлять на него. Действий не требуется; CI-чек path-diff
этот пробел знает (whitelist).

### 3.4 KnowledgeModule

Не возвращаем в bootstrap в рамках этого ADR. Если/когда вернётся —
отдельный ADR с разрешением конфликта с STATIC_FOOTER (например,
ограничение allowlist'а только `docs/` без `apps/web/src` и
`packages/shared`).

---

## 4. Тикеты

| Ключ | Кто | Summary |
|---|---|---|
| **A1** | architect | ADR-071 (этот документ + таблица расхождений). **Выполнено этим коммитом.** |
| **S1** | backend | Правки `packages/shared/src/features-catalog/`: обновить `precision.ts` / `analysis.ts` / `archive.ts` / `puzzles.ts` summary + ADR refs; создать `board-recognition.ts`; добавить в `index.ts`. `npm run build` shared. CI-чек `tools/check-features-catalog.mjs` должен пройти (новый id `board-recognition` с `paths:[]` в whitelist, как `ai-chat`; других routes не добавляется). Тест `apps/api/src/ai-chat/system-prompt.spec.ts` обновить ожидания (если есть массив `expectedIds`/`expectedTitles`). |

**Опциональные (не в acceptance):**

| Ключ | Кто | Summary |
|---|---|---|
| O1 (опц.) | backend | Re-enable `KnowledgeModule` со урезанным allowlist'ом (только `docs/` + `apps/api/src/board-recognition/dto`), снимет противоречие с `STATIC_FOOTER`. Требует отдельного ADR — здесь только фиксация идеи. |

### 4.1 Зависимости

```
A1 (architect)   ──► merge сразу (этот коммит)
                       │
S1 (backend)     ──► merge после ревью таблицы расхождений
```

Только два тикета (A1 + S1) — достаточно для acceptance этого ADR
по запросу пользователя. KnowledgeModule re-enable — отдельный
разговор.

---

## 5. Acceptance ADR-071

- [x] Этот документ создан в `docs/adr/071-knowledge-base-sync.md`.
- [x] Аудит каталога по всем 25 записям + поиск отсутствующих
  фич выполнен (§2). Найдены ровно 4 устаревших/неполных
  (`precision`, `analysis`, `archive`, `puzzles`) и 1 отсутствующая
  (`board-recognition`). Studies записи отсутствуют (как ожидалось).
- [x] Зафиксировано внутреннее противоречие `analysis.summary` vs
  `STATIC_FOOTER` (§2.3), лечится той же правкой S1.
- [x] Зафиксировано, что KnowledgeModule отключён в bootstrap (§1.1, §2.4).
- [ ] Тикет S1 заведён координатором по списку §4 (architect код не правит).
