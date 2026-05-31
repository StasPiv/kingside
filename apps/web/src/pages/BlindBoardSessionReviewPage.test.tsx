import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { screen, testI18n } from '../test/test-utils';
import { ThemeProvider } from '../context/ThemeContext';
import { BoardSettingsProvider } from '../context/BoardSettingsContext';
import type {
  BlindBoardAttemptDto,
  BlindBoardSessionDto,
  BlindBoardSessionReviewResponse,
} from '@kingside/shared';
import { BlindBoardSessionReviewPage } from './BlindBoardSessionReviewPage';

/**
 * KS-3517. Страница review blind-board сессии: метрики, конфиг,
 * раунды, опц. startPosition.
 */

const { mockUseAuth } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(() => ({
    user: { id: 'u1', username: 't' },
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

function session(
  overrides: Partial<BlindBoardSessionDto> = {},
): BlindBoardSessionDto {
  return {
    id: 'bb-1',
    status: 'finished',
    finishReason: 'wrong-answer',
    round: 8,
    streak: 7,
    bestStreak: 11,
    level: 2,
    nextMove: null,
    startedAt: '2026-05-30T10:00:00.000Z',
    finishedAt: '2026-05-30T10:03:25.000Z',
    ...overrides,
  };
}

function attempt(
  round: number,
  overrides: Partial<BlindBoardAttemptDto> = {},
): BlindBoardAttemptDto {
  return {
    round,
    compMove: { from: 'e2', to: 'e4' },
    expectedSquare: 'd4',
    expectedPieceType: 'Q',
    userSquare: 'd4',
    userPieceType: 'Q',
    correct: true,
    createdAt: '2026-05-30T10:00:00.000Z',
    ...overrides,
  };
}

function renderAt(
  path: string,
  response:
    | BlindBoardSessionReviewResponse
    | (() => Promise<BlindBoardSessionReviewResponse>),
) {
  const getSession = vi
    .fn()
    .mockImplementation(
      typeof response === 'function'
        ? response
        : () => Promise.resolve(response),
    );
  render(
    <I18nextProvider i18n={testI18n}>
      <ThemeProvider initialTheme="dark">
        <BoardSettingsProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/blind-board/sessions/:id"
                element={
                  <BlindBoardSessionReviewPage getSession={getSession} />
                }
              />
            </Routes>
          </MemoryRouter>
        </BoardSettingsProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
  return getSession;
}

describe('<BlindBoardSessionReviewPage> KS-3517', () => {
  it('finished: метрики + конфиг + раунды + startPosition', async () => {
    renderAt('/blind-board/sessions/bb-1', {
      session: session(),
      config: {
        startPieces: ['Q', 'N', 'R'],
        addOrder: ['B', 'B', 'R', 'N'],
        memorizeTimeSec: 5,
      },
      attempts: [
        attempt(1),
        attempt(2, {
          correct: false,
          userSquare: 'a1',
          userPieceType: 'N',
        }),
      ],
      startPosition: [
        { square: 'd4', type: 'Q' },
        { square: 'a1', type: 'R' },
        { square: 'c3', type: 'N' },
      ],
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-review-page').getAttribute('data-state'),
      ).toBe('ready'),
    );
    // Метрики.
    expect(
      screen.getByTestId('blind-board-review-metric-level').textContent,
    ).toContain('L2');
    expect(
      screen.getByTestId('blind-board-review-metric-best-streak').textContent,
    ).toContain('11');
    expect(
      screen.getByTestId('blind-board-review-metric-current-streak').textContent,
    ).toContain('7');
    expect(
      screen.getByTestId('blind-board-review-metric-accuracy').textContent,
    ).toContain('50%');
    expect(
      screen.getByTestId('blind-board-review-metric-accuracy').textContent,
    ).toContain('1 / 2');
    expect(
      screen.getByTestId('blind-board-review-metric-rounds').textContent,
    ).toContain('2');
    expect(
      screen.getByTestId('blind-board-review-metric-finish-reason').textContent,
    ).toContain('Wrong answer');
    expect(
      screen.getByTestId('blind-board-review-duration').textContent,
    ).toContain('3:25');
    // Конфиг (значение memorizeTimeSec).
    expect(
      screen.getByTestId('blind-board-review-config-memorize').textContent,
    ).toContain('5s');
    // Раунды.
    expect(
      screen
        .getByTestId('blind-board-review-attempt-1')
        .getAttribute('data-correct'),
    ).toBe('true');
    expect(
      screen
        .getByTestId('blind-board-review-attempt-2')
        .getAttribute('data-correct'),
    ).toBe('false');
    expect(
      screen.getByTestId('blind-board-review-attempt-mark-1').textContent,
    ).toContain('Correct');
    expect(
      screen.getByTestId('blind-board-review-attempt-mark-2').textContent,
    ).toContain('Incorrect');
    // Start position list.
    expect(
      screen.getByTestId('blind-board-review-position-list'),
    ).toBeInTheDocument();
  });

  it('active: startPosition отсутствует → placeholder «locked»', async () => {
    renderAt('/blind-board/sessions/bb-2', {
      session: session({
        id: 'bb-2',
        status: 'active',
        finishReason: null,
        finishedAt: null,
      }),
      config: {
        startPieces: ['Q', 'N', 'R'],
        addOrder: ['B'],
        memorizeTimeSec: 3,
      },
      attempts: [attempt(1)],
      // нет startPosition.
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-review-page').getAttribute('data-status'),
      ).toBe('active'),
    );
    expect(
      screen.getByTestId('blind-board-review-position-hidden').textContent,
    ).toContain('revealed after the session ends');
  });

  it('attempt без ответа (open) → плашка (open)', async () => {
    renderAt('/blind-board/sessions/bb-3', {
      session: session({ id: 'bb-3', status: 'active', finishReason: null }),
      config: {
        startPieces: ['Q'],
        addOrder: [],
        memorizeTimeSec: 5,
      },
      attempts: [
        attempt(1, {
          userSquare: null,
          userPieceType: null,
          correct: false,
        }),
      ],
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-review-attempt-open-1'),
      ).toBeInTheDocument(),
    );
  });

  it('KS-3526: defensive — config/attempts/startPosition null НЕ роняют рендер', async () => {
    // Имитируем неполный ответ: attempts=null, config=null, startPosition=null
    // (это могло быть для legacy сессий до KS-3517 backend). До хотфикса
    // `data.attempts.filter(...)` бросал TypeError → React error → белый экран.
    renderAt('/blind-board/sessions/bb-degraded', {
      session: session({ id: 'bb-degraded' }),
      // typecheck shim: cast через unknown, чтобы передать null-поля.
      config: null as unknown as BlindBoardSessionReviewResponse['config'],
      attempts: null as unknown as BlindBoardAttemptDto[],
      startPosition:
        null as unknown as BlindBoardSessionReviewResponse['startPosition'],
    } as BlindBoardSessionReviewResponse);
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-review-page').getAttribute('data-state'),
      ).toBe('ready'),
    );
    // Метрики базовые отрисовались.
    expect(
      screen.getByTestId('blind-board-review-metric-rounds').textContent,
    ).toContain('0');
    // Attempts-empty placeholder.
    expect(
      screen.getByTestId('blind-board-review-attempts-empty'),
    ).toBeInTheDocument();
    // Position locked-плашка (startPosition отсутствует).
    expect(
      screen.getByTestId('blind-board-review-position-hidden'),
    ).toBeInTheDocument();
  });

  it('error: показывает retry', async () => {
    renderAt('/blind-board/sessions/bb-x', () =>
      Promise.reject(new Error('boom')),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('blind-board-review-error'),
      ).toBeInTheDocument(),
    );
  });
});
