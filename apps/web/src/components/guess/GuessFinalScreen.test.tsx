import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { GuessFinalScreen } from './GuessFinalScreen';
import type {
  FinishGuessSessionResponse,
  GuessSessionDto,
} from '@kingside/shared';

/**
 * KS-3461 (ADR-089 §6) — кнопка «Разобрать в анализе» на финал-экране.
 * guessApi.toAnalysis и react-router-dom.useNavigate замоканы; цель —
 * проверить wiring: кнопку видим при finished, клик → POST → navigate;
 * existing=true → toast «Открываю существующий разбор» перед навигацией;
 * ошибка POST'а → видим error-сообщение.
 */

const toAnalysis = vi.fn();
vi.mock('../../api/guessApi', () => ({
  guessApi: {
    toAnalysis: (...a: unknown[]) => toAnalysis(...a),
  },
  GUESS_VERDICT_POINTS: { strongest: 10, betterThanPlayer: 7, asPlayer: 5, weaker: 1 },
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

function session(over: Partial<GuessSessionDto> = {}): GuessSessionDto {
  return {
    id: 's-1',
    gameSource: 'pgn',
    gameRef: null,
    side: 'white',
    status: 'finished',
    userAccuracy: 72,
    playerAccuracy: 88,
    userStars: 3,
    score: 1,
    bestStreak: 1,
    betterThanPlayerCount: 0,
    startedAt: '2026-05-30T00:00:00.000Z',
    finishedAt: '2026-05-30T00:10:00.000Z',
    ...over,
  };
}

function finalRes(
  over: Partial<FinishGuessSessionResponse> = {},
): FinishGuessSessionResponse {
  return {
    session: session(),
    outcome: 'tie',
    ...over,
  };
}

beforeEach(() => {
  toAnalysis.mockReset();
  navigate.mockReset();
  vi.useRealTimers();
});

describe('<GuessFinalScreen> KS-3461 open-in-analysis', () => {
  it('кнопка не рендерится если session.status !== "finished"', () => {
    renderWithProviders(
      <GuessFinalScreen
        side="white"
        moves={[]}
        finalResult={finalRes({
          session: session({ status: 'active' }),
        })}
        score={1}
      />,
    );
    expect(screen.queryByTestId('guess-final-open-analysis')).toBeNull();
  });

  it('finished → клик кнопки → POST + navigate(/analysis/:id)', async () => {
    toAnalysis.mockResolvedValue({
      analysisId: 'a-42',
      url: '/analysis/a-42',
      existing: false,
    });
    renderWithProviders(
      <GuessFinalScreen
        side="white"
        moves={[]}
        finalResult={finalRes()}
        score={1}
      />,
    );
    const btn = screen.getByTestId(
      'guess-final-open-analysis',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    // analyzing=true → кнопка disabled (React 19 batching — даём
    // следующий тик через waitFor).
    await waitFor(() =>
      expect(
        (screen.getByTestId('guess-final-open-analysis') as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    await waitFor(() => expect(toAnalysis).toHaveBeenCalledWith('s-1'));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/analysis/a-42'),
    );
    // existing=false → toast не показываем.
    expect(screen.queryByTestId('guess-final-open-existing-toast')).toBeNull();
  });

  it('existing=true → toast виден; navigate с задержкой', async () => {
    toAnalysis.mockResolvedValue({
      analysisId: 'a-7',
      url: '/analysis/a-7',
      existing: true,
    });
    renderWithProviders(
      <GuessFinalScreen
        side="white"
        moves={[]}
        finalResult={finalRes()}
        score={1}
      />,
    );
    (
      screen.getByTestId('guess-final-open-analysis') as HTMLButtonElement
    ).click();
    // Toast «открываю существующий разбор» появляется ДО navigate.
    await waitFor(() =>
      expect(
        screen.getByTestId('guess-final-open-existing-toast'),
      ).toBeTruthy(),
    );
    // Navigate срабатывает с короткой задержкой (800ms в реализации).
    await waitFor(
      () => expect(navigate).toHaveBeenCalledWith('/analysis/a-7'),
      { timeout: 2000 },
    );
  });

  it('POST упал → отображаем error, кнопка снова enabled', async () => {
    toAnalysis.mockRejectedValue(new Error('500'));
    renderWithProviders(
      <GuessFinalScreen
        side="white"
        moves={[]}
        finalResult={finalRes()}
        score={1}
      />,
    );
    (
      screen.getByTestId('guess-final-open-analysis') as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(
        screen.getByTestId('guess-final-open-analysis-error'),
      ).toBeTruthy(),
    );
    expect(
      (screen.getByTestId('guess-final-open-analysis') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
