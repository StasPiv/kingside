import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, screen } from '../../test/test-utils';
import { AddToRepertoireModal } from './AddToRepertoireModal';
import type { OpeningRepertoireDto } from '@kingside/shared';

/**
 * KS-3331 (ADR-078 §5.3) — модалка «Добавить анализ в существующий
 * репертуар». Проверяем: рендер списка, выбор → onSelect(id), отмена →
 * onClose, submitting блокирует кнопки и показывает «Adding…».
 */

function rep(over: Partial<OpeningRepertoireDto> = {}): OpeningRepertoireDto {
  return {
    id: 'r-1',
    ownerId: 'u-1',
    title: 'Italian Game',
    description: null,
    side: 'white',
    nodeCount: 10,
    edgeCount: 9,
    maxDepth: 6,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...over,
  };
}

describe('<AddToRepertoireModal> — KS-3331', () => {
  it('рендерит список репертуаров с названием и стороной', () => {
    renderWithProviders(
      <AddToRepertoireModal
        repertoires={[
          rep({ id: 'r-1', title: 'Italian Game', side: 'white' }),
          rep({ id: 'r-2', title: 'Sicilian Defense', side: 'black' }),
        ]}
        submitting={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('analysis-add-to-repertoire-modal')).toBeTruthy();
    expect(screen.getByText('Italian Game')).toBeTruthy();
    expect(screen.getByText('Sicilian Defense')).toBeTruthy();
    // Бейджи сторон.
    expect(screen.getByTestId('analysis-add-to-repertoire-item-r-1').textContent).toContain(
      'White',
    );
    expect(screen.getByTestId('analysis-add-to-repertoire-item-r-2').textContent).toContain(
      'Black',
    );
  });

  it('клик по репертуару вызывает onSelect с его id', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AddToRepertoireModal
        repertoires={[rep({ id: 'r-1' }), rep({ id: 'r-2', title: 'Caro-Kann' })]}
        submitting={false}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByTestId('analysis-add-to-repertoire-item-r-2'));
    expect(onSelect).toHaveBeenCalledWith('r-2');
  });

  it('клик Cancel вызывает onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AddToRepertoireModal
        repertoires={[rep()]}
        submitting={false}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('analysis-add-to-repertoire-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submitting: кнопки disabled, по элементу с submittingId показывается «Adding…»', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <AddToRepertoireModal
        repertoires={[rep({ id: 'r-1', title: 'Italian Game' })]}
        submitting
        submittingId="r-1"
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );
    const item = screen.getByTestId('analysis-add-to-repertoire-item-r-1') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain('Adding…');
    expect(
      (screen.getByTestId('analysis-add-to-repertoire-cancel') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('клик по подложке закрывает (когда не submitting)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AddToRepertoireModal
        repertoires={[rep()]}
        submitting={false}
        onSelect={() => {}}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('analysis-add-to-repertoire-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
