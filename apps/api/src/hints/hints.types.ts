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
  /**
   * KS-4823. Расширенный текст инструкции (popover «Подробнее»).
   * Опционален в JSON; парсер safe-приведёт к `string|null`.
   */
  instructionBody?: string | null;
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
  // KS-4810 follow-up (запрос пользователя по KS-4802): глобальный
  // throttle убран по умолчанию. Любой hint, который успешно прошёл
  // per-hint state-checks и DSL, показывается без 10-минутного блока.
  // На прод-окружении прежнее значение можно вернуть env-var'ом
  // `HINTS_GLOBAL_THROTTLE_SEC=<sec>` (см. `hints-limits.service.ts`).
  globalThrottleSec: 0,
  // Symmetric: квота показов в сутки тоже убрана из дефолтов. Если
  // нужно ограничение — env-var `HINTS_SESSION_MAX_SHOWS=<int>` либо
  // `HINTS_DEFAULTS_OVERRIDE_JSON`.
  sessionMaxShows: 1_000_000,
  smartDismissWindowH: 24,
  // KS-4788 / ADR-151 §2.3. Окно реплея на WS-handshake: hint, у которого
  // `lastShownAt > now - replayWindowSec` и нет client-ack, повторно
  // эмитится при reconnect. 60s — десятикратный запас на типовой
  // page reload (1–5с), при этом достаточно коротко, чтобы не отдавать
  // протухший popover.
  replayWindowSec: 60,
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
