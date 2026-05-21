# ADR-072. Шаг урока «Партия» — read-only просмотрщик с переиспользованием анализатора

Статус: предложен (2026-05-21)
Связано: KS-3178 (этот ADR), ADR-024 (Lessons), ADR-026 (User Courses),
ADR-049 (Feature parity user-courses), ADR-051 §3 (публичные анализы),
ADR-054 (Merge user-courses в системные модели).

## 1. Контекст

Автор курса хочет вставлять в урок партию для разбора студентом. Источник
партии — либо вставленный PGN, либо ссылка на свой сохранённый анализ из
мастерской (`/analysis/public/:id`). Студенту — read-only-просмотр с
теми же возможностями, что и публичная страница анализа: дерево
вариантов, движок Stockfish, opening explorer, аннотации, навигация по
ходам.

Что уже есть в проекте:

- `LessonStep.type` — строковый дискриминатор, текущий whitelist: `text`,
  `puzzle`, `quiz`, `position`, `game_review`, `video`, `endgame_drill`,
  `opening_drill` (см. `packages/shared/src/types/lessons.ts` и
  `apps/api/src/lessons/admin/lessons-admin-steps.controller.ts`).
- `UserStepType` (whitelist для пользовательских курсов после
  ADR-049/054): `text | puzzle | endgame_drill | quiz`.
- Тип `game_review` зарезервирован как заглушка под будущий «разбор своей
  партии» (с авто-классификацией ходов движком — отдельная фича). Его
  payload — `{ gameId?: string; pgn?: string }`, без шаринга и без
  логики ссылок на сохранённые анализы.
- Модель `Analysis` (`packages/db/prisma/schema.prisma`, строки 509–549)
  — сохранённые анализы пользователя: `pgn`, `title`, `headline`,
  `boardOrientation`, метаданные партии (`white/black/event/result/…`),
  флаг `isPublic` (KS-2600/ADR-051 §3) и endpoint
  `GET /analyses/public/:id` для read-only-доступа третьим лицам.
- Просмотрщик `apps/web/src/pages/AnalysisPage.tsx` — большой компонент,
  у него уже есть prop `publicMode` (см. `App.tsx:557`). В режиме
  `publicMode=true` отключены autosave, edit title и share, но
  компонент по-прежнему завязан на загрузку анализа по `:id` из
  публичного эндпоинта. Структурно делится на:
  `AnalysisHeader / AnalysisBoard / AnalysisSidebar` + контекст
  `AnalysisContext` (discriminated union `kind: 'review' | 'analysis' |
  'puzzle'`) + локальные хуки persistence-резолвера.

После ADR-054 (Phase A/B) `Course / Lesson / LessonStep` — единые
таблицы для системных и пользовательских курсов; различение — по
`ownerId` (NULL = системный). Поэтому новый тип шага достаточно
зарегистрировать один раз; для пользовательских курсов отдельно
расширить только API-whitelist `UserStepType`.

## 2. Решение

### 2.1 Новый тип шага `game` (рядом с `game_review`)

Добавляем НОВЫЙ тип `'game'` в `LessonStepType` — отдельно от
зарезервированного `'game_review'`. Причины разделения:

- Семантика разная: `game_review` — это разбор СВОЕЙ партии студентом
  с авто-классификацией ходов (mistake/blunder/best) и рекомендациями;
  `game` — read-only просмотр любой партии (учебный пример, классика,
  собственная анализ-сессия автора), без авто-разбора.
- Payload разный: `game_review` опирается на `gameId` (наша партия в
  БД); `game` — на PGN-снапшот или ссылку на сохранённый анализ.
- Прогресс разный: для `game_review` критерий — пройти разбор; для
  `game` — отметка «разобрал».

Миграция БД не нужна: `LessonStep.type` хранится как `String` без
Postgres-enum'а; добавление 9-го значения в whitelist DTO достаточно.

В UI редактора показываем тип как «Партия» (запрос пользователя
говорит про «Лекция / Задача / Диаграмма / Квиз / Партия»). Маппинг
UI-лейбла на технический `type='game'` — фронтовая константа.

### 2.2 Snapshot + ref (а не live-link)

Payload шага хранит **снапшот PGN целиком** и **необязательный
analysisId** как ссылку:

```ts
type GameStepSource =
  | { sourceType: 'pgn' }
  | { sourceType: 'workshop_analysis'; analysisId: string };

interface GameStepPayload {
  type: 'game';
  source: GameStepSource;
  /** Снапшот PGN на момент создания/обновления шага. Лимит — 200 KB. */
  pgn: string;
  /** Метаданные снапшота (для заголовка / sidebar). Опционально. */
  meta?: {
    title?: string;        // из Analysis.title или из PGN-headers
    headline?: string;     // короткая подпись «Каспаров — Карпов 1985»
    white?: string;
    black?: string;
    result?: string;
    event?: string;
    opening?: string;
  };
  /** Ориентация доски по умолчанию (default — белые снизу). */
  boardOrientation?: 'white' | 'black';
}
```

Почему snapshot, а не live-link к `Analysis`:

1. **Иммутабельность контента курса**. Студент не должен видеть «партия
   недоступна», если автор удалил анализ или переписал его до неузнаваемости.
2. **Снимаются авторизационные вопросы**. Автор может вложить в
   публичный курс и приватный по `Analysis.isPublic` анализ — это
   осознанное действие при выборе источника; дальше PGN живёт уже
   в payload шага и не зависит от `isPublic` исходника.
3. **Производительность**. Чтение шага не делает JOIN на `analyses` и
   не страдает от их недоступности (`Analysis` принадлежит другому
   модулю).
4. **Простота отката**. Если что-то пойдёт не так — удаление шага не
   тянет за собой данные другого модуля.

`analysisId` храним только для UX-удобства: кнопка «Открыть в
мастерской» в редакторе и (опционально) в студенческом viewer'е (если
анализ всё ещё `isPublic`).

Минус подхода: нет автоматического обновления. Решается явной кнопкой
«Обновить из мастерской» в редакторе шага (M2, см. §6).

### 2.3 API

Никаких новых endpoint'ов для чтения шага студентом не требуется — он
приходит в составе `LessonWithStepsResponse` (system) или
`UserLessonWithStepsResponse` (user-courses) с уже встроенным payload'ом.

Для редактора шага нужен **листинг сохранённых анализов автора** — он
уже есть: `GET /analyses?limit=20[&category=…]`, `GET /analyses/search?q=`
и `GET /analyses/:id` (`apps/api/src/analysis/analysis.controller.ts`,
`apps/web/src/hooks/useSavedAnalyses.ts`).

Создание/обновление шага: существующие `POST /lessons/admin/lessons/
:lessonId/steps` и `PATCH /lessons/admin/steps/:id` (system),
`POST /api/lessons/user-lessons/:id/steps` и
`PATCH /api/lessons/user-steps/:id` (user). Backend DTO
`GameStepPayloadDto`:

- Принимает либо клиентский снапшот (`pgn` + опц. `meta`), либо
  «лёгкий» payload `{ source: { sourceType: 'workshop_analysis',
  analysisId } }` без PGN — в этом случае сервис при сохранении
  ДОТЯГИВАЕТ `Analysis` по id, проверяет `ownerId === currentUserId`
  (только свои анализы), копирует pgn+meta в payload, и сохраняет
  итоговый «жирный» payload в JSONB. Это снимает с фронта работу по
  копированию PGN.
- Валидирует PGN через `chess.js#loadPgn` (то же место, что
  `OpeningDrillStepPayloadDto` валидирует свой PGN).
- Лимит размера `pgn`: 200 000 символов. UTF-8 в Postgres JSONB
  переживает (один LessonStep — это одна строка, нет коллекций
  payload'ов).

### 2.4 Read-only просмотрщик: embedded режим `AnalysisPage`

Студенческий viewer переиспользует существующий
`apps/web/src/pages/AnalysisPage.tsx`. Меняем props-контракт:

```ts
type AnalysisPageProps =
  | { publicMode?: false }                                  // обычный режим (auth)
  | { publicMode: true }                                    // /analysis/public/:id
  | {
      embedded: true;
      pgn: string;
      meta?: GameStepPayload['meta'];
      boardOrientation?: 'white' | 'black';
    };                                                       // шаг урока
```

В режиме `embedded`:

- Контекст `AnalysisContext` инициализируется типом
  `kind: 'embedded'` (новое значение в discriminated union, рядом с
  `review/analysis/puzzle`).
- Загрузка анализа по `:id` — НЕ выполняется; PGN берётся из props.
- Persistence (`useAnalysisPersistenceResolver`) — no-op: ходы и
  current-позиция студента в payload урока не пишутся (это его личный
  просмотр, прогресс шага — отдельно).
- `AnalysisHeader` — упрощённая версия: заголовок партии из `meta`,
  никаких edit-title / share / autosave-индикаторов.
- `AnalysisBoard` и `AnalysisSidebar` — без изменений. Внутри них —
  доска (`react-chessboard`), дерево вариантов, opening explorer
  (`/openings/...` endpoint), Stockfish-движок (WebWorker, тот же
  shared-хук, что и в обычном анализе), аннотации/комментарии,
  evaluation bar.
- Доска оборачивается дополнительным внешним контейнером, чтобы
  вписаться в shell урока (адаптив — задача L, см. §6).

Рефакторинг минимальный: один файл `AnalysisPage.tsx`, один файл
`AnalysisContext.ts`, опционально упрощённый `AnalysisHeader`
(прокинуть проп `mode='embedded'` и скрыть лишние блоки). Никаких
новых React-Component'ов вроде `<AnalysisViewer>` НЕ заводим — это
было бы дублированием логики ради чистоты, а проект ведётся одним
разработчиком и переиспользуемая поверхность сейчас одна (шаг урока).
Если в будущем понадобится третий embedded-юзкейс — рефакторинг будет
оправдан, до того момента — нет.

### 2.5 UI редактора шага «Партия»

В редакторе шага (`apps/web/src/pages/LessonEditorPage.tsx` для системы
и `apps/web/src/components/lessons/editor/user/UserCourseEditor.tsx`
для user-courses) добавляется компонент `GameStepEditor`:

1. **Радио «Источник»**: «PGN» / «Из моих анализов».
2. **Режим PGN**:
   - `<textarea>` с PGN.
   - Кнопка «Проверить» → парсит chess.js, показывает заголовок партии
     и число ходов, либо ошибку.
   - Опц. поле «Ориентация доски» (white/black).
3. **Режим «Из моих анализов»**:
   - Модалка со списком моих анализов
     (`useSavedAnalyses().getById` + `GET /analyses?limit=20`,
     pagination + search через `/analyses/search`).
   - Превью выбранного: заголовок, дебют, игроки, превью FEN.
   - Кнопка «Открыть в мастерской» → `/analysis/:id` в новой вкладке.
4. **Сохранение**: фронт шлёт `{ source: { sourceType: 'workshop_analysis',
   analysisId } }` без pgn. Бэк сам копирует PGN в payload (см. §2.3).
   Для PGN-режима — `{ source: { sourceType: 'pgn' }, pgn, meta? }`.
5. **«Обновить из мастерской»** (только M2): при `sourceType =
   workshop_analysis` показываем кнопку — она зовёт тот же
   create/update-endpoint с пустым pgn, бэк перечитывает Analysis и
   обновляет снапшот. Если автор больше не владеет анализом или он
   удалён — UI показывает «связь с мастерской потеряна», snapshot
   остаётся прежним.

### 2.6 Прогресс шага

«Партия» — read-only-контент. Критерий завершения — **явная отметка
студента**, симметрично `TextStep` («Прочитал — пометил готово»).

- Кнопка «Я разобрал партию» под доской (рядом с навигацией) проставляет
  `state: 'done'` через существующие endpoint'ы
  `POST /api/lessons/progress/step` (system) или
  `POST /api/lessons/user-progress/lessons/:userLessonId/step` (user).
- `score` не передаётся (это не задача).
- Дополнительно: фронт может автоматически подсвечивать кнопку, когда
  студент дошёл до конца основной линии (UX-нюанс, не влияет на
  бэк-логику).
- В `LessonStepState` ничего не меняем — используются существующие
  `pending | in_progress | done | skipped`.

Альтернативы, отвергнутые:

- *«Открыл — значит сделал»* — обесценивает прогресс, пользователь
  пролистывает урок без вовлечения.
- *«Прошёл всю основную линию»* — нечёткий критерий (студент может
  ходить по вариантам, в любом порядке), требует трекинга навигации.

### 2.7 Объём payload'а — оценка

100-ходовая партия с двумя-тремя уровнями вариантов и комментариями —
~30–80 КБ PGN. Запас по лимиту 200 КБ — достаточен. JSONB-строка
Postgres до ~1 МБ — без проблем. Если в одном уроке окажется 5 шагов
по 200 КБ — это 1 МБ payload'а в `LessonWithStepsResponse`. Решение:
если в практике будут уроки с многими тяжёлыми партиями — выносить шаги
в lazy-load (резолвить payload по требованию). На текущий момент
ADR-053 (reader pagination) уже отдаёт студенту один шаг за раз — нагрузка
естественно ограничена. Лимит на шаг (200 КБ) фиксируем в DTO как
страховку.

## 3. Модель данных — diff

`packages/shared/src/types/lessons.ts`:

```ts
export type LessonStepType =
  | 'text' | 'puzzle' | 'quiz' | 'position'
  | 'game_review' | 'video' | 'endgame_drill'
  | 'opening_drill' | 'drill'
  | 'game';                              // ← новое

export type GameStepSource =             // ← новое
  | { sourceType: 'pgn' }
  | { sourceType: 'workshop_analysis'; analysisId: string };

export interface GameStepPayload {        // ← новое
  type: 'game';
  source: GameStepSource;
  pgn: string;
  meta?: { title?: string; headline?: string; white?: string;
           black?: string; result?: string; event?: string;
           opening?: string };
  boardOrientation?: 'white' | 'black';
}

export type StepPayload = … | GameStepPayload; // расширяем union
export type GameStep = GameStepPayload;        // алиас в стиле остальных
```

`packages/shared/src/types/user-courses.ts`:

```ts
export type UserStepType =
  'text' | 'puzzle' | 'endgame_drill' | 'quiz'
  | 'game';                              // ← новое
```

`LessonStep` Prisma-модель — БЕЗ изменений (тип в БД хранится как
`String`, миграция не требуется).

`Analysis` Prisma-модель — БЕЗ изменений (мы только читаем при
создании/обновлении шага).

## 4. API — diff

Добавления:

- `dto/step-payload.dto.ts` (admin/user) — новый класс
  `GameStepPayloadDto` (class-validator: дискриминатор `source.sourceType`,
  валидация PGN через chess.js, лимит 200 КБ).
- `lessons-admin.service.ts` и `user-lessons.service.ts` — в
  `createStep` / `updateStep`: если `payload.type === 'game'` и
  `payload.source.sourceType === 'workshop_analysis'` без `pgn` —
  загружаем `Analysis` через `AnalysisService.findById`, проверяем
  `ownerId === currentUserId` (только свои; 404 иначе), копируем
  `pgn` + `meta` в итоговый payload.
- `STEP_PAYLOAD_SUBTYPES` (admin DTO) и `ALLOWED_USER_STEP_TYPES`
  (user DTO) — добавить `'game'`.

Существующие endpoint'ы анализа (`/analyses`, `/analyses/search`,
`/analyses/:id`, `/analyses/public/:id`) не трогаем.

## 5. Риски

- **Удаление сохранённого анализа в мастерской после создания шага**.
  Snapshot выживает; ссылка `analysisId` становится «битой» — UI
  «Открыть в мастерской» вернёт 404. Допустимо.
- **Stockfish в embedded-режиме**. Один WebWorker на странице урока, в
  один момент виден один шаг (ADR-053 — pagination); kill на unmount —
  утечки исключены. На малых устройствах WASM-Stockfish тяжёл, но
  компонент уже работает на странице `/analysis/public/:id` — поведение
  идентично.
- **Раздутие payload'а**. Лимит 200 КБ на шаг + ADR-053 одностраничная
  выдача шагов. Дополнительной защиты не требуется.
- **PGN-валидация на бэке**. Должны принимать `chess.js`-парсимые PGN
  без NAG-зависимостей (комментарии в фигурных скобках, варианты в
  скобках). Невалидный PGN — 400 при сохранении шага.
- **Расхождение `game` ↔ `game_review`**. Два близких типа в whitelist
  могут спутать автора курса. Митигация: в UI редактора
  `game_review` НЕ показываем (он — заглушка под фичу, которой пока
  нет), оставляем только `game` с лейблом «Партия». Запись в whitelist
  `game_review` остаётся как заделка под будущий ADR разбора своей
  партии.

## 6. Реализация — порядок задач (S → B → F → L)

Зависимости: B зависит от S; F-editor зависит от S+B; F-runner зависит
только от S; L зависит от F-runner.

См. §7 — конкретные follow-up-задачи с acceptance.

M1 (этот ADR):

1. KS-3179 (S) — типы и whitelist.
2. KS-3180 (B) — DTO/валидация, копирование snapshot из `Analysis`.
3. KS-3181 (F) — редактор шага: PGN + выбор из анализов.
4. KS-3182 (F) — runner: `AnalysisPage` mode='embedded' + кнопка
   «Я разобрал».
5. KS-3183 (L) — вёрстка GameStep в shell'е урока (адаптив).

M2 (отдельно, по запросу):

- Кнопка «Обновить из мастерской» в редакторе (force-refresh snapshot'а).
- Превью FEN текущей позиции в карточке шага списка (UX-улучшение).
- Поддержка PGN-загрузки файлом в редакторе.

## 7. Follow-up задачи

Все — с метками `lessons,analysis` (+ роль).

### KS-3179 (S) — shared types для шага «Партия»

**Assignee:** backend (или architect — формальный owner shared-пакета;
по практике делает backend).
**Labels:** `lessons`, `analysis`.
**Описание:** добавить в `packages/shared/src/types/lessons.ts` тип
`'game'` в `LessonStepType`, интерфейсы `GameStepPayload` и
`GameStepSource`, расширить `StepPayload` union; в
`packages/shared/src/types/user-courses.ts` расширить `UserStepType`
значением `'game'`.
**Acceptance:**
- `LessonStepType` содержит 10 значений (добавлен `'game'`).
- `UserStepType` содержит 5 значений (добавлен `'game'`).
- `StepPayload` — дискриминируется по `type`; `payload.type === 'game'`
  сужает к `GameStepPayload`.
- `GameStepPayload.source` — дискриминированный union по `sourceType`.
- Поле `pgn: string` обязательное; `meta`, `boardOrientation`,
  `analysisId` — опциональные.
- TS-сборка `npm run build` в `packages/shared` — без ошибок.
- Юнит-тест (если такие есть для других payload'ов) на сужение union'а
  по `type` и `sourceType`.

### KS-3180 (B) — backend DTO, валидация, snapshot из мастерской

**Assignee:** backend.
**Labels:** `lessons`, `analysis`.
**Зависит:** KS-3179.
**Описание:** добавить `GameStepPayloadDto` (class-validator) в
admin- и user-DTO шагов; расширить whitelist'ы (`STEP_PAYLOAD_SUBTYPES`,
`ALLOWED_USER_STEP_TYPES`); в сервисах
`LessonsAdminService.createStep/updateStep` и
`UserLessonsService.createStep/updateStep` реализовать поведение:
«если source.sourceType === 'workshop_analysis' и pgn не передан — тянем
`Analysis`, проверяем owner, копируем pgn+meta в payload, сохраняем
жирный payload».
**Acceptance:**
- Создание `LessonStep type='game'` с `source.sourceType='pgn'`,
  валидным PGN, лимитом 200 КБ — 201, payload в БД содержит pgn.
- Создание с `sourceType='workshop_analysis'` без pgn — бэк сам тянет
  Analysis, валидирует ownerId, кладёт snapshot. Возвращает 201 с
  жирным payload.
- Создание `sourceType='workshop_analysis'` с чужим `analysisId` —
  404 (либо 403, по практике сервиса).
- Невалидный PGN (`chess.js#loadPgn` бросает) — 400.
- PGN > 200 000 символов — 400.
- В user-courses (`ownerId IS NOT NULL`) тип `'game'` принимается;
  попытка создать `'video'` или `'opening_drill'` (нет в whitelist) —
  400 как и было.
- Юнит-тесты:
  `lessons-admin.service.spec.ts`,
  `lessons-admin-steps.controller.spec.ts`,
  `user-lessons.service.spec.ts` (или эквивалент).

### KS-3181 (F) — редактор шага «Партия»

**Assignee:** frontend.
**Labels:** `lessons`, `analysis`.
**Зависит:** KS-3179, KS-3180.
**Описание:** добавить компонент `GameStepEditor` в редактор шагов
системных уроков (`LessonEditorPage.tsx`) и пользовательских курсов
(`UserCourseEditor.tsx`). UI:
- Радио «Источник»: PGN / Из моих анализов.
- PGN-режим: textarea + кнопка «Проверить» (`chess.js` валидация на
  клиенте, заголовок и число ходов в превью).
- Workshop-режим: модалка с моими анализами (`useSavedAnalyses` —
  список + поиск). Превью выбранного анализа: заголовок, игроки,
  дебют, FEN-превью. Кнопка «Открыть в мастерской» (`/analysis/:id` в
  новой вкладке).
- Опциональное поле «Ориентация» (white/black).
- Сохранение: для PGN — `{ source: {sourceType:'pgn'}, pgn, meta? }`;
  для workshop — `{ source: {sourceType:'workshop_analysis', analysisId} }`
  без pgn (бэк дотянет).
**Acceptance:**
- В выпадушке типов шага появляется «Партия» (i18n-ключ
  `lesson.stepTypes.game`).
- Можно вставить PGN и сохранить шаг. Валидный PGN сохраняется,
  невалидный — UI показывает ошибку.
- Можно выбрать из своих сохранённых анализов; после сохранения
  карточка шага показывает заголовок партии.
- Тесты `LessonEditorPage.test.tsx` / `UserCourseEditor.test.tsx` —
  smoke на «выбран тип game, шаг сохранён». Mock API.

### KS-3182 (F) — runner: embedded-режим AnalysisPage + кнопка «Я разобрал»

**Assignee:** frontend.
**Labels:** `lessons`, `analysis`.
**Зависит:** KS-3179.
**Описание:** расширить `AnalysisPage` props новым режимом
`embedded` (см. §2.4). Добавить значение `'embedded'` в discriminated
union `AnalysisContext.kind`. В `useAnalysisPersistenceResolver` —
no-op для embedded. Компонент `AnalysisHeader` — режим `embedded`
прячет edit-title, share, autosave-индикаторы. В runner'е урока
добавить `GameStepRunner` (рядом с `TextStep`/`PuzzleStep`/…), который
рендерит `AnalysisPage embedded pgn={…} meta={…}` и кнопку «Я
разобрал партию» (ставит `state='done'` через существующий
progress-endpoint).
**Acceptance:**
- На шаге типа `'game'` в уроке студент видит доску, дерево вариантов,
  движок и opening explorer (как на `/analysis/public/:id`).
- Никаких кнопок share / edit-title / autosave-индикатора.
- Кнопка «Я разобрал партию» проставляет состояние `done` —
  `stepsState[stepId] === 'done'` в `UserLessonProgress`.
- Stockfish-worker не утекает (kill на unmount шага).
- Тесты: `LessonPage.test.tsx` (рендер шага game), smoke на
  embedded-режим AnalysisPage.

### KS-3183 (L) — вёрстка GameStep в shell'е урока

**Assignee:** layout.
**Labels:** `lessons`, `analysis`.
**Зависит:** KS-3182.
**Описание:** причесать вёрстку embedded-просмотрщика внутри shell'а
урока. Десктоп: доска и сайдбар в две колонки, помещаются в высоту
окна без двойных скроллов. Мобильный: доска сверху, сайдбар табами
(варианты / движок / opening). Без переопределения цветов и тем —
только сетка и адаптив.
**Acceptance:**
- На десктопе (≥ 1024px) — две колонки, доска и сайдбар не выходят за
  viewport.
- На мобильном (< 768px) — доска сверху, сайдбар табами под ней,
  единый вертикальный скролл (нет вложенного).
- Кнопка «Я разобрал партию» видна без скролла, либо sticky внизу
  shell'а.
- Высота доски не «прыгает» при переключении между шагом game и
  другими типами в одном уроке.

## 8. Что НЕ входит в этот ADR

- Импорт PGN-файлом в редакторе (M2).
- Авто-классификация ходов (`game_review` — отдельная фича, отдельный
  ADR).
- Live-link к мастерской (отвергнуто, см. §2.2). При необходимости —
  отдельный ADR.
- Совместное редактирование/комментарии студентов в шаге партии.

## 9. Откат

- Удалить значение `'game'` из whitelist'ов DTO и фронт-UI.
- Существующие записи `LessonStep type='game'` останутся в БД с
  payload'ом `pgn` + `meta` — данные не потеряются, но не будут
  рендериться. Можно одной миграцией пометить такие шаги
  `disabled`/удалить.
- БД-миграция для отката не требуется (тип хранится как String).
