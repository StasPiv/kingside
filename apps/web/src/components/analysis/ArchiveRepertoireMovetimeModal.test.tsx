import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderWithProviders, screen } from '../../test/test-utils';
import { ArchiveRepertoireMovetimeModal } from './ArchiveRepertoireMovetimeModal';

/**
 * KS-3471 (ADR-090 V4 F1) — unit-тесты для модалки выбора movetime.
 */

describe('<ArchiveRepertoireMovetimeModal>', () => {
  it('open=false → не рендерится', () => {
    renderWithProviders(
      <ArchiveRepertoireMovetimeModal
        open={false}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByTestId('archive-rep-movetime-modal')).toBeNull();
  });

  it('open=true → 3 опции, дефолт 1000 выбран и помечен default-бейджем', () => {
    renderWithProviders(
      <ArchiveRepertoireMovetimeModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByTestId('archive-rep-movetime-modal')).toBeTruthy();
    const opt1000 = screen.getByTestId('archive-rep-movetime-modal-option-1000');
    expect(opt1000.getAttribute('data-selected')).toBe('true');
    expect(opt1000.getAttribute('data-default')).toBe('true');
    expect(
      screen.getByTestId('archive-rep-movetime-modal-option-500').getAttribute('data-selected'),
    ).toBe('false');
    expect(
      screen.getByTestId('archive-rep-movetime-modal-option-2000').getAttribute('data-selected'),
    ).toBe('false');
  });

  it('клик по 500 → радио выделено, Start вызывает onConfirm(500)', async () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ArchiveRepertoireMovetimeModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    await act(async () => {
      (screen.getByTestId('archive-rep-movetime-modal-radio-500') as HTMLInputElement).click();
    });
    expect(
      screen.getByTestId('archive-rep-movetime-modal-option-500').getAttribute('data-selected'),
    ).toBe('true');
    (screen.getByTestId('archive-rep-movetime-modal-start') as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledWith(500);
  });

  it('Cancel и backdrop → onClose без onConfirm', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    renderWithProviders(
      <ArchiveRepertoireMovetimeModal
        open
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    (screen.getByTestId('archive-rep-movetime-modal-cancel') as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
    (screen.getByTestId('archive-rep-movetime-modal-backdrop') as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Start без изменения → onConfirm(1000) (default)', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ArchiveRepertoireMovetimeModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    (screen.getByTestId('archive-rep-movetime-modal-start') as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledWith(1000);
  });
});
