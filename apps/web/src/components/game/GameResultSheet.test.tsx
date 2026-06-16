import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../../test/test-utils';
import { GameResultSheet } from './GameResultSheet';

describe('KS-4288 / ADR-134 §1: GameResultSheet', () => {
  const baseProps = {
    outcome: 'win' as const,
    title: 'Victory',
    detail: 'White wins by checkmate',
    actions: (
      <>
        <button type="button">Rematch</button>
        <button type="button">Open in analysis</button>
        <button type="button">New game</button>
        <button type="button">Home</button>
      </>
    ),
  };

  it('по умолчанию открыт: показывает заголовок, описание и кнопки', () => {
    renderWithProviders(<GameResultSheet {...baseProps} />);
    expect(screen.getByTestId('game-result-sheet')).toBeInTheDocument();
    expect(screen.getByText('Victory')).toBeInTheDocument();
    expect(screen.getByText('White wins by checkmate')).toBeInTheDocument();
    expect(screen.getByText('Rematch')).toBeInTheDocument();
    expect(screen.getByText('Open in analysis')).toBeInTheDocument();
    expect(screen.queryByTestId('game-result-pill')).not.toBeInTheDocument();
  });

  it('применяет модификатор по исходу (win/loss/draw)', () => {
    const { rerender } = renderWithProviders(<GameResultSheet {...baseProps} />);
    expect(screen.getByTestId('game-result-sheet')).toHaveClass(
      'game-result-sheet--win',
    );
    rerender(<GameResultSheet {...baseProps} outcome="loss" />);
    expect(screen.getByTestId('game-result-sheet')).toHaveClass(
      'game-result-sheet--loss',
    );
    rerender(<GameResultSheet {...baseProps} outcome="draw" />);
    expect(screen.getByTestId('game-result-sheet')).toHaveClass(
      'game-result-sheet--draw',
    );
  });

  it('рейтинг рендерится только когда передан', () => {
    const { rerender } = renderWithProviders(
      <GameResultSheet {...baseProps} />,
    );
    expect(
      screen.queryByText('+12', { exact: false }),
    ).not.toBeInTheDocument();
    rerender(
      <GameResultSheet
        {...baseProps}
        ratingBlock={<span data-testid="rating-block">1500 → 1512 (+12)</span>}
      />,
    );
    expect(screen.getByTestId('rating-block')).toBeInTheDocument();
  });

  it('клик по подложке вызывает onCloseOverlay, если передан', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <GameResultSheet {...baseProps} onCloseOverlay={onClose} />,
    );
    await userEvent.click(screen.getByTestId('game-result-sheet-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('клик внутри панели НЕ вызывает onCloseOverlay (stopPropagation)', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <GameResultSheet {...baseProps} onCloseOverlay={onClose} />,
    );
    await userEvent.click(screen.getByTestId('game-result-sheet'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('без onCloseOverlay клик по подложке сворачивает в полоску', async () => {
    renderWithProviders(<GameResultSheet {...baseProps} />);
    await userEvent.click(screen.getByTestId('game-result-sheet-overlay'));
    expect(screen.getByTestId('game-result-pill')).toBeInTheDocument();
    expect(screen.queryByTestId('game-result-sheet')).not.toBeInTheDocument();
  });

  it('клик по полоске раскрывает панель обратно', async () => {
    renderWithProviders(<GameResultSheet {...baseProps} />);
    // Сворачиваем
    await userEvent.click(screen.getByTestId('game-result-sheet-overlay'));
    expect(screen.getByTestId('game-result-pill')).toBeInTheDocument();
    // Раскрываем обратно
    await userEvent.click(screen.getByTestId('game-result-pill'));
    expect(screen.getByTestId('game-result-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('game-result-pill')).not.toBeInTheDocument();
  });
});
