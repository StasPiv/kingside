/**
 * KS-4699 / ADR-147 §3 + §4. Внутренние типы HintsModule.
 * Не реэкспорт shared (HintShowPayload и компания живут в
 * `@kingside/shared`); здесь — то, что нужно только этому модулю.
 */
import type { Actor } from '../events/events.types';

/**
 * Контекст, который HintsEngine получает на проверке (через hook
 * EventsService.onTrack или явный POST из контроллеров T8).
 */
export interface HintCheckContext {
  /** Текущая страница пользователя (`/play/abc`, `/`, `/admin/...`). */
  page?: string;
  /** Тип события, которое спровоцировало check (`game_end`, ...). */
  triggerEventType?: string;
  /** Дополнительный сигнал для quiet-pages (например, для
   *  `/play/:gameId` при `clock_low_time_focus`). */
  clockLowTimeFocus?: boolean;
}

/** Один локализованный bundle из `Hint.i18n`. */
export interface HintI18nEntry {
  title: string;
  body: string;
  ctaLabel?: string | null;
}

/** Tuple для `Hint.cta`. */
export interface HintCtaPayload {
  href?: string | null;
  event?: string | null;
}

/** Имена ключей feature-flags для hints (§5.2). */
export const HINTS_FLAGS = {
  enabled: 'hints.enabled',
  globalThrottleSec: 'hints.global_throttle_seconds',
  sessionMaxShows: 'hints.session_max_shows',
  smartDismissWindowH: 'hints.smart_dismiss_window_hours',
} as const;

export const HINTS_DEFAULTS = {
  enabled: false,
  globalThrottleSec: 600, // 10 минут
  sessionMaxShows: 5,
  smartDismissWindowH: 24,
} as const;

/** Префиксы Redis-ключей для лимитов (§5.2). */
export function throttleKey(actorId: string): string {
  return `hints:throttle:${actorId}`;
}
export function sessionCounterKey(actorId: string, dateIso: string): string {
  // Date в формате YYYY-MM-DD UTC, чтобы лимит был «в сутки», не
  // «в скользящее окно».
  return `hints:session:${actorId}:${dateIso}`;
}

export function todayUtc(now: Date = new Date()): string {
  // Берём только YYYY-MM-DD ISO без времени.
  return now.toISOString().slice(0, 10);
}

export interface ActorRef extends Actor {}
