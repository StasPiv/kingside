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
          progressionEnabled: true,
          levelDurationRounds: 10,
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

  it('KS-3492: иконки фигур (а не текстовые названия) в counter, addOrder, кнопках Add', () => {
    renderWithProviders(
      <BlindBoardConfigForm
        value={DEFAULT_BLIND_BOARD_CONFIG}
        onChange={() => {}}
      />,
    );
    // Counter-selector: для каждого типа есть icon-span + aria-label.
    for (const type of ['Q', 'R', 'B', 'N'] as const) {
      const icon = screen.getByTestId(`blind-board-config-start-icon-${type}`);
      expect(icon.getAttribute('aria-label')).toBe(
        // testI18n.en — fallback на «Queen/Rook/Bishop/Knight».
        { Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight' }[type],
      );
      // Внутри не должно быть текстового названия (только SVG/IMG).
      expect(icon.textContent).toBe('');
    }
    // addOrder row 0: иконка вместо текста.
    const addRow0 = screen.getByTestId('blind-board-config-add-icon-0');
    expect(addRow0.getAttribute('data-piece')).toBe('B');
    expect(addRow0.getAttribute('aria-label')).toBe('Bishop');
    expect(addRow0.textContent).toBe('');
    // Кнопка Add B: aria-label «Add Bishop», в textContent только «+».
    const addBtnB = screen.getByTestId('blind-board-config-add-add-B');
    expect(addBtnB.getAttribute('aria-label')).toBe('Add Bishop');
    expect(addBtnB.textContent?.trim()).toBe('+');
  });

  it('KS-3495: исчерпанная квота → inc disabled + aria-disabled + title с причиной', () => {
    // B квота = 2, оба слона уже в addOrder → +B должен быть disabled.
    renderWithProviders(
      <BlindBoardConfigForm
        value={{
          startPieces: ['Q', 'N', 'R'],
          addOrder: ['B', 'B'],
          memorizeTimeSec: 5,
          progressionEnabled: true,
          levelDurationRounds: 10,
        }}
        onChange={() => {}}
      />,
    );
    const incB = screen.getByTestId(
      'blind-board-config-start-inc-B',
    ) as HTMLButtonElement;
    expect(incB.disabled).toBe(true);
    expect(incB.getAttribute('aria-disabled')).toBe('true');
    expect(incB.className).toContain('blind-board-config-form__counter-btn--disabled');
    expect(incB.title).toBe('Quota for B is full (2 already chosen).');

    const addBtnB = screen.getByTestId(
      'blind-board-config-add-add-B',
    ) as HTMLButtonElement;
    expect(addBtnB.disabled).toBe(true);
    expect(addBtnB.getAttribute('aria-disabled')).toBe('true');
    expect(addBtnB.className).toContain(
      'blind-board-config-form__add-add-btn--disabled',
    );
    expect(addBtnB.title).toBe('Quota for B is full (2 already chosen).');
  });

  it('KS-3495: активная inc-кнопка не имеет title (пустая строка)', () => {
    // У типа B при addOrder=['B'] квота 2 не исчерпана → canInc=true.
    renderWithProviders(
      <BlindBoardConfigForm
        value={{
          startPieces: ['Q', 'N', 'R'],
          addOrder: ['B'],
          memorizeTimeSec: 5,
          progressionEnabled: true,
          levelDurationRounds: 10,
        }}
        onChange={() => {}}
      />,
    );
    const incB = screen.getByTestId(
      'blind-board-config-start-inc-B',
    ) as HTMLButtonElement;
    expect(incB.disabled).toBe(false);
    expect(incB.title).toBe('');
    expect(incB.className).not.toContain(
      'blind-board-config-form__counter-btn--disabled',
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

  describe('KS-3553 (V3): подгруппа «Прогрессия»', () => {
    it('дефолт: чекбокс включён, выбран pill 10, секция addOrder видна', () => {
      renderWithProviders(
        <BlindBoardConfigForm value={DEFAULT_BLIND_BOARD_CONFIG} onChange={() => {}} />,
      );
      const cb = screen.getByTestId(
        'blind-board-config-progression-checkbox',
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
      expect(
        screen.getByTestId('blind-board-config-add-section'),
      ).toBeInTheDocument();
      expect(
        screen
          .getByTestId('blind-board-config-level-duration-10')
          .getAttribute('data-checked'),
      ).toBe('true');
    });

    it('снятие чекбокса: addOrder скрыт, pill disabled', async () => {
      const onChange = vi.fn();
      renderWithProviders(
        <BlindBoardConfigForm
          value={{ ...DEFAULT_BLIND_BOARD_CONFIG, progressionEnabled: false }}
          onChange={onChange}
        />,
      );
      // addOrder скрыт.
      expect(
        screen.queryByTestId('blind-board-config-add-section'),
      ).toBeNull();
      // Pill — data-disabled=true.
      expect(
        screen
          .getByTestId('blind-board-config-level-duration')
          .getAttribute('data-disabled'),
      ).toBe('true');
      const pill10 = screen.getByTestId(
        'blind-board-config-level-duration-10',
      );
      expect(pill10.getAttribute('data-disabled')).toBe('true');
      // Клик по pill не вызывает onChange.
      await act(async () => {
        (pill10.querySelector('input') as HTMLInputElement).click();
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('клик по чекбоксу шлёт onChange с новым progressionEnabled', async () => {
      const onChange = vi.fn();
      renderWithProviders(
        <BlindBoardConfigForm value={DEFAULT_BLIND_BOARD_CONFIG} onChange={onChange} />,
      );
      await act(async () => {
        (
          screen.getByTestId(
            'blind-board-config-progression-checkbox',
          ) as HTMLInputElement
        ).click();
      });
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ progressionEnabled: false }),
      );
    });

    it('клик по pill (включено) шлёт onChange с новым levelDurationRounds', async () => {
      const onChange = vi.fn();
      renderWithProviders(
        <BlindBoardConfigForm value={DEFAULT_BLIND_BOARD_CONFIG} onChange={onChange} />,
      );
      const pill15 = screen.getByTestId(
        'blind-board-config-level-duration-15',
      );
      await act(async () => {
        (pill15.querySelector('input') as HTMLInputElement).click();
      });
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ levelDurationRounds: 15 }),
      );
    });

    it('addOrderHint подставляет levelDurationRounds (V3 — параметризован)', () => {
      renderWithProviders(
        <BlindBoardConfigForm
          value={{ ...DEFAULT_BLIND_BOARD_CONFIG, levelDurationRounds: 20 }}
          onChange={() => {}}
        />,
      );
      const hint = screen.getByTestId('blind-board-config-add-hint');
      expect(hint.textContent).toContain('20');
    });
  });
});
