import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { PublishToggle } from './PublishToggle';

describe('<PublishToggle>', () => {
  it('isPublic=false → показывает Private + hint', () => {
    renderWithProviders(<PublishToggle isPublic={false} onChange={vi.fn()} />);
    const toggle = screen.getByTestId('publish-toggle');
    expect(toggle.getAttribute('data-is-public')).toBe('false');
    expect((screen.getByTestId('publish-toggle-input') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('publish-toggle-hint').textContent).toMatch(/Only you/i);
  });

  it('isPublic=true → показывает Public + hint', () => {
    renderWithProviders(<PublishToggle isPublic={true} onChange={vi.fn()} />);
    expect(screen.getByTestId('publish-toggle').getAttribute('data-is-public')).toBe('true');
    expect(screen.getByTestId('publish-toggle-hint').textContent).toMatch(/everyone/i);
  });

  it('клик по checkbox → onChange(true)', () => {
    const onChange = vi.fn();
    renderWithProviders(<PublishToggle isPublic={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('publish-toggle-input'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('busy=true → input disabled', () => {
    renderWithProviders(
      <PublishToggle isPublic={false} onChange={vi.fn()} busy />,
    );
    expect(
      (screen.getByTestId('publish-toggle-input') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
