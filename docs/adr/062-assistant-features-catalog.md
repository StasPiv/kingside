# ADR-062. Автообновление system-prompt AI-ассистента из каталога фич

Статус: принят (KS-2961).
Дата: 2026-05-13.
Связано: ADR-061 (MCP API auto-discovery), ADR-047/048/055/056/057 (Precision), ADR-058 (Sidebar restructure).

## 1. Контекст

База знаний AI-ассистента сайта живёт в `apps/api/src/ai-chat/system-prompt.ts` — это монолитный шаблонный текст, который правится вручную при добавлении новых страниц. На практике это уже сломалось:

- 2026-05-13 пользователь спросил у ассистента про оценку точности игры. Ассистент ответил «такой функции нет», хотя у нас полноценный раздел Precision (4 страницы, backend-модуль, 3 таблицы БД, ADR-047/048/055/056/057) и пост-партийный разбор Play vs Bot (`PlayVsEngineRunner` + `PostGameReview`, ADR-047).
- Промт содержит инструкцию «If a feature does not exist — honestly say "this feature is not available yet"». В сочетании с устаревшим описанием раздела это заставляет модель уверенно отрицать существующую функциональность.
- Маршрутов на фронте — около 100 (`grep "path=" apps/web/src/App.tsx | wc -l → 98`). В промте описано ~20. Регулярно вылезают новые: drills, studies, gamebook reader, broadcasts. Ручная синхронизация уже не работает и не заработает.

Ассистент опирается ровно на этот текст для двух вещей:
1. Знать, на какие страницы направлять пользователя (URL-ы).
2. Понимать, что в принципе доступно на платформе (чтобы не отказывать в существующих фичах).

ADR-061 уже решил похожую задачу для **API-стороны**: backend сам экспортирует каталог эндпоинтов через `@McpModule({...})`/`@McpTool({...})` и отдаёт его MCP-серверу через `GET /_mcp/tools`. Но этот каталог — про API-тулы (`analyses__list`, `puzzles__daily`), а не про UI-страницы. У многих фронтовых страниц нет 1:1 соответствия с API-ручкой (например, `/analysis` работает на WASM-Stockfish без бэкенда, `/play/bot` — композиция matchmaking + game + engine). И описания в `@McpModule.description` написаны в жанре «когда дёргать API-секцию», а не «куда направить пользователя на сайте». Поэтому ADR-061 — соседний механизм, не заменяющий этот.

## 2. Цель

Описание разделов в system-prompt должно обновляться **автоматически**: автор фичи правит файл рядом с роутом, и при ближайшей сборке (или даже без сборки — через TS-импорт) описание попадает в промт. CI блокирует merge новой страницы, для которой описание не добавлено или удалено.

Конкретно:

- Добавление нового `<Route path="/foo">` в `App.tsx` без записи в каталоге → CI-фейл, не уходит в main.
- Удаление маршрута без удаления записи → CI-фейл.
- Изменение названия раздела / списка под-страниц → одна правка в одном месте, промт пересоберётся при старте API.
- Фичи за feature flag описываются в промте всегда, но с явной пометкой «доступно только при включённом флаге X»; ассистент через user-контекст знает текущее состояние флагов и не утверждает фичу доступной всем.

Не входит:
- Содержимое описаний (миграция существующего текста промта в новый формат) — отдельная backend-задача после ADR.
- Реализация генератора и CI-чека — отдельная backend-задача.
- Многоязычность промта (сейчас ассистент работает по-английски, см. §9 ADR-061; вопрос i18n решается в `schemaVersion: 2` каталога).

## 3. Решение (краткое)

Принимаем **гибрид (вариант г)**:

1. **Источник истины — TypeScript-массив `FEATURES` в `packages/shared/features-catalog/index.ts`**, экспортирующий типизированные записи `AssistantFeature` (см. §5). Один файл на одну фичу/раздел внутри директории `packages/shared/features-catalog/<id>.ts`, агрегирующий `index.ts` собирает массив. Это co-location-light: каждая фича в своём файле (мерж-конфликты разнесены), но всё в одной директории (один shared-пакет, без зависимости api ↔ web).
2. **Костяк промта остаётся ручным.** Файл `apps/api/src/ai-chat/system-prompt.ts` хранит вводный текст («You are a helpful assistant for Kingside...»), guidelines и инструкции — это редактируемая редакторская часть. **Блок «Site pages and features» рендерится из `FEATURES` при каждом вызове** `buildSystemPrompt()`. Никакого build-step / кодогенерации — обычный TS-импорт.
3. **CI-чек `tools/check-features-catalog.mjs`** через AST-парсинг `apps/web/src/App.tsx` собирает список `<Route path="...">` и сверяет с union всех `paths[]` из `FEATURES`. Расхождение в обе стороны → exit 1. Подключается в `npm run lint` (root, прогон через turbo) и в pre-commit (опционально, дешёвый).
4. **Feature flags** декларируются полем `featureFlag: 'puzzlesEnabled' | null` на каждой записи. Имя флага — литеральный union, импортируемый из `packages/shared/types/feature-flags.ts` (где уже определён `FeatureFlagKey` для KS-2104). Build-time проверка типов гарантирует, что несуществующий флаг не пройдёт.
5. **Хранение рядом с кодом vs централизованно — централизованно в `packages/shared`.** Обоснование в §6.

Безопасность: каталог — это публичные URL-ы и user-facing-описания. Секретов в нём нет, изменения видны в diff. Случайно описать админскую страницу можно — отсеивается CI-чеком, где есть whitelist «системных» путей (`/login`, `/register`, `/admin/*`, `/oauth/callback`, `/dev/*`, `/terms*`, redirects через `<Navigate>`), которые НЕ должны быть в каталоге.

## 4. Сравнение вариантов

| | (а) Реестр в `packages/shared` | (б) Парсинг ADR | (в) Аннотации к роутам | (г) Гибрид: ручной костяк + автореестр **(выбран)** |
|---|---|---|---|---|
| Новая фича автоматически в промте | да (одна правка в одном файле) | только если автор написал ADR с правильной шапкой | да (одна правка рядом с роутом) | да |
| Старая фича автоматически вычищается | да (CI-чек + удаление файла) | нет (старые ADR не удаляются) | да | да |
| CI-блокировка merge без описания | да (path-diff) | нет (ADR опциональны) | да | да |
| Не зависит от внешней структуры (ADR-шапки, JSDoc-комментариев) | да | нет — хрупкий парсер markdown | средне — RSC-аннотации/декораторы | да |
| Сохраняет редакторский контроль над «голосом» промта (guidelines, тон, ограничения) | нужно вручную поддерживать костяк | нет — генерируется целиком из ADR | нужно вручную поддерживать костяк | да (костяк отдельно) |
| Feature flags | поле в записи | надо парсить отдельно из кода | поле в декораторе | поле в записи |
| Совместим с tree-shaking фронта (импорт в nav-меню) | да (TS) | нет (markdown) | да | да |

Вариант (б) отпадает: ADR — это документация архитектурных решений, не пользовательская справка. Часть фич не имеет ADR (например, `/players`, `/friends` — никогда не было выделенного ADR). Часть ADR — про инфраструктуру (ADR-045, 051) и не должна попадать в промт ассистенту. Поднимать ADR в роль user-facing-каталога — двойная нагрузка и хрупкий парсер.

Вариант (в) симметричен ADR-061 (декораторы на коде). Но React-роуты — это JSX-элементы внутри `App.tsx`, а не классы; чтобы повесить аннотацию, нужно либо обернуть `<Route>` в кастомный компонент `<RoutedFeature meta={...}>`, либо ставить декоратор на компонент страницы (`@AssistantFeature` на `PrecisionPage`). Декоратор на компонент работает не во всех случаях (одна страница — несколько роутов: `/precision`, `/precision/stats`, `/precision/history`, `/precision/attempts/:id` обслуживаются разными компонентами, но это один раздел). Получается, что аннотация всё равно мапит «много роутов → одна запись», что эквивалентно реестру. Чистый реестр проще.

Вариант (а) — чистый реестр без ручной части — теряет редакторский контроль над тоном промта (guidelines «Be friendly and encouraging», «Keep responses concise», «NEVER reveal technical details» нельзя выводить из каталога фич). Промт всегда будет состоять из «универсальной обёртки» + «список разделов» + «контекст пользователя».

Вариант (г) — выбран — сохраняет ручной костяк (guidelines, тон, инструкции к tool-use), а блок «Site pages and features» рендерится из каталога. Этот блок — самый объёмный и самый часто-устаревающий, именно его автоматизируем.

## 5. Схема записи фичи

```ts
// packages/shared/features-catalog/types.ts

import type { FeatureFlagKey } from '../types/feature-flags';

export interface AssistantFeature {
  /**
   * Стабильный машинный id раздела (snake_case). Используется в логах,
   * тестах, и для cross-ref с `@McpModule({section})` (ADR-061 §3).
   * Совпадение id с MCP-section — желательно, но не обязательно;
   * не все UI-разделы имеют backend-секцию (например, `analysis`
   * работает чисто на WASM).
   */
  id: string;

  /**
   * Заголовок раздела для системного промта (EN, пока ассистент EN).
   * Появляется в промте как `### {title} ({paths.join(', ')})`.
   */
  title: string;

  /**
   * Пути в react-router. Параметризованные через `:param`. Перечислять
   * ВСЕ пути, которые относятся к этому разделу (например,
   * `/precision`, `/precision/stats`, `/precision/history`,
   * `/precision/attempts/:id`). Каждый путь должен реально существовать
   * в `apps/web/src/App.tsx` — это проверяет CI-чек.
   *
   * НЕ перечислять системные пути (`/login`, `/admin/*`, `/dev/*`,
   * `/oauth/callback`, redirects). Они в whitelist'е CI-чека и НЕ
   * должны попадать в каталог.
   */
  paths: string[];

  /**
   * Краткое назначение раздела (1-3 предложения, EN). Отвечает на
   * вопрос «что это и когда сюда идти». Поведение / детальные правила —
   * в `highlights`.
   */
  summary: string;

  /**
   * Опциональные буллеты с ключевыми возможностями раздела. EN.
   * Рекомендованная длина — до 8 пунктов; больше — модель не запомнит.
   * Шаблонная подстановка `{siteUrl}` поддерживается.
   */
  highlights?: string[];

  /**
   * Ограничения / технические оговорки. EN. Примеры:
   *  - «Requires authentication»
   *  - «Max 3 active bot games at a time»
   *  - «Engine runs locally (WebAssembly) — no server needed»
   */
  caveats?: string[];

  /**
   * Требуется ли авторизация. Подсказка ассистенту: предлагать раздел
   * гостям только если `auth !== 'user'`.
   *  - 'user'     — `<ProtectedRoute>` на всех путях
   *  - 'public'   — гости видят
   *  - 'optional' — некоторые подпути защищены, остальные нет
   */
  auth: 'user' | 'public' | 'optional';

  /**
   * Имя runtime feature flag из `FeatureFlagsService`. null — раздел
   * включён всегда. Если флаг задан — описание ВСЁ РАВНО попадает в
   * промт, но с пометкой «available only when the {featureFlag}
   * feature flag is enabled». Текущее значение флага ассистент видит
   * в user-контексте (отдельная задача — пробросить флаги в контекст,
   * см. §13 Follow-up).
   */
  featureFlag: FeatureFlagKey | null;

  /**
   * Связанные ADR для трассировки. Опционально. Пример:
   * `['ADR-047', 'ADR-048']` для Precision.
   * В промт не попадают — только для разработчиков, чтобы по записи
   * каталога быстро находить контекст решения.
   */
  adr?: string[];

  /**
   * Связь с MCP-секцией (`@McpModule({section})` из ADR-061). null —
   * раздел чисто клиентский / не имеет backend-секции. Если задан —
   * CI-чек дополнительно проверяет, что такая секция существует
   * в `/_mcp/tools` (см. §10).
   */
  mcpSection: string | null;
}
```

Записи живут как отдельные файлы:

```
packages/shared/features-catalog/
  index.ts                   # экспортирует FEATURES: AssistantFeature[]
  types.ts                   # интерфейс выше + helpers
  play-online.ts             # export const playOnline: AssistantFeature = {...}
  play-vs-bot.ts
  precision.ts
  puzzles.ts
  puzzle-rush.ts
  analysis.ts
  workshop.ts
  studies.ts
  drills.ts
  lessons.ts
  tournaments.ts
  broadcasts.ts
  games.ts
  players.ts
  friends.ts
  messages.ts
  profile.ts
  settings.ts
  feedback.ts
  ai-chat.ts
```

`index.ts`:

```ts
import { playOnline } from './play-online';
import { playVsBot } from './play-vs-bot';
// ...
export * from './types';
export const FEATURES: readonly AssistantFeature[] = [
  playOnline, playVsBot, precision, puzzles, puzzleRush,
  analysis, workshop, studies, drills, lessons,
  tournaments, broadcasts, games, players, friends,
  messages, profile, settings, feedback, aiChat,
] as const;
```

Стабильность сортировки (порядок в `FEATURES` = порядок в промте) даёт детерминированный output и предсказуемый diff в PR.

## 6. Физическое расположение

**Решение: `packages/shared/features-catalog/`.** Обоснование:

- **`apps/api/src/ai-chat/features-catalog/`** — отпадает: фронт не должен зависеть от `apps/api` (сейчас не зависит — это сохраняем). А он мог бы хотеть импортировать каталог в nav-меню или для генерации sitemap.
- **`apps/web/src/features-catalog/`** — отпадает: API не должен зависеть от `apps/web` (build-граф этого не позволяет; `apps/api` — отдельный workspace, не подключает `apps/web`).
- **`packages/shared`** — уже имеющийся «нейтральный» пакет с типами api-contracts. Подходит точно. Импортируется и API (для `system-prompt.ts`), и web (для nav-меню, если потребуется).
- **Co-location рядом с компонентом страницы (`apps/web/src/pages/PrecisionPage.feature.ts`)** — отпадает: чтобы потом собрать массив для API, нужен build-step (сканер файлов или index-генератор). Build-step добавляет точку отказа и усложняет dev-цикл (правка → перегенерация → перезапуск API). Гипотетический выигрыш «правлю рядом с компонентом» съедается тем, что описание — это редакторский текст, его меняют редко и тщательно, а не вместе с каждым refactor'ом страницы.

Запись `precision.ts` — это ~30 строк декларации. Цена «открыть отдельный файл при добавлении страницы» — пренебрежимо мала по сравнению с ценой build-step'а.

## 7. Интеграция с system-prompt

Текущий `apps/api/src/ai-chat/system-prompt.ts` (191 строка, монолит) после миграции делится на три части:

```ts
import { FEATURES } from '@kingside/shared/features-catalog';

const STATIC_HEADER = (siteUrl: string) => `You are a helpful assistant for Kingside...
You are NOT a chess engine or analyzer...
## Site pages and features
`;

const STATIC_FOOTER = `## Guidelines:
- When the user asks about their data — USE TOOLS to look it up...
- ...
- NEVER reveal technical details about the application...
`;

function renderFeaturesBlock(siteUrl: string, flags: FeatureFlagsSnapshot): string {
  return FEATURES
    .map((f) => renderFeature(f, siteUrl, flags))
    .join('\n\n');
}

function renderFeature(
  f: AssistantFeature,
  siteUrl: string,
  flags: FeatureFlagsSnapshot,
): string {
  const urls = f.paths.map((p) => `${siteUrl}${p}`).join(', ');
  const lines = [`### ${f.title} (${urls})`, f.summary];
  if (f.featureFlag) {
    const enabled = flags[f.featureFlag] ?? false;
    lines.push(
      `**Availability**: gated behind \`${f.featureFlag}\` feature flag. ` +
        `Currently ${enabled ? 'enabled' : 'disabled'} for this user. ` +
        (enabled
          ? ''
          : `Do NOT recommend this section unless the user explicitly asks about it.`),
    );
  }
  if (f.highlights?.length) {
    lines.push(...f.highlights.map((h) => `- ${h.replaceAll('{siteUrl}', siteUrl)}`));
  }
  if (f.caveats?.length) {
    lines.push(...f.caveats.map((c) => `_${c}_`));
  }
  return lines.join('\n');
}

export function buildSystemPrompt(
  context: UserContext,
  flags: FeatureFlagsSnapshot,
  siteUrl = 'https://kingside.site',
): string {
  return [
    STATIC_HEADER(siteUrl),
    renderFeaturesBlock(siteUrl, flags),
    STATIC_FOOTER,
    formatContext(context),
  ].join('\n\n');
}
```

Ключевое:
- Никакого build-step или кодогенерации. Обычный TS-импорт. Перезапуск API → новый текст.
- `flags` пробрасывается из `FeatureFlagsService.getAll()` в `ChatAssistantService` — это новый параметр `buildSystemPrompt`, миграция этой подписи — задача backend в этапе A.
- Структура `STATIC_HEADER` / `STATIC_FOOTER` оставляет редакторский контроль (guidelines / тон). При желании их можно вынести в `.md`-файл и `fs.readFile` на старте, но это вкусовая правка — не часть этого ADR.

### Безопасность от регрессии «голых» URL в костяке

Тест `system-prompt.spec.ts` проверяет: в `STATIC_HEADER` и `STATIC_FOOTER` (после конкатенации) нет литералов вида `${siteUrl}/`, `https://kingside.site/`, `kingside.site/` для путей, не относящихся к `siteUrl` корневому. Если кто-то решит «по-быстрому» дописать в костяк строку «See https://kingside.site/foo» — тест падает с сообщением «add it to FEATURES instead». Это страхует от обхода каталога в обход CI-чека.

## 8. CI-проверка (механизм блокировки)

Скрипт `tools/check-features-catalog.mjs` (Node, без зависимостей кроме `typescript` для AST):

```
npm run check:features
```

Алгоритм:

1. Парсить `apps/web/src/App.tsx` через TypeScript-compiler-API. Обойти AST, найти все JSX-элементы `<Route path="...">`. Собрать множество `routesInApp: Set<string>`.
2. Удалить из `routesInApp` пути из whitelist'а (см. §8.1) — это системные/инфраструктурные пути, которые не идут в каталог.
3. Удалить пути, у которых `element` — это `<Navigate to=...>` или `<RedirectWithQuery to=...>`. Это redirects, не самостоятельные фичи.
4. Импортировать `FEATURES` из `packages/shared/features-catalog` (через `tsx` или предкомпилированный JS). Собрать множество `routesInCatalog: Set<string>` (union всех `paths`).
5. Сравнить:
   - `routesInApp \ routesInCatalog` (роуты есть, описания нет) → exit 1, сообщение «Routes missing from features-catalog: /foo, /bar. Add records to packages/shared/features-catalog/».
   - `routesInCatalog \ routesInApp` (описания есть, роутов нет) → exit 1, сообщение «Stale entries in features-catalog: /foo (in record `precision`). Remove or update.».
6. Дополнительные валидации:
   - Каждая запись имеет непустой `summary` (минимум 30 символов).
   - `featureFlag` если задан — действительно ключ из `FeatureFlagKey` (статически проверяется TS, runtime-чек — defense in depth).
   - `mcpSection` если задан — есть в `/_mcp/tools` (опционально, fetch при наличии env `KINGSIDE_API_URL` + `MCP_DISCOVERY_KEY`; в CI без сети — skip с warn).
7. Exit 0, log «features-catalog OK: N records cover M routes».

### 8.1. Whitelist «не-фич»

Файл `tools/features-catalog-whitelist.json` (один источник правды для скрипта):

```jsonc
{
  "exactPaths": [
    "/login", "/register", "/oauth/callback",
    "/terms", "/terms-of-service",
    "/lobby",       // KS-2538: lobby — это не фича, это transit-страница
    "/dashboard"
  ],
  "prefixes": [
    "/admin",       // админка — никогда не для ассистента
    "/dev"          // dev-only роуты, не в prod-бандле
  ],
  "redirectElements": ["Navigate", "RedirectWithQuery", "RedirectMyCourse", "RedirectMyLesson", "ProfileRedirect", "InviteRedirect"],
  "indexRoute": true              // `<Route index>` — это HomePage, описание под id `home`
}
```

Whitelist меняется редко и осознанно. Изменение whitelist'а — отдельный коммит, видный в diff.

### 8.2. Подключение

- **Локально и в CI**: добавить `check:features` в `npm run lint` корня (через turbo `pipeline.lint`). Тогда `npm run lint` блокирует merge через стандартный CI-job.
- **Pre-commit (опционально)**: husky/lefthook (если появится) дёргает `npm run check:features`. Время прогона — ~200 мс (parse одного файла + import константного массива). Cheap.
- **Standalone**: автор фичи может запустить локально перед коммитом и сразу увидеть, что забыл описание.

### 8.3. Дополнительная страховка: тест в API

`apps/api/src/ai-chat/system-prompt.spec.ts`:

```ts
it('every FEATURES entry appears in the rendered prompt', () => {
  const prompt = buildSystemPrompt(stubContext, stubFlags);
  for (const f of FEATURES) {
    expect(prompt).toContain(f.title);
    for (const p of f.paths) {
      expect(prompt).toContain(p);
    }
  }
});

it('prompt does NOT contain bare URLs outside FEATURES', () => {
  // см. §7 — детектор «голых» URL в STATIC_HEADER/FOOTER
});
```

Это страхует от случая, когда `renderFeature` сломается (например, забудут поле `highlights` отрендерить) и фича исчезнет из промта, хотя CI-чек на App.tsx пройдёт.

## 9. Feature flags

Текущее поведение `apps/web/src/App.tsx` — некоторые блоки роутов рендерятся условно (`{puzzlesEnabled ? (...) : (...)}`). Если просто перечислить такие пути в каталоге, ассистент будет утверждать фичу доступной даже при выключенном флаге.

Решение в §5 (`featureFlag: FeatureFlagKey | null`) и §7 (`renderFeature` дописывает блок «Availability»):

```
### Tournaments (https://kingside.site/tournaments, https://kingside.site/tournaments/:id)
Three tournament formats: Arena, Swiss, Round Robin...
**Availability**: gated behind `tournamentsEnabled` feature flag. Currently disabled for this user. Do NOT recommend this section unless the user explicitly asks about it.
```

То есть:
- При **выключенном** флаге — описание в промте есть, но ассистент видит маркер «do not recommend». Если пользователь сам спросил «есть ли турниры», ассистент не отрицает («есть, но временно недоступно»).
- При **включённом** флаге — обычное описание, ассистент свободно направляет.

`FeatureFlagsSnapshot` — это просто `Record<FeatureFlagKey, boolean>`, полученный из `FeatureFlagsService.getAll()`. Snapshot читается на каждый запрос к ассистенту (не кэшируется в самом промте), потому что флаги могут переключаться runtime'но (KS-2104, KS-2109 admin UI). Стоимость — один Map-lookup на запрос, пренебрежимо.

CI-чек обходит conditional-роуты в `App.tsx`: для `{puzzlesEnabled ? ... : ...}` собирает пути и из then-ветки, и из else-ветки. Then-ветка добавляется в `routesInApp` с пометкой `flag: 'puzzlesEnabled'`; else-ветка — это обычно `<Navigate to=>` (попадает в `redirectElements`). Поэтому в каталоге для такой фичи будет запись с `featureFlag: 'puzzlesEnabled'` и `paths: [...then-ветка]`.

Расширенная валидация CI: если путь рендерится из then-ветки conditional с флагом `puzzlesEnabled`, запись в каталоге должна иметь `featureFlag: 'puzzlesEnabled'`. Несовпадение → exit 1. Это страхует от ситуации, когда автор перенёс фичу под флаг, но забыл обновить каталог.

## 10. Соотношение с ADR-061

| | ADR-061 (`/_mcp/tools`) | ADR-062 (features-catalog) |
|---|---|---|
| Что описывает | API-эндпоинты | UI-страницы и разделы сайта |
| Источник истины | `@McpModule`/`@McpTool` декораторы на backend | TS-массив `FEATURES` в `packages/shared` |
| Кто потребитель | MCP-сервер (`mcp-kingside.mjs`, вне репо) — регистрирует тулы для ассистента | `apps/api/src/ai-chat/system-prompt.ts` — рендерит текст промта |
| Как обновляется | bootstrap NestJS, кэш в памяти, перезапуск API | TS-импорт, перезапуск API |
| Защита от merge без описания | нет (по дизайну: opt-in, новый модуль виден ассистенту только если автор поставил `@McpModule`) | да (CI-чек path-diff) |

**Точка пересечения:** поле `mcpSection` в `AssistantFeature`. Если задано — раздел имеет соответствующую секцию в `/_mcp/tools` (например, `precision`/`precision`). CI-чек опционально (при наличии доступа к API в окружении сборки) проверяет cross-ref: если `mcpSection: 'precision'`, в каталоге `/_mcp/tools` должна быть секция с `id: 'precision'`.

Дублирование описаний минимально: в `@McpModule.description` пишется в жанре «когда дёргать API» («сюда — если нужно загрузить статистику»), в `AssistantFeature.summary` — в жанре «когда направить пользователя» («Тренировка точности игры на ваших партиях»). Это разные тексты для разных аудиторий (модель-MCP-tool-caller vs модель-навигатор-пользователя), синхронизировать их не нужно.

## 11. Очистка удалённых фич

Когда фича удаляется:

1. Автор удаляет `<Route path="/foo">` из `App.tsx`.
2. CI-чек ловит, что запись `foo.ts` в каталоге содержит `paths: ['/foo']`, которого больше нет в `App.tsx` → exit 1.
3. Автор удаляет файл `packages/shared/features-catalog/foo.ts` и убирает его import из `index.ts`.
4. PR проходит CI.

Если запись описывает несколько путей (`/precision`, `/precision/stats`), и удаляется только один из них (`/precision/history`):

1. Автор удаляет `<Route path="/precision/history">`.
2. CI-чек ловит, что `paths` записи содержит несуществующий путь → exit 1.
3. Автор правит `paths` в `precision.ts`, убирая `/precision/history`. Также удаляет соответствующий пункт из `highlights`, если он там был.
4. PR проходит CI.

Никакого «архива удалённых фич», никаких deprecation-флагов в каталоге — фича либо есть, либо её нет.

## 12. Минимальный пример записи

`packages/shared/features-catalog/precision.ts`:

```ts
import type { AssistantFeature } from './types';

export const precision: AssistantFeature = {
  id: 'precision',
  title: 'Precision Training',
  paths: [
    '/precision',
    '/precision/stats',
    '/precision/history',
    '/precision/attempts/:id',
  ],
  summary:
    'Practice precision on user-uploaded positions and on positions from your own games. The system measures move accuracy against engine evaluation (centipawn loss) and tracks trends over time.',
  highlights: [
    'Main training screen at {siteUrl}/precision — pick a position pack and play through it move by move',
    'Statistics at {siteUrl}/precision/stats — accuracy %, ACPL, distribution of best/good/inaccuracy/mistake/blunder moves, per-pack and per-timeframe breakdowns',
    'History at {siteUrl}/precision/history — list of past attempts with filters and sorting',
    'Per-attempt review at {siteUrl}/precision/attempts/:id — replay an attempt move by move with engine evaluation',
  ],
  caveats: [
    'Requires authentication',
    'Engine evaluation runs on the server (Stockfish 18), not in the browser',
  ],
  auth: 'user',
  featureFlag: 'puzzlesEnabled',
  adr: ['ADR-047', 'ADR-048', 'ADR-055', 'ADR-056', 'ADR-057'],
  mcpSection: 'precision',
};
```

## 13. Миграционный план

Реализация — отдельные backend-задачи по результатам этого ADR. Этот ADR — только проектирование.

### Этап A (backend, отдельная задача)

1. Создать `packages/shared/features-catalog/` с `types.ts` и пустым `index.ts`.
2. Создать `tools/check-features-catalog.mjs` + whitelist. Подключить в `npm run lint` корня.
3. Прогнать скрипт по существующему `App.tsx` без записей в каталоге → получить полный список путей, которые нужно описать (~80 user-facing после фильтрации). Это input для шага 4.
4. Перенести содержимое текущего `system-prompt.ts` в записи каталога (по одной записи на раздел, описания дословно переносятся из текущего промта, расширяются для отсутствующих разделов — Precision, Drills, Studies, и т.д.).
5. Обновить `system-prompt.ts` под §7 (STATIC_HEADER / renderFeaturesBlock / STATIC_FOOTER + новый параметр `flags`).
6. Обновить `ChatAssistantService` — пробросить `FeatureFlagsService.getAll()` в `buildSystemPrompt`.
7. Тесты: §8.3 (snapshot-test промта, проверка отсутствия голых URL).
8. CI-чек должен пройти, в `npm run lint` зелёный.

### Этап B (backend, опционально)

- Расширить каталог полем `i18n: { en, ru }` если ассистент станет двуязычным. До этого момента — EN-only (текущая реализация уже EN).
- Cross-ref-проверка `mcpSection ↔ /_mcp/tools` в CI, если будет доступ к API.

### Этап C (frontend, опционально)

- Переиспользовать `FEATURES` для генерации `<nav>`-меню / sitemap / SEO meta-tags. Это снимает ещё одно ручное дублирование (заголовки разделов в Sidebar — KS-2792, ADR-058 — сейчас тоже свой набор констант).

## 14. Не входит в этот ADR

- Реализация (отдельные задачи backend).
- Само наполнение каталога описаниями фич (этап A.4 — контентная работа).
- Многоязычность промта (этап B).
- Переиспользование `FEATURES` фронтом (этап C).
- Изменения в `tools/mcp-kingside.mjs` — это зона пользователя (как и в ADR-061 §15).
- Описание non-user-facing разделов (админка, dev-роуты) — намеренно вне каталога, см. whitelist §8.1.

## 15. Follow-up задачи

Координатор создаёт по этому ADR:

1. **Backend (A)**: «Внедрить `packages/shared/features-catalog/`, перенести content из system-prompt в записи, подключить рендеринг + флаги, CI-чек `check:features`».
2. **Backend (отдельно)**: «Пробросить `FeatureFlagsSnapshot` в `ChatAssistantService.buildSystemPrompt` через `FeatureFlagsService.getAll()`». Может быть подзадачей (A) или отдельной — на усмотрение координатора.
3. **DevOps**: «Подключить `npm run check:features` в CI lint-job» — если CI lint уже работает через turbo, может оказаться no-op.
4. **Frontend (опционально, этап C)**: «Переиспользовать `FEATURES` для Sidebar и sitemap».
