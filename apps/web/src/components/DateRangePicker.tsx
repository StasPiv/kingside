import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './DateRangePicker.css';

/**
 * KS-3081. Компактный date range-picker для фильтров архива.
 *
 * До KS-3081 у нас было два отдельных `<input type="date">` (since/until).
 * Это занимало два поля в фильтре, не очень дружелюбно к mobile и не
 * показывало «диапазон» как единое целое (Aviasales/Booking-pattern).
 *
 * Без новой зависимости — пишем минимальный календарь на нативном JS.
 * Состояние pickаemое снаружи (`{ from, to }` в ISO YYYY-MM-DD,
 * пустая строка = «не задано»). Внутренний state — выбранный диапазон
 * во время drafting'а в popup'е (применение по Apply, отмена по
 * Cancel/Esc/clickOutside без apply).
 */

export interface DateRangeValue {
  /** ISO `YYYY-MM-DD` или пустая строка, если не задано. */
  from: string;
  /** ISO `YYYY-MM-DD` или пустая строка. */
  to: string;
}

export interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** ARIA-label триггер-кнопки. */
  ariaLabel?: string;
  /** Префикс для `data-testid` — позволяет иметь несколько пикеров на странице. */
  testIdPrefix?: string;
  /** Заголовок над календарём в popup'е. */
  popupTitle?: string;
}

function toIso(d: Date): string {
  // Локальное время → ISO YYYY-MM-DD (без часового пояса, чтобы
  // совпадать с тем как пользователь видит дату на доске календаря).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromIsoOrNull(iso: string): Date | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return new Date(y, mo, d);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isBetween(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function buildMonthGrid(viewMonth: Date): Date[] {
  // 7 колонок × 6 строк = 42 дня. Первая колонка — понедельник.
  const first = startOfMonth(viewMonth);
  const dow = (first.getDay() + 6) % 7; // 0 = пн, 6 = вс
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - dow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return cells;
}

function formatMonth(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(d);
}

function formatShortDate(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function weekdayLabels(locale: string): string[] {
  // Понедельник как первый день. Создаём опорную пнделю и берём short.
  // 2024-01-01 — понедельник.
  const base = new Date(2024, 0, 1);
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    out.push(fmt.format(new Date(base.getFullYear(), 0, 1 + i)));
  }
  return out;
}

export function DateRangePicker({
  value,
  onChange,
  ariaLabel,
  testIdPrefix = 'date-range-picker',
  popupTitle,
}: DateRangePickerProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'ru';

  const [open, setOpen] = useState(false);
  // Draft диапазон в popup'е — применяется только по «Apply».
  const [draftFrom, setDraftFrom] = useState<Date | null>(fromIsoOrNull(value.from));
  const [draftTo, setDraftTo] = useState<Date | null>(fromIsoOrNull(value.to));
  const [viewMonth, setViewMonth] = useState<Date>(() =>
    fromIsoOrNull(value.from) ?? fromIsoOrNull(value.to) ?? startOfMonth(new Date()),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Sync draft с внешним value, когда popup закрыт (если внешний
  // источник изменил фильтр).
  useEffect(() => {
    if (!open) {
      setDraftFrom(fromIsoOrNull(value.from));
      setDraftTo(fromIsoOrNull(value.to));
    }
  }, [open, value.from, value.to]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Esc → close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handleDayClick = useCallback(
    (d: Date) => {
      // 1-й клик: start. 2-й клик: end. Если second < first — swap.
      // 3-й клик (после полной выборки) — начинает новый range.
      if (!draftFrom || (draftFrom && draftTo)) {
        setDraftFrom(d);
        setDraftTo(null);
        return;
      }
      if (d.getTime() < draftFrom.getTime()) {
        setDraftFrom(d);
        setDraftTo(draftFrom);
      } else {
        setDraftTo(d);
      }
    },
    [draftFrom, draftTo],
  );

  const apply = useCallback(() => {
    onChange({
      from: draftFrom ? toIso(draftFrom) : '',
      to: draftTo ? toIso(draftTo) : '',
    });
    setOpen(false);
  }, [draftFrom, draftTo, onChange]);

  const reset = useCallback(() => {
    setDraftFrom(null);
    setDraftTo(null);
    onChange({ from: '', to: '' });
    setOpen(false);
  }, [onChange]);

  const triggerLabel = useMemo(() => {
    const f = fromIsoOrNull(value.from);
    const tt = fromIsoOrNull(value.to);
    if (f && tt) return `${formatShortDate(f, locale)} — ${formatShortDate(tt, locale)}`;
    if (f) return `${t('dateRange.fromShort', 'From')} ${formatShortDate(f, locale)}`;
    if (tt) return `${t('dateRange.untilShort', 'Until')} ${formatShortDate(tt, locale)}`;
    return t('dateRange.placeholder', 'Select dates');
  }, [value.from, value.to, locale, t]);

  const grid = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const weekdays = useMemo(() => weekdayLabels(locale), [locale]);
  const today = new Date();

  return (
    <div className="date-range-picker" ref={rootRef} data-testid={testIdPrefix}>
      <button
        type="button"
        className="date-range-picker__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={`${testIdPrefix}-trigger`}
      >
        <span className="date-range-picker__trigger-icon" aria-hidden="true">📅</span>
        <span className="date-range-picker__trigger-text">{triggerLabel}</span>
      </button>

      {open && (
        <div
          ref={popupRef}
          className="date-range-picker__popup"
          role="dialog"
          aria-modal="false"
          aria-label={popupTitle ?? t('dateRange.popupTitle', 'Select date range')}
          data-testid={`${testIdPrefix}-popup`}
        >
          <div className="date-range-picker__nav">
            <button
              type="button"
              className="date-range-picker__nav-btn"
              onClick={() => setViewMonth((m) => addMonths(m, -1))}
              aria-label={t('dateRange.prevMonth', 'Previous month')}
              data-testid={`${testIdPrefix}-prev-month`}
            >
              ‹
            </button>
            <span
              className="date-range-picker__month-label"
              data-testid={`${testIdPrefix}-month-label`}
            >
              {formatMonth(viewMonth, locale)}
            </span>
            <button
              type="button"
              className="date-range-picker__nav-btn"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              aria-label={t('dateRange.nextMonth', 'Next month')}
              data-testid={`${testIdPrefix}-next-month`}
            >
              ›
            </button>
          </div>

          <div className="date-range-picker__weekdays" aria-hidden="true">
            {weekdays.map((w, i) => (
              <span key={i} className="date-range-picker__weekday">
                {w}
              </span>
            ))}
          </div>

          <div className="date-range-picker__grid" role="grid">
            {grid.map((d) => {
              const isCurrentMonth = d.getMonth() === viewMonth.getMonth();
              const isStart = draftFrom ? sameDay(d, draftFrom) : false;
              const isEnd = draftTo ? sameDay(d, draftTo) : false;
              const inRange =
                draftFrom && draftTo ? isBetween(d, draftFrom, draftTo) : false;
              const isToday = sameDay(d, today);
              const cls = [
                'date-range-picker__day',
                !isCurrentMonth ? 'is-outside' : '',
                isStart ? 'is-start' : '',
                isEnd ? 'is-end' : '',
                inRange && !isStart && !isEnd ? 'is-in-range' : '',
                isToday ? 'is-today' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  type="button"
                  key={toIso(d)}
                  className={cls}
                  onClick={() => handleDayClick(d)}
                  data-testid={`${testIdPrefix}-day-${toIso(d)}`}
                  data-iso={toIso(d)}
                  aria-pressed={isStart || isEnd || inRange}
                  tabIndex={isCurrentMonth ? 0 : -1}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="date-range-picker__footer">
            <button
              type="button"
              className="date-range-picker__btn date-range-picker__btn--reset"
              onClick={reset}
              data-testid={`${testIdPrefix}-reset`}
            >
              {t('common.reset', 'Reset')}
            </button>
            <button
              type="button"
              className="date-range-picker__btn date-range-picker__btn--apply"
              onClick={apply}
              data-testid={`${testIdPrefix}-apply`}
            >
              {t('common.apply', 'Apply')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
