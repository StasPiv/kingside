/**
 * KS-3603. Тесты `GameReviewProgressModal` — рендер по статусам, кнопки.
 */
import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';

import { GameReviewProgressModal } from './GameReviewProgressModal';
import { renderWithProviders, screen } from '../../test/test-utils';

describe('<GameReviewProgressModal>', () => {
  it('open=false → ничего не рендерится', () => {
    renderWithProviders(
      <GameReviewProgressModal
        open={false}
        status="running"
        done={0}
        total={10}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('game-review-progress-modal')).toBeNull();
  });

  it('running: показывает прогресс «done/total» и cancel-кнопку', () => {
    renderWithProviders(
      <GameReviewProgressModal
        open
        status="running"
        done={5}
        total={10}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const txt = screen.getByTestId('game-review-progress-text');
    expect(txt.textContent).toContain('5');
    expect(txt.textContent).toContain('10');
    expect(txt.textContent).toContain('50%');
    expect(screen.getByTestId('game-review-progress-cancel-btn')).toBeTruthy();
  });

  it('cancel-кнопка вызывает onCancel', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <GameReviewProgressModal
        open
        status="running"
        done={0}
        total={10}
        onCancel={onCancel}
        onClose={vi.fn()}
      />,
    );
    act(() => {
      (
        screen.getByTestId('game-review-progress-cancel-btn') as HTMLButtonElement
      ).click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('крестик × вызывает onClose', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <GameReviewProgressModal
        open
        status="running"
        done={0}
        total={10}
        onCancel={vi.fn()}
        onClose={onClose}
      />,
    );
    act(() => {
      (
        screen.getByTestId('game-review-progress-modal-close') as HTMLButtonElement
      ).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('error: показывает текст ошибки и close+retry кнопки', () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <GameReviewProgressModal
        open
        status="error"
        done={3}
        total={10}
        error="WASM crashed"
        onCancel={vi.fn()}
        onClose={vi.fn()}
        onRetry={onRetry}
      />,
    );
    // Дженерик текст ошибки или техдеталь (зависит от перевода).
    expect(screen.getByTestId('game-review-progress-error')).toBeTruthy();
    const retry = screen.getByTestId(
      'game-review-progress-retry-btn',
    ) as HTMLButtonElement;
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId('game-review-progress-cancel-btn'),
    ).toBeNull();
  });

  it('KS-3616: stage="comments" — текст сообщает о генерации, без процентов', () => {
    renderWithProviders(
      <GameReviewProgressModal
        open
        status="running"
        stage="comments"
        done={0}
        total={5}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const txt = screen.getByTestId('game-review-progress-text');
    // Текст не содержит числа — это «Готовлю комментарии…» / «Generating comments…».
    expect(txt.textContent).not.toContain('0 /');
    expect(txt.textContent).not.toContain('%');
    expect(txt.textContent && txt.textContent.length > 0).toBe(true);
  });

  it('progress-bar fill = done/total * 100%', () => {
    renderWithProviders(
      <GameReviewProgressModal
        open
        status="running"
        done={3}
        total={10}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const bar = screen.getByTestId('game-review-progress-bar-fill') as HTMLDivElement;
    expect(bar.style.width).toBe('30%');
  });
});
