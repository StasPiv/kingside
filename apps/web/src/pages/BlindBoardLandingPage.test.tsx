import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { DEFAULT_BLIND_BOARD_CONFIG } from '@kingside/shared';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { BlindBoardLandingPage } from './BlindBoardLandingPage';

/**
 * KS-3488 (ADR-088 V2 §15 F1) — лендинг с настройками сложности.
 *
 * KS-3556: KS-3511 добавил `BlindBoardSubNav` на лендинг, а он зовёт
 * `useAuth()`. `renderWithProviders` из `test-utils.tsx` не оборачивает
 * в `AuthProvider` — мокаем `AuthContext` локально по тому же паттерну,
 * что и `GuessLandingPage.test.tsx` (KS-3503).
 */
const { mockUseAuth } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(() => ({
    user: { id: 'u-1', username: 'tester' },
    token: 'jwt',
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    loginWithTokens: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  })),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// SessionRunner мокаем — он рендерит лишний UI и фетчит api.
vi.mock('../components/blindBoard/BlindBoardSessionRunner', () => ({
  BlindBoardSessionRunner: ({
    config,
  }: {
    config?: typeof DEFAULT_BLIND_BOARD_CONFIG;
  }) => (
    <div
      data-testid="session-runner-stub"
      data-config={JSON.stringify(config ?? null)}
    />
  ),
}));

beforeEach(() => {
  localStorage.clear();
});

describe('<BlindBoardLandingPage> KS-3488', () => {
  it('setup-экран: видны блок настроек (свёрнут) и кнопка Start enabled на дефолте', () => {
    renderWithProviders(<BlindBoardLandingPage />);
    expect(screen.getByTestId('blind-board-page-title')).toBeTruthy();
    expect(screen.getByTestId('blind-board-settings').getAttribute('data-open')).toBe(
      'false',
    );
    expect(screen.queryByTestId('blind-board-settings-body')).toBeNull();
    expect(
      (screen.getByTestId('blind-board-start') as HTMLButtonElement).disabled,
    ).toBe(false);
    // Summary показывает дефолтный конфиг (Q+N+R / B,B,R,N / 5s).
    const summary = screen.getByTestId('blind-board-settings-summary').textContent;
    expect(summary).toContain('Q+N+R');
    expect(summary).toContain('B,B,R,N');
    expect(summary).toContain('5s');
  });

  it('toggle открывает форму настроек', async () => {
    renderWithProviders(<BlindBoardLandingPage />);
    await act(async () => {
      (
        screen.getByTestId('blind-board-settings-toggle') as HTMLButtonElement
      ).click();
    });
    expect(screen.getByTestId('blind-board-settings-body')).toBeTruthy();
    expect(screen.getByTestId('blind-board-config-form')).toBeTruthy();
  });

  it('изменение конфига → сохраняется в localStorage; кнопка Start всё ещё enabled', async () => {
    renderWithProviders(<BlindBoardLandingPage />);
    await act(async () => {
      (
        screen.getByTestId('blind-board-settings-toggle') as HTMLButtonElement
      ).click();
    });
    // Меняем memorize 5 → 10.
    await act(async () => {
      const radio = screen
        .getByTestId('blind-board-config-memorize-10')
        .querySelector('input') as HTMLInputElement;
      radio.click();
    });
    await waitFor(() => {
      const stored = localStorage.getItem('blindBoard:config:v1');
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.memorizeTimeSec).toBe(10);
    });
    expect(
      (screen.getByTestId('blind-board-start') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('startPieces < 3 → Start disabled + error', async () => {
    renderWithProviders(<BlindBoardLandingPage />);
    await act(async () => {
      (
        screen.getByTestId('blind-board-settings-toggle') as HTMLButtonElement
      ).click();
    });
    // Default startPieces: Q+N+R. Уменьшаем R и N до 0 → останется Q (1<3).
    await act(async () => {
      (
        screen.getByTestId('blind-board-config-start-dec-R') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        screen.getByTestId('blind-board-config-start-dec-N') as HTMLButtonElement
      ).click();
    });
    expect(
      (screen.getByTestId('blind-board-start') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('blind-board-settings-error')).toBeTruthy();
  });

  it('клик Start → SessionRunner получает текущий config', async () => {
    renderWithProviders(<BlindBoardLandingPage />);
    await act(async () => {
      (
        screen.getByTestId('blind-board-settings-toggle') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      const radio = screen
        .getByTestId('blind-board-config-memorize-3')
        .querySelector('input') as HTMLInputElement;
      radio.click();
    });
    await act(async () => {
      (screen.getByTestId('blind-board-start') as HTMLButtonElement).click();
    });
    const stub = screen.getByTestId('session-runner-stub');
    const passed = JSON.parse(stub.getAttribute('data-config') ?? 'null');
    expect(passed).toMatchObject({ memorizeTimeSec: 3 });
  });

  it('Restore defaults → конфиг возвращается к DEFAULT', async () => {
    renderWithProviders(<BlindBoardLandingPage />);
    await act(async () => {
      (
        screen.getByTestId('blind-board-settings-toggle') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      const radio = screen
        .getByTestId('blind-board-config-memorize-10')
        .querySelector('input') as HTMLInputElement;
      radio.click();
    });
    await act(async () => {
      (
        screen.getByTestId('blind-board-settings-restore') as HTMLButtonElement
      ).click();
    });
    // summary вернулся к 5s.
    expect(
      screen.getByTestId('blind-board-settings-summary').textContent,
    ).toContain('5s');
  });
});
