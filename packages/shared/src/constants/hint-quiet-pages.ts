/**
 * KS-4689 / ADR-147 §4.2.1. «Тихие» страницы — где контекстные
 * подсказки никогда не показываются. Фильтрация выполняется
 * `HintsEngine.checkFor` ДО оценки DSL-правил: дешёвый short-circuit
 * для иммерсивных режимов, где любая подсказка убивает UX.
 *
 * Список — закрытый, расширяется миграцией кода (изменение —
 * архитектурное решение, не контентное; через админ-UI подсказок
 * не настраивается). При добавлении пункта обнови `HINT_QUIET_PAGES`
 * + соответствующий тест в `apps/api/src/hints/hints.engine.spec.ts`
 * (T6).
 *
 * Формат `pattern` — упрощённый path-glob, совместимый с тем, что
 * приходит в `context.page` от `<HintHost>`:
 *
 *   - `/admin/*`       — любой путь, начинающийся с `/admin/`.
 *   - `/lecture/:id`   — `/lecture/<любой непустой сегмент>`,
 *                        без вложенных `/`.
 *   - `/play/:gameId`  — то же, специально для матча партии.
 *
 * Универсальный glob-парсер шарится с HintsEngine (T6) — не дублируем
 * логику здесь, оставляем константу декларативной.
 */

/**
 * Условие «когда тихо». Большинство страниц тихи всегда
 * (`'always'`). Особый случай — `/play/:gameId` при `low-time-focus`
 * (ADR-144): сама страница НЕ тихая, но при срабатывании режима
 * концентрации на низком времени любая подсказка выключается.
 * Проверку условия делает `HintsEngine` (T6) через сигнал из
 * `clock`/`game`-stat'а, не через `context.page`.
 */
export type HintQuietCondition = 'always' | 'low-time-focus';

export interface HintQuietPage {
  /** Path-pattern (см. формат в шапке файла). */
  readonly pattern: string;
  /** Когда срабатывает фильтр. */
  readonly condition: HintQuietCondition;
  /** Ссылка на источник правила — для следующего читателя кода. */
  readonly source: string;
}

/**
 * Канонический список тихих страниц (ADR-147 §4.2.1). Порядок —
 * декларативный, не влияет на семантику (HintsEngine применяет
 * первый совпавший).
 */
export const HINT_QUIET_PAGES: readonly HintQuietPage[] = [
  {
    pattern: '/live/*',
    condition: 'always',
    source: 'ADR-147 §4.2.1 — иммерсивный просмотр трансляций',
  },
  {
    pattern: '/broadcast/*',
    condition: 'always',
    source: 'ADR-147 §4.2.1 — иммерсивный просмотр трансляций',
  },
  {
    pattern: '/play/:gameId',
    condition: 'low-time-focus',
    source: 'ADR-147 §4.2.1 + ADR-144 — режим концентрации на низком времени',
  },
  {
    pattern: '/lecture/:id',
    condition: 'always',
    source: 'ADR-147 §4.2.1 + ADR-118 — режим лекции, внимание занято',
  },
  {
    pattern: '/admin/*',
    condition: 'always',
    source: 'ADR-147 §4.2.1 — административные страницы',
  },
];

/**
 * Список pattern'ов, для которых страница тихая БЕЗУСЛОВНО
 * (`condition='always'`). Полезен HintsEngine как hot-path: если
 * текущий `context.page` попал сюда — короткий выход без проверки
 * сопутствующих сигналов вроде `low-time-focus`.
 */
export const HINT_QUIET_PAGE_PATTERNS_ALWAYS: readonly string[] =
  HINT_QUIET_PAGES.filter((p) => p.condition === 'always').map(
    (p) => p.pattern,
  );

/**
 * KS-4806 / ADR-153 §2.4. Чистая функция-предикат: попадает ли
 * `pathname` под список «всегда тихих» страниц.
 *
 * Используется одновременно:
 *   - frontend `<HintHost>` — при смене `location.pathname` через
 *     React Router отменяет pending hint c reason='quiet_page', если
 *     новая страница тихая (не ждёт 30s MutationObserver-timeout).
 *   - backend `HintsService.checkFor` — текущий gate `isQuietPage(ctx)`
 *     проверяет тот же список, через тот же matcher. Single source of
 *     truth: pattern'ы не разойдутся между фронтом и бэком.
 *
 * Семантика pattern'ов:
 *   - `*` в pattern'е → `.+` в regex (greedy, через любые `/`).
 *     `/live/*` совпадает с `/live/round1` и с `/live/round1/game1`.
 *   - `:name` → `[^/]+` (один path-сегмент без вложенных `/`).
 *     `/lecture/:id` совпадает с `/lecture/abc`, не совпадает с
 *     `/lecture/abc/def`.
 *   - Остальные символы — литеральные. Regex-specials escape'аются.
 *
 * Чистая функция: ни I/O, ни кэша. `pathname` — то, что обычно лежит
 * в `location.pathname` (без query/hash). Если приходит query — каждый
 * caller должен очистить (`pathname.split('?')[0]`) до вызова.
 */
export function isQuietPage(pathname: string): boolean {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  for (const pattern of HINT_QUIET_PAGE_PATTERNS_ALWAYS) {
    if (quietPagePatternToRegex(pattern).test(pathname)) return true;
  }
  return false;
}

/**
 * Конвертер path-glob → RegExp по семантике HINT_QUIET_PAGES (см.
 * шапку файла и `isQuietPage` выше). Экспорт публичный — может
 * пригодиться backend HintsEngine для общего matcher'а (T6 потенциально
 * переносит свою копию `globMatch` на этот шаринг).
 *
 * Захарденная семантика: `*` → `.+`, `:name` → `[^/]+`. Эта пара
 * покрывает все текущие pattern'ы из `HINT_QUIET_PAGES`. Расширение —
 * редкий случай (новый pattern в const'е), синхронно обновляется
 * и regex здесь.
 */
export function quietPagePatternToRegex(pattern: string): RegExp {
  // Escape всех regex-special символов КРОМЕ `*` и `:` (они имеют
  // нашу собственную семантику в pattern'ах).
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = escaped
    .replace(/\*/g, '.+')                          // `*` → `.+`
    .replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, '[^/]+');  // `:name` → `[^/]+`
  return new RegExp(`^${re}$`);
}
