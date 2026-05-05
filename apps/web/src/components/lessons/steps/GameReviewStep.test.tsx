import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { GameReviewStepPayload } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { GameReviewStep } from './GameReviewStep';

// `ImportExternalModal` дёргает `/workshop/import-external`. Для проверки
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

function payload(p: Partial<GameReviewStepPayload>): GameReviewStepPayload {
  return { type: 'game_review', ...p };
}

describe('<GameReviewStep>', () => {
  it('gameId задан → рендерится deep-link на /analysis (без серверного отчёта, KS-2434)', () => {
    renderWithProviders(
      <GameReviewStep payload={payload({ gameId: 'g-123' })} />,
    );
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'gameId',
    );
    // KS-2434: панель серверного отчёта удалена, deep-link на /analysis остался.
    const link = screen.getByRole('link', {
      name: /full analysis|openFullAnalysis|полный/i,
    });
    expect(link).toHaveAttribute('href', '/analysis/g-123');
  });

  it('pgn задан → рендерит интерактивный viewer (KS-1999), без сырого PGN и без Workshop ссылки', () => {
    const pgn = '[Event "Test"]\n1. e4 e5 2. Nf3 Nc6 *';
    renderWithProviders(<GameReviewStep payload={payload({ pgn })} />);
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'pgn',
    );
    expect(screen.getByTestId('inline-pgn-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('inline-pgn-viewer-counter').textContent).toBe(
      '0/4',
    );
    expect(
      screen.queryByTestId('lesson-game-review-step-pgn-text'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lesson-game-review-step-workshop-link'),
    ).not.toBeInTheDocument();
  });

  it('пустой payload → кнопки импорта; клик → ImportExternalModal', () => {
    renderWithProviders(<GameReviewStep payload={payload({})} />);
    expect(screen.getByTestId('lesson-game-review-step')).toHaveAttribute(
      'data-mode',
      'empty',
    );
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

  it('KS-2000: чек-лист удалён', () => {
    const pgn = '[Event "Test"]\n1. e4 e5 *';
    renderWithProviders(<GameReviewStep payload={payload({ pgn })} />);
    expect(
      screen.queryByTestId('lesson-game-review-step-checklist'),
    ).not.toBeInTheDocument();
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
    expect(btn.textContent).toMatch(/got it|готово/i);
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
