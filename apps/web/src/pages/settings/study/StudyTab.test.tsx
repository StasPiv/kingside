// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n/index';
import { StudyTab } from './StudyTab';
import { api } from '../../../api';
import type { StudyScheduleDto, NotificationChannelDto } from '@kingside/shared';

/**
 * KS-4883 / ADR-160. Вкладка «Занятия»: загрузка расписания и каналов,
 * сохранение формы (PUT /study/schedule), подключение Telegram
 * (POST /study/channels → deep-link).
 */

const SCHEDULE: StudyScheduleDto = {
  id: 's1',
  daysOfWeek: [1, 3, 5],
  timeLocal: '19:30',
  timezone: 'Europe/Prague',
  sessionMinutes: 45,
  focus: 'tactics',
  active: true,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

const ONSITE: NotificationChannelDto = {
  id: 'c1',
  type: 'onsite',
  verified: true,
  enabled: true,
  createdAt: '2026-07-11T00:00:00.000Z',
};

function mockGet(schedule: StudyScheduleDto | null, channels: NotificationChannelDto[]) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/study/schedule') return { schedule };
    if (path === '/study/channels') return { channels };
    throw new Error(`unexpected GET ${path}`);
  });
}

function wrap() {
  return render(
    <I18nextProvider i18n={i18n}>
      <StudyTab />
    </I18nextProvider>,
  );
}

describe('StudyTab (KS-4883)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('заполняет форму из существующего расписания', async () => {
    mockGet(SCHEDULE, [ONSITE]);
    wrap();
    await waitFor(() =>
      expect((screen.getByTestId('study-time-input') as HTMLInputElement).value).toBe('19:30'),
    );
    expect((screen.getByTestId('study-minutes-select') as HTMLSelectElement).value).toBe('45');
    expect((screen.getByTestId('study-focus-select') as HTMLSelectElement).value).toBe('tactics');
    expect(screen.getByTestId('study-day-1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('study-day-2').getAttribute('aria-pressed')).toBe('false');
    expect(
      (screen.getByTestId('study-channel-onsite-toggle') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('без расписания: кнопка Сохранить заблокирована пока не выбраны дни', async () => {
    mockGet(null, []);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-section')).toBeInTheDocument(),
    );
    expect((screen.getByTestId('study-schedule-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('study-day-1'));
    expect((screen.getByTestId('study-schedule-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('сохранение отправляет PUT /study/schedule и показывает статус', async () => {
    mockGet(SCHEDULE, [ONSITE]);
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ schedule: SCHEDULE });
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-section')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-schedule-save'));
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-saved')).toBeInTheDocument(),
    );
    expect(put).toHaveBeenCalledWith('/study/schedule', {
      daysOfWeek: [1, 3, 5],
      timeLocal: '19:30',
      timezone: 'Europe/Prague',
      sessionMinutes: 45,
      focus: 'tactics',
      active: true,
    });
  });

  it('подключение Telegram: POST → deep-link открывается, статус pending', async () => {
    mockGet(SCHEDULE, [ONSITE]);
    const tgChannel: NotificationChannelDto = {
      id: 'c2',
      type: 'telegram',
      verified: false,
      enabled: true,
      createdAt: '2026-07-11T00:00:00.000Z',
    };
    vi.spyOn(api, 'post').mockResolvedValue({
      channel: tgChannel,
      telegramDeepLink: 'https://t.me/bot?start=tok',
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-telegram-connect')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-telegram-connect'));
    await waitFor(() =>
      expect(screen.getByTestId('study-telegram-pending')).toBeInTheDocument(),
    );
    expect(open).toHaveBeenCalledWith('https://t.me/bot?start=tok', '_blank', 'noopener');
    vi.unstubAllGlobals();
  });
});
