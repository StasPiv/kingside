import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { MistakesPage } from './MistakesPage';

const mockLessonsApi = {
  getMistakeAggregates: vi.fn(),
};

vi.mock('../api/lessonsApi', () => ({
  lessonsApi: {
    getMistakeAggregates: (...args: unknown[]) =>
      mockLessonsApi.getMistakeAggregates(...args),
  },
}));

beforeEach(() => {
  mockLessonsApi.getMistakeAggregates.mockReset();
});

describe('MistakesPage (/lessons/mistakes)', () => {
  it('рендерит индикатор загрузки', () => {
    mockLessonsApi.getMistakeAggregates.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<MistakesPage />);
    expect(screen.getByTestId('mistakes-loading')).toBeInTheDocument();
  });

  it('рендерит таблицу со всеми темами и ссылкой «Тренировать» по каждой', async () => {
    mockLessonsApi.getMistakeAggregates.mockResolvedValueOnce({
      aggregates: [
        { theme: 'fork', count: 12, lastOccurredAt: '2026-04-22T00:00:00.000Z' },
        { theme: 'pin', count: 7, lastOccurredAt: '2026-04-20T00:00:00.000Z' },
        { theme: 'skewer', count: 5, lastOccurredAt: '2026-04-19T00:00:00.000Z' },
      ],
      totalThemes: 3,
      since: null,
      limit: 20,
    });
    renderWithProviders(<MistakesPage />);

    await waitFor(() =>
      expect(screen.getByTestId('mistakes-page-table')).toBeInTheDocument(),
    );

    expect(screen.getByTestId('mistakes-page-total')).toHaveTextContent('3');
    expect(screen.getByTestId('mistakes-page-row-fork')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-page-row-pin')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-page-row-skewer')).toBeInTheDocument();
    expect(screen.getByTestId('mistakes-page-cta-fork')).toHaveAttribute(
      'href',
      '/lessons/mistakes-practice?theme=fork',
    );
  });

  it('пустой список → «пока ошибок нет»', async () => {
    mockLessonsApi.getMistakeAggregates.mockResolvedValueOnce({
      aggregates: [],
      totalThemes: 0,
      since: null,
      limit: 20,
    });
    renderWithProviders(<MistakesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-empty')).toBeInTheDocument(),
    );
  });

  it('сетевая ошибка → сообщение об ошибке', async () => {
    mockLessonsApi.getMistakeAggregates.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<MistakesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-error')).toBeInTheDocument(),
    );
  });

  it('ссылка «All courses» ведёт на /lessons', async () => {
    mockLessonsApi.getMistakeAggregates.mockResolvedValueOnce({
      aggregates: [],
      totalThemes: 0,
      since: null,
      limit: 20,
    });
    renderWithProviders(<MistakesPage />);
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-empty')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('mistakes-page-back')).toHaveAttribute(
      'href',
      '/lessons',
    );
  });
});
