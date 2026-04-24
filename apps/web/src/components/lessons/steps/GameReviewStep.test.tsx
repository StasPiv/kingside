import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { GameReviewStepPayload } from '@kingside/shared';

import { renderWithProviders, screen, waitFor } from '../../../test/test-utils';
import { GameReviewStep } from './GameReviewStep';

// ─── Моки тяжёлых зависимостей ────────────────────────────────────────
// `useGameReport` дёргает API (`GET /games/:id/report` + `POST
// /games/:id/analyze`). В unit-тестах шага нам важна диспетчеризация и
// чек-лист, не сетевой слой — мокаем хук и `GameReportPanel`.
const mockGameReport = {
  report: null as unknown,
  analyzing: false,
  error: null as string | null,
  fetchReport: vi.fn(),
  analyze: vi.fn(),
};

vi.mock('../../../hooks/useGameReport', () => ({
  useGameReport: (_gameId: string | undefined) => mockGameReport,
}));

vi.mock('../../GameReportPanel', () => ({
  GameReportPanel: () => (
    <div data-testid="game-report-panel-mock">report-panel</div>
  ),
}));

// `ImportExternalModal` дергает `/workshop/import-external`. Для проверки
// факта открытия модалки достаточно лёгкой заглушки.
vi.mock('../../workshop/ImportExternalModal', () => ({
  ImportExternalModal: ({
    source,
    onClose,
    onImported,
  }: {
    source: string;
    onClose: () => void;
    onImported: () => void;
  }) => (
    <div data-testid={`import-modal-mock-${source}`}>
      <button
        type="button"
        data-testid="import-modal-close"
        onClick={onClose}
      >
        close
      </button>
      <button
        type="button"
        data-testid="import-modal-complete"
        onClick={onImported}
      >
        complete
      </button>
    </div>
  ),
}));

beforeEach(() => {
  mockGameReport.report = null;
  mockGameReport.analyzing = false;
  mockGameReport.error = null;
  mockGameReport.fetchReport.mockReset();
  mockGameReport.analyze.mockReset();
});

function payload(p: Partial<GameReviewStepPayload>): GameReviewStepPayload {
  return { type: 'game_review', ...p };
}

describe('<GameReviewStep>', () => {
  it('gameId задан → рендерится GameReportPanel и deep-link на /analysis', async () => {
    renderWithProviders(
      <GameReviewStep payload={payload({ gameId: 'g-123' })} />,
    );
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'gameId',
    );
    expect(screen.getByTestId('game-report-panel-mock')).toBeInTheDocument();
    // useEffect вызывает fetchReport при монтировании
    await waitFor(() =>
      expect(mockGameReport.fetchReport).toHaveBeenCalledTimes(1),
    );
    // deep-link в полный разбор
    const link = screen.getByRole('link', { name: /full analysis|openFullAnalysis|полный/i });
    expect(link).toHaveAttribute('href', '/analysis/g-123');
  });

  it('pgn задан → показывается текст PGN и ссылка в Workshop', () => {
    const pgn = '[Event "Test"]\n1. e4 e5 2. Nf3 Nc6 *';
    renderWithProviders(<GameReviewStep payload={payload({ pgn })} />);
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'pgn',
    );
    expect(
      screen.getByTestId('lesson-game-review-step-pgn-text'),
    ).toHaveTextContent('1. e4 e5');
    expect(
      screen.getByTestId('lesson-game-review-step-workshop-link'),
    ).toHaveAttribute('href', expect.stringContaining('importPgn='));
    // fetchReport не должен дёргаться без gameId
    expect(mockGameReport.fetchReport).not.toHaveBeenCalled();
  });

  it('пустой payload → кнопки импорта; клик → ImportExternalModal', () => {
    renderWithProviders(<GameReviewStep payload={payload({})} />);
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'empty',
    );
    // Модалка не показана по умолчанию
    expect(
      screen.queryByTestId('import-modal-mock-lichess'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lesson-game-review-step-import-lichess'));
    expect(
      screen.getByTestId('import-modal-mock-lichess'),
    ).toBeInTheDocument();
  });

  it('модалка chesscom открывается по клику на соответствующую кнопку', () => {
    renderWithProviders(<GameReviewStep payload={payload({})} />);
    fireEvent.click(
      screen.getByTestId('lesson-game-review-step-import-chesscom'),
    );
    expect(
      screen.getByTestId('import-modal-mock-chesscom'),
    ).toBeInTheDocument();
  });

  it('после onImported из модалки показывается подсказка про мастерскую', () => {
    renderWithProviders(<GameReviewStep payload={payload({})} />);
    fireEvent.click(screen.getByTestId('lesson-game-review-step-import-lichess'));
    fireEvent.click(screen.getByTestId('import-modal-complete'));
    expect(
      screen.getByTestId('lesson-game-review-step-import-done'),
    ).toBeInTheDocument();
  });

  it('кнопка «Шаг пройден» заблокирована, пока не отмечен весь чек-лист', () => {
    renderWithProviders(<GameReviewStep payload={payload({ gameId: 'g1' })} />);
    const btn = screen.getByTestId(
      'lesson-game-review-step-done',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(
      screen.getByTestId('lesson-game-review-step-done-hint'),
    ).toBeInTheDocument();
  });

  it('отметка всех пунктов чек-листа → кнопка активна, onStepDone по клику', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <GameReviewStep
        payload={payload({ gameId: 'g1' })}
        onStepDone={onStepDone}
      />,
    );
    fireEvent.click(screen.getByTestId('lesson-game-review-step-check-key-mistake'));
    fireEvent.click(
      screen.getByTestId('lesson-game-review-step-check-opponent-plan'),
    );
    fireEvent.click(screen.getByTestId('lesson-game-review-step-check-best-move'));

    const btn = screen.getByTestId(
      'lesson-game-review-step-done',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(
      screen.queryByTestId('lesson-game-review-step-done-hint'),
    ).not.toBeInTheDocument();

    fireEvent.click(btn);
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('снятие одного пункта — кнопка снова блокируется', () => {
    renderWithProviders(<GameReviewStep payload={payload({ gameId: 'g1' })} />);
    fireEvent.click(screen.getByTestId('lesson-game-review-step-check-key-mistake'));
    fireEvent.click(
      screen.getByTestId('lesson-game-review-step-check-opponent-plan'),
    );
    fireEvent.click(screen.getByTestId('lesson-game-review-step-check-best-move'));
    fireEvent.click(screen.getByTestId('lesson-game-review-step-check-key-mistake'));

    const btn = screen.getByTestId(
      'lesson-game-review-step-done',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('hideNext → кнопка «Шаг пройден» не рендерится', () => {
    renderWithProviders(
      <GameReviewStep payload={payload({ gameId: 'g1' })} hideNext />,
    );
    expect(
      screen.queryByTestId('lesson-game-review-step-done'),
    ).not.toBeInTheDocument();
  });
});
