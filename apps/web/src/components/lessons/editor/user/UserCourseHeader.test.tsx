import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { UserCourseHeader } from './UserCourseHeader';

/**
 * KS-1855 (FE-R7): `UserCourseHeader`.
 */

function defaultProps(over: Partial<Parameters<typeof UserCourseHeader>[0]> = {}) {
  return {
    title: 'My course',
    isPublic: false,
    saveStatus: 'idle' as const,
    lastSavedAt: null,
    onTitleChange: vi.fn(),
    onRetrySave: vi.fn(),
    onPublicChange: vi.fn(),
    onView: vi.fn(),
    onCopyLink: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

function renderHdr(over?: Partial<Parameters<typeof UserCourseHeader>[0]>) {
  const props = defaultProps(over);
  // renderWithProviders уже оборачивает в MemoryRouter — достаточно
  // передать component напрямую.
  return {
    ...renderWithProviders(<UserCourseHeader {...props} />),
    props,
  };
}

describe('<UserCourseHeader>', () => {
  it('рендерит breadcrumbs + title + SaveStatusPill + PublishToggle + OwnerActionsMenu', () => {
    renderHdr();
    expect(screen.getByTestId('user-course-header')).toBeInTheDocument();
    expect(
      screen.getByTestId('user-course-header-breadcrumbs'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('user-course-header-breadcrumb-root'),
    ).toHaveAttribute('href', '/lessons');
    expect(screen.getByTestId('save-status-pill')).toBeInTheDocument();
    expect(screen.getByTestId('publish-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('owner-actions-menu')).toBeInTheDocument();
  });

  it('inline-edit: клик по title → input, Enter → commit + onTitleChange', () => {
    const { props } = renderHdr();
    fireEvent.click(screen.getByTestId('user-course-header-title'));
    const input = screen.getByTestId(
      'user-course-header-title-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // onBlur commit’ится (так как Enter вызывает blur)
    fireEvent.blur(input);
    expect(props.onTitleChange).toHaveBeenCalledWith('Renamed');
  });

  it('inline-edit: Escape отменяет изменения, onTitleChange не вызывается', () => {
    const { props } = renderHdr();
    fireEvent.click(screen.getByTestId('user-course-header-title'));
    const input = screen.getByTestId(
      'user-course-header-title-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Discard' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onTitleChange).not.toHaveBeenCalled();
  });

  it('пустое название при commit → onTitleChange не вызывается', () => {
    const { props } = renderHdr();
    fireEvent.click(screen.getByTestId('user-course-header-title'));
    const input = screen.getByTestId(
      'user-course-header-title-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(props.onTitleChange).not.toHaveBeenCalled();
  });

  it('saveStatus=error → SaveStatusPill показывает retry, клик → onRetrySave', () => {
    const { props } = renderHdr({ saveStatus: 'error' });
    expect(screen.getByTestId('save-status-pill-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('save-status-pill-retry'));
    expect(props.onRetrySave).toHaveBeenCalledTimes(1);
  });

  it('publish-toggle → onPublicChange(true)', () => {
    const { props } = renderHdr({ isPublic: false });
    fireEvent.click(screen.getByTestId('publish-toggle-input'));
    expect(props.onPublicChange).toHaveBeenCalledWith(true);
  });

  it('owner-menu: клик по view → onView', () => {
    const { props } = renderHdr();
    fireEvent.click(screen.getByTestId('owner-actions-menu-trigger'));
    fireEvent.click(screen.getByTestId('owner-actions-menu-view'));
    expect(props.onView).toHaveBeenCalledTimes(1);
  });

  it('busy=true → title не редактируется по клику', () => {
    renderHdr({ busy: true });
    fireEvent.click(screen.getByTestId('user-course-header-title'));
    expect(
      screen.queryByTestId('user-course-header-title-input'),
    ).not.toBeInTheDocument();
  });
});
