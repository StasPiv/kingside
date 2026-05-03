import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { DrillCountAttackersButtons } from './DrillCountAttackersButtons';

describe('<DrillCountAttackersButtons>', () => {
  it('рендерит ровно 4 кнопки 1..4 в группе', () => {
    renderWithProviders(<DrillCountAttackersButtons onSelect={() => {}} />);
    const group = screen.getByTestId('drill-count-attackers');
    expect(group.getAttribute('role')).toBe('group');
    for (const v of [1, 2, 3, 4]) {
      const btn = screen.getByTestId(`drill-count-attackers-btn-${v}`);
      expect(btn).toBeInTheDocument();
      expect(btn.textContent).toBe(String(v));
    }
  });

  it.each([1, 2, 3, 4] as const)(
    'клик по кнопке %s → onSelect(%s)',
    async (value) => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<DrillCountAttackersButtons onSelect={onSelect} />);
      await user.click(screen.getByTestId(`drill-count-attackers-btn-${value}`));
      expect(onSelect).toHaveBeenCalledWith(value);
    },
  );

  it('selected=2 → активна только кнопка 2 (data-active + aria-pressed)', () => {
    renderWithProviders(
      <DrillCountAttackersButtons selected={2} onSelect={() => {}} />,
    );
    for (const v of [1, 2, 3, 4]) {
      const btn = screen.getByTestId(`drill-count-attackers-btn-${v}`);
      const expected = v === 2;
      expect(btn.getAttribute('data-active')).toBe(String(expected));
      expect(btn.getAttribute('aria-pressed')).toBe(String(expected));
    }
  });

  it('disabled → все кнопки disabled и hotkey игнорируется', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillCountAttackersButtons disabled onSelect={onSelect} />,
    );
    for (const v of [1, 2, 3, 4]) {
      const btn = screen.getByTestId(
        `drill-count-attackers-btn-${v}`,
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
    await user.keyboard('1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['1', '2', '3', '4'] as const)(
    'hotkey "%s" → onSelect',
    async (key) => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<DrillCountAttackersButtons onSelect={onSelect} />);
      await user.keyboard(key);
      expect(onSelect).toHaveBeenCalledWith(Number(key));
    },
  );

  it('hotkey "5" игнорируется (не входит в 1..4)', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DrillCountAttackersButtons onSelect={onSelect} />);
    await user.keyboard('5');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Ctrl+1 — НЕ вызывает onSelect (системный шорткат)', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DrillCountAttackersButtons onSelect={onSelect} />);
    await user.keyboard('{Control>}1{/Control}');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hotkey игнорируется если фокус в <input>', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <input data-testid="other-input" defaultValue="" />
        <DrillCountAttackersButtons onSelect={onSelect} />
      </>,
    );
    const input = screen.getByTestId('other-input');
    input.focus();
    await user.keyboard('1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
