/**
 * KS-4881 / ADR-160 §3-4. Вычисление слотов занятий по расписанию
 * `daysOfWeek + timeLocal + timezone` без rrule-библиотек.
 *
 * Ядро — конверсия «локальное время IANA-зоны → UTC» через
 * `Intl.DateTimeFormat` (двухпроходный метод: угадываем UTC, меряем
 * фактический offset зоны на этот момент, поправляемся; второй проход
 * закрывает края DST-переходов).
 */

/** Offset зоны (мс) в момент `utcMs`: local = utc + offset. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // hour12:false может отдать "24" для полуночи — нормализуем.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

/**
 * UTC-момент, соответствующий `year-month-day hh:mm` в зоне `timeZone`.
 * При несуществующем локальном времени (весенний DST-скачок) вернёт
 * ближайший корректный момент; при неоднозначном (осенний повтор) —
 * один из двух вариантов, детерминированно.
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hh, mm, 0);
  let guess = naive - tzOffsetMs(naive, timeZone);
  guess = naive - tzOffsetMs(guess, timeZone); // второй проход (DST-края)
  return new Date(guess);
}

/** Компоненты локальной даты зоны в момент `at`. */
function localDateParts(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, d] = dtf.format(at).split('-').map(Number);
  return { y, m, d };
}

/**
 * Ближайший будущий слот расписания в пределах `horizonHours` от `now`
 * (или null). Слот = локальная дата с подходящим днём недели +
 * `timeLocal`, сконвертированные в UTC.
 */
export function nextSlotWithin(
  schedule: { daysOfWeek: number[]; timeLocal: string; timezone: string },
  now: Date,
  horizonHours: number,
): Date | null {
  const [hh, mm] = schedule.timeLocal.split(':').map(Number);
  const horizonMs = horizonHours * 3600_000;
  const days = new Set(schedule.daysOfWeek);

  // Кандидаты: локальные даты «сегодня … сегодня+ceil(horizon/24)+1».
  const maxDays = Math.ceil(horizonHours / 24) + 1;
  for (let i = 0; i <= maxDays; i++) {
    const probe = new Date(now.getTime() + i * 86_400_000);
    const { y, m, d } = localDateParts(probe, schedule.timezone);
    const slot = zonedTimeToUtc(y, m, d, hh, mm, schedule.timezone);
    if (slot.getTime() <= now.getTime()) continue; // уже прошёл
    if (slot.getTime() - now.getTime() > horizonMs) return null;
    // День недели проверяем по ЛОКАЛЬНОЙ дате слота.
    const localDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (days.has(localDow)) return slot;
  }
  return null;
}
