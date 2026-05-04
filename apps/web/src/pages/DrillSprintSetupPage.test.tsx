import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';
import { ApiError } from '../ApiError';

const apiPost = vi.fn();
const apiGet = vi.fn();
const navigateMock = vi.fn();

vi.mock('../api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => navigateMock };
});

import { DrillSprintSetupPage } from './DrillSprintSetupPage';

const SESSION = {
  sessionId: 'sess-1',
  drill: {
    id: 'd1',
    drillType: 'count-attackers',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    sideToMove: null,
    answerShape: 'number',
    difficulty: 1,
  },
  startedAt: new Date().toISOString(),
  durationMs: 180000,
};

beforeEach(() => {
  apiPost.mockReset();
  apiGet.mockReset();
  navigateMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('<DrillSprintSetupPage> KS-2241', () => {
  it('рендерит контейнер + duration radio + 7 type checkboxes', () => {
    renderWithProviders(<DrillSprintSetupPage />);
    expect(screen.getByTestId('drill-sprint-setup')).toBeInTheDocument();
    expect(screen.getByTestId('drill-sprint-setup-duration-180000')).toBeInTheDocument();
    expect(screen.getByTestId('drill-sprint-setup-duration-300000')).toBeInTheDocument();
    for (const id of [
      'count-attackers',
      'find-loose-piece',
      'find-hanging-piece',
      'find-all-checks',
      'find-pin',
      'find-fork',
      'find-undefended-attack',
    ]) {
      expect(
        screen.getByTestId(`drill-sprint-setup-type-${id}`),
      ).toBeInTheDocument();
    }
  });

  it('default duration = 180000 (3 минуты)', () => {
    renderWithProviders(<DrillSprintSetupPage />);
    const r3 = screen.getByTestId('drill-sprint-setup-duration-180000') as HTMLInputElement;
    const r5 = screen.getByTestId('drill-sprint-setup-duration-300000') as HTMLInputElement;
    expect(r3.checked).toBe(true);
    expect(r5.checked).toBe(false);
  });

  it('кнопка «Все типы» отмечает все 7 чекбоксов', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrillSprintSetupPage />);
    await user.click(screen.getByTestId('drill-sprint-setup-select-all'));
    for (const id of [
      'count-attackers',
      'find-pin',
      'find-undefended-attack',
    ]) {
      const cb = screen.getByTestId(`drill-sprint-setup-type-${id}`) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
    // data-selected-count=7 (все 7 чекбоксов отмечены).
    expect(
      screen.getByTestId('drill-sprint-setup-types').getAttribute('data-selected-count'),
    ).toBe('7');
  });

  it('кнопка «Очистить» снимает все галочки', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrillSprintSetupPage />);
    await user.click(screen.getByTestId('drill-sprint-setup-select-all'));
    expect(
      screen.getByTestId('drill-sprint-setup-types').getAttribute('data-selected-count'),
    ).toBe('7');
    await user.click(screen.getByTestId('drill-sprint-setup-clear'));
    expect(
      screen.getByTestId('drill-sprint-setup-types').getAttribute('data-selected-count'),
    ).toBe('0');
  });

  it('переключение duration на 5 мин', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DrillSprintSetupPage />);
    await user.click(screen.getByTestId('drill-sprint-setup-duration-300000'));
    const r5 = screen.getByTestId('drill-sprint-setup-duration-300000') as HTMLInputElement;
    expect(r5.checked).toBe(true);
  });

  it('Start (без выбора типов) → POST /sprint/start с types=[] (= все 7) и duration', async () => {
    apiPost.mockResolvedValue(SESSION);
    const user = userEvent.setup();
    renderWithProviders(<DrillSprintSetupPage />);
    await user.click(screen.getByTestId('drill-sprint-setup-start'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/sprint/start',
        expect.objectContaining({ durationMs: 180000, types: [] }),
      ),
    );
    expect(navigateMock).toHaveBeenCalledWith(
      '/drills/sprint/play',
      expect.objectContaining({ state: { session: SESSION } }),
    );
  });

  it('Start с выбранными типами и 5 мин → правильный body', async () => {
    apiPost.mockResolvedValue(SESSION);
    const user = userEvent.setup();
    renderWithProviders(<DrillSprintSetupPage />);
    await user.click(screen.getByTestId('drill-sprint-setup-duration-300000'));
    await user.click(screen.getByTestId('drill-sprint-setup-type-count-attackers'));
    await user.click(screen.getByTestId('drill-sprint-setup-type-find-pin'));
    await user.click(screen.getByTestId('drill-sprint-setup-start'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/tactic-drill/sprint/start',
        expect.objectContaining({
          durationMs: 300000,
          types: expect.arrayContaining(['count-attackers', 'find-pin']),
        }),
      ),
    );
  });

  // KS-2350: 409 → диалог «Продолжить / Начать новый» (force=true).
  describe('KS-2350 — обработка 409 ConflictException', () => {
    it('409 → conflict-плашка вместо generic-error', async () => {
      apiPost.mockRejectedValue(
        new ApiError('sprint session already active', undefined, 409),
      );
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(
          screen.getByTestId('drill-sprint-setup-conflict'),
        ).toBeInTheDocument(),
      );
      // Generic-плашка НЕ показана.
      expect(
        screen.queryByTestId('drill-sprint-setup-error'),
      ).not.toBeInTheDocument();
      // Главная Start-кнопка скрыта в conflict-режиме.
      expect(
        screen.queryByTestId('drill-sprint-setup-start'),
      ).not.toBeInTheDocument();
      // Видны 3 кнопки выбора.
      expect(
        screen.getByTestId('drill-sprint-setup-resume'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('drill-sprint-setup-force-start'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('drill-sprint-setup-cancel'),
      ).toBeInTheDocument();
    });

    it('«Начать новый» → POST /sprint/start с force=true и переход на Play', async () => {
      apiPost
        .mockRejectedValueOnce(
          new ApiError('sprint session already active', undefined, 409),
        )
        .mockResolvedValueOnce(SESSION);
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(
          screen.getByTestId('drill-sprint-setup-conflict'),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('drill-sprint-setup-force-start'));
      await waitFor(() =>
        expect(apiPost).toHaveBeenLastCalledWith(
          '/tactic-drill/sprint/start',
          expect.objectContaining({ force: true }),
        ),
      );
      expect(navigateMock).toHaveBeenCalledWith(
        '/drills/sprint/play',
        expect.objectContaining({ state: { session: SESSION } }),
      );
    });

    it('«Продолжить» → GET /sprint/active + переход на Play со state', async () => {
      apiPost.mockRejectedValue(
        new ApiError('sprint session already active', undefined, 409),
      );
      apiGet.mockResolvedValue(SESSION);
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-sprint-setup-resume')).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('drill-sprint-setup-resume'));
      await waitFor(() =>
        expect(apiGet).toHaveBeenCalledWith('/tactic-drill/sprint/active'),
      );
      expect(navigateMock).toHaveBeenCalledWith(
        '/drills/sprint/play',
        expect.objectContaining({ state: { session: SESSION } }),
      );
    });

    it('«Продолжить» при 404 GET → подсказка resumeNotSupported, не падает', async () => {
      apiPost.mockRejectedValue(
        new ApiError('sprint session already active', undefined, 409),
      );
      apiGet.mockRejectedValue(new ApiError('Not Found', undefined, 404));
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-sprint-setup-resume')).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('drill-sprint-setup-resume'));
      await waitFor(() =>
        expect(
          screen.getByTestId('drill-sprint-setup-resume-error'),
        ).toBeInTheDocument(),
      );
      expect(
        screen
          .getByTestId('drill-sprint-setup-resume-error')
          .getAttribute('data-resume-error'),
      ).toBe('notSupported');
      // Conflict-плашка остаётся открытой, кнопки доступны.
      expect(
        screen.getByTestId('drill-sprint-setup-force-start'),
      ).not.toBeDisabled();
      expect(navigateMock).not.toHaveBeenCalled();
    });

    it('«Отмена» закрывает conflict-плашку и возвращает Start-кнопку', async () => {
      apiPost.mockRejectedValue(
        new ApiError('sprint session already active', undefined, 409),
      );
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(
          screen.getByTestId('drill-sprint-setup-conflict'),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId('drill-sprint-setup-cancel'));
      expect(
        screen.queryByTestId('drill-sprint-setup-conflict'),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('drill-sprint-setup-start')).toBeInTheDocument();
    });
  });

  // KS-2351: таймауты + сетевые ошибки.
  describe('KS-2351 — timeout / network errors', () => {
    it('REQUEST_TIMEOUT → error-баннер с data-error=timeout', async () => {
      apiPost.mockRejectedValue(
        new ApiError('Request timed out', 'REQUEST_TIMEOUT', 0),
      );
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(screen.getByTestId('drill-sprint-setup-error')).toBeInTheDocument(),
      );
      expect(
        screen.getByTestId('drill-sprint-setup-error').getAttribute('data-error'),
      ).toBe('timeout');
      // Кнопка снова доступна.
      expect(screen.getByTestId('drill-sprint-setup-start')).not.toBeDisabled();
    });

    it('NETWORK_ERROR → тот же data-error=timeout (для пользователя «сервер не отвечает»)', async () => {
      apiPost.mockRejectedValue(
        new ApiError('Network error', 'NETWORK_ERROR', 0),
      );
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(
          screen
            .getByTestId('drill-sprint-setup-error')
            .getAttribute('data-error'),
        ).toBe('timeout'),
      );
    });

    it('500 → data-error=loadFailed (отличается от timeout)', async () => {
      apiPost.mockRejectedValue(new ApiError('Internal', undefined, 500));
      const user = userEvent.setup();
      renderWithProviders(<DrillSprintSetupPage />);
      await user.click(screen.getByTestId('drill-sprint-setup-start'));
      await waitFor(() =>
        expect(
          screen
            .getByTestId('drill-sprint-setup-error')
            .getAttribute('data-error'),
        ).toBe('loadFailed'),
      );
    });

    it('watchdog: pending Promise → через 20с error=timeout, кнопка enabled', async () => {
      vi.useFakeTimers();
      try {
        apiPost.mockReturnValue(new Promise(() => {})); // never settles
        renderWithProviders(<DrillSprintSetupPage />);
        // userEvent проблематичен с fake timers — кликаем напрямую.
        fireEvent.click(screen.getByTestId('drill-sprint-setup-start'));
        // До 20с — кнопка disabled, ошибки нет.
        expect(screen.getByTestId('drill-sprint-setup-start')).toBeDisabled();
        expect(
          screen.queryByTestId('drill-sprint-setup-error'),
        ).not.toBeInTheDocument();
        // Прокручиваем 20с.
        act(() => {
          vi.advanceTimersByTime(20_000);
        });
        expect(
          screen.getByTestId('drill-sprint-setup-error').getAttribute(
            'data-error',
          ),
        ).toBe('timeout');
        expect(screen.getByTestId('drill-sprint-setup-start')).not.toBeDisabled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('Сетевая ошибка /sprint/start → error-баннер и кнопка снова enabled', async () => {
    apiPost.mockImplementation(() =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('500')), 0),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<DrillSprintSetupPage />);
    await user.click(screen.getByTestId('drill-sprint-setup-start'));
    await waitFor(() =>
      expect(screen.getByTestId('drill-sprint-setup-error')).toBeInTheDocument(),
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
