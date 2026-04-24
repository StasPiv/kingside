import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { AddLessonEmptyState } from './AddLessonEmptyState';

/**
 * KS-1851 (FE-R3): `AddLessonEmptyState`.
 */

describe('<AddLessonEmptyState>', () => {
  it('рендерит карточку, заголовок и CTA', () => {
    renderWithProviders(<AddLessonEmptyState onAdd={vi.fn()} />);
    expect(screen.getByTestId('add-lesson-empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('add-lesson-empty-cta')).toBeInTheDocument();
  });

  it('клик по CTA → onAdd()', () => {
    const onAdd = vi.fn();
    renderWithProviders(<AddLessonEmptyState onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('add-lesson-empty-cta'));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('busy=true → CTA заблокирован, onAdd не вызывается', () => {
    const onAdd = vi.fn();
    renderWithProviders(<AddLessonEmptyState onAdd={onAdd} busy />);
    const cta = screen.getByTestId('add-lesson-empty-cta') as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    fireEvent.click(cta);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
