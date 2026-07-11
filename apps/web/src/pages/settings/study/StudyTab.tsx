import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useStudySchedule } from '../../../hooks/useStudySchedule';
import type { StudyFocus } from '@kingside/shared';

/**
 * KS-4883 / ADR-160 (задача 4 из 6). Вкладка «Занятия» в /settings:
 *   - расписание: дни недели, локальное время + таймзона (IANA),
 *     длительность занятия, долгосрочный фокус, вкл/выкл;
 *   - каналы уведомлений: onsite и Telegram (подключение по deep-link
 *     `t.me/<bot>?start=<token>`, подтверждение — /start в боте).
 *
 * Сохранение — единой кнопкой (PUT /study/schedule, upsert). Каналы
 * управляются отдельно (POST/DELETE /study/channels) — им кнопка
 * «Сохранить» не нужна.
 */

/** Порядок отображения дней: с понедельника; значения — 0=вс…6=сб. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const SESSION_MINUTES_OPTIONS = [15, 30, 45, 60, 90] as const;

const FOCUS_OPTIONS: StudyFocus[] = ['balanced', 'tactics', 'openings', 'endgames'];

/** Таймзона браузера — дефолт для нового расписания. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Список IANA-таймзон; фолбэк — минимальный набор + браузерная. */
function timezoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC', 'Europe/Prague', 'Europe/Moscow', 'Europe/Kiev', 'America/New_York'];
  }
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones;
}

export function StudyTab(): ReactElement {
  const { t } = useTranslation();
  const {
    schedule,
    channels,
    loading,
    error,
    refresh,
    saveSchedule,
    createChannel,
    deleteChannel,
  } = useStudySchedule();

  // ── Локальное состояние формы (заполняется из schedule после загрузки) ──
  const [days, setDays] = useState<number[]>([]);
  const [timeLocal, setTimeLocal] = useState('19:00');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [sessionMinutes, setSessionMinutes] = useState(30);
  const [focus, setFocus] = useState<StudyFocus>('balanced');
  const [active, setActive] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    if (!schedule) return;
    setDays(schedule.daysOfWeek);
    setTimeLocal(schedule.timeLocal);
    setTimezone(schedule.timezone);
    setSessionMinutes(schedule.sessionMinutes);
    setFocus(schedule.focus ?? 'balanced');
    setActive(schedule.active);
  }, [schedule]);

  const toggleDay = useCallback((day: number) => {
    setSaveStatus(null);
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      await saveSchedule({
        daysOfWeek: days,
        timeLocal,
        timezone,
        sessionMinutes,
        focus,
        active,
      });
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  }, [saveSchedule, days, timeLocal, timezone, sessionMinutes, focus, active]);

  // ── Каналы ──────────────────────────────────────────────────────────
  const onsite = useMemo(() => channels.find((c) => c.type === 'onsite'), [channels]);
  const telegram = useMemo(
    () => channels.find((c) => c.type === 'telegram'),
    [channels],
  );

  const [channelBusy, setChannelBusy] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [telegramDeepLink, setTelegramDeepLink] = useState<string | null>(null);

  const handleToggleOnsite = useCallback(async () => {
    setChannelBusy(true);
    setChannelError(null);
    try {
      if (onsite) {
        await deleteChannel(onsite.id);
      } else {
        await createChannel('onsite');
      }
    } catch (err) {
      setChannelError(err instanceof Error ? err.message : 'error');
    } finally {
      setChannelBusy(false);
    }
  }, [onsite, createChannel, deleteChannel]);

  const handleConnectTelegram = useCallback(async () => {
    setChannelBusy(true);
    setChannelError(null);
    try {
      const res = await createChannel('telegram');
      if (res.telegramDeepLink) {
        setTelegramDeepLink(res.telegramDeepLink);
        window.open(res.telegramDeepLink, '_blank', 'noopener');
      }
    } catch (err) {
      setChannelError(err instanceof Error ? err.message : 'error');
    } finally {
      setChannelBusy(false);
    }
  }, [createChannel]);

  const handleDisconnectTelegram = useCallback(async () => {
    if (!telegram) return;
    setChannelBusy(true);
    setChannelError(null);
    try {
      await deleteChannel(telegram.id);
      setTelegramDeepLink(null);
    } catch (err) {
      setChannelError(err instanceof Error ? err.message : 'error');
    } finally {
      setChannelBusy(false);
    }
  }, [telegram, deleteChannel]);

  if (loading) {
    return (
      <section className="settings-section">
        <p>{t('common.loading', 'Loading…')}</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="settings-section">
        <p style={{ color: 'var(--c-ef4444)' }} data-testid="study-tab-error">
          {t('settings.study.loadError', 'Failed to load study settings.')}
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="settings-section" data-testid="study-schedule-section">
        <h2>{t('settings.study.scheduleTitle', 'Training schedule')}</h2>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          {t(
            'settings.study.scheduleHint',
            'Pick convenient days and time — the platform prepares each session for you and sends a reminder.',
          )}
        </p>

        <div
          className="settings-field"
          style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}
        >
          <label>{t('settings.study.daysLabel', 'Days of week')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {DAY_ORDER.map((day) => (
              <button
                key={day}
                type="button"
                data-testid={`study-day-${day}`}
                onClick={() => toggleDay(day)}
                aria-pressed={days.includes(day)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: days.includes(day)
                    ? '2px solid var(--c-4caf50)'
                    : '1px solid var(--c-555)',
                  background: 'var(--c-2a2a2a, #2a2a2a)',
                  color: 'var(--c-fff, #fff)',
                  opacity: days.includes(day) ? 1 : 0.7,
                }}
              >
                {t(`settings.study.day.${day}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-field" style={{ marginTop: 12 }}>
          <label htmlFor="study-time">{t('settings.study.timeLabel', 'Time')}</label>
          <input
            id="study-time"
            data-testid="study-time-input"
            type="time"
            value={timeLocal}
            onChange={(e) => {
              setSaveStatus(null);
              setTimeLocal(e.target.value);
            }}
          />
        </div>

        <div className="settings-field" style={{ marginTop: 12 }}>
          <label htmlFor="study-timezone">
            {t('settings.study.timezoneLabel', 'Time zone')}
          </label>
          <select
            id="study-timezone"
            data-testid="study-timezone-select"
            value={timezone}
            onChange={(e) => {
              setSaveStatus(null);
              setTimezone(e.target.value);
            }}
          >
            {timezoneOptions(timezone).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-field" style={{ marginTop: 12 }}>
          <label htmlFor="study-minutes">
            {t('settings.study.minutesLabel', 'Session length')}
          </label>
          <select
            id="study-minutes"
            data-testid="study-minutes-select"
            value={sessionMinutes}
            onChange={(e) => {
              setSaveStatus(null);
              setSessionMinutes(Number(e.target.value));
            }}
          >
            {SESSION_MINUTES_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {t('settings.study.minutesValue', '{{minutes}} min', { minutes: m })}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-field" style={{ marginTop: 12 }}>
          <label htmlFor="study-focus">{t('settings.study.focusLabel', 'Focus')}</label>
          <select
            id="study-focus"
            data-testid="study-focus-select"
            value={focus}
            onChange={(e) => {
              setSaveStatus(null);
              setFocus(e.target.value as StudyFocus);
            }}
          >
            {FOCUS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {t(`settings.study.focus.${f}`)}
              </option>
            ))}
          </select>
        </div>

        {schedule && (
          <div
            className="settings-field"
            style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              id="study-active"
              data-testid="study-active-toggle"
              type="checkbox"
              checked={active}
              onChange={(e) => {
                setSaveStatus(null);
                setActive(e.target.checked);
              }}
            />
            <label htmlFor="study-active">
              {t('settings.study.activeLabel', 'Schedule active')}
            </label>
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            data-testid="study-schedule-save"
            onClick={() => void handleSave()}
            disabled={saving || days.length === 0 || !timeLocal}
          >
            {saving ? t('common.loading', 'Saving…') : t('common.save', 'Save')}
          </button>
          {days.length === 0 && (
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {t('settings.study.noDaysHint', 'Pick at least one day')}
            </span>
          )}
          {saveStatus === 'saved' && (
            <span
              data-testid="study-schedule-saved"
              style={{ fontSize: 12, color: 'var(--c-4caf50)' }}
            >
              {t('settings.externalSaved', 'Saved')}
            </span>
          )}
          {saveStatus === 'error' && (
            <span style={{ fontSize: 12, color: 'var(--c-ef4444)' }}>
              {t('settings.externalError', 'Failed to save')}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section" data-testid="study-channels-section">
        <h2>{t('settings.study.channelsTitle', 'Session notifications')}</h2>

        {/* On-site: колокольчик на сайте. */}
        <div className="settings-field" style={{ display: 'flex', gap: 8 }}>
          <input
            id="study-channel-onsite"
            data-testid="study-channel-onsite-toggle"
            type="checkbox"
            checked={!!onsite}
            disabled={channelBusy}
            onChange={() => void handleToggleOnsite()}
          />
          <label htmlFor="study-channel-onsite">
            {t('settings.study.channelOnsite', 'On-site notifications')}
          </label>
        </div>

        {/* Telegram: deep-link → /start в боте → канал подтверждён. */}
        <div
          className="settings-field"
          style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 12 }}
        >
          <label>Telegram</label>
          {telegram?.verified ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span data-testid="study-telegram-status" style={{ color: 'var(--c-4caf50)' }}>
                {t('settings.study.telegramConnected', 'Connected')}
              </span>
              <button
                type="button"
                data-testid="study-telegram-disconnect"
                disabled={channelBusy}
                onClick={() => void handleDisconnectTelegram()}
              >
                {t('settings.study.telegramDisconnect', 'Disconnect')}
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                data-testid="study-telegram-connect"
                disabled={channelBusy}
                onClick={() => void handleConnectTelegram()}
              >
                {telegram
                  ? t('settings.study.telegramNewLink', 'Get a new link')
                  : t('settings.study.telegramConnect', 'Connect Telegram')}
              </button>
              {telegram && !telegram.verified && (
                <div
                  data-testid="study-telegram-pending"
                  style={{ fontSize: 13, opacity: 0.85 }}
                >
                  {t(
                    'settings.study.telegramPending',
                    'Waiting for confirmation — press Start in the bot chat, then refresh the status.',
                  )}
                  {telegramDeepLink && (
                    <>
                      {' '}
                      <a href={telegramDeepLink} target="_blank" rel="noopener noreferrer">
                        {t('settings.study.telegramOpenLink', 'Open link again')}
                      </a>
                    </>
                  )}
                  <button
                    type="button"
                    data-testid="study-telegram-refresh"
                    style={{ marginLeft: 8 }}
                    disabled={channelBusy}
                    onClick={() => void refresh()}
                  >
                    {t('settings.study.telegramRefresh', 'Refresh status')}
                  </button>
                </div>
              )}
            </>
          )}
          <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>
            {t(
              'settings.study.telegramHint',
              'Session reminders with task links arrive from the platform bot. The link opens a chat — press Start to confirm.',
            )}
          </p>
        </div>

        {channelError && (
          <p style={{ color: 'var(--c-ef4444)', fontSize: 13 }} data-testid="study-channel-error">
            {t('settings.study.channelError', 'Channel operation failed. Try again.')}
          </p>
        )}
      </section>
    </>
  );
}
