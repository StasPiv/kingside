/**
 * KS-4798 / ADR-152 §2.3. Каталог событий — единый источник правды для
 * UI-meta событий из `events.actor_events` (страница «Мои действия»,
 * `/me/actions`).
 *
 * Архитектура:
 *   - Backend (`EventsService` / `internal-events.controller`) валидирует
 *     `type` грамматикой `^[a-z][a-z0-9_]*$` ≤64 байт без whitelist
 *     (см. `apps/api/src/events/dto/create-events.dto.ts`). Этот каталог
 *     backend не использует — он сознательно не закрытый.
 *   - Frontend (`apps/web/src/pages/MyActionsPage.tsx`) читает каталог
 *     для подписи/категории/href записи. Для неизвестных `type`
 *     `findEventMeta()` возвращает `undefined`, фронт рендерит
 *     fallback (`event.unknown`-key + raw payload) — страница не
 *     ломается на новых событиях, даже если ещё нет локализации.
 *   - `SYSTEM_EVENT_TYPES` импортируется backend'ом для серверной
 *     фильтрации по `showSystem=false` в `GET /me/events` (см. T2,
 *     KS-4799). Список закрытый — изменение требует осознанного коммита.
 *
 * Расширение каталога — без миграций. Новая строка в `EVENT_CATALOG`
 * + i18n-ключ `event.<type>` в `apps/web/src/i18n/locales/{en,ru}.json`
 * → деплой. Backend ничего о каталоге не знает.
 */

export type EventCategory =
  | 'game'
  | 'puzzle'
  | 'lesson'
  | 'drill'
  | 'analysis'
  | 'hint'
  | 'session'
  | 'guest'
  | 'other';

/** Допустимые значения `EventCategory` — для рантайм-проверок и тестов. */
export const EVENT_CATEGORIES: ReadonlyArray<EventCategory> = [
  'game',
  'puzzle',
  'lesson',
  'drill',
  'analysis',
  'hint',
  'session',
  'guest',
  'other',
];

/**
 * Описание одного известного типа события. Все три поля кроме
 * `hrefBuilder` обязательны.
 */
export interface EventMeta {
  /** Совпадает с `actor_events.type`. Уникален в каталоге. */
  type: string;
  /** Группа для UI-чипов фильтра на `/me/actions`. */
  category: EventCategory;
  /** i18n-ключ заголовка (frontend подставит payload через `t()`). */
  titleKey: string;
  /**
   * Опциональный построитель SPA-ссылки по payload'у. Возвращает
   * `null`, если в payload нет нужного поля (например, `game_id`),
   * чтобы фронт не рисовал нерабочую кнопку.
   *
   * Чистая функция: ни I/O, ни побочных эффектов. Контракт ввода —
   * `Record<string, unknown>`, поэтому в имплементации обязательно
   * нарративить типы через `typeof`-чек, а не приведение.
   */
  hrefBuilder?: (payload: Record<string, unknown>) => string | null;
}

/**
 * Базовый набор известных событий. Состав основан на фактических
 * `track()`-вызовах в `apps/api` и `apps/game-service` на момент
 * KS-4798 — не на гипотетических списках. Новые события добавляются
 * декларативно без миграций.
 */
export const EVENT_CATALOG: ReadonlyArray<EventMeta> = [
  // ── game (apps/game-service `endGame`, `resign`, `drawOffer`,
  // apps/api `game.service.ts:trackBoth`) ────────────────────────────
  {
    type: 'game_start',
    category: 'game',
    titleKey: 'event.game_start',
    hrefBuilder: (p) => stringId(p, 'game_id', (id) => `/game/${id}`),
  },
  {
    type: 'game_end',
    category: 'game',
    titleKey: 'event.game_end',
    hrefBuilder: (p) => stringId(p, 'game_id', (id) => `/game/${id}`),
  },
  {
    type: 'resign',
    category: 'game',
    titleKey: 'event.resign',
    hrefBuilder: (p) => stringId(p, 'game_id', (id) => `/game/${id}`),
  },
  {
    type: 'draw_offered',
    category: 'game',
    titleKey: 'event.draw_offered',
    hrefBuilder: (p) => stringId(p, 'game_id', (id) => `/game/${id}`),
  },

  // ── puzzle (apps/api/src/puzzle) ──────────────────────────────────
  {
    type: 'puzzle_start',
    category: 'puzzle',
    titleKey: 'event.puzzle_start',
    hrefBuilder: (p) => stringId(p, 'puzzle_id', (id) => `/puzzle/${id}`),
  },
  {
    type: 'puzzle_solved',
    category: 'puzzle',
    titleKey: 'event.puzzle_solved',
    hrefBuilder: (p) => stringId(p, 'puzzle_id', (id) => `/puzzle/${id}`),
  },
  {
    type: 'puzzle_failed',
    category: 'puzzle',
    titleKey: 'event.puzzle_failed',
    hrefBuilder: (p) => stringId(p, 'puzzle_id', (id) => `/puzzle/${id}`),
  },

  // ── puzzle-rush (apps/api/src/puzzle-rush) ────────────────────────
  {
    type: 'rush_start',
    category: 'puzzle',
    titleKey: 'event.rush_start',
    hrefBuilder: () => '/puzzle-rush',
  },
  {
    type: 'rush_finish',
    category: 'puzzle',
    titleKey: 'event.rush_finish',
    hrefBuilder: (p) =>
      stringId(p, 'score_id', (id) => `/puzzle-rush/review/${id}`)
      ?? '/puzzle-rush',
  },
  {
    type: 'rush_streak_broken',
    category: 'puzzle',
    titleKey: 'event.rush_streak_broken',
  },

  // ── lesson (apps/api/src/lessons) ─────────────────────────────────
  {
    type: 'lesson_open',
    category: 'lesson',
    titleKey: 'event.lesson_open',
    hrefBuilder: (p) => buildLessonHref(p),
  },
  {
    type: 'lesson_start',
    category: 'lesson',
    titleKey: 'event.lesson_start',
    hrefBuilder: (p) => buildLessonHref(p),
  },
  {
    type: 'lesson_complete',
    category: 'lesson',
    titleKey: 'event.lesson_complete',
    hrefBuilder: (p) => buildLessonHref(p),
  },

  // ── tactic-drill (apps/api/src/tactic-drill) ──────────────────────
  {
    type: 'drill_start',
    category: 'drill',
    titleKey: 'event.drill_start',
    hrefBuilder: () => '/drills/sprint',
  },
  {
    type: 'drill_complete',
    category: 'drill',
    titleKey: 'event.drill_complete',
    hrefBuilder: () => '/drills/sprint',
  },

  // ── analysis (apps/api/src/analysis) ──────────────────────────────
  {
    type: 'analysis_open',
    category: 'analysis',
    titleKey: 'event.analysis_open',
    hrefBuilder: (p) =>
      stringId(p, 'analysis_id', (id) => `/analysis/${id}`)
      ?? stringId(p, 'game_id', (id) => `/game/${id}/review`),
  },
  {
    type: 'engine_started',
    category: 'analysis',
    titleKey: 'event.engine_started',
  },

  // ── hint (apps/api/src/hints, ADR-147 §4.2) ───────────────────────
  {
    type: 'hint_shown',
    category: 'hint',
    titleKey: 'event.hint_shown',
  },
  {
    type: 'hint_acted',
    category: 'hint',
    titleKey: 'event.hint_acted',
  },
  {
    type: 'hint_used',
    category: 'hint',
    titleKey: 'event.hint_used',
  },

  // ── session (системные, скрыты по умолчанию через showSystem=false) ─
  {
    type: 'page_view',
    category: 'session',
    titleKey: 'event.page_view',
    hrefBuilder: (p) => stringField(p, 'path'),
  },
  {
    type: 'session_start',
    category: 'session',
    titleKey: 'event.session_start',
  },
  {
    type: 'session_idle',
    category: 'session',
    titleKey: 'event.session_idle',
  },

  // ── guest (для гостевых сессий — фоном; не показывается в /me/actions) ─
  {
    type: 'guest_landing_viewed',
    category: 'guest',
    titleKey: 'event.guest_landing_viewed',
  },
  {
    type: 'guest_play_attempted',
    category: 'guest',
    titleKey: 'event.guest_play_attempted',
  },

  // ── other ─────────────────────────────────────────────────────────
  {
    type: 'feature_used',
    category: 'other',
    titleKey: 'event.feature_used',
  },
  {
    type: 'no_lives',
    category: 'other',
    titleKey: 'event.no_lives',
  },
];

/**
 * Закрытый список «шумных» событий, который backend отрезает в
 * `GET /me/events` при `showSystem=false`. Изменения здесь — это
 * изменение публичного контракта; нельзя расширять list автоматически.
 */
export const SYSTEM_EVENT_TYPES: ReadonlyArray<string> = [
  'page_view',
  'session_idle',
  'session_start',
];

/**
 * Поиск меты по типу. `undefined` для неизвестных типов —
 * сознательно: страница `/me/actions` должна продолжать работать при
 * появлении нового `type` в БД до того, как разработчик добавит
 * строку в каталог и i18n-ключ.
 */
export function findEventMeta(type: string): EventMeta | undefined {
  return EVENT_CATALOG.find((m) => m.type === type);
}

/**
 * Категория события или `'other'`, если тип не в каталоге. Удобно для
 * группировки на UI без отдельной ветки на `undefined`.
 */
export function resolveEventCategory(type: string): EventCategory {
  return findEventMeta(type)?.category ?? 'other';
}

// ── internal helpers ────────────────────────────────────────────────

/**
 * Безопасно извлечь строковое поле `key` из payload и пропустить через
 * builder. Возвращает `null` если поля нет / оно пустое / не строка.
 */
function stringId(
  payload: Record<string, unknown>,
  key: string,
  builder: (id: string) => string,
): string | null {
  const v = payload[key];
  if (typeof v !== 'string' || v.length === 0) {
    return null;
  }
  return builder(v);
}

/** Поле как строка или null. Используется для `page_view.path`. */
function stringField(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Урок в БД хранится как `(courseSlug, lessonSlug)` — не как один id.
 * Если в payload оба поля — строим вложенный URL; иначе откат на
 * страницу курса или общий список. Имена ключей выровнены с тем, что
 * пишет `apps/api/src/lessons/progress.service.ts` в `track('lesson_*')`.
 */
function buildLessonHref(payload: Record<string, unknown>): string | null {
  const course = payload.course_slug;
  const lesson = payload.lesson_slug;
  if (typeof course === 'string' && course.length > 0) {
    if (typeof lesson === 'string' && lesson.length > 0) {
      return `/lessons/${course}/${lesson}`;
    }
    return `/lessons/${course}`;
  }
  return null;
}
