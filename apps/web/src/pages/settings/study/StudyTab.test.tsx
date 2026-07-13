// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n/index';
import { StudyTab } from './StudyTab';
import { api } from '../../../api';
import type { StudyScheduleDto, NotificationChannelDto } from '@kingside/shared';

/**
 * KS-4928 / ADR-163. Вкладка «Занятия» v2: список карточек тренировок
 * со слотами, создание (POST /study/schedules), редактирование (PUT),
 * удаление (DELETE), ошибки лимитов/пересечений из API (400),
 * подключение Telegram (POST /study/channels → deep-link).
 */

const SCHEDULE: StudyScheduleDto = {
  id: 's1',
  name: 'Вечерняя тактика',
  timezone: 'Europe/Prague',
  sessionMinutes: 45,
  focus: 'tactics',
  active: true,
  slots: [
    { id: 'slot1', daysOfWeek: [1, 3, 5], timeLocal: '19:30', sessionMinutes: null },
    { id: 'slot2', daysOfWeek: [6], timeLocal: '10:00', sessionMinutes: 90 },
  ],
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

function mockGet(schedules: StudyScheduleDto[], channels: NotificationChannelDto[]) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/study/schedules') return { schedules };
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

describe('StudyTab (KS-4928)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('рендерит карточку тренировки: имя, фокус, слоты с днями и оверрайдом', async () => {
    mockGet([SCHEDULE], [ONSITE]);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s1')).toBeInTheDocument(),
    );
    const card = within(screen.getByTestId('study-schedule-card-s1'));
    expect((card.getByTestId('study-name-input') as HTMLInputElement).value).toBe(
      'Вечерняя тактика',
    );
    expect((card.getByTestId('study-focus-select') as HTMLSelectElement).value).toBe('tactics');
    expect((card.getByTestId('study-minutes-select') as HTMLSelectElement).value).toBe('45');
    // Слот 0: пн/ср/пт 19:30, длительность наследуется.
    expect((card.getByTestId('study-slot-0-time') as HTMLInputElement).value).toBe('19:30');
    expect(card.getByTestId('study-slot-0-day-1').getAttribute('aria-pressed')).toBe('true');
    expect(card.getByTestId('study-slot-0-day-2').getAttribute('aria-pressed')).toBe('false');
    expect((card.getByTestId('study-slot-0-minutes') as HTMLSelectElement).value).toBe('');
    // Слот 1: сб 10:00, оверрайд 90 минут.
    expect((card.getByTestId('study-slot-1-time') as HTMLInputElement).value).toBe('10:00');
    expect((card.getByTestId('study-slot-1-minutes') as HTMLSelectElement).value).toBe('90');
    expect(
      (screen.getByTestId('study-channel-onsite-toggle') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('сохранение карточки: PUT /study/schedules/:id с полным списком слотов', async () => {
    mockGet([SCHEDULE], [ONSITE]);
    const put = vi.spyOn(api, 'put').mockResolvedValue({ schedule: SCHEDULE });
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s1')).toBeInTheDocument(),
    );
    const card = within(screen.getByTestId('study-schedule-card-s1'));
    fireEvent.change(card.getByTestId('study-name-input'), {
      target: { value: 'Тактика и эндшпили' },
    });
    fireEvent.click(card.getByTestId('study-schedule-save'));
    await waitFor(() =>
      expect(card.getByTestId('study-schedule-saved')).toBeInTheDocument(),
    );
    expect(put).toHaveBeenCalledWith('/study/schedules/s1', {
      name: 'Тактика и эндшпили',
      timezone: 'Europe/Prague',
      sessionMinutes: 45,
      focus: 'tactics',
      active: true,
      slots: [
        { daysOfWeek: [1, 3, 5], timeLocal: '19:30', sessionMinutes: null },
        { daysOfWeek: [6], timeLocal: '10:00', sessionMinutes: 90 },
      ],
    });
  });

  it('добавление тренировки: черновик → POST /study/schedules', async () => {
    mockGet([], []);
    const created: StudyScheduleDto = {
      ...SCHEDULE,
      id: 's-new',
      name: 'Тренировка',
      slots: [{ id: 'sl', daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: null }],
    };
    const post = vi.spyOn(api, 'post').mockResolvedValue({ schedule: created });
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-no-schedules')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('study-add-schedule'));
    const card = within(screen.getByTestId('study-schedule-card-new'));
    // Кнопка заблокирована, пока у слота не выбраны дни.
    expect((card.getByTestId('study-schedule-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(card.getByTestId('study-slot-0-day-1'));
    expect((card.getByTestId('study-schedule-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(card.getByTestId('study-schedule-save'));
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s-new')).toBeInTheDocument(),
    );
    expect(post).toHaveBeenCalledWith(
      '/study/schedules',
      expect.objectContaining({
        slots: [{ daysOfWeek: [1], timeLocal: '19:00', sessionMinutes: null }],
      }),
    );
    // Черновик закрылся.
    expect(screen.queryByTestId('study-schedule-card-new')).not.toBeInTheDocument();
  });

  it('«добавить время» добавляет слот; до 7; «убрать» удаляет', async () => {
    mockGet([SCHEDULE], []);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s1')).toBeInTheDocument(),
    );
    const card = within(screen.getByTestId('study-schedule-card-s1'));
    fireEvent.click(card.getByTestId('study-slot-add'));
    expect(card.getByTestId('study-slot-2')).toBeInTheDocument();
    fireEvent.click(card.getByTestId('study-slot-2-remove'));
    expect(card.queryByTestId('study-slot-2')).not.toBeInTheDocument();
    // Добиваем до 7 — кнопка исчезает.
    for (let i = 0; i < 5; i += 1) fireEvent.click(card.getByTestId('study-slot-add'));
    expect(card.getByTestId('study-slot-6')).toBeInTheDocument();
    expect(card.queryByTestId('study-slot-add')).not.toBeInTheDocument();
  });

  it('ошибка 400 из API (пересечение слотов) показывается в карточке', async () => {
    mockGet([SCHEDULE], []);
    vi.spyOn(api, 'put').mockRejectedValue(
      new Error('Slot overlap: day 1 at 19:30 is already taken'),
    );
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s1')).toBeInTheDocument(),
    );
    const card = within(screen.getByTestId('study-schedule-card-s1'));
    fireEvent.click(card.getByTestId('study-schedule-save'));
    await waitFor(() =>
      expect(card.getByTestId('study-schedule-error')).toBeInTheDocument(),
    );
    expect(card.getByTestId('study-schedule-error').textContent).toContain('Slot overlap');
  });

  it('удаление тренировки: confirm → DELETE /study/schedules/:id', async () => {
    mockGet([SCHEDULE], []);
    const del = vi.spyOn(api, 'delete').mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s1')).toBeInTheDocument(),
    );
    fireEvent.click(
      within(screen.getByTestId('study-schedule-card-s1')).getByTestId('study-schedule-delete'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('study-schedule-card-s1')).not.toBeInTheDocument(),
    );
    expect(del).toHaveBeenCalledWith('/study/schedules/s1');
    vi.unstubAllGlobals();
  });

  it('при 5 тренировках кнопка добавления заблокирована с подсказкой', async () => {
    const five = [1, 2, 3, 4, 5].map((n) => ({
      ...SCHEDULE,
      id: `s${n}`,
      name: `Тренировка ${n}`,
    }));
    mockGet(five, []);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-schedule-card-s5')).toBeInTheDocument(),
    );
    expect((screen.getByTestId('study-add-schedule') as HTMLButtonElement).disabled).toBe(true);
  });

  it('подключение Telegram: POST → deep-link открывается, статус pending', async () => {
    mockGet([SCHEDULE], [ONSITE]);
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
