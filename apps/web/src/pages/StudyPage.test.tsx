// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n/index';
import { StudyPage } from './StudyPage';
import { api } from '../api';
import type { StudyScheduleDto } from '@kingside/shared';

/**
 * KS-4883 / ADR-160. Страница /study: состояния «нет расписания»
 * (CTA в настройки) и «расписание есть, занятие не запланировано».
 */

const SCHEDULE: StudyScheduleDto = {
  id: 's1',
  daysOfWeek: [1, 3, 5],
  timeLocal: '19:30',
  timezone: 'Europe/Prague',
  sessionMinutes: 45,
  focus: null,
  active: true,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

function mockGet(schedule: StudyScheduleDto | null) {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/study/schedule') return { schedule };
    if (path === '/study/channels') return { channels: [] };
    throw new Error(`unexpected GET ${path}`);
  });
}

function wrap() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <StudyPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('StudyPage (KS-4883)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('без расписания — приглашение настроить со ссылкой в /settings?tab=study', async () => {
    mockGet(null);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-empty-no-schedule')).toBeInTheDocument(),
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/settings?tab=study');
  });

  it('с расписанием — «занятие пока не запланировано»', async () => {
    mockGet(SCHEDULE);
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId('study-empty-no-session')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('study-empty-no-schedule')).not.toBeInTheDocument();
  });
});
