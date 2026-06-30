/**
 * KS-4825 / ADR-154. Серверная подстановка `{{var}}` в payload
 * контекстной подсказки (`hint:show`) из триггерующего события.
 *
 * Контракт:
 *   - Синтаксис: Mustache-минимум, `{{<name>}}`, regex
 *     `/\{\{([a-z][a-z0-9_]{0,31})\}\}/g`. Без условий/итераций/фильтров.
 *   - Whitelist допустимых переменных — на trigger_event_type, см.
 *     `TRIGGER_VAR_WHITELIST`. Имя переменной отсутствует в whitelist'е
 *     → плейсхолдер считается «не разрешённым».
 *   - Шаблонизируются только три поля payload: `ctaHref`, `ctaLabel`,
 *     `instructionBody`. `title`/`body`/`anchor`/`ctaEvent` — без
 *     подстановки.
 *   - Значения coerce'ятся в строку через `String()`. Подставленные
 *     значения в `ctaHref` дополнительно проходят `encodeURIComponent`
 *     для URL-безопасности (см. ADR-154 §2.4).
 *   - Fallback при нерезолвенных vars (ADR-154 §2.7):
 *       * `ctaHref` — fallback на `fallbackHref` если задан; иначе
 *         `null`. При итоге `null` принудительно зачищается и
 *         `ctaLabel` — «битая» кнопка пользователю не показывается.
 *       * `ctaLabel` / `instructionBody` — нерешённый плейсхолдер
 *         удаляется (replace на пустую строку), trim. Если итог
 *         пустой — поле `null`.
 *   - Валидация шаблонов на админ-CRUD (см. `parseTemplateVars`):
 *     парсер собирает все `{{var}}` в полях, сравнивает с whitelist'ом
 *     для упомянутых в `rule` event-имён. Неизвестная переменная →
 *     ошибка с указанием поля.
 *
 * Чистый модуль без I/O и зависимостей от Nest/Prisma. Импортируется
 * и backend (`HintsService.checkFor`, `HintsAdminService`), и frontend
 * (для админ-превью — будущая UX-задача из ADR §6).
 */
import type { HintShowPayload } from './hint-payload.js';

/** Регекс плейсхолдера. `g`-флаг чтобы `replace` шёл по всем вхождениям. */
export const HINT_TEMPLATE_PLACEHOLDER_RE = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

/** Описание одной разрешённой переменной для конкретного trigger_event_type. */
export interface TriggerVarSpec {
  /** Имя переменной в шаблоне (без скобок). */
  name: string;
  /** Из какого поля `triggerEvent.payload` берётся значение. */
  payloadField: string;
  /** Тип значения для админ-валидации и тестов. */
  type: 'string' | 'number' | 'boolean';
}

/**
 * Whitelist переменных по триггерующему событию. Закрытый список —
 * расширяется явно при появлении нового кейса (минор-PR со spec'ом).
 *
 * Источники полей `payloadField` — см. ADR-147 §2.1, и фактический
 * `EventsService.track(...)` в:
 *   - `apps/game-service/src/game/game.service.ts` (`game_end`,
 *     `game_start`, `resign`, `draw_offered`),
 *   - `apps/api/src/puzzle/...` (puzzle_start/solved/failed),
 *   - `apps/api/src/puzzle-rush/...` (rush_start/finish),
 *   - `apps/api/src/lessons/...` (lesson_open/start/complete),
 *   - `apps/api/src/tactic-drill/...` (drill_start/complete),
 *   - `apps/api/src/analysis/...` (analysis_open / engine_started).
 */
export const TRIGGER_VAR_WHITELIST: Readonly<
  Record<string, ReadonlyArray<TriggerVarSpec>>
> = {
  game_end: [
    { name: 'game_id',      payloadField: 'game_id',      type: 'string' },
    { name: 'result',       payloadField: 'result',       type: 'string' },
    { name: 'time_control', payloadField: 'time_control', type: 'string' },
    { name: 'rating_delta', payloadField: 'rating_delta', type: 'number' },
  ],
  game_start: [
    { name: 'game_id',      payloadField: 'game_id',      type: 'string' },
    { name: 'time_control', payloadField: 'time_control', type: 'string' },
  ],
  resign: [
    { name: 'game_id',      payloadField: 'game_id',      type: 'string' },
  ],
  draw_offered: [
    { name: 'game_id',      payloadField: 'game_id',      type: 'string' },
  ],
  puzzle_solved: [
    { name: 'puzzle_id',    payloadField: 'puzzle_id',    type: 'string' },
    { name: 'theme',        payloadField: 'theme',        type: 'string' },
    { name: 'attempts',     payloadField: 'attempts',     type: 'number' },
  ],
  puzzle_failed: [
    { name: 'puzzle_id',    payloadField: 'puzzle_id',    type: 'string' },
    { name: 'theme',        payloadField: 'theme',        type: 'string' },
    { name: 'attempts',     payloadField: 'attempts',     type: 'number' },
  ],
  rush_finish: [
    { name: 'score',        payloadField: 'score',        type: 'number' },
    { name: 'mode',         payloadField: 'mode',         type: 'string' },
  ],
  lesson_start: [
    { name: 'lesson_id',    payloadField: 'lesson_id',    type: 'string' },
    { name: 'course_id',    payloadField: 'course_id',    type: 'string' },
  ],
  lesson_complete: [
    { name: 'lesson_id',    payloadField: 'lesson_id',    type: 'string' },
    { name: 'course_id',    payloadField: 'course_id',    type: 'string' },
  ],
  drill_complete: [
    { name: 'drill_id',     payloadField: 'drill_id',     type: 'string' },
  ],
  analysis_open: [
    { name: 'analysis_id',  payloadField: 'analysis_id',  type: 'string' },
    { name: 'game_id',      payloadField: 'game_id',      type: 'string' },
  ],
  // Гостевые и системные — без переменных (см. ADR §2.5).
  guest_landing_viewed: [],
  guest_play_attempted: [],
  page_view: [],
  session_idle: [],
  session_start: [],
  hint_shown: [],
  hint_acted: [],
  hint_used: [],
  engine_started: [],
};

/** Доступные переменные для конкретного triggerType. Пустой массив если тип неизвестен. */
export function getTriggerVars(
  triggerType: string | undefined,
): ReadonlyArray<TriggerVarSpec> {
  if (!triggerType) return [];
  return TRIGGER_VAR_WHITELIST[triggerType] ?? [];
}

export interface ApplyTemplateContext {
  triggerEventType?: string;
  triggerEventPayload?: Record<string, unknown> | null | undefined;
}

/**
 * Подставляет `{{var}}` в шаблонизируемые поля payload. См. ADR-154
 * §2.6 алгоритм + §2.7 fallback. Не модифицирует входной объект.
 *
 * `fallbackHref` — опциональный fallback для `ctaHref`, должен
 * прилетать снаружи из `Hint.cta.fallbackHref` (см. ADR §2.7).
 */
export function applyTemplate(
  payload: HintShowPayload,
  ctx: ApplyTemplateContext,
  fallbackHref: string | null = null,
): HintShowPayload {
  const allowed = getTriggerVars(ctx.triggerEventType);
  const resolveVar = (name: string): string | null => {
    const spec = allowed.find((v) => v.name === name);
    if (!spec) return null;
    const raw = ctx.triggerEventPayload?.[spec.payloadField];
    if (raw === undefined || raw === null) return null;
    return String(raw);
  };

  // ctaHref: подставленные значения URL-encode'им. Если хоть один
  // placeholder не разрешён — используем fallback или null.
  const ctaHrefResolved = (() => {
    const input = payload.ctaHref;
    if (input == null) return null;
    if (!HINT_TEMPLATE_PLACEHOLDER_RE.test(input)) return input;
    // Re-reset из-за `g`-флага у глобального regex'а.
    HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
    let anyUnresolved = false;
    const out = input.replace(HINT_TEMPLATE_PLACEHOLDER_RE, (_, name: string) => {
      const v = resolveVar(name);
      if (v == null) { anyUnresolved = true; return ''; }
      return encodeURIComponent(v);
    });
    return anyUnresolved ? fallbackHref : out;
  })();

  const replaceText = (input: string | null | undefined): string | null => {
    if (input == null) return null;
    if (!HINT_TEMPLATE_PLACEHOLDER_RE.test(input)) return input;
    HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
    const out = input
      .replace(HINT_TEMPLATE_PLACEHOLDER_RE, (_, name: string) => resolveVar(name) ?? '')
      .trim();
    return out.length > 0 ? out : null;
  };

  const ctaLabelResolved = ctaHrefResolved == null
    ? null  // ADR §2.7: «битая» кнопка пользователю не показывается.
    : replaceText(payload.ctaLabel);
  const instructionBodyResolved = replaceText(payload.instructionBody);

  return {
    ...payload,
    ctaHref: ctaHrefResolved,
    ctaLabel: ctaLabelResolved,
    instructionBody: instructionBodyResolved,
  };
}

/**
 * Извлечь имена `{{var}}` из строки. Дубликаты убраны. Используется
 * админ-валидацией в `HintsAdminService.create/update` для проверки,
 * что все плейсхолдеры разрешены текущим набором triggerType'ов.
 */
export function parseTemplateVars(input: string | null | undefined): string[] {
  if (input == null) return [];
  HINT_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = HINT_TEMPLATE_PLACEHOLDER_RE.exec(input)) !== null) {
    seen.add(m[1]);
  }
  return [...seen];
}
