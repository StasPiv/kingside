import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { PrecisionStartTrainingButton } from './PrecisionStartTrainingButton';

/**
 * KS-3348 (ADR-079 §3.4). Sticky-кнопка «Начать тренировку».
 * Покрытие:
 *  - idle render + label.
 *  - клик → precisionApi.pickNext с правильными фильтрами из URL.
 *  - 404 (puzzleId=null) → empty-сообщение.
 *  - сетевая ошибка → error-сообщение.
 *  - loading-состояние disabled + label «Подбираем…».
 *  - guest → pickNext всё равно работает с scope=server.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const authMock: { user: { id: string; username: string } | null } = {
  user: { id: 'u1', username: 'tester' },
};
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: authMock.user,
    loading: false,
    token: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

const pickNext = vi.fn();
vi.mock('../../api/precisionApi', () => ({
  precisionApi: {
    pickNext: (...args: unknown[]) => pickNext(...args),
  },
}));

beforeEach(() => {
  mockNavigate.mockReset();
  pickNext.mockReset();
  authMock.user = { id: 'u1', username: 'tester' };
});

describe('<PrecisionStartTrainingButton> KS-3348', () => {
  it('idle → рендерит «Начать тренировку»', () => {
    renderWithProviders(<PrecisionStartTrainingButton />);
    const btn = screen.getByTestId('precision-start-training');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('data-status')).toBe('idle');
    expect(btn.textContent).toMatch(/Start training|Начать/);
  });

  it('клик → pickNext с фильтрами из URL → navigate /puzzle', async () => {
    pickNext.mockResolvedValue({
      puzzleId: 'p-42',
      rating: 1700,
      ratingDelta: 80,
    });
    renderWithProviders(<PrecisionStartTrainingButton />, {
      route: '/precision?scope=drafts&objective=convertAdvantage',
    });
    fireEvent.click(screen.getByTestId('precision-start-training'));
    await waitFor(() => expect(pickNext).toHaveBeenCalledTimes(1));
    expect(pickNext.mock.calls[0][0]).toMatchObject({
      scope: 'drafts',
      objective: 'convertAdvantage',
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
    const target = mockNavigate.mock.calls[0][0] as string;
    expect(target).toMatch(/^\/puzzle\/p-42\?/);
    expect(target).toContain('source=precision');
    expect(target).toContain('scope=drafts');
    expect(target).toContain('objective=convertAdvantage');
  });

  it('404 (puzzleId=null) → empty-сообщение, no navigate', async () => {
    pickNext.mockResolvedValue({
      puzzleId: null,
      reason: 'no_puzzles_available',
    });
    renderWithProviders(<PrecisionStartTrainingButton />);
    fireEvent.click(screen.getByTestId('precision-start-training'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('precision-start-training-empty'),
      ).toBeTruthy();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('precision-start-training-empty').textContent,
    ).toMatch(/No puzzles match|Нет подходящих/);
  });

  it('сетевая ошибка → error-сообщение, no navigate', async () => {
    pickNext.mockRejectedValue(new Error('500'));
    renderWithProviders(<PrecisionStartTrainingButton />);
    fireEvent.click(screen.getByTestId('precision-start-training'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('precision-start-training-error'),
      ).toBeTruthy();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('loading → кнопка disabled + label «Подбираем…»', async () => {
    let resolvePick: (v: unknown) => void = () => {};
    pickNext.mockReturnValue(
      new Promise((res) => {
        resolvePick = res;
      }),
    );
    renderWithProviders(<PrecisionStartTrainingButton />);
    fireEvent.click(screen.getByTestId('precision-start-training'));
    await waitFor(() => {
      const btn = screen.getByTestId(
        'precision-start-training',
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('data-status')).toBe('loading');
      expect(btn.textContent).toMatch(/Picking|Подбираем/);
    });
    resolvePick({ puzzleId: 'p-1', rating: 1500, ratingDelta: 0 });
  });

  it('guest → scope=server в pickNext-запросе', async () => {
    authMock.user = null;
    pickNext.mockResolvedValue({
      puzzleId: 'p-7',
      rating: 1500,
      ratingDelta: 0,
    });
    renderWithProviders(<PrecisionStartTrainingButton />, {
      route: '/precision?scope=drafts', // даже если в URL drafts —
      // backend форсит server для гостя (buildPrecisionNextParams).
    });
    fireEvent.click(screen.getByTestId('precision-start-training'));
    await waitFor(() => expect(pickNext).toHaveBeenCalledTimes(1));
    expect(pickNext.mock.calls[0][0].scope).toBe('server');
  });
});
