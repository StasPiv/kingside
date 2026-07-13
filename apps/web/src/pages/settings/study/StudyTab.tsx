import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useStudySchedules } from '../../../hooks/useStudySchedules';
import type {
  StudyFocus,
  StudyScheduleDto,
  StudySlotInput,
  UpsertStudyScheduleRequest,
} from '@kingside/shared';

/**
 * KS-4928 / ADR-163 (задача 2 из 4). Вкладка «Занятия» в /settings, v2:
 *   - список карточек тренировок (до 5): имя, фокус, длительность,
 *     таймзона, вкл/выкл; у каждой 1..7 временных слотов (дни недели +
 *     время + опциональный оверрайд длительности);
 *   - REST KS-4927: GET/POST/PUT/DELETE /study/schedules; слоты
 *     сохраняются replace-on-write (полный список в каждом PUT);
 *   - ошибки лимитов и пересечений слотов приходят из API (400) —
 *     показываем серверное сообщение под кнопкой сохранения карточки;
 *   - каналы уведомлений: onsite и Telegram (как в v1, ADR-160).
 */

/** Порядок отображения дней: с понедельника; значения — 0=вс…6=сб. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const SESSION_MINUTES_OPTIONS = [15, 30, 45, 60, 90] as const;

const FOCUS_OPTIONS: StudyFocus[] = ['balanced', 'tactics', 'openings', 'endgames'];

/** Лимиты ADR-163 §2 (сервер их тоже проверяет — 400). */
const MAX_SCHEDULES = 5;
const MAX_SLOTS = 7;

/** Таймзона браузера — дефолт для новой тренировки. */
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

/** Локальный черновик слота (key — стабильный ключ рендера). */
interface SlotDraft {
  key: string;
  daysOfWeek: number[];
  timeLocal: string;
  sessionMinutes: number | null;
}

let slotKeySeq = 0;
function nextSlotKey(): string {
  slotKeySeq += 1;
  return `slot-${slotKeySeq}`;
}

function slotsFromSchedule(schedule: StudyScheduleDto | null): SlotDraft[] {
  if (!schedule || schedule.slots.length === 0) {
    return [{ key: nextSlotKey(), daysOfWeek: [], timeLocal: '19:00', sessionMinutes: null }];
  }
  return schedule.slots.map((s) => ({
    key: s.id,
    daysOfWeek: s.daysOfWeek,
    timeLocal: s.timeLocal,
    sessionMinutes: s.sessionMinutes,
  }));
}

/**
 * Карточка тренировки: локальная форма, сохранение своей кнопкой.
 * `schedule=null` — черновик новой тренировки (POST при сохранении).
 */
function ScheduleCard({
  schedule,
  defaultName,
  onSave,
  onDelete,
  onCancel,
}: {
  schedule: StudyScheduleDto | null;
  defaultName: string;
  onSave: (body: UpsertStudyScheduleRequest) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(schedule?.name ?? defaultName);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browserTimezone());
  const [sessionMinutes, setSessionMinutes] = useState(schedule?.sessionMinutes ?? 30);
  const [focus, setFocus] = useState<StudyFocus>(schedule?.focus ?? 'balanced');
  const [active, setActive] = useState(schedule?.active ?? true);
  const [slots, setSlots] = useState<SlotDraft[]>(() => slotsFromSchedule(schedule));

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'error' | null>(null);
  /** Сообщение сервера из 400 (лимиты/пересечения слотов). */
  const [apiError, setApiError] = useState<string | null>(null);

  const touch = useCallback(() => {
    setSaveStatus(null);
    setApiError(null);
  }, []);

  const toggleSlotDay = useCallback(
    (slotKey: string, day: number) => {
      touch();
      setSlots((prev) =>
        prev.map((s) =>
          s.key === slotKey
            ? {
                ...s,
                daysOfWeek: s.daysOfWeek.includes(day)
                  ? s.daysOfWeek.filter((d) => d !== day)
                  : [...s.daysOfWeek, day].sort(),
              }
            : s,
        ),
      );
    },
    [touch],
  );

  const patchSlot = useCallback(
    (slotKey: string, patch: Partial<SlotDraft>) => {
      touch();
      setSlots((prev) => prev.map((s) => (s.key === slotKey ? { ...s, ...patch } : s)));
    },
    [touch],
  );

  const addSlot = useCallback(() => {
    touch();
    setSlots((prev) =>
      prev.length >= MAX_SLOTS
        ? prev
        : [...prev, { key: nextSlotKey(), daysOfWeek: [], timeLocal: '19:00', sessionMinutes: null }],
    );
  }, [touch]);

  const removeSlot = useCallback(
    (slotKey: string) => {
      touch();
      setSlots((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.key !== slotKey)));
    },
    [touch],
  );

  const valid =
    name.trim().length > 0 &&
    slots.length > 0 &&
    slots.every((s) => s.daysOfWeek.length > 0 && s.timeLocal);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus(null);
    setApiError(null);
    try {
      const body: UpsertStudyScheduleRequest = {
        name: name.trim(),
        timezone,
        sessionMinutes,
        focus,
        active,
        slots: slots.map<StudySlotInput>((s) => ({
          daysOfWeek: s.daysOfWeek,
          timeLocal: s.timeLocal,
          sessionMinutes: s.sessionMinutes,
        })),
      };
      await onSave(body);
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error');
      // ApiError.message несёт текст 400 (лимит тренировок/слотов,
      // пересечение слотов) — показываем как есть.
      if (err instanceof Error && err.message) setApiError(err.message);
    } finally {
      setSaving(false);
    }
  }, [onSave, name, timezone, sessionMinutes, focus, active, slots]);

  const [deleting, setDeleting] = useState(false);
  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    // ADR-163 §5: удаление тренировки удаляет и историю её занятий.
    const ok = window.confirm(
      t('settings.study.deleteConfirm', {
        name,
        defaultValue:
          'Delete training “{{name}}”? Its planned sessions and history will be deleted too.',
      }),
    );
    if (!ok) return;
    setDeleting(true);
    setApiError(null);
    try {
      await onDelete();
    } catch (err) {
      if (err instanceof Error && err.message) setApiError(err.message);
      setSaveStatus('error');
    } finally {
      setDeleting(false);
    }
  }, [onDelete, t, name]);

  return (
    <div
      className="study-schedule-card settings-subsection"
      data-testid={`study-schedule-card-${schedule?.id ?? 'new'}`}
    >
      <div className="settings-field study-field">
        <label htmlFor={`study-name-${schedule?.id ?? 'new'}`}>
          {t('settings.study.nameLabel', 'Name')}
        </label>
        <input
          id={`study-name-${schedule?.id ?? 'new'}`}
          data-testid="study-name-input"
          type="text"
          maxLength={60}
          value={name}
          placeholder={t('settings.study.namePlaceholder', 'e.g. Evening tactics')}
          onChange={(e) => {
            touch();
            setName(e.target.value);
          }}
        />
      </div>

      <div className="settings-field study-field">
        <label htmlFor={`study-focus-${schedule?.id ?? 'new'}`}>
          {t('settings.study.focusLabel', 'Focus')}
        </label>
        <select
          id={`study-focus-${schedule?.id ?? 'new'}`}
          data-testid="study-focus-select"
          value={focus}
          onChange={(e) => {
            touch();
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

      <div className="settings-field study-field">
        <label htmlFor={`study-minutes-${schedule?.id ?? 'new'}`}>
          {t('settings.study.minutesLabel', 'Session length')}
        </label>
        <select
          id={`study-minutes-${schedule?.id ?? 'new'}`}
          data-testid="study-minutes-select"
          value={sessionMinutes}
          onChange={(e) => {
            touch();
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

      <div className="settings-field study-field">
        <label htmlFor={`study-timezone-${schedule?.id ?? 'new'}`}>
          {t('settings.study.timezoneLabel', 'Time zone')}
        </label>
        <select
          id={`study-timezone-${schedule?.id ?? 'new'}`}
          data-testid="study-timezone-select"
          value={timezone}
          onChange={(e) => {
            touch();
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

      <div className="settings-field study-field study-field-stack">
        <label>{t('settings.study.slotsLabel', 'Times')}</label>
        {slots.map((slot, i) => (
          <div key={slot.key} className="study-slot" data-testid={`study-slot-${i}`}>
            <div className="study-days">
              {DAY_ORDER.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="study-day-btn"
                  data-testid={`study-slot-${i}-day-${day}`}
                  onClick={() => toggleSlotDay(slot.key, day)}
                  aria-pressed={slot.daysOfWeek.includes(day)}
                >
                  {t(`settings.study.day.${day}`)}
                </button>
              ))}
            </div>
            <div className="study-slot-row">
              <input
                data-testid={`study-slot-${i}-time`}
                type="time"
                value={slot.timeLocal}
                onChange={(e) => patchSlot(slot.key, { timeLocal: e.target.value })}
              />
              <select
                data-testid={`study-slot-${i}-minutes`}
                value={slot.sessionMinutes ?? ''}
                aria-label={t('settings.study.slotMinutesLabel', 'Slot length')}
                onChange={(e) =>
                  patchSlot(slot.key, {
                    sessionMinutes: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">
                  {t('settings.study.slotMinutesInherit', 'Training default')}
                </option>
                {SESSION_MINUTES_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {t('settings.study.minutesValue', '{{minutes}} min', { minutes: m })}
                  </option>
                ))}
              </select>
              {slots.length > 1 && (
                <button
                  type="button"
                  data-testid={`study-slot-${i}-remove`}
                  className="study-slot-remove"
                  onClick={() => removeSlot(slot.key)}
                >
                  {t('settings.study.removeSlot', 'Remove')}
                </button>
              )}
            </div>
            {slot.daysOfWeek.length === 0 && (
              <span className="study-note">
                {t('settings.study.noDaysHint', 'Pick at least one day')}
              </span>
            )}
          </div>
        ))}
        {slots.length < MAX_SLOTS && (
          <button
            type="button"
            data-testid="study-slot-add"
            className="study-slot-add"
            onClick={addSlot}
          >
            {t('settings.study.addSlot', '+ Add time')}
          </button>
        )}
      </div>

      <div className="settings-field study-field study-field-check">
        <input
          id={`study-active-${schedule?.id ?? 'new'}`}
          data-testid="study-active-toggle"
          type="checkbox"
          checked={active}
          onChange={(e) => {
            touch();
            setActive(e.target.checked);
          }}
        />
        <label htmlFor={`study-active-${schedule?.id ?? 'new'}`}>
          {t('settings.study.activeLabel', 'Schedule active')}
        </label>
      </div>

      <div className="study-save-row">
        <button
          type="button"
          data-testid="study-schedule-save"
          onClick={() => void handleSave()}
          disabled={saving || deleting || !valid}
        >
          {saving ? t('common.loading', 'Saving…') : t('common.save', 'Save')}
        </button>
        {schedule && onDelete && (
          <button
            type="button"
            data-testid="study-schedule-delete"
            className="study-schedule-delete"
            disabled={saving || deleting}
            onClick={() => void handleDelete()}
          >
            {t('settings.study.deleteSchedule', 'Delete training')}
          </button>
        )}
        {!schedule && onCancel && (
          <button
            type="button"
            data-testid="study-schedule-cancel"
            disabled={saving}
            onClick={onCancel}
          >
            {t('common.cancel', 'Cancel')}
          </button>
        )}
        {saveStatus === 'saved' && (
          <span data-testid="study-schedule-saved" className="study-note study-note-ok">
            {t('settings.externalSaved', 'Saved')}
          </span>
        )}
        {saveStatus === 'error' && !apiError && (
          <span className="study-note study-note-err">
            {t('settings.externalError', 'Failed to save')}
          </span>
        )}
      </div>
      {apiError && (
        <p className="study-error" data-testid="study-schedule-error">
          {apiError}
        </p>
      )}
    </div>
  );
}

export function StudyTab(): ReactElement {
  const { t } = useTranslation();
  const {
    schedules,
    channels,
    loading,
    error,
    refresh,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    createChannel,
    deleteChannel,
  } = useStudySchedules();

  /** Черновик новой тренировки (одна за раз). */
  const [draftOpen, setDraftOpen] = useState(false);

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
        <p className="study-error" data-testid="study-tab-error">
          {t('settings.study.loadError', 'Failed to load study settings.')}
        </p>
      </section>
    );
  }

  const canAdd = schedules.length < MAX_SCHEDULES && !draftOpen;

  return (
    <>
      <section className="settings-section" data-testid="study-schedule-section">
        <h2>{t('settings.study.schedulesTitle', 'Trainings')}</h2>
        <p className="settings-hint study-section-hint">
          {t(
            'settings.study.schedulesHint',
            'Create up to 5 trainings, each with its own focus and up to 7 weekly times — the platform prepares every session and sends a reminder.',
          )}
        </p>

        {schedules.length === 0 && !draftOpen && (
          <p className="study-note" data-testid="study-no-schedules">
            {t('settings.study.noSchedules', 'No trainings yet — add the first one.')}
          </p>
        )}

        {schedules.map((schedule) => (
          <ScheduleCard
            key={schedule.id}
            schedule={schedule}
            defaultName={t('settings.study.defaultName', 'Training')}
            onSave={async (body) => {
              await updateSchedule(schedule.id, body);
            }}
            onDelete={async () => {
              await deleteSchedule(schedule.id);
            }}
          />
        ))}

        {draftOpen && (
          <ScheduleCard
            schedule={null}
            defaultName={t('settings.study.defaultName', 'Training')}
            onSave={async (body) => {
              await createSchedule(body);
              setDraftOpen(false);
            }}
            onCancel={() => setDraftOpen(false)}
          />
        )}

        <div className="study-save-row">
          <button
            type="button"
            data-testid="study-add-schedule"
            disabled={!canAdd}
            onClick={() => setDraftOpen(true)}
          >
            {t('settings.study.addSchedule', '+ Add training')}
          </button>
          {schedules.length >= MAX_SCHEDULES && (
            <span className="study-note">
              {t('settings.study.scheduleLimit', 'Limit: {{max}} trainings', {
                max: MAX_SCHEDULES,
              })}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section" data-testid="study-channels-section">
        <h2>{t('settings.study.channelsTitle', 'Session notifications')}</h2>

        {/* On-site: колокольчик на сайте. */}
        <div className="settings-field study-field study-field-check">
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
        <div className="settings-field study-field study-field-stack">
          <label>Telegram</label>
          {telegram?.verified ? (
            <div className="study-telegram-row">
              <span data-testid="study-telegram-status" className="study-note-ok">
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
                <div data-testid="study-telegram-pending" className="study-telegram-pending">
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
                    className="study-telegram-refresh"
                    disabled={channelBusy}
                    onClick={() => void refresh()}
                  >
                    {t('settings.study.telegramRefresh', 'Refresh status')}
                  </button>
                </div>
              )}
            </>
          )}
          <p className="settings-hint">
            {t(
              'settings.study.telegramHint',
              'Session reminders with task links arrive from the platform bot. The link opens a chat — press Start to confirm.',
            )}
          </p>
        </div>

        {channelError && (
          <p className="study-error" data-testid="study-channel-error">
            {t('settings.study.channelError', 'Channel operation failed. Try again.')}
          </p>
        )}
      </section>
    </>
  );
}
