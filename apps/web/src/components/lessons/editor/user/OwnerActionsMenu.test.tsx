import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { OwnerActionsMenu } from './OwnerActionsMenu';

describe('<OwnerActionsMenu>', () => {
  it('dropdown закрыт по умолчанию', () => {
    renderWithProviders(
      <OwnerActionsMenu
        onView={vi.fn()}
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('owner-actions-menu-trigger')).toBeInTheDocument();
    expect(
      screen.queryByTestId('owner-actions-menu-dropdown'),
    ).not.toBeInTheDocument();
  });

  it('клик по trigger → dropdown открывается', () => {
    renderWithProviders(
      <OwnerActionsMenu
        onView={vi.fn()}
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    expect(
      screen.getByTestId('owner-actions-menu-dropdown'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('owner-actions-menu-view')).toBeInTheDocument();
    expect(screen.getByTestId('owner-actions-menu-copy-link')).toBeInTheDocument();
    expect(screen.getByTestId('owner-actions-menu-delete')).toBeInTheDocument();
  });

  it('клик по пункту «View» → onView() + dropdown закрывается', () => {
    const onView = vi.fn();
    renderWithProviders(
      <OwnerActionsMenu
        onView={onView}
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    fireEvent.click(screen.getByTestId('owner-actions-menu-view'));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId('owner-actions-menu-dropdown'),
    ).not.toBeInTheDocument();
  });

  it('клик «Copy link» → onCopyLink()', () => {
    const onCopyLink = vi.fn();
    renderWithProviders(
      <OwnerActionsMenu
        onView={vi.fn()}
        onCopyLink={onCopyLink}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    fireEvent.click(screen.getByTestId('owner-actions-menu-copy-link'));
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it('клик «Delete» → onDelete()', () => {
    const onDelete = vi.fn();
    renderWithProviders(
      <OwnerActionsMenu
        onView={vi.fn()}
        onCopyLink={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    fireEvent.click(screen.getByTestId('owner-actions-menu-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('Escape → dropdown закрывается', () => {
    renderWithProviders(
      <OwnerActionsMenu
        onView={vi.fn()}
        onCopyLink={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    expect(
      screen.getByTestId('owner-actions-menu-dropdown'),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByTestId('owner-actions-menu-dropdown'),
    ).not.toBeInTheDocument();
  });

  it('клик вне меню → dropdown закрывается', () => {
    renderWithProviders(
      <div>
        <div data-testid="outside">outside</div>
        <OwnerActionsMenu
          onView={vi.fn()}
          onCopyLink={vi.fn()}
          onDelete={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    expect(
      screen.getByTestId('owner-actions-menu-dropdown'),
    ).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(
      screen.queryByTestId('owner-actions-menu-dropdown'),
    ).not.toBeInTheDocument();
  });
});
