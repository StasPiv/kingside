/**
 * KS-4689 / ADR-147 §4.2 + §9. Закрытый список значений атрибута
 * `data-hint-anchor` — единственная точка истины, к которой может
 * «прилипнуть» контекстная подсказка (popover на десктопе,
 * bottom-sheet на мобильном).
 *
 * Контракт: значение, которое сервер передаёт в WS-событии
 * `hint:show` (поле `anchor`), ОБЯЗАНО присутствовать в этом списке.
 * Frontend (`<HintHost>`) ищет узел через `document.querySelector(
 * '[data-hint-anchor="<key>"]')`. Если на текущей странице узла нет —
 * клиент шлёт `hint:no-anchor`, сервер фиксирует `hint_dismissed
 * { reason: 'no_anchor' }` и больше эту подсказку в текущем page-view
 * не предлагает (ADR-147 §4.2 п.2).
 *
 * Расширение списка — миграция кода: новый anchor нужно одновременно
 * добавить сюда (контракт), расставить `data-hint-anchor=...` в JSX
 * (T10) и выпустить версию shared-пакета. Через админ-UI подсказок
 * (T12) anchor НЕ создаётся — это архитектурное решение по UI,
 * не контентное.
 */

/**
 * Гостевые anchors — точки на публичных страницах (ADR-128). Видны
 * незарегистрированному посетителю, используются гостевыми правилами
 * (`targetActorTypes: ['guest']`, см. §9: `guest-register-prompt`,
 * `guest-try-puzzles`, `guest-play-friction`).
 */
export const HINT_ANCHORS_GUEST = [
  /** Кнопка регистрации в шапке/лендинге — для `guest-register-prompt`,
   *  `guest-play-friction`. */
  'landing-signup-button',
  /** Плитка пазлов на лендинге — для `guest-try-puzzles`. */
  'landing-puzzles-tile',
  /** Кнопка «Играть» на лендинге — для подсказок о регистрации перед
   *  попыткой партии. */
  'landing-play-button',
  /** Блок «Возможности» лендинга — для общих подсказок о фичах. */
  'landing-features-block',
] as const;

/**
 * Anchors для авторизованных пользователей — точки внутри
 * SPA после логина. Источник — стартовый набор подсказок §9.
 */
export const HINT_ANCHORS_USER = [
  /** Кнопка/таб «Анализ» на экране завершённой партии —
   *  `analyze-your-game`. */
  'game-end-analysis-button',
  /** Иконка настроек доски в `/play/*` — `try-pre-move`
   *  (открывает `BoardSettingsModal` через `ctaEvent`). */
  'board-settings-icon',
  /** Плитка пазлов на главной — `puzzles-comeback`. */
  'home-puzzles-tile',
  /** Таб «Puzzle Rush» в разделе пазлов — `rush-mode-discovery`. */
  'puzzles-rush-tab',
  /** Ссылка «Дневник ошибок» в профиле — `mistakes-diary`. */
  'profile-mistakes-link',
] as const;

/**
 * Объединённый набор anchors. Литеральный тип `HintAnchor` — то, что
 * валидируется на входе/выходе контрактов (`HintShowPayload.anchor`).
 */
export const HINT_ANCHORS = [
  ...HINT_ANCHORS_GUEST,
  ...HINT_ANCHORS_USER,
] as const;

export type HintAnchorGuest = (typeof HINT_ANCHORS_GUEST)[number];
export type HintAnchorUser = (typeof HINT_ANCHORS_USER)[number];
export type HintAnchor = HintAnchorGuest | HintAnchorUser;

/**
 * Type-guard: проверка, что произвольная строка — валидный anchor.
 * Используется на входе сервера (валидация payload из БД-правила) и
 * на клиенте (защита от рассинхронизации версии shared-пакета между
 * фронтом и бэком).
 */
export function isHintAnchor(value: unknown): value is HintAnchor {
  return (
    typeof value === 'string' &&
    (HINT_ANCHORS as readonly string[]).includes(value)
  );
}
