import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { ArchiveGameRow } from './ArchiveGameRow';
import type { ArchiveGameSummary } from '@kingside/shared';

/**
 * KS-3499 (ADR-091 F2). Selection-режим архива: optional `onSelect`
 * рисует кнопку «✓ Pick» рядом со строкой, клик по которой не должен
 * триггерить обычный `onClick` row'а (stopPropagation).
 */

const ITEM: ArchiveGameSummary = {
  id: 'g-1',
  white: { name: 'White Player', elo: 2700, slug: 'white-player' },
  black: { name: 'Black Player', elo: 2650, slug: 'black-player' },
  result: '1-0',
  eco: 'C42',
  opening: 'Petroff',
  event: 'Test Cup',
  date: '2024.01.01',
  plyCount: 40,
  timeControl: null,
  timeControlCategory: null,
};

describe('<ArchiveGameRow> KS-3499 selection mode', () => {
  it('без onSelect — кнопка «Pick» не рендерится', () => {
    renderWithProviders(<ArchiveGameRow item={ITEM} onClick={() => {}} />);
    expect(screen.queryByTestId('archive-game-row-select-g-1')).toBeNull();
  });

  it('с onSelect — кнопка рендерится с текстом и aria-label', () => {
    renderWithProviders(
      <ArchiveGameRow item={ITEM} onClick={() => {}} onSelect={() => {}} />,
    );
    const btn = screen.getByTestId('archive-game-row-select-g-1');
    expect(btn.textContent).toContain('Pick');
    expect(btn.getAttribute('aria-label')).toBe('Pick this game');
  });

  it('клик по «Pick» вызывает onSelect и НЕ вызывает onClick row', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onSelect = vi.fn();
    renderWithProviders(
      <ArchiveGameRow item={ITEM} onClick={onClick} onSelect={onSelect} />,
    );
    await user.click(screen.getByTestId('archive-game-row-select-g-1'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ITEM);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('клик по самой строке (вне «Pick») вызывает onClick row, как раньше', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onSelect = vi.fn();
    renderWithProviders(
      <ArchiveGameRow item={ITEM} onClick={onClick} onSelect={onSelect} />,
    );
    // ECO-span — заведомо вне select-кнопки и вне Link'ов игроков.
    const row = screen.getByTestId('archive-game-row-g-1');
    await user.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
