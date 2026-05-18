import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { CreateStudyDialog } from './CreateStudyDialog';

const createMock = vi.fn();
vi.mock('../../api/studiesApi', () => ({
  studiesApi: { create: (req: unknown) => createMock(req) },
}));

beforeEach(() => {
  createMock.mockReset();
});

describe('<CreateStudyDialog> (KS-2852)', () => {
  it('рендерит поля name/description/public + submit/cancel', () => {
    renderWithProviders(
      <CreateStudyDialog onClose={() => {}} onCreated={() => {}} />,
    );
    expect(screen.getByTestId('create-study-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('create-study-dialog-name')).toBeInTheDocument();
    expect(
      screen.getByTestId('create-study-dialog-description'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('create-study-dialog-public'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('create-study-dialog-submit'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('create-study-dialog-cancel'),
    ).toBeInTheDocument();
  });

  it('пустое имя → submit disabled', () => {
    renderWithProviders(
      <CreateStudyDialog onClose={() => {}} onCreated={() => {}} />,
    );
    expect(
      screen.getByTestId('create-study-dialog-submit'),
    ).toBeDisabled();
  });

  it('заполненное имя → submit активен; click → studiesApi.create + onCreated + onClose', async () => {
    const created = {
      id: 's1',
      ownerId: 'u1',
      slug: 'demo',
      name: 'Demo',
      description: null,
      isPublic: false,
      chaptersCount: 0,
      createdAt: '',
      updatedAt: '',
      // KS-2994 / KS-2995: POV-флаги в StudyDto.
      likedByMe: false,
      viewerRole: 'owner',
    };
    createMock.mockResolvedValue(created);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    renderWithProviders(
      <CreateStudyDialog onClose={onClose} onCreated={onCreated} />,
    );
    fireEvent.change(screen.getByTestId('create-study-dialog-name'), {
      target: { value: 'Demo study' },
    });
    fireEvent.change(screen.getByTestId('create-study-dialog-description'), {
      target: { value: 'My demo desc' },
    });
    fireEvent.click(screen.getByTestId('create-study-dialog-submit'));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'Demo study',
        description: 'My demo desc',
        isPublic: false,
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(onClose).toHaveBeenCalled();
  });

  it('пустой description → передаём undefined (не пустую строку)', async () => {
    createMock.mockResolvedValue({ slug: 'x' });
    renderWithProviders(
      <CreateStudyDialog onClose={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('create-study-dialog-name'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('create-study-dialog-submit'));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: 'X',
        description: undefined,
        isPublic: false,
      }),
    );
  });

  it('checkbox isPublic → передаётся в API', async () => {
    createMock.mockResolvedValue({ slug: 'x' });
    renderWithProviders(
      <CreateStudyDialog onClose={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('create-study-dialog-name'), {
      target: { value: 'Public study' },
    });
    fireEvent.click(screen.getByTestId('create-study-dialog-public'));
    fireEvent.click(screen.getByTestId('create-study-dialog-submit'));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: true }),
      ),
    );
  });

  it('Enter в name → submit', async () => {
    createMock.mockResolvedValue({ slug: 'x' });
    renderWithProviders(
      <CreateStudyDialog onClose={() => {}} onCreated={() => {}} />,
    );
    const input = screen.getByTestId('create-study-dialog-name');
    fireEvent.change(input, { target: { value: 'Enter study' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Enter study' }),
      ),
    );
  });

  it('ошибка create → показ error-display', async () => {
    createMock.mockRejectedValue(new Error('Slug already in use'));
    renderWithProviders(
      <CreateStudyDialog onClose={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('create-study-dialog-name'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('create-study-dialog-submit'));
    await waitFor(() =>
      expect(
        screen.getByTestId('create-study-dialog-error'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('create-study-dialog-error')).toHaveTextContent(
      /slug already/i,
    );
  });

  it('cancel → onClose', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CreateStudyDialog onClose={onClose} onCreated={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('create-study-dialog-cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
