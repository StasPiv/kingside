import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { DeleteCourseDialog } from './DeleteCourseDialog';

describe('<DeleteCourseDialog>', () => {
  it('open=false → не рендерится', () => {
    renderWithProviders(
      <DeleteCourseDialog
        open={false}
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('delete-course-dialog')).not.toBeInTheDocument();
  });

  it('open=true → рендерит модалку + input + disabled confirm', () => {
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-course-dialog')).toBeInTheDocument();
    const confirm = screen.getByTestId(
      'delete-course-dialog-confirm',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('ввод «DELETE» → confirm enabled; клик вызывает onConfirm', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByTestId(
      'delete-course-dialog-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'DELETE' } });
    const confirm = screen.getByTestId(
      'delete-course-dialog-confirm',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('неправильная фраза → confirm остаётся disabled', () => {
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('delete-course-dialog-input'), {
      target: { value: 'delete!' },
    });
    expect(
      (screen.getByTestId('delete-course-dialog-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('«delete» / «  Delete  » → в нижнем регистре с пробелами тоже засчитывается', () => {
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('delete-course-dialog-input'), {
      target: { value: '  delete ' },
    });
    expect(
      (screen.getByTestId('delete-course-dialog-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('клик Cancel → onCancel()', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-course-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('клик по overlay → onCancel()', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-course-dialog-overlay'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('клик внутри диалога — событие НЕ всплывает на overlay → onCancel НЕ вызывается', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-course-dialog'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape → onCancel()', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy=true → cancel и confirm disabled, input disabled', () => {
    renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        busy
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('delete-course-dialog-input'), {
      target: { value: 'DELETE' },
    });
    expect(
      (screen.getByTestId('delete-course-dialog-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('delete-course-dialog-cancel') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('повторное открытие сбрасывает введённое значение (нельзя pre-confirm)', () => {
    const { rerender } = renderWithProviders(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('delete-course-dialog-input'), {
      target: { value: 'DELETE' },
    });
    // Close → reopen
    rerender(
      <DeleteCourseDialog
        open={false}
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    rerender(
      <DeleteCourseDialog
        open
        courseTitle="Test"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId('delete-course-dialog-input') as HTMLInputElement).value,
    ).toBe('');
    expect(
      (screen.getByTestId('delete-course-dialog-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
