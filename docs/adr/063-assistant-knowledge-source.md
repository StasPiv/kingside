# ADR-063. Автоматический источник знаний для AI-ассистента: hybrid catalog + knowledge-tools

Статус: предложен (KS-2965).
Дата: 2026-05-13.
Связано: ADR-061 (MCP API auto-discovery), ADR-062 (features-catalog), KS-2961 (история «ассистент не знает фичи»), KS-2964 (ручная ревизия 27 записей).

## 1. Контекст

ADR-062 / KS-2962 ввёл `packages/shared/src/features-catalog/` (27 записей) и рендер `Site pages and features` в system-prompt из этого каталога. Покрытие путей контролируется CI-чеком `tools/check-features-catalog.mjs` (path-diff `App.tsx` ↔ `paths[]`).

Через неделю в проде выяснилось: **CI-чек гарантирует только наличие записи, не достоверность её контента.** KS-2964 (ручная ревизия архитектора, см. комментарий #9183) показала, что из 27 записей:

- 5 содержат прямые ложные факты (Archive импортирует «Chess.com / Lichess» вместо TWIC; mistakes-источников два, не один; alternative-within-50cp — выдумка; archive.mcpSection — несуществующая секция и т. п.).
- 10 записей содержат расхождения по `mcpSection` (несуществующие или ошибочно `null`).
- 4 записи врут в highlights (отсутствует часть time-controls, sound в settings, etc.).
- 5 записей корректны частично (semantic mismatches по auth/featureFlag, info-замечания).
- 14 записей корректны.

Цикл, который не масштабируется:

```
backend заполняет catalog по интуиции
  → пользователь ловит ложь в ответе ассистента
  → architect сверяет (KS-2964: ~3 часа на 27 записей)
  → backend применяет patch
  → следующий релиз: новая фича / отрефакторили старую — patch устаревает
  → goto step 1
```

Цитата пользователя из задачи: «Мы не можем добавлять знания ему по моим запросам? Это ничем не отличается от ручного наполнения. Почему он не знает функции сайта? Мы не можем ему их дать или позволить искать?»

Корень проблемы: **поля `summary`, `highlights`, `caveats` каталога — это произвольный текст, не привязанный к коду фичи.** TypeScript-типизация не помогает: `summary: string` не проверяет, что строка соответствует тому, что страница реально делает. Path-diff не помогает: страница может существовать, а описание — врать.

## 2. Цель

Минимизировать **ручное наполнение** контента, не теряя три гарантии текущего решения:

1. **Pre-merge gate** — нельзя влить страницу, о которой ассистент ничего не услышит.
2. **Hallucination cap** — модель не должна выдумывать URL (она строго ходит по разрешённому списку).
3. **Feature-flag awareness** — ассистент знает, какие фичи скрыты от текущего пользователя.

И добавить:

4. **Knowledge depth on demand** — на детальные вопросы («как импортируются партии в архив?», «какие фильтры есть в /workshop?») ассистент достаёт ответ из кода / документации, а не из заранее написанного резюме.
5. **Adaptivity** — добавление новой фичи / рефакторинг существующей не требует ручного редактирования каталога ради того, чтобы ассистент перестал врать.

Не входит:

- Замена `@McpModule.description` / `@McpTool.description` (ADR-061 — отдельный slot, описания API-секций для tool-call'ов, см. §10.2 ниже).
- Многоязычность ассистента.
- Goal-driven навигация (предложить пользователю следующий шаг тренировки и т. п. — отдельная задача).

## 3. Решение (краткое)

Принимаем **гибрид C+A с фазами**:

1. **Phase 1 (slim catalog).** `FEATURES` урезается до того, что верифицируется автоматически по фактам кода: `id`, `title`, `paths`, `auth`, `featureFlag`, `mcpSection`, плюс **один предложение** `summary` (1 строка, не редактируется в отрыве от изменения роута). `highlights`/`caveats` **удаляются как поля каталога**. CI-чек path-diff остаётся.
2. **Phase 2 (knowledge-tools).** Новый модуль `apps/api/src/knowledge/` с двумя ручками (`search` и `read`), помеченный `@McpModule({section:'knowledge'})` (ADR-061). Whitelist путей: `apps/web/src/pages/**`, `apps/web/src/components/**`, `apps/web/src/hooks/**`, `apps/web/src/context/**`, `docs/**/*.md`, `apps/*/README.md`, `packages/shared/src/**`, фронтовая `apps/web/public/locales/**` (i18n-ключи = тексты, видимые пользователю). Чёрный список (см. §6.3) явно исключает auth/admin/secrets. Ассистент получает MCP-тулы `kingside__knowledge__search` и `kingside__knowledge__read`, через них «ходит» в репозиторий по требованию.
3. **Phase 3 (опциональный RAG).** Если оффлайн-eval (см. §9) покажет, что keyword-search не покрывает класс семантических вопросов («какие тренажёры лучше всего подходят новичку») — индексировать `docs/adr`, `README.md` и i18n через embeddings (pgvector в Postgres-master или Postgres-archive — обсудимо отдельно) и подмешивать топ-N в system-prompt. До эксперимента не делаем.

ADR-062 остаётся в силе как **базовый контракт «UI = paths»**: каталог не выкидываем, мы просто переносим контент с полей `highlights/caveats` на runtime-извлечение через tools.

## 4. Сравнение вариантов

Полная матрица. Шкалы — порядковые (низко/средне/высоко), для трёх метрик добавлены ориентиры конкретных значений.

|  | **A. Codegen из JSDoc** | **B. RAG-индекс** | **C. MCP knowledge-tools** | **C+A гибрид (выбран)** |
|---|---|---|---|---|
| Ручная работа на новую фичу | средне (JSDoc на page-компонент) | низко (написал код — попало в индекс) | низко-средне (только slim запись в FEATURES + сам код) | низко-средне |
| Adaptivity (рефактор без правок каталога) | средне (JSDoc нужно держать актуальным как и текст) | высоко | высоко | высоко |
| Точность фактов | средне (JSDoc может быть таким же выдуманным) | средне (зависит от качества чанков + retrieval) | высоко (модель видит реальный код, цитирует строку) | высоко |
| Latency / turn | +0 ms (статичный prompt) | **+150-400 ms** (1 embedding + vector query) | **+800-2500 ms** (1-3 round-trip tool-call к Anthropic) | +0 ms baseline; +tool-cost когда модель решает искать |
| Доп. cost / 1k turns ассистента | +0 | **+~30¢** (embedding+storage) | **+5-15$** (доп. input/output токены при tool-loop) | +tool-cost только когда нужно |
| Pre-merge gate | да (path-diff остаётся; если catalog становится generated artifact — gate тоже) | нет (RAG ловит drift через retrieval-качество, не блокирует merge) | нет (tools видны независимо от добавления фичи) | **да** (CI-чек path-diff из ADR-062 сохраняется) |
| Защита от halluc. URL | да (FEATURES — whitelist) | средне (URL в чанках кода) | да (FEATURES + ограничение «only catalog URLs» в системном промте остаётся) | **да** |
| Покрытие невидимых-в-UI фич (cron/importers/admin-tooling) | низко (нет JSX → нечего парсить) | высоко (всё индексируется) | высоко (search ходит по `apps/*/src/`) | высоко (через tools) |
| Защита от утечки секретов | n/a (catalog — публичный текст) | средне (нужны фильтры по чанкам, embedding-индекс уже содержит код) | **высоко** (allowlist путей в search/read, см. §6.3) | высоко |
| Сложность инфраструктуры | низкая (один скрипт) | **высокая** (embedding pipeline + vector DB + инвалидация + monitoring retrieval-качества) | средняя (один Nest-модуль, два эндпоинта) | средняя |
| Объём работ MVP (по оценке) | 3-4 дня (парсер + JSDoc-стандарт + переписать pages) | 7-10 дней (embed-pipeline + pgvector + retrieve + system-prompt-mix + invalidation) | 2-3 дня (модуль с двумя эндпоинтами через grep/read + декораторы) | **2-3 дня Phase 2** (Phase 1 — час, Phase 3 — отложен) |
| Совместимость с ADR-061 | ортогональна | требует отдельной инфры | прямая (новый @McpModule, попадает в /_mcp/tools автоматически) | прямая |
| Зависит ли качество от дисциплины разработчика | да (JSDoc) | средне (комментарии в коде) | низко (модель читает само определение функции / JSX-разметку) | низко |

Краткое отбрасывание:

- **A в одиночку.** JSDoc — тот же ручной текст, только в другом месте. KS-2964 показала: backend пишет описания «по интуиции» — JSDoc будут писаться так же. Преимущество A только в том, что один и тот же файл редактируется при изменении фичи (co-location). На практике PR-ревью смотрит на функциональность кода, не на текст JSDoc. **Не решает корневую проблему.**
- **B в одиночку.** Дорогостоящая инфра ради одной задачи. Vector DB / embeddings pipeline / стратегия инвалидации / мониторинг retrieval-качества — это месяц работы для команды из одного бекендера. Польза неочевидна, пока не доказано на практике, что keyword-search не справляется. **Преждевременная оптимизация.**
- **C в одиночку (без FEATURES).** Теряется pre-merge gate из ADR-062: можно влить фичу, о которой ассистент так и не узнает, пока кто-то вручную не задаст ему вопрос «есть ли такая страница». Также теряется явный allowlist URL — модель будет искать URL по коду, иногда находя dev-роуты или legacy-редиректы. **Слишком большой регресс по гарантиям.**

## 5. Phase 1 — slim catalog (immediate, low-risk)

### 5.1. Что режется

`AssistantFeature.highlights` и `AssistantFeature.caveats` **удаляются как поля каталога**. Это два поля, которые в 100% случаев писались руками и в 60%+ случаев врали (KS-2964: 4 из 4 highlights-расхождений в settings, play, archive, puzzles были несоответствиями реальному коду).

### 5.2. Что остаётся

```ts
export interface AssistantFeature {
  id: string;           // машинный id, неизменный
  title: string;        // короткое название раздела (3-5 слов)
  paths: string[];      // ВСЕ react-router пути; проверяет CI-чек
  summary: string;      // ОДНО предложение (≤200 символов), отвечает на «что это»
  auth: 'user' | 'public' | 'optional';
  featureFlag: FeatureFlagKey | null;
  mcpSection: string | null;
  adr?: string[];       // только для разработчиков
}
```

`summary` — **намеренно один предложение**. Длинные описания → искушение писать про несуществующие фичи. Один предложение модель в состоянии написать правдиво, потому что оно описывает только «что это», без перечисления механик.

Пример (precision):

```ts
// До (KS-2962, 25+ строк, 5 highlights, 2 caveats):
summary: 'Practice precision on user-uploaded positions and on positions from your own games...',
highlights: [
  'Main training screen at {siteUrl}/precision — pick a position pack and play through it move by move',
  'Statistics at {siteUrl}/precision/stats — accuracy %, ACPL, ...',
  ...4 more
],
caveats: ['Requires authentication', 'Engine evaluation runs on the server (Stockfish 18), not in the browser'],

// После (Phase 1):
summary: 'Training mode that measures accuracy of your moves (centipawn loss) against engine evaluation on user positions or your own games.',
```

Детали (ACPL, на каком движке, кэшируется ли результат) — модель достаёт через Phase 2 tools, если пользователь спросит.

### 5.3. Кода ADR-062 это не отменяет

ADR-062 формулирует:
- источник правды — TS-массив `FEATURES` в `packages/shared` (остаётся);
- костяк промта остаётся ручным (`STATIC_HEADER`/`STATIC_FOOTER`) — остаётся;
- CI-чек path-diff — остаётся;
- feature-flag-awareness через `FeatureFlagsSnapshot` — остаётся;
- структура «отдельный файл на фичу в `features-catalog/`» — остаётся.

Меняется только **схема записи и render-функция**. `renderFeature` упрощается до `### {title} ({urls}) — {summary} [+availability-блок если флаг]`. Никаких bullet'ов, никаких caveats.

### 5.4. Тест-набор

- Тест `summary.length <= 200` для каждой записи.
- Тест «summary заканчивается точкой».
- Тест «summary не содержит шаблонную подстановку `{siteUrl}` или прямой URL» (URL'ы — только в `paths`).
- CI-чек path-diff из ADR-062 §8 — без изменений.

### 5.5. Side-effect: ADR-062 §7 «детектор голых URL»

Тест из ADR-062 §7 (детектор `${siteUrl}/foo` в `STATIC_HEADER`/`STATIC_FOOTER`) **остаётся**. Без `highlights` риск голых URL только снижается.

## 6. Phase 2 — knowledge-tools (через ADR-061 MCP)

### 6.1. Решение

Новый модуль `apps/api/src/knowledge/`:

```ts
// knowledge.module.ts
@McpDiscoveryModule({
  section: 'knowledge',
  title: 'Kingside knowledge base',
  description:
    'Search and read Kingside source code, ADRs, README files, and i18n strings. ' +
    'Use these tools when the user asks specific questions about how a feature works, ' +
    'what fields exist on a page, or where a function lives. Do NOT use for chess analysis — ' +
    'these tools only read the application source, not chess positions.',
  defaultAuth: 'public',  // knowledge — публичный read-only, ниже см. allowlist
})
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
})
export class KnowledgeModule {}
```

Контроллер:

```ts
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly svc: KnowledgeService) {}

  /**
   * Keyword/regex search through the whitelisted parts of the Kingside repo.
   * Use to locate where a feature is implemented or what UI text is shown to users.
   */
  @McpTool({
    description:
      'Search Kingside source for a keyword or short regex. Returns up to 10 matches, ' +
      'each with file path and 5 lines of surrounding context. Use specific queries — ' +
      'broad terms like "user" return noise.',
    defaultLimit: 10,
    maxLimit: 25,
  })
  @Get('search')
  search(@Query() dto: KnowledgeSearchDto): Promise<KnowledgeSearchResult> {
    return this.svc.search(dto);
  }

  /**
   * Read a single file from the whitelisted parts of the repo. Use after `search` to inspect
   * the full implementation of a page, hook, or doc.
   */
  @McpTool({
    description:
      'Read the contents of one allowlisted file. Max 400 lines returned (truncated with marker). ' +
      'Allowed paths: apps/web/src/pages/**, apps/web/src/components/**, apps/web/src/hooks/**, ' +
      'apps/web/src/context/**, packages/shared/src/**, docs/**/*.md, apps/*/README.md, ' +
      'apps/web/public/locales/**.',
    maxLimit: 400,
  })
  @Get('read')
  read(@Query() dto: KnowledgeReadDto): Promise<KnowledgeReadResult> {
    return this.svc.read(dto);
  }
}
```

Через ADR-061 эти ручки автоматически попадают в `/_mcp/tools`, MCP-сервер пользователя (`mcp-kingside.mjs`) видит их как `mcp__kingside__knowledge__search` и `mcp__kingside__knowledge__read` и регистрирует ассистенту. Ноль ручных правок в `mcp-kingside.mjs`.

### 6.2. Реализация поиска — без embeddings

`KnowledgeService.search(dto)`:

1. Резолвим query → ripgrep-compatible regex (через child-process `rg` или nodejs-обёртка вроде `@nodelib/fs.walk` + RegExp).
2. Прогон по allowlist путей с `--max-count=25 --max-filesize=200K`.
3. Для каждого match — 5 строк контекста (`-C 2`), отрезаем по 200 символов на строку.
4. Сериализуем `{ file, line, context, matchedText }`.

Никаких embeddings, никакой векторной БД. На репо нашего размера (~150k LOC, ~100 MB исходников) ripgrep отрабатывает за 50-150ms. Cache не нужен — поиск дешевле, чем round-trip к Anthropic.

`KnowledgeService.read(dto)`:

1. Резолвим `dto.path` к абсолютному пути через `path.resolve`, проверяем что он внутри allowlist'а (см. §6.3).
2. Читаем файл (макс 400 строк), отдаём как `{ path, lines: [...], truncated: boolean }`.

### 6.3. Whitelist / Blacklist

```ts
// apps/api/src/knowledge/knowledge.config.ts

/** Только эти пути доступны для search и read. */
export const KNOWLEDGE_ALLOWLIST: readonly string[] = [
  'apps/web/src/pages/**',
  'apps/web/src/components/**',
  'apps/web/src/hooks/**',
  'apps/web/src/context/**',
  'apps/web/src/layouts/**',
  'apps/web/public/locales/**',           // i18n строки — это пользовательский текст
  'packages/shared/src/**',                // типы, константы, FEATURES
  'docs/adr/*.md',
  'docs/architecture/*.md',
  'apps/*/README.md',                      // user-facing README'ы сервисов
];

/** Явно запрещено, даже если попало в allowlist по wildcard. */
export const KNOWLEDGE_BLOCKLIST: readonly string[] = [
  '**/.env*',
  '**/secrets*',
  '**/auth/**',                            // auth-логика
  '**/admin/**',                           // админка
  '**/*.test.ts',                          // снижение шума в search
  '**/*.spec.ts',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  'apps/api/src/jwt-strategy*',            // защищаем secrets-related код
  'apps/api/src/mcp/mcp-discovery-key.guard*',
];
```

Resolution — после normalize path: блок проверяется первым (защитная зона), allowlist — вторым. Любой путь вне allowlist'а отдаётся как `404 not found` без подсказок о существовании файла (стандартная hide-not-found практика).

### 6.4. DTO с class-validator

```ts
export class KnowledgeSearchDto {
  @IsString() @MinLength(2) @MaxLength(120)
  query!: string;

  /** Опциональный фильтр по подпути, должен быть внутри allowlist. */
  @IsOptional() @IsString() @MaxLength(200)
  path?: string;

  @IsOptional() @IsInt() @Min(1) @Max(25)
  limit?: number;
}

export class KnowledgeReadDto {
  @IsString() @MinLength(3) @MaxLength(300)
  path!: string;

  @IsOptional() @IsInt() @Min(1) @Max(10000)
  fromLine?: number;

  @IsOptional() @IsInt() @Min(1) @Max(400)
  limit?: number;
}
```

JSON Schema для MCP discovery собирается автоматически (ADR-061 §9.1 `class-validator-to-jsonschema`).

### 6.5. Системный промт — корректировка инструкций

В `STATIC_FOOTER` системного промта (`apps/api/src/ai-chat/system-prompt.ts`) добавляются 2 строки:

```
- When the user asks specific questions about how a feature works ("how does X import games?", "what fields are in the workshop?", "what languages are supported?") — call mcp__kingside__knowledge__search before answering. Cite the file path and line number in your response so the user can verify.
- Prefer knowledge_search results over your own assumptions. If search returns nothing relevant — say so, do not invent.
```

`Citation requirement` — это намеренный design choice: модель явно цитирует «по `apps/web/src/pages/SettingsPage.tsx:262` есть линковка Chess.com/Lichess username» — пользователь видит откуда взят факт, и галлюцинации становятся легко детектируемыми.

### 6.6. Latency и cost

При каждом запросе пользователя:

- **Минимум tool-call'ов:** 0. Если вопрос покрыт slim catalog (например «куда зайти, чтобы сыграть с ботом?» → `play.summary` отвечает прямо), модель отвечает без tools — latency как сейчас.
- **Типичный «детальный» вопрос:** 1-2 tool-call'а. Сетевой round-trip + сам Grep ~ 200ms × N + Anthropic-cycle.
- **Worst case:** 3-4 tool-call'а если модель сначала search, потом read, потом search ещё раз. Total +2-3s к latency.

Cost оценка (по Claude 3.5 Sonnet pricing on 2026-05-13):
- Caching включён → system-prompt со slim catalog ≈ 4-6k tokens, кешируется.
- Один tool-call ≈ 500-1500 output tokens (search results JSON) + повторный input.
- Доп. стоимость на запрос с 2 tool-calls ≈ $0.005-0.015.

Это приемлемо для существующих лимитов (`CHAT_RATE_LIMIT_PER_DAY=100`, `CHAT_GLOBAL_DAILY_LIMIT=1000` — см. `chat-assistant.service.ts:41-42`). Worst-case дневной бюджет растёт с условных $3/день до $15/день.

### 6.7. Что НЕ делаем в Phase 2

- НЕ удаляем `summary` из FEATURES. Модель должна получать обзор бесплатно (без tool-call) — это сокращает latency для «лёгких» вопросов.
- НЕ даём ассистенту write-access (никаких `edit_file` / `commit` / `mutation` инструментов). Knowledge-tools — строго read-only.
- НЕ открываем доступ к `apps/api/src/**` целиком — там auth/admin/internal код. Только узкая выборка по allowlist'у.
- НЕ открываем доступ к `tools/` и `scripts/` — это devops-зона, может содержать API-ключи / hostnames.

## 7. Phase 3 — опциональный RAG (условный)

Не делаем сразу. Проводим эксперимент:

### 7.1. Hold-out набор вопросов

Собрать 30 типичных вопросов от пользователя (часть — из реальных конверсаций, часть — придумать). Категории:
- Прямые URL-вопросы («где играть с ботом?») — slim catalog должен покрыть.
- Детальные feature-вопросы («какие тренажёры есть? что в settings?») — Phase 2 search должен покрыть.
- Семантические («с чего начать новичку?», «что лучше тренировать после 10 партий проиграл подряд?») — гипотеза: ни slim catalog, ни keyword-search не справятся.

### 7.2. Метрика принятия Phase 3

После запуска Phase 2 — ручной eval (architect или назначенный QA):
- accuracy_phase2 = доля корректных ответов на all-30 questions.
- accuracy_semantic = доля корректных на 10 семантических.

Если `accuracy_semantic < 50%` — заводим Phase 3. Иначе закрываем как «не нужно».

### 7.3. Если Phase 3 нужна — устройство

- **Индекс:** pgvector в Postgres-master (новая таблица `assistant_knowledge_embeddings: { source, path, chunk_id, content, embedding vector(1024) }`).
- **Чанкование:** docs/adr/*.md по заголовкам H2/H3, README — по разделам, i18n — по namespace + key.
- **Embedding:** воспользуемся Anthropic embeddings (или Cohere) — оба ≈ $0.10/1M токенов, существенно дешевле LLM-вызова.
- **Invalidation:** cron в `apps/api`, раз в час re-embed только изменённых файлов (mtime-based).
- **Retrieve:** `RagService.search(query, topK=5)` → подмешать в system-prompt как блок `## Relevant context (from knowledge base):` ДО `## Player Context`.
- **A/B-флаг** `assistantRagEnabled` — выкатываем под флагом, чтобы можно было откатить на Phase 2 без redeploy.

## 8. Risk register

| # | Риск | Вероятность | Импакт | Mitigation |
|---|---|---|---|---|
| 1 | Phase 2: модель не использует knowledge-tools, отвечает по slim catalog даже когда нужны детали | средне | средне | Жёсткая инструкция в `STATIC_FOOTER` («ALWAYS call knowledge_search before answering specific feature questions»); offline-eval на стандартных вопросах; адаптация инструкций по результатам |
| 2 | Phase 2: search возвращает шум, модель путается | средне | низко | `maxLimit=25`, query-валидация (минимум 2 символа, максимум 120); инструкция «use specific queries» в @McpTool description |
| 3 | Phase 2: tool-loop latency раздражает пользователя | средне | средне | Streaming SSE уже есть (`streamResponse` в `chat-assistant.service.ts`); UI показывает индикатор «Looking up the knowledge base…»; жёсткий лимит max_tool_use_turns=4 на стороне MCP-сервера (вне scope ADR, отметить пользователю) |
| 4 | Phase 2: утечка кода/секретов через `read` | низко | высокий | Strict allowlist + явный blocklist; абсолютный path-resolve до проверки; e2e-тест «попытка прочитать `.env` возвращает 404»; e2e-тест «попытка прочитать `apps/api/src/auth/jwt-strategy.ts` возвращает 404» |
| 5 | Phase 2: пользователь обнаруживает endpoint `/knowledge/search` (он `auth:'public'`) и использует напрямую для скана репо | низко | низко | Allowlist таков, что отдаёт только то, что уже видно в `https://github.com/<repo>/tree/main/apps/web/src/pages` (open-source страницы UI). Аналог `cat` по публичному коду. Если репозиторий приватный — добавить `auth:'user'` на эндпоинт (изменить `defaultAuth` в @McpDiscoveryModule). См. §8 ниже |
| 6 | Phase 1: slim summary окажется недостаточным для простых вопросов, и модель будет постоянно дёргать knowledge_search | средне | низко | Offline-eval измеряет «tool-call-count distribution» (распределение количества tool-call'ов на запрос); если медиана > 2 — расширить summary до 2 предложений |
| 7 | Phase 2: разработчик добавляет sensitive путь в allowlist по ошибке | низко | средний | `KNOWLEDGE_ALLOWLIST`/`BLOCKLIST` — централизованные константы; unit-тесты «список выглядит так-то»; PR-ревью на изменение этого файла обязателен |
| 8 | Phase 3: pgvector добавляет нагрузку на master-БД | средне (при включении) | средне | Phase 3 опциональна; если включаем — отдельная таблица, отдельные индексы, не блокирует основной workload; мониторинг через существующие Postgres-метрики |
| 9 | Регрессия после Phase 1: пользователи привыкли к «развёрнутым» ответам ассистента, slim-первый-ответ покажется поверхностным | низко | низко | После slim-catalog + knowledge-tools — ответ всё равно может быть длинным, если модель сделала search. Тестируем на hold-out наборе перед раскаткой |
| 10 | Auto-доступ ассистента к репо в open-source режиме раскрывает приватный код | низко (зависит от visibility репо) | потенциально высокий | На момент написания ADR — статус репо приватный. Решение: оставить `defaultAuth: 'public'` для knowledge — но это означает, что любой залогиненный пользователь может через прямой вызов API получить кусок кода. Альтернатива: `defaultAuth: 'user'` — ограничивает доступ зарегистрированным. **Рекомендация:** `defaultAuth: 'user'` для дополнительной защиты. Решение принимает пользователь при реализации, отмечено в follow-up задаче. |

### 8.1. Доступ к knowledge-endpoint'ам

Подходы:

- `auth: 'public'` — любой может GET. Прост, но любой бот может скрапнуть. **Не рекомендую.**
- `auth: 'user'` — нужен Bearer JWT. Естественная защита от ботов. **Рекомендую** для MVP.
- `auth: 'internal'` — только MCP-сервер с `X-Mcp-Knowledge-Key`. Самая защищённая, но усложняет flow (MCP-сервер сам подписывается ключом из env). Можно сделать в Phase 2.1 если auth-user не хватит.

В MVP: `defaultAuth: 'user'` (ассистент работает от JWT пользователя — это уже реализовано через `getResponse` → webhook → MCP-сервер с user JWT, см. `chat-assistant.service.ts:299-302`).

## 9. Метрики качества ответов

Live-метрики (требуют UI-доработок, отмечено в follow-up):

1. **Thumbs up/down** на каждом ответе ассистента → колонка `chat_messages.feedback (+1, -1, null)`. Дневной отчёт «топ-10 минусов» в `apps/api/src/scripts/`.
2. **Latency p50/p90/p99** на одного юзера и общая (метрика `chat_response_time_seconds` Prometheus с label `phase=p1|p2`). Phase 2 не должна ухудшить p50 более чем на 500ms по сравнению с Phase 1.
3. **Tool-call distribution:** для каждого ответа считаем `len(tool_use_events)`. Гистограмма по дням. Медиана > 2 — сигнал расширить slim summary.

Offline-eval (запускается архитектором/QA после каждого major-релиза ассистента):

4. **Стандартный набор 30 вопросов** (см. §7.1). Ручная оценка по шкале `wrong / partial / correct / better-than-baseline`. Целевая accuracy ≥ 80% на Phase 2.
5. **Регрессионный набор «20 ловушек KS-2964»:** список из 20 вопросов специально сконструированных вокруг расхождений, которые поймал KS-2964 («откуда импортируются партии в Archive?», «какие piece sets есть в settings?», «можно ли в puzzles использовать альтернативный ход?»). Ожидание: после Phase 2 — 18+ из 20 правильных ответов (текущая система фейлит 100% этого набора, потому что отвечает по каталогу-с-ошибками).

Артефакт offline-eval — markdown-файл `docs/qa/assistant-eval-<date>.md` (создаётся как часть отдельной задачи QA, не в этом ADR).

## 10. Соотношение с ADR-061 / ADR-062

### 10.1. ADR-061 (MCP API auto-discovery)

ADR-063 **расширяет** ADR-061: добавляется новый `@McpModule({section:'knowledge'})`. Никаких изменений в самом фреймворке discovery — модуль помечается стандартным декоратором, попадает в `/_mcp/tools` через существующий механизм.

ADR-061 §4 таблица сравнения вариантов остаётся в силе. Knowledge-модуль — естественное приложение «opt-in на модуле», именно для того его и проектировали.

### 10.2. ADR-062 (features-catalog)

ADR-063 **меняет схему** ADR-062:

- `AssistantFeature.highlights` и `caveats` **удаляются**.
- `summary` — теперь ограничен ≤200 символами + один предложение (валидируется CI-чеком, см. §5.4).
- Остальная структура (`paths`, `auth`, `featureFlag`, `mcpSection`, CI-чек path-diff) — без изменений.
- `renderFeature` упрощается (см. §5.2).

Storage-локация (`packages/shared/src/features-catalog/`) и принцип «один файл на фичу» — сохраняется.

### 10.3. Конфликта между описаниями нет

| | `AssistantFeature.summary` | `@McpModule({description})` | `@McpTool({description})` |
|---|---|---|---|
| Аудитория | модель-навигатор | модель-tool-caller | модель-tool-caller на конкретной ручке |
| Жанр | «куда направить пользователя» | «когда дёргать API-секцию» | «когда вызвать эту ручку» |
| Длина | ≤200 символов | 1-3 предложения | 1-3 предложения |
| Источник правды | `FEATURES` в `packages/shared` | декоратор на NestJS-модуле | декоратор на handler-методе |

Knowledge-tools — четвёртый, параллельный слой («что есть в коде вообще»). Не дублирует первые три.

## 11. Миграционный план

Реализация — отдельные follow-up задачи.

### 11.1. Этап A (backend, ~1-2 часа)

**KS-XXXX (создать после ADR): Slim features-catalog.**

1. Удалить поля `highlights` и `caveats` из `AssistantFeature` в `packages/shared/src/features-catalog/types.ts`.
2. Удалить эти же поля во всех 27 файлах `packages/shared/src/features-catalog/*.ts`.
3. Сократить `summary` каждой записи до одного предложения ≤200 символов. **Шаблон содержания**: «{что это} (для {какой задачи / целевой аудитории}).» Без перечисления механик, без URL-ов в summary.
4. Обновить `renderFeature` в `apps/api/src/ai-chat/system-prompt.ts`: убрать рендеринг highlights и caveats.
5. Тесты: `summary.length <= 200`, `summary.endsWith('.')`, отсутствие `{siteUrl}` или прямых URL в summary.
6. Тест регрессии: `system-prompt.spec.ts` после миграции должен пройти.

Backend применяет patch одной итерацией, ссылаясь на KS-2964 для контента 27 записей (где написать «один предложение по факту» — KS-2964 даёт правильные тексты).

### 11.2. Этап B (backend, ~2-3 дня)

**KS-XXXX (создать после ADR): Knowledge-tools для AI-ассистента.**

1. Создать `apps/api/src/knowledge/`:
   - `knowledge.module.ts` (@McpDiscoveryModule, defaultAuth='user').
   - `knowledge.service.ts` (search via ripgrep-CLI или js-impl, read via fs.readFile).
   - `knowledge.controller.ts` (GET /knowledge/search, GET /knowledge/read).
   - `knowledge.config.ts` (ALLOWLIST/BLOCKLIST константы).
   - DTO: `KnowledgeSearchDto`, `KnowledgeReadDto`.
2. Подключить модуль в `app.module.ts`.
3. Обновить `STATIC_FOOTER` системного промта (см. §6.5).
4. Тесты:
   - Unit: allowlist/blocklist резолверы (`isPathAllowed(path)` для разных кейсов).
   - Unit: search возвращает корректное количество, обрезает по limit, экранирует regex.
   - Unit: read truncates после 400 строк.
   - E2E (`knowledge.e2e.spec.ts`): попытки прочитать `.env`, `apps/api/src/auth/*` — 404; прочитать `apps/web/src/pages/HomePage.tsx` — OK.
5. Метрика `mcp_tool_calls_total{tool='knowledge__search'}` через существующий Prometheus.

### 11.3. Этап C (architect/QA, ~0.5 дня)

**KS-XXXX (создать после ADR): Offline-eval ассистента после Phase 2.**

1. Создать `docs/qa/assistant-eval-questions.md` с 30 вопросами + ожидаемыми ответами/критериями оценки.
2. Прогнать через ассистент (вручную через UI или скриптом), записать ответы.
3. Зафиксировать accuracy и tool-call-distribution в `docs/qa/assistant-eval-<date>.md`.
4. На основе результатов — решение по Phase 3 (запускать или закрывать).

### 11.4. Этап D (frontend, опционально, ~1-2 дня)

**KS-XXXX (создать после Этапа A): UI thumbs up/down для ответов ассистента.**

1. Добавить колонку `chat_assistant_messages.feedback (Int? -- -1 | null | 1)`.
2. UI в `ChatWidget` / `MessagesPage`: 👍/👎 рядом с ответом ассистента.
3. PATCH `/chat/messages/:id/feedback`.
4. Дневной отчёт «топ-10 минусов» — скрипт в `apps/api/src/scripts/`.

### 11.5. Этап E (условный, Phase 3, ~7-10 дней)

**Создаётся ТОЛЬКО если этап C даст accuracy_semantic < 50%.**

1. pgvector в Postgres-master.
2. Embedding pipeline (cron в apps/api).
3. RagService с retrieve топ-5.
4. A/B-флаг `assistantRagEnabled`.

## 12. Не входит в этот ADR

- Реализация (отдельные follow-up задачи).
- Содержимое 27 slim-summary (контентная часть этапа A — backend по KS-2964).
- Конкретный список 30 вопросов оффлайн-eval (этап C).
- Изменения в `tools/mcp-kingside.mjs` (зона пользователя; в Phase 2 новый @McpModule подхватится автоматически).
- Goal-driven навигация ассистента (предложить следующий шаг тренировки) — отдельная задача.
- Многоязычность ассистента — отдельная задача (текущая EN-only, см. ADR-062 §13).

## 13. Follow-up задачи

Координатор создаёт по этому ADR:

1. **Backend (Этап A) — Slim features-catalog**: удалить highlights/caveats, сократить summary, обновить renderFeature и тесты. Контент summary берётся из KS-2964 (правильные факты уже сведены).
2. **Backend (Этап B) — Knowledge-tools**: модуль `apps/api/src/knowledge/`, @McpDiscoveryModule, allowlist/blocklist, тесты, обновление STATIC_FOOTER.
3. **QA / Architect (Этап C) — Offline-eval**: 30 вопросов, прогон через ассистент после Phase 2, документ с результатами и решением по Phase 3.
4. **Frontend (Этап D, опционально) — UI feedback**: thumbs up/down для ответов ассистента + миграция БД.
5. **Backend (Этап E, условно) — RAG**: только если этап C показал необходимость.

Все задачи независимы кроме E (зависит от C). A и B можно делать параллельно, A — короче и снимает «класс KS-2964 проблем» немедленно.
