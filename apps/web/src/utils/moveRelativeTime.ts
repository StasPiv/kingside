/**
 * KS-2795. Форматирование «сколько прошло с последнего хода» под мини-доской
 * на странице тура трансляции. В отличие от `relativeTime.ts` (тот заточен
 * под часы/дни активности контента), здесь шкала — секунды/минуты/часы:
 * партия классическая, ход раз в 1–5 минут, секундная точность не нужна,
 * но нужна минутная.
 *
 * Источник времени — `BroadcastGameSummary.clockUpdatedAt` (KS-2699) до
 * появления отдельного `lastMoveAt` от backend. Поле обновляется при
 * каждом применении `%clk` из PGN — то есть практически на каждом ходе
 * классической партии. Если `clockUpdatedAt === null` (нет `%clk` в
 * источнике) — функция возвращает `null` и карточка показывает только
 * SAN без блока времени.
 *
 * Используемые i18n-ключи (см. ru/en translation.json):
 *  - `broadcastRound.lastMove.justNow` — «только что» / «just now»
 *  - `broadcastRound.lastMove.secondsAgo` — «N сек. назад» / «N s ago»
 *  - `broadcastRound.lastMove.minutesAgo` — «N мин. назад» / «N min ago»
 *  - `broadcastRound.lastMove.hoursAgo` — «N ч. назад» / «N h ago»
 *  - `broadcastRound.lastMove.daysAgo` — «N дн. назад» / «N d ago»
 *
 * Все ключи с i18next-plural (`_one/_few/_many/_other` для ru,
 * `_one/_other` для en).
 */

const MS_IN_SECOND = 1000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;

export type MoveAgoT = (
  key: string,
  opts?: Record<string, unknown> & { defaultValue?: string },
) => string;

/**
 * Возвращает локализованную строку «N мин. назад» либо `null` если входное
 * время невалидно (null / пустая строка / нераспарсилось). Никогда не
 * возвращает «сейчас» / «давно» / другие неопределённые формулировки —
 * пустота лучше неточности.
 */
export function formatMoveAgo(
  iso: string | null | undefined,
  now: number,
  t: MoveAgoT,
): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = now - ts;
  // Защита от слегка отрицательной разницы (рассинхрон часов клиент/сервер
  // на пару секунд). До -2 сек трактуем как «только что», ниже — null.
  if (diff < -2 * MS_IN_SECOND) return null;
  const diffPos = Math.max(0, diff);

  if (diffPos < 10 * MS_IN_SECOND) {
    return t('broadcastRound.lastMove.justNow', { defaultValue: 'just now' });
  }
  if (diffPos < MS_IN_MINUTE) {
    const seconds = Math.floor(diffPos / MS_IN_SECOND);
    return t('broadcastRound.lastMove.secondsAgo', {
      count: seconds,
      defaultValue: '{{count}}s ago',
    });
  }
  if (diffPos < MS_IN_HOUR) {
    const minutes = Math.floor(diffPos / MS_IN_MINUTE);
    return t('broadcastRound.lastMove.minutesAgo', {
      count: minutes,
      defaultValue: '{{count}} min ago',
    });
  }
  if (diffPos < MS_IN_DAY) {
    const hours = Math.floor(diffPos / MS_IN_HOUR);
    return t('broadcastRound.lastMove.hoursAgo', {
      count: hours,
      defaultValue: '{{count}}h ago',
    });
  }
  const days = Math.floor(diffPos / MS_IN_DAY);
  return t('broadcastRound.lastMove.daysAgo', {
    count: days,
    defaultValue: '{{count}}d ago',
  });
}

/**
 * Возвращает «точное» представление времени для title-атрибута/tooltip
 * — локализованная дата+время.
 */
export function formatExactMoveTime(
  iso: string | null | undefined,
  locale: string,
): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toLocaleString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: 'short',
    });
  } catch {
    return new Date(ts).toISOString();
  }
}
