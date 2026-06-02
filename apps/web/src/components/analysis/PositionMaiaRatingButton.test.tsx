/**
 * KS-3579. Тесты `PositionMaiaRatingButton` — UI оборачивает
 * `usePositionMaiaRating`. Мокаем хук чтобы проверить только
 * рендеринг состояний и disabled-логику.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';

import { PositionMaiaRatingButton } from './PositionMaiaRatingButton';
import { renderWithProviders, screen } from '../../test/test-utils';

const { mockUseHook } = vi.hoisted(() => ({
  mockUseHook: vi.fn(),
}));
vi.mock('../../hooks/usePositionMaiaRating', () => ({
  usePositionMaiaRating: () => mockUseHook(),
  POSITION_MAIA_RATINGS: [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400],
}));

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

beforeEach(() => {
  mockUseHook.mockReset();
});

describe('<PositionMaiaRatingButton> KS-3579', () => {
  it('idle: показывает CTA-кнопку, disabled если нет stockfishBestUci', () => {
    mockUseHook.mockReturnValue({
      status: 'idle',
      rating: null,
      error: null,
      compute: vi.fn(),
      reset: vi.fn(),
    });
    renderWithProviders(
      <PositionMaiaRatingButton fen={STARTPOS} stockfishBestUci={null} />,
    );
    const btn = screen.getByTestId(
      'position-maia-rating-btn',
    ) as HTMLButtonElement;
    expect(btn.textContent?.toLowerCase()).toContain('get');
    expect(btn.disabled).toBe(true);
  });

  it('idle: кнопка enabled когда stockfishBestUci задан, клик зовёт compute(fen, best)', () => {
    const compute = vi.fn();
    mockUseHook.mockReturnValue({
      status: 'idle',
      rating: null,
      error: null,
      compute,
      reset: vi.fn(),
    });
    renderWithProviders(
      <PositionMaiaRatingButton fen={STARTPOS} stockfishBestUci="e2e4" />,
    );
    const btn = screen.getByTestId(
      'position-maia-rating-btn',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => {
      btn.click();
    });
    expect(compute).toHaveBeenCalledWith(STARTPOS, 'e2e4');
  });

  it('computing: показывает loading-лейбл и disabled-кнопку', () => {
    mockUseHook.mockReturnValue({
      status: 'computing',
      rating: null,
      error: null,
      compute: vi.fn(),
      reset: vi.fn(),
    });
    renderWithProviders(
      <PositionMaiaRatingButton fen={STARTPOS} stockfishBestUci="e2e4" />,
    );
    const btn = screen.getByTestId(
      'position-maia-rating-btn',
    ) as HTMLButtonElement;
    expect(btn.textContent?.toLowerCase()).toContain('computing');
    expect(btn.disabled).toBe(true);
  });

  it('done: показывает «~<rating>» с числом и кнопку «Ещё раз»', () => {
    mockUseHook.mockReturnValue({
      status: 'done',
      rating: 1700,
      error: null,
      compute: vi.fn(),
      reset: vi.fn(),
    });
    renderWithProviders(
      <PositionMaiaRatingButton fen={STARTPOS} stockfishBestUci="e2e4" />,
    );
    const result = screen.getByTestId('position-maia-rating-result');
    expect(result.textContent).toContain('1700');
    // Acceptance: без шкалы/FIDE/Lichess.
    expect(result.textContent).not.toMatch(/lichess|fide/i);
    expect(screen.getByTestId('position-maia-rating-reset')).toBeTruthy();
  });

  it('above-range: показывает дженерик-сообщение и кнопку «Ещё раз»', () => {
    mockUseHook.mockReturnValue({
      status: 'above-range',
      rating: null,
      error: null,
      compute: vi.fn(),
      reset: vi.fn(),
    });
    renderWithProviders(
      <PositionMaiaRatingButton fen={STARTPOS} stockfishBestUci="e2e4" />,
    );
    const result = screen.getByTestId('position-maia-rating-result');
    expect(result.textContent?.toLowerCase()).toContain('above');
  });

  it('error: показывает дженерик-ошибку без техдеталей', () => {
    mockUseHook.mockReturnValue({
      status: 'error',
      rating: null,
      error: 'WASM 500 internal-onnx-crash',
      compute: vi.fn(),
      reset: vi.fn(),
    });
    renderWithProviders(
      <PositionMaiaRatingButton fen={STARTPOS} stockfishBestUci="e2e4" />,
    );
    const result = screen.getByTestId('position-maia-rating-result');
    expect(result.textContent).toBe('Could not get rating');
    // Реальный текст ошибки не должен утекать в UI.
    expect(result.textContent).not.toContain('WASM');
    expect(result.textContent).not.toContain('onnx');
  });
});
