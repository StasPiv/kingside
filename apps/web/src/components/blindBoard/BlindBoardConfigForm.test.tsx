import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';
import { DEFAULT_BLIND_BOARD_CONFIG } from '@kingside/shared';
import { renderWithProviders, screen } from '../../test/test-utils';
import { BlindBoardConfigForm } from './BlindBoardConfigForm';

/**
 * KS-3488 (ADR-088 V2 §15 F1) — UI настройки конфига.
 */

describe('<BlindBoardConfigForm>', () => {
  it('счётчики стартового набора отражают value', () => {
    renderWithProviders(
      <BlindBoardConfigForm value={DEFAULT_BLIND_BOARD_CONFIG} onChange={() => {}} />,
    );
    // default: Q+N+R по 1.
    expect(
      screen.getByTestId('blind-board-config-start-value-Q').textContent,
    ).toBe('1');
    expect(
      screen.getByTestId('blind-board-config-start-value-R').textContent,
    ).toBe('1');
    expect(
      screen.getByTestId('blind-board-config-start-value-N').textContent,
    ).toBe('1');
    expect(
      screen.getByTestId('blind-board-config-start-value-B').textContent,
    ).toBe('0');
  });

  it('Q квота 1: после первого + кнопка inc выключается', () => {
    const cfg = { ...DEFAULT_BLIND_BOARD_CONFIG };
    renderWithProviders(
      <BlindBoardConfigForm value={cfg} onChange={() => {}} />,
    );
    expect(
      (screen.getByTestId('blind-board-config-start-inc-Q') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('клик + на B при свободной ёмкости → onChange с новым startPieces', async () => {
    // DEFAULT total=7 (max). Используем урезанный addOrder, чтобы было место.
    const onChange = vi.fn();
    renderWithProviders(
      <BlindBoardConfigForm
        value={{
          startPieces: ['Q', 'N', 'R'],
          addOrder: ['B'],
          memorizeTimeSec: 5,
        }}
        onChange={onChange}
      />,
    );
    await act(async () => {
      (
        screen.getByTestId('blind-board-config-start-inc-B') as HTMLButtonElement
      ).click();
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        startPieces: ['Q', 'N', 'R', 'B'],
      }),
    );
  });

  it('addOrder up/down меняет порядок', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <BlindBoardConfigForm
        value={DEFAULT_BLIND_BOARD_CONFIG}
        onChange={onChange}
      />,
    );
    // addOrder default: ['B','B','R','N']. Опустим первую (idx=0) ↓.
    await act(async () => {
      (
        screen.getByTestId('blind-board-config-add-down-0') as HTMLButtonElement
      ).click();
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        addOrder: ['B', 'B', 'R', 'N'].slice() && ['B', 'B', 'R', 'N'],
      }),
    );
    // Swap idx 0<->1: одинаковые 'B','B' → массив тот же визуально.
    // Возьмём более показательный пример: opustит R idx=2 → пойдёт в конец.
    onChange.mockClear();
    await act(async () => {
      (
        screen.getByTestId('blind-board-config-add-down-2') as HTMLButtonElement
      ).click();
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        addOrder: ['B', 'B', 'N', 'R'],
      }),
    );
  });

  it('select memorize 10 → onChange.memorizeTimeSec=10', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <BlindBoardConfigForm
        value={DEFAULT_BLIND_BOARD_CONFIG}
        onChange={onChange}
      />,
    );
    await act(async () => {
      const radio = screen
        .getByTestId('blind-board-config-memorize-10')
        .querySelector('input') as HTMLInputElement;
      radio.click();
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ memorizeTimeSec: 10 }),
    );
  });

  it('disabled выключает все кнопки управления', () => {
    renderWithProviders(
      <BlindBoardConfigForm
        value={DEFAULT_BLIND_BOARD_CONFIG}
        onChange={() => {}}
        disabled
      />,
    );
    expect(
      (screen.getByTestId('blind-board-config-start-inc-N') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('blind-board-config-add-up-1') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
