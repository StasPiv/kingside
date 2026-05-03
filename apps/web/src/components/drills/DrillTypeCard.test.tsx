import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { DrillTypeCard } from './DrillTypeCard';

describe('<DrillTypeCard>', () => {
  it('рендерит title', () => {
    renderWithProviders(<DrillTypeCard title="Count attackers" />);
    const card = screen.getByTestId('drill-type-card');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('Count attackers');
  });

  it('description рендерится отдельным span', () => {
    renderWithProviders(
      <DrillTypeCard title="X" description="Подсчёт атакующих фигур" />,
    );
    const card = screen.getByTestId('drill-type-card');
    expect(card.textContent).toContain('Подсчёт атакующих фигур');
    expect(card.querySelector('.drill-type-card__desc')).not.toBeNull();
  });

  it('icon рендерится с aria-hidden', () => {
    renderWithProviders(
      <DrillTypeCard
        title="X"
        icon={<span data-testid="ic">⚔</span>}
      />,
    );
    expect(screen.getByTestId('ic')).toBeInTheDocument();
    const iconWrap = screen.getByTestId('drill-type-card').querySelector('.drill-type-card__icon');
    expect(iconWrap?.getAttribute('aria-hidden')).toBe('true');
  });

  it('badge рендерится в drill-type-card__badge', () => {
    renderWithProviders(
      <DrillTypeCard title="X" badge={<span data-testid="bdg">NEW</span>} />,
    );
    expect(screen.getByTestId('bdg')).toBeInTheDocument();
    expect(
      screen.getByTestId('drill-type-card').querySelector('.drill-type-card__badge'),
    ).not.toBeNull();
  });

  it('aria-label = title если description нет', () => {
    renderWithProviders(<DrillTypeCard title="Solo" />);
    expect(screen.getByTestId('drill-type-card').getAttribute('aria-label')).toBe(
      'Solo',
    );
  });

  it('aria-label = "title. description" если description задано', () => {
    renderWithProviders(
      <DrillTypeCard title="Count" description="how many attackers" />,
    );
    expect(screen.getByTestId('drill-type-card').getAttribute('aria-label')).toBe(
      'Count. how many attackers',
    );
  });

  it('onClick срабатывает', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DrillTypeCard title="x" onClick={onClick} />);
    await user.click(screen.getByTestId('drill-type-card'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled=true → button disabled, data-disabled, click игнорируется', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillTypeCard title="x" disabled onClick={onClick} />,
    );
    const card = screen.getByTestId('drill-type-card') as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card.getAttribute('data-disabled')).toBe('true');
    await user.click(card);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('тег button (keyboard-accessible)', () => {
    renderWithProviders(<DrillTypeCard title="x" />);
    expect(screen.getByTestId('drill-type-card').tagName).toBe('BUTTON');
  });
});
