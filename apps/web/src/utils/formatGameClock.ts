/**
 * KS-4651 / ADR-144 §3.2-§3.3 — единый формат отображения шахматных
 * часов и расчёт уровня срочности (urgency) по остатку времени.
 *
 * Эта утилита — фундамент для трёх потребителей часов (live, local-bot,
 * broadcast). UI/хуки/CSS правит следующая задача (KS-4651 не трогает
 * компоненты — только pure-функции и тесты).
 *
 * Сейчас в проекте уже есть похожая `formatBroadcastClock` в
 * `hooks/useBroadcastClock.ts` — для нормального режима поведение
 * совпадает (mm:ss / H:MM:SS), но новая утилита дополнительно умеет
 * tenths/hundredths и кладёт всё в одно место. Перевод broadcast на
 * новую утилиту — отдельная задача (см. ADR-144 §4 п.1).
 */

/**
 * Режим вывода. Выбирается потребителем по результату
 * `computeClockUrgency` (см. ADR-144 §3.3):
 *   - `normal` → `mm:ss` / `H:MM:SS` (≥1 ч).
 *   - `tenths` → `mm:ss.t` (одна цифра десятых) — для `urgency='low'`.
 *   - `hundredths` → `ss.tt` без минут (или `m:ss.tt` если осталась
 *     минута) — для `urgency='critical'`.
 */
export type ClockMode = 'normal' | 'tenths' | 'hundredths';

/**
 * Уровень срочности часов активной стороны. `low`/`critical` —
 * сигнал UI поменять подсветку, включить тиканье, переключить
 * `ClockMode` на дробный (см. ADR-144 §3.5 / §3.6).
 */
export type ClockUrgency = 'normal' | 'low' | 'critical';

/**
 * Нормализованный остаток времени — без NaN/Infinity, без
 * отрицательных значений (упавший флаг отображается как `0:00`).
 * Используется внутри `formatGameClock`.
 */
function normalizeMs(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return 0;
  return remainingMs < 0 ? 0 : remainingMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * KS-4651 / ADR-144 §3.3. Единое форматирование часов для всех мест,
 * где они отображаются.
 *
 * Контракт по примерам:
 *   - `normal`: `5:23`, `12:00`, `1:02:45` (≥1 ч), `0:00` (нолик/упавший флаг).
 *   - `tenths`: `0:09.4`, `1:00.5`, `0:00.0`.
 *   - `hundredths`: `9.43`, `59.99`, `1:00.00`, `1:05.43`, `0.00`.
 *
 * Отрицательные значения и NaN/Infinity нормализуются в 0 — это
 * страховка от пограничных серверных сообщений (ADR-144 §3.6 говорит,
 * что fall-flag отдельным событием `game:claim-timeout`, но визуально
 * клиент должен показать нолик ещё до получения этого события).
 *
 * `mode` выбирается потребителем (см. README ADR-144 §3.3): для
 * неактивной стороны — всегда `normal`, чтобы дробные доли не
 * отвлекали обоих игроков сразу. Здесь это лишь форматтер; правила
 * выбора режима живут в `useGameClockDisplay` (KS-4652).
 */
export function formatGameClock(
  remainingMs: number,
  mode: ClockMode,
): string {
  const ms = normalizeMs(remainingMs);

  if (mode === 'normal') {
    // Те же правила, что у `formatBroadcastClock` (KS-2700): округляем
    // вниз до секунды, показываем `H:MM:SS` только когда есть хоть
    // один час (`h > 0`). 3600000 мс → `1:00:00`, 3599999 → `59:59`.
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
    return `${m}:${pad2(s)}`;
  }

  if (mode === 'tenths') {
    // `mm:ss.t` — одна цифра десятых. Округляем ВНИЗ, чтобы при
    // прокрутке часы не «прыгали через» очередную десятую.
    const totalTenths = Math.floor(ms / 100);
    const tenths = totalTenths % 10;
    const totalSec = Math.floor(totalTenths / 10);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    // ≥1 ч в tenths практически невозможно (порог `emergency1` ≤30c),
    // но безопасно обрабатываем так же как normal — иначе на странном
    // input'е `mm` >= 60 показалось бы плоское `100:09.4`.
    if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}.${tenths}`;
    return `${m}:${pad2(s)}.${tenths}`;
  }

  // mode === 'hundredths'
  // `ss.tt` без минут пока ms < 60_000; `mm:ss.tt` иначе.
  // Округляем ВНИЗ до сотых.
  const totalHundredths = Math.floor(ms / 10);
  const hundredths = totalHundredths % 100;
  const totalSec = Math.floor(totalHundredths / 100);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}.${pad2(hundredths)}`;
  if (m > 0) return `${m}:${pad2(s)}.${pad2(hundredths)}`;
  return `${s}.${pad2(hundredths)}`;
}

/**
 * KS-4651 / ADR-144 §3.2. Уровень срочности по остатку времени.
 *
 * Пороги:
 *   emergency1 = clamp(initialMs * 0.10, 8_000, 30_000)
 *   emergency2 = clamp(initialMs * 0.025, 2_000, 8_000)
 *
 * Семантика порогов: `low` — пора напрячься (включаем десятые, янтарь);
 * `critical` — последние секунды (сотые, красная пульсация, тиканье).
 * Подход взят у lichess (`emerg` в `clockView.ts`).
 *
 * Если `initialMs` неизвестно (например, наблюдатель за live-партией
 * без `timeControl` в state) — fallback `emergency1=30_000`,
 * `emergency2=8_000` (нижняя планка по разумной партии).
 *
 * Отрицательные/нулевые `remainingMs` → `'critical'` (флаг уже падает).
 * NaN/Infinity в `remainingMs` нормализуются в 0 → `'critical'`.
 * NaN/Infinity в `initialMs` трактуем как «неизвестно» → fallback.
 */
export function computeClockUrgency(
  remainingMs: number,
  initialMs: number | null,
): ClockUrgency {
  const safeRemaining = Number.isFinite(remainingMs) ? remainingMs : 0;
  const hasInitial = initialMs != null && Number.isFinite(initialMs);
  const emergency1 = hasInitial
    ? clamp((initialMs as number) * 0.10, 8_000, 30_000)
    : 30_000;
  const emergency2 = hasInitial
    ? clamp((initialMs as number) * 0.025, 2_000, 8_000)
    : 8_000;
  if (safeRemaining <= emergency2) return 'critical';
  if (safeRemaining <= emergency1) return 'low';
  return 'normal';
}
