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

  it('pgn задан → рендерит интерактивный viewer (KS-1999), без сырого PGN и без Workshop ссылки', () => {
    const pgn = '[Event "Test"]\n1. e4 e5 2. Nf3 Nc6 *';
    renderWithProviders(<GameReviewStep payload={payload({ pgn })} />);
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'pgn',
    );
    // KS-1999: viewer на месте, его counter — «0/4» (4 plies в этом PGN).
    expect(screen.getByTestId('inline-pgn-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('inline-pgn-viewer-counter').textContent).toBe(
      '0/4',
    );
    // Сырого PGN-блока и Workshop-ссылки больше нет.
    expect(
      screen.queryByTestId('lesson-game-review-step-pgn-text'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lesson-game-review-step-workshop-link'),
    ).not.toBeInTheDocument();
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

  // ─── KS-2000: чек-лист удалён, шаг завершается обычной «Далее» ────

  it('KS-2000: под viewer\'ом нет чек-листа', () => {
    const pgn = '[Event "Test"]\n1. e4 e5 *';
    renderWithProviders(<GameReviewStep payload={payload({ pgn })} />);
    // Чек-лист и его внутренние тестовые id больше не должны существовать.
    expect(
      screen.queryByTestId('lesson-game-review-step-checklist'),
    ).not.toBeInTheDocument();
    for (const id of ['key-mistake', 'opponent-plan', 'best-move']) {
      expect(
        screen.queryByTestId(`lesson-game-review-step-check-${id}`),
      ).not.toBeInTheDocument();
    }
  });

  it('KS-2000: кнопка «Далее» всегда активна и вызывает onStepDone по клику', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <GameReviewStep
        payload={payload({ gameId: 'g1' })}
        onStepDone={onStepDone}
      />,
    );
    const btn = screen.getByTestId(
      'lesson-game-review-step-next',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/next|далее/i);
    fireEvent.click(btn);
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('KS-2000: hideNext → кнопка «Далее» не рендерится', () => {
    renderWithProviders(
      <GameReviewStep payload={payload({ gameId: 'g1' })} hideNext />,
    );
    expect(
      screen.queryByTestId('lesson-game-review-step-next'),
    ).not.toBeInTheDocument();
  });
});
