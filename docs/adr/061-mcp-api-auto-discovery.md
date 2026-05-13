# ADR-061. Автоматическая регистрация API-эндпоинтов в MCP веб-ассистента

Статус: принят (KS-2951).
Дата: 2026-05-13.
Связано: KS-2948 (закрыта, ручная правка `mcp-kingside.mjs` под лимит `tool_result`).

## 1. Контекст

Веб-ассистент (chat-страница) общается с пользователем через MCP-сервер `tools/mcp-kingside.mjs` (живёт на хосте пользователя, namespace `mcp__kingside__*`, в репозиторий не входит). Сейчас MCP-сервер вручную поддерживает список тулов: для каждой ручки `apps/api` дописывается отдельный обёрточный тул.

Проблемы:

1. Новый эндпоинт в `apps/api` ассистенту не виден, пока кто-то не отредактирует `mcp-kingside.mjs`. Например, после выхода «Тренировки точности» (`/precision/*`) ассистент несколько недель отвечал «не знаю про такой раздел».
2. Ассистент не знает о разделах сайта как таковых — нет даже описания «есть такой раздел, направляй туда вопросы X».
3. Тяжёлые поля в ответах (PGN, FEN-стримы, длинные JSON) ломают token-limit `tool_result` (KS-2948 пришлось закрывать ручным `?withPgn=false` и `limit ≤ 100`).
4. Системные/админские эндпоинты (`AdminController`, `internal/*`, `auth/login`, `chat/*`) не должны утекать ассистенту: либо они опасны (логин, отмена операций), либо бессмысленны (метрики), либо приводят к рекурсии (сам ассистент дёргает себя).

API растёт еженедельно. Ручной opt-in каждого нового эндпоинта в MCP-обёртку — нерабочая модель.

## 2. Цель

`apps/api` должен сам экспортировать машинно-читаемый каталог своих эндпоинтов («что есть, чем управляет, какие параметры, какие лимиты»). MCP-сервер `mcp-kingside.mjs` периодически читает каталог и регистрирует MCP-тулы автоматически.

После добавления нового эндпоинта в уже-помеченный модуль `apps/api`:
- он становится видимым ассистенту без правок MCP-сервера и системного промта;
- системные/админские/internal ручки исключаются автоматически;
- ограничения по пейлоаду (default limit, exclude полей) заданы декларативно в коде.

## 3. Решение (краткое)

Принимаем **вариант (г) — комбо**:

1. **Opt-in на уровне NestJS-модуля** через декоратор `@McpModule({ section, description })`. Все controller-методы внутри помеченного модуля автоматически попадают в каталог.
2. **Hard exclude по guards.** Любой контроллер/метод, в цепочке `@UseGuards()` которого есть `AdminApiKeyGuard`, `AdminUserGuard`, `AdminEmailGuard` или `InternalKeyGuard`, исключается автоматически и без вариантов — независимо от `@McpModule`.
3. **Soft exclude по сегменту пути.** Если в маршруте встречается сегмент `admin` или `internal` — endpoint исключается. Защита на случай, если кто-то поставит guard через другой механизм (interceptor, middleware) и hard-exclude не сработает.
4. **Per-method override**: `@McpExclude()` (выкинуть один метод из помеченного модуля) и `@McpTool({...})` (задать description / limits / excludeFields / переименовать).
5. **Endpoint `GET /_mcp/tools`** на `apps/api` отдаёт JSON-каталог. Защищён shared-secret заголовком `X-Mcp-Discovery-Key` (env `MCP_DISCOVERY_KEY`). MCP-сервер пользователя ходит с этим ключом.
6. **JSON Schema параметров** генерируется из DTO. Инструмент — `class-validator-jsonschema` (без перехода на Swagger).
7. **Контекст пользователя.** MCP-сервер для каждого вызова пользовательского тула пробрасывает `Authorization: Bearer <jwt>` из локальной сессии. В каталоге у каждого тула проставлен флаг `auth: "user" | "public" | "optional"`.

Безопасность: ничего секретного при опубликовании каталога не выдаётся (только сигнатуры путей и DTO). Auth-флоу, админка и internal-ручки отсекаются на трёх уровнях (guard, path, явный exclude).

## 4. Сравнение вариантов

| | (а) Opt-in метод | (б) Opt-out префикс | (в) Opt-in модуль | (г) Комбо **(выбран)** |
|---|---|---|---|---|
| Новый метод в существующем разделе сам попадает | нет | да | да | да |
| Новый модуль/раздел сам попадает | нет | да | нет, надо `@McpModule()` | нет, надо `@McpModule()` |
| Защита от случайной утечки нового sensitive-модуля | да (просто не помечен) | нет — пока кто-то не добавил exclude, эндпоинт уже опубликован | да (просто не помечен) | да (двойная — opt-in + hard guard-exclude) |
| Описание раздела для системного промта | нет места | нет места | есть (`@McpModule({description})`) | есть |
| Стоимость для разработчика нового раздела | помечать каждый метод | не делать ничего → потенциально опасно | один декоратор на модуль | один декоратор на модуль |

Вариант (а) сразу отпадает (цель ADR — «без правок» под новый метод).

Вариант (б) проигрывает по безопасности: представим, что завтра появится `apps/api/src/billing/` с `POST /billing/cancel`. По (б) он автоматом попадёт в MCP, ассистент сможет случайно отменить подписку. Hard-exclude по `admin/`/`internal/` не покроет — модуль называется `billing`. Чтобы (б) работало, нужен централизованный whitelist sensitive-имён, который тоже надо вручную поддерживать — это и есть та проблема, которую мы пытаемся убрать, только зеркальная.

Вариант (в) безопасен, но не даёт описать раздел отдельно от Swagger. И не имеет страховки против ошибочной пометки `AdminModule` через `@McpModule` (ревью забыло).

Вариант (г) — opt-in на модуле + hard-exclude по guards/path даёт обе гарантии: новые методы внутри раздела автоматически, новый раздел требует явного решения разработчика, ошибочная пометка sensitive-модуля отрезается guard-фильтром.

## 5. Декораторы

Живут в `apps/api/src/mcp/decorators.ts`:

```ts
export interface McpModuleMeta {
  /** Машинный id раздела для MCP-тулов и системного промта. Стабилен. */
  section: string;
  /** Человекочитаемый заголовок раздела (RU). Для системного промта. */
  title: string;
  /**
   * Описание раздела для системного промта ассистента (RU, 1-3 предложения).
   * Отвечает на вопрос «о чём этот раздел и когда туда идти».
   */
  description: string;
  /**
   * Дефолтный тип авторизации для всех методов раздела.
   * Может быть переопределён `@McpTool({auth})` на методе.
   */
  defaultAuth?: 'user' | 'public' | 'optional';
}

export function McpModule(meta: McpModuleMeta): ClassDecorator;
```

`@McpModule()` ставится на класс NestJS-модуля (`*.module.ts`). Discovery-сервис обходит controller-классы, объявленные в `controllers`/`imports.controllers` этого модуля.

```ts
export interface McpToolMeta {
  /** Переопределить автогенерируемое имя тула. По умолчанию: `<section>__<methodName>`. */
  name?: string;
  /** Краткое описание под модель (RU). Если не задано — берётся JSDoc метода. */
  description?: string;
  /** Тип авторизации для этого метода. */
  auth?: 'user' | 'public' | 'optional';
  /**
   * Подсказка лимитов для query-параметра `limit`. Информативная: реальную
   * валидацию делает controller. Нужна mcp-серверу, чтобы по умолчанию не
   * передавать огромные `limit` и обрезать ответ.
   */
  defaultLimit?: number;
  maxLimit?: number;
  /**
   * Поля, которые MCP-сервер должен вырезать из ответа перед отдачей модели
   * (защита от token-limit `tool_result`). Пример: `['pgn','fen']` для
   * списочных эндпоинтов с тяжёлыми полями.
   * Поддерживает dot-path: `'items[].pgn'`.
   */
  excludeFields?: string[];
  /**
   * Whitelist полей. Если задан — MCP-сервер оставляет только перечисленное.
   * Взаимоисключающе с excludeFields.
   */
  fieldsAllowList?: string[];
}

export function McpTool(meta?: McpToolMeta): MethodDecorator;
export function McpExclude(): MethodDecorator & ClassDecorator;
```

Правила:

- `@McpTool()` без параметров эквивалентен «использовать дефолты модуля».
- Метод без явного `@McpTool` всё равно попадает в каталог, если его класс-контроллер живёт в `@McpModule()`-модуле и нет hard/soft exclude.
- `@McpExclude()` на классе — выкидывает весь контроллер; на методе — конкретный handler.
- `@McpTool({excludeFields})` и `@McpTool({fieldsAllowList})` одновременно — ошибка bootstrap'а (DiscoveryService падает с понятным логом).

## 6. Формат `/_mcp/tools`

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-13T15:50:00Z",
  "apiBaseUrl": "https://kingside.app",
  "sections": [
    {
      "id": "analyses",
      "title": "Анализ партий",
      "description": "Сохранённые анализы пользователя ... когда туда идти.",
      "defaultAuth": "user"
    }
  ],
  "tools": [
    {
      "name": "analyses__list",
      "section": "analyses",
      "method": "GET",
      "path": "/analyses",
      "description": "Список анализов текущего пользователя.",
      "auth": "user",
      "input": {
        "type": "object",
        "properties": {
          "limit":   { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
          "offset":  { "type": "integer", "minimum": 0, "default": 0 },
          "withPgn": { "type": "boolean", "default": false }
        }
      },
      "output": null,
      "defaults": { "limit": 20 },
      "limits":   { "maxLimit": 100 },
      "excludeFields": ["items[].pgn", "items[].fen"]
    }
  ]
}
```

Поля:

- `schemaVersion` — версионирование контракта. Несовместимое изменение → инкремент. MCP-сервер при несовпадении major версии отказывается стартовать и логирует ошибку (без try-catch-молчания).
- `generatedAt` — для UI «когда последний раз обновляли». ETag — отдельным HTTP-заголовком.
- `apiBaseUrl` — берётся из env `MCP_API_BASE_URL`. MCP-сервер использует для построения полных URL.
- `sections[]` — описания разделов из `@McpModule`. Нужны для системного промта (`mcp-kingside.mjs` рендерит их в текст «у пользователя есть такие разделы: …»).
- `tools[]` — машинно-вызываемые ручки.
- `auth: "user" | "public" | "optional"` — нужно ли передавать JWT.
- `input` — JSON Schema query/body параметров (объединённо). Path-параметры присутствуют в `path` как `{id}` плейсхолдеры и отдельно дублируются в `input.properties`.
- `output` — опционально (см. §9 про generation cost).
- `defaults`, `limits`, `excludeFields`, `fieldsAllowList` — копируются из `@McpTool`.

### Имя тула

Автогенерация: `<section>__<controllerMethodName>` (snake_case). Например, `AnalysisController.findAll` в секции `analyses` → `analyses__find_all`. Можно переопределить через `@McpTool({name})` для удобочитаемости (`analyses__list`). Имя — уникальный ключ в `tools[]`; коллизия → ошибка bootstrap.

### Auth для `/_mcp/tools`

Заголовок `X-Mcp-Discovery-Key`, сверка с `process.env.MCP_DISCOVERY_KEY` constant-time-сравнением (паттерн `InternalKeyGuard`). Без заголовка / неверный ключ → 401/403, без подсказок. Endpoint не публичный (мог бы быть, но проще закрыть — содержит наводки на внутренние пути для атакующего).

В dev (`NODE_ENV !== 'production'`) — без ключа, чтобы локально не возиться.

## 7. DiscoveryService

Модуль `apps/api/src/mcp/`:

- `mcp.module.ts` — регистрирует `McpDiscoveryService` (provider) и `McpDiscoveryController` (`GET /_mcp/tools`).
- `decorators.ts` — `@McpModule`, `@McpTool`, `@McpExclude` (через `Reflector.metadata`).
- `discovery.service.ts` — бизнес-логика:
  1. На `OnApplicationBootstrap` обходит `ModulesContainer` (Nest core).
  2. Для каждого модуля — читает метаданные `@McpModule`. Если нет — skip всего модуля.
  3. Для каждого `Controller` модуля — пробегает методы через `MetadataScanner`. Берёт `@RequestMapping`-метаданные (`PATH_METADATA`, `METHOD_METADATA`).
  4. Hard-exclude фильтр: смотрит метаданные `__guards__` на классе и методе. Если в списке есть `AdminApiKeyGuard`/`AdminUserGuard`/`AdminEmailGuard`/`InternalKeyGuard` — skip. Список guards-blacklist — экспортируемая константа `MCP_FORBIDDEN_GUARDS`, чтобы добавлять новые имена в одном месте.
  5. Soft-exclude по path: regexp `(?:^|\/)(admin|internal)(?:\/|$)`. Skip при матче.
  6. Per-method `@McpExclude` — skip.
  7. Сборка JSON Schema input (см. §9).
  8. Финальный массив кэшируется в памяти. Инвалидация — только перезапуск процесса (новых эндпоинтов в runtime не появляется).
- `discovery.controller.ts` — `@Controller('_mcp')` + `@Get('tools')` + guard `McpDiscoveryKeyGuard`.

Логи: при старте `[MCP] Discovered 47 tools across 12 sections. Excluded: 23 (admin), 4 (internal), 2 (@McpExclude).` — для проверки, что миграция прошла.

## 8. Карта существующих модулей

Для каждого NestJS-модуля из `apps/api/src/app.module.ts` определено: `in MCP` (с какой section) или `excluded` (с причиной).

| Модуль | Статус | Section | Причина / комментарий |
|---|---|---|---|
| `AuthModule` | excluded | — | Логин/refresh/OAuth — никогда не для ассистента. Плюс `OAuthCallbackController` живёт на `api/auth/*`. |
| `AdminModule` | excluded | — | `AdminApiKeyGuard` + path `admin/*`. |
| `UserModule` | in | `users` | Профиль текущего пользователя, time-controls, saved-filters, preferences, nav-stats. `internal-users.controller.ts` отсечётся по `InternalKeyGuard` + path. |
| `GameModule` | in | `games` | Список/детали партий пользователя. WebSocket gateway не попадает (нет HTTP-роутов). |
| `PuzzleModule` | in | `puzzles` | Задачи, daily puzzle, mistakes. |
| `PrecisionModule` | in | `precision` | Тренировка точности — статистика, попытки, тренды. Цели KS-2951 в первую очередь касаются именно её. |
| `PuzzleRushModule` | in | `puzzle_rush` | Рекорды, история. |
| `TournamentModule` | in | `tournaments` | Турниры, регистрация — `auth: user`. |
| `LiveTournamentModule` | in | `live_tournaments` | Просмотр live-турниров. |
| `AnalysisModule` | in | `analyses` | `AnalysisController` (user) + `AnalysisPublicController` (public). Один section, две разные `auth`. |
| `WorkshopModule` | in | `workshop` | Мастерская. |
| `ClientLogsModule` | excluded | — | POST-only клиентские логи. Ассистенту бесполезно. `@McpExclude` на модуле явно. |
| `PlayerModule` | in | `players` | Просмотр чужих профилей (public). |
| `MessageModule` | in | `messages` | Личные сообщения. `auth: user`. |
| `FriendModule` | in | `friends` | Список друзей, запросы. |
| `NotificationModule` | in | `notifications` | Уведомления. |
| `ArenaModule` | in | `arena` | Арена. |
| `AiChatModule` | excluded | — | Это сам ассистент. Регистрация привела бы к рекурсии. `@McpExclude` на модуле. |
| `FeedbackModule` | in | `feedback` | POST `/feedback` — отправка обратной связи. Через `@McpTool({description: '...'})` явно описать чтобы ассистент знал «как переслать жалобу». |
| `MetricsModule` | excluded | — | Prometheus, бесполезно ассистенту. `@McpExclude`. |
| `LessonsModule` | in | `lessons` | Уроки, прогресс, ревью. `lessons/admin/*` отсечётся по AdminEmailGuard + path-segment `admin`. |
| `MistakesModule` | in | `puzzles` (та же что у Puzzle) | Дневник ошибок. Особый случай: модуль отдельный, но логически часть раздела `puzzles`. Используем тот же section. |
| `UserCoursesModule` | in | `user_courses` | Пользовательские курсы. |
| `FeatureFlagsModule` | partial | `config` | `ConfigController` (`/config`) — public read, in. `AdminFeatureFlagsController` (`/admin/feature-flags`) — отсечётся по `AdminUserGuard` + path. |
| `ProfileModule` | in | `users` | Часть «пользователи»: `/profile/me`, и т.д. Тот же section что `UserModule`. |
| `TacticDrillModule` | in | `tactic_drills` | Тактические тренировки. Daily-drill — отдельная подсекция? Решаем: оставляем единый section с разделением через имена тулов (`tactic_drills__daily_get`). |
| `StudyModule` | in | `studies` | Студии (private + `studies/public`). |
| `PrismaModule`, `RedisModule`, `I18nModule`, `ScheduleModule`, `ConfigModule` | n/a | — | Не имеют контроллеров. |
| `HealthController` (root) | excluded | — | `@McpExclude` на классе. |

Итого ожидаемо:
- `in MCP`: ~20 секций. Реальных tool-ручек — ориентировочно 80–120 (после первой расстановки декораторов backend уточнит).
- `excluded by guard/path`: AdminModule, AdminFeatureFlagsController, LessonsAdminController, InternalUsersController, InternalAuthController, ScreenshotTokenController.
- `excluded by @McpExclude`: AuthModule, AiChatModule, ClientLogsModule, MetricsModule, HealthController.

## 9. JSON Schema из DTO

Сейчас все DTO в `apps/api` — обычные классы с `class-validator`-декораторами (`@IsString`, `@IsInt`, `@IsOptional` и т.д.). Swagger в проект не подключен.

Решение: библиотека [`class-validator-jsonschema`](https://www.npmjs.com/package/class-validator-jsonschema). Преобразует существующие DTO в JSON Schema без правки самих классов.

Альтернативы рассмотрены и отклонены:

- **`@nestjs/swagger` + `@ApiProperty`** — требует разметить все DTO повторно. Не стоит ради одного эндпоинта.
- **Ручные схемы в `@McpTool({input})`** — двойной источник правды, синхронизация на разработчике, цель «без правок» нарушена.
- **Из TypeScript-типов через ts-json-schema-generator** — требует доступа к TS source code на runtime / сборку схем на build. Сложно интегрировать в Nest.

`class-validator-jsonschema` запускается на старте API, метаданные `class-validator` уже в памяти (Reflect-metadata), стоимость близка к нулю. Path/query-параметры контроллера → собираются вручную DiscoveryService (через `Reflect.getMetadata` на параметрах метода).

`output` schema на первом этапе **не публикуется** — генерация требует разметки return-типов и сложна. Ассистенту достаточно описания + примера в `description`. Если выяснится, что нужно, — добавим во второй версии (`schemaVersion: 2`).

### 9.1. Отступление при реализации: peer-dep конфликт

При реализации этапа A backend столкнулся с `ERESOLVE`: `class-validator-jsonschema@^5.0.1` декларирует peer-dep `class-validator: ^0.14.0`, в проекте используется `class-validator@^0.15.1`. Понижение версии нежелательно — `0.15.x` уже точечно используется в существующих DTO, регрессия на ~50+ файлов и переписывание ряда декораторов под старое API.

Рассмотренные варианты:

- `npm install --legacy-peer-deps` / `--force` — установится, но внутри библиотеки возможны рантайм-несовместимости с приватным API `class-validator` (внутренние `MetadataStorage`/`ValidationMetadata`). Тихий сбой при первой нетривиальной валидации.
- Форк библиотеки и patch peer-dep — оверкилл ради тонкого слоя, плюс долг на сопровождение форка.
- Подождать обновления библиотеки — у репозитория последний релиз более года назад, ждать нельзя.

**Решение: самописный inline-конвертер** `DtoToJsonSchema` (~150 строк, `apps/api/src/mcp/dto-to-json-schema.ts`), покрывающий узкий набор декораторов, фактически используемых в DTO `apps/api`:

| Декоратор | Маппинг в JSON Schema |
|---|---|
| `@IsString()` | `type: "string"` |
| `@IsInt()` | `type: "integer"` |
| `@IsNumber()` | `type: "number"` |
| `@IsBoolean()` | `type: "boolean"` |
| `@IsArray()` | `type: "array"` (items резолвится по `@Type()`) |
| `@IsObject()` | `type: "object"` |
| `@IsUUID()` | `type: "string", format: "uuid"` |
| `@IsEmail()` | `type: "string", format: "email"` |
| `@IsEnum(E)` | `enum: [...значения E]` |
| `@IsIn([a,b,c])` | `enum: [a,b,c]` |
| `@Min(n)`, `@Max(n)` | `minimum`, `maximum` |
| `@MinLength(n)`, `@MaxLength(n)` | `minLength`, `maxLength` |
| `@IsOptional()` | поле не попадает в `required[]` |
| `@Type(() => Nested)` | рекурсивный вызов `DtoToJsonSchema.build(Nested)` |

Поведение при незнакомом декораторе: конвертер бросает `Error('Unsupported class-validator decorator <name> on <Dto>.<field>')` на этапе bootstrap. Это явный сигнал автору нового DTO добавить маппер или поставить `@McpExclude()` на эндпоинт. Тихого fallback'а нет.

Тесты: `dto-to-json-schema.spec.ts` — отдельный кейс на каждый поддержанный декоратор и комбинации (`@IsOptional + @IsString`, `@IsArray + @Type`, nested DTO глубины 2). Снапшоты JSON Schema проверяются буква-в-букву.

Если в будущем `class-validator-jsonschema` (или замена) станет совместим с `class-validator@^0.15`, можно вернуться к ней — публичный контракт `DtoToJsonSchema.build(DtoClass): JsonSchema` стабильный, замена внутренностей не сломает остальной MCP-код.

Альтернативы из §9 (`@nestjs/swagger`, ручные схемы, ts-json-schema-generator) остаются актуально отклонёнными и по тем же причинам — peer-dep конфликт сам по себе их не реанимирует.

## 10. Контракт с `mcp-kingside.mjs`

MCP-сервер пользователя (вне репозитория, его пишет/правит пользователь сам — это не задача агентов):

1. На старте: `GET /_mcp/tools` с заголовком `X-Mcp-Discovery-Key` → парсит каталог.
2. Кэширует в локальном файле + ETag. Перечитывает каждые 10 минут (или по `SIGHUP`).
3. Регистрирует MCP-функции: `mcp__kingside__<tool.name>` (например, `mcp__kingside__analyses__list`).
4. JSON Schema из `tool.input` → MCP `inputSchema` без преобразований (MCP уже использует JSON Schema-подобный формат).
5. На вызов тула: формирует HTTP-запрос на `apiBaseUrl + tool.path`, метод из `tool.method`, query/body — из аргументов модели согласно schema. Если `tool.auth === 'user' | 'optional'` — добавляет `Authorization: Bearer <jwt>` из локальной user-сессии. Если `'public'` — не добавляет.
6. После ответа: применяет `excludeFields` / `fieldsAllowList` к JSON-телу до возврата результата ассистенту. Защита от token-limit.
7. Для секций — рендерит блок системного промта вида «Доступные разделы: …\n- analyses: <description>». Это позволяет ассистенту знать о разделе даже без вызова тула.

Версионирование: MCP-сервер проверяет `schemaVersion`. Несовпадение major — отказ старта, понятный лог.

## 11. Безопасность

Уровни защиты «не утечь админ/internal»:

| Уровень | Что | Что отсекается |
|---|---|---|
| 1 | Hard exclude by guard | `AdminApiKeyGuard`, `AdminUserGuard`, `AdminEmailGuard`, `InternalKeyGuard` |
| 2 | Soft exclude by path-segment | `admin`, `internal` |
| 3 | Module-level `@McpExclude()` | `AuthModule`, `AiChatModule`, `ClientLogsModule`, `MetricsModule`, `HealthController` |
| 4 | Method-level `@McpExclude()` | Точечные сенситивные методы внутри помеченного модуля |
| 5 | `MCP_DISCOVERY_KEY` на эндпоинте | Сам каталог не публичен; без ключа `/_mcp/tools` не открывается |

Уровень 1 + 2 работают вместе: если новый guard-класс ещё не в `MCP_FORBIDDEN_GUARDS`, path-segment `admin/internal` всё равно отсечёт. Если path-сегмент пропущен, guard-класс отсечёт. Обе защиты случайно одновременно не сломать.

Что **не защищает** этот ADR:
- RW-операции, доступные пользователю. Если у пользователя есть `DELETE /analyses/:id` — ассистент может его вызвать. Это ожидаемое поведение, ассистент действует «как пользователь под его JWT». Согласие пользователя на каждое разрушительное действие — отдельная задача UX/промта, не этого ADR.
- DoS через ассистента. `maxLimit` в каталоге — подсказка для MCP; реальный rate-limiting должен быть на API. Это вне scope ADR.

## 12. Контекст пользователя (JWT)

- `auth: "user"` — MCP добавляет `Authorization: Bearer <jwt>`. Если JWT нет (анонимная сессия) — тул не показывается ассистенту вообще (фильтрация в `mcp-kingside.mjs`).
- `auth: "public"` — MCP не добавляет JWT. Подходит для `analyses/public`, `studies/public`, `players/*`, `puzzles/daily`, `config`.
- `auth: "optional"` — MCP добавляет JWT если есть, иначе анонимный вызов. Подходит для смешанных GET'ов (`StudyController` с `OptionalJwtAuthGuard`).

JWT берётся из локальной user-сессии MCP-сервера (как именно — вне scope этого ADR, это пользователь решает на своей стороне). Передавать JWT через сам каталог `/_mcp/tools` запрещено — каталог общий для всех пользователей.

## 13. Описания для модели

- В `@McpModule({description})` и `@McpTool({description})` — RU-описания.
- Описание тула — что делает, когда вызывать, что значит каждый параметр.
- JSDoc метода считается резервом: если `@McpTool` без `description`, берётся первая строка JSDoc. Если и его нет — `description` отсутствует в каталоге, MCP-сервер логирует warn.
- Длина описания — рекомендованно 1-3 предложения. Жёсткого лимита нет, но при превышении 500 символов DiscoveryService логирует warn (повлияет на размер `tool_result` и context-window системного промта ассистента).

EN-описания пока не нужны: текущий ассистент работает по-русски с пользователем. Если потребуется i18n, в `schemaVersion: 2` добавим `description: { ru, en }`.

## 14. Миграционный план

Реализация — отдельные backend-задачи по результатам этого ADR.

### Этап A (backend, отдельная задача)

1. Создать `apps/api/src/mcp/` с декораторами, DiscoveryService, контроллером, guard'ом.
2. Подключить `class-validator-jsonschema`.
3. Добавить `MCP_DISCOVERY_KEY` в `.env.example`.
4. Подключить `McpModule` в `app.module.ts`.
5. Проставить `@McpModule({...})` и `@McpExclude()` на всех модулях по таблице §8.
6. Тесты: e2e на `GET /_mcp/tools` (с/без ключа, проверка отсутствия admin-эндпоинтов в выдаче), unit на DiscoveryService (guard-фильтр, path-фильтр, override).
7. Дать описание каждому разделу в `@McpModule({description})` — это контентная работа, лучше делать в той же задаче чтобы текст был у одного автора.

### Этап B (backend, отдельная задача)

- Точечная расстановка `@McpTool({description, defaultLimit, maxLimit, excludeFields})` на ручках, где это критично (списочные эндпоинты с тяжёлыми полями: `/analyses`, `/games`, `/studies`).
- В первую очередь те, где уже есть подобные ручные хаки (KS-2948).

### Этап C (пользователь)

- Привести `tools/mcp-kingside.mjs` под §10 контракта. Старые ручные тулы удалить. Это вне зоны агентов.

## 15. Не входит в этот ADR

- Реализация (отдельные задачи backend).
- Расстановка декораторов по проекту (часть этапа A).
- Изменения в `tools/mcp-kingside.mjs` (зона пользователя).
- Согласие пользователя на разрушительные действия ассистента.
- Rate-limiting/quotas для MCP-вызовов (отдельный ADR при необходимости).

## 16. Follow-up задачи

Координатор создаёт по этому ADR:

1. **Backend (A)**: «Внедрить `apps/api/src/mcp/` — декораторы, DiscoveryService, `/_mcp/tools`, разметка модулей по таблице §8».
2. **Backend (B)**: «Проставить `@McpTool({...})` с лимитами на listing-эндпоинты согласно §14». Можно делать после A, по мере необходимости.
3. **Пользователь (вне Jira)**: «Переписать `tools/mcp-kingside.mjs` под контракт §10».
