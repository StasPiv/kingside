import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface RoundCountdownProps {
  /** ISO-8601 время старта раунда либо `null`, если Lichess не отдал. */
  startsAt: string | null;
}

/**
 * KS-4848 / ADR-158 §2.4.1: обратный отсчёт до старта раунда трансляции.
 *
 * Прогрессивная детализация — чем ближе к старту, тем чаще пере-рендер,
 * чтобы не жечь CPU за 3 часа до начала:
 *   • `startsAt === null`      → «Время старта не объявлено», без tick
 *   • > 24 часов               → абсолютная дата (локаль браузера), tick 5 мин
 *   • 1..24 часа               → «Через 15 ч 20 мин», tick 5 мин
 *   • 5 мин..1 час             → «Через 45 мин», tick 30 сек
 *   • 0..5 мин                 → «Через 04:32», tick 1 сек
 *   • прошлое (задержка старта) → «Раунд должен был начаться в 14:00. Ожидаем…», tick 30 сек
 */
export function RoundCountdown({ startsAt }: RoundCountdownProps) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!startsAt) return;
    const target = new Date(startsAt).getTime();
    if (!Number.isFinite(target)) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      const diffMs = target - Date.now();
      let intervalMs: number;
      if (diffMs <= 0) intervalMs = 30_000;
      else if (diffMs <= 5 * 60_000) intervalMs = 1_000;
      else if (diffMs <= 60 * 60_000) intervalMs = 30_000;
      else intervalMs = 5 * 60_000;
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setNow(Date.now());
        scheduleNext();
      }, intervalMs);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [startsAt]);

  const lang = i18n.language || 'en';

  if (!startsAt) {
    return (
      <div
        className="broadcast-countdown broadcast-countdown--unknown"
        data-testid="broadcast-countdown"
        data-countdown-state="unknown"
      >
        {t('broadcastRound.countdown.notScheduled', 'Start time not announced')}
      </div>
    );
  }

  const target = new Date(startsAt).getTime();
  if (!Number.isFinite(target)) {
    return (
      <div
        className="broadcast-countdown broadcast-countdown--unknown"
        data-testid="broadcast-countdown"
        data-countdown-state="unknown"
      >
        {t('broadcastRound.countdown.notScheduled', 'Start time not announced')}
      </div>
    );
  }

  const diffMs = target - now;

  if (diffMs <= 0) {
    const timeStr = new Date(target).toLocaleTimeString(lang, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div
        className="broadcast-countdown broadcast-countdown--overdue"
        data-testid="broadcast-countdown"
        data-countdown-state="overdue"
      >
        {t('broadcastRound.countdown.overdue', {
          defaultValue: 'Round was scheduled for {{time}}. Awaiting start…',
          time: timeStr,
        })}
      </div>
    );
  }

  if (diffMs > 24 * 60 * 60_000) {
    const dateStr = new Date(target).toLocaleString(lang, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div
        className="broadcast-countdown broadcast-countdown--far"
        data-testid="broadcast-countdown"
        data-countdown-state="far"
      >
        {t('broadcastRound.countdown.startsAt', {
          defaultValue: 'Starts: {{date}}',
          date: dateStr,
        })}
      </div>
    );
  }

  if (diffMs > 60 * 60_000) {
    const totalMinutes = Math.floor(diffMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return (
      <div
        className="broadcast-countdown broadcast-countdown--medium"
        data-testid="broadcast-countdown"
        data-countdown-state="medium"
      >
        {t('broadcastRound.countdown.inHoursMinutes', {
          defaultValue: 'In {{hours}} h {{minutes}} min',
          hours,
          minutes,
        })}
      </div>
    );
  }

  if (diffMs > 5 * 60_000) {
    const minutes = Math.max(1, Math.ceil(diffMs / 60_000));
    return (
      <div
        className="broadcast-countdown broadcast-countdown--near"
        data-testid="broadcast-countdown"
        data-countdown-state="near"
      >
        {t('broadcastRound.countdown.inMinutes', {
          defaultValue: 'In {{count}} min',
          count: minutes,
        })}
      </div>
    );
  }

  const totalSeconds = Math.max(0, Math.ceil(diffMs / 1000));
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const ss = (totalSeconds % 60).toString().padStart(2, '0');
  return (
    <div
      className="broadcast-countdown broadcast-countdown--imminent"
      data-testid="broadcast-countdown"
      data-countdown-state="imminent"
    >
      {t('broadcastRound.countdown.inMmSs', {
        defaultValue: 'In {{mmss}}',
        mmss: `${mm}:${ss}`,
      })}
    </div>
  );
}
