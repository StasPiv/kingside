import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { StudyMembersDialog } from './StudyMembersDialog';

/**
 * KS-2892 / ADR-060 §2.5 (FC7). Юнит-тесты StudyMembersDialog.
 *
 * Покрытие:
 *  • первичный рендер: список members с ролями (owner badge, contributor remove);
 *  • invite by username: input + submit → API с `userIdOrUsername`, success-msg;
 *  • remove contributor: DELETE → элемент исчезает;
 *  • generate invite-link: успех → input с URL + copy-кнопка;
 *  • copy → useCopyToClipboard, переход «Copied!»;
 *  • ошибки API → inline-error, состояние не сломано;
 *  • owner НЕ может быть удалён (нет кнопки remove).
 */

const listMock = vi.fn();
const inviteMock = vi.fn();
const removeMock = vi.fn();
const linkMock = vi.fn();
const copyMock = vi.fn();

vi.mock('../../api/studiesApi', () => ({
  studiesApi: {
    listMembers: (...args: unknown[]) => listMock(...args),
    inviteMember: (...args: unknown[]) => inviteMock(...args),
    removeMember: (...args: unknown[]) => removeMock(...args),
    createInviteLink: (...args: unknown[]) => linkMock(...args),
  },
}));

vi.mock('../../hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => copyMock,
}));

const OWNER = {
  studyId: 's',
  userId: 'u-owner',
  username: 'OwnerJoe',
  role: 'owner' as const,
  addedAt: '2026-05-01T00:00:00.000Z',
};
const CONTRIB = {
  studyId: 's',
  userId: 'u-contrib',
  username: 'ContribJane',
  role: 'contributor' as const,
  addedAt: '2026-05-02T00:00:00.000Z',
};

beforeEach(() => {
  listMock.mockReset();
  inviteMock.mockReset();
  removeMock.mockReset();
  linkMock.mockReset();
  copyMock.mockReset();
  listMock.mockResolvedValue({ members: [OWNER, CONTRIB] });
  copyMock.mockResolvedValue(true);
});

describe('StudyMembersDialog (KS-2892 FC7)', () => {
  it('рендерит список members с ролями; у contributor есть Remove, у owner — нет', async () => {
    renderWithProviders(
      <StudyMembersDialog slug="my-study" onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('study-members-list')).toBeInTheDocument(),
    );
    expect(listMock).toHaveBeenCalledWith('my-study');
    // Owner есть, кнопка remove у него отсутствует.
    expect(
      screen.getByTestId(`study-members-item-${OWNER.userId}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`study-members-remove-${OWNER.userId}`),
    ).toBeNull();
    // Contributor — есть, и кнопка remove видна.
    expect(
      screen.getByTestId(`study-members-item-${CONTRIB.userId}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`study-members-remove-${CONTRIB.userId}`),
    ).toBeInTheDocument();
  });

  it('invite by username: API получает userIdOrUsername, список обновляется', async () => {
    const NEW = {
      studyId: 's',
      userId: 'u-new',
      username: 'NewKid',
      role: 'contributor' as const,
      addedAt: '2026-05-03T00:00:00.000Z',
    };
    inviteMock.mockResolvedValueOnce({
      members: [OWNER, CONTRIB, NEW],
    });
    renderWithProviders(
      <StudyMembersDialog slug="my-study" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const input = screen.getByTestId(
      'study-members-invite-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'NewKid' } });
    fireEvent.click(screen.getByTestId('study-members-invite-submit'));
    await waitFor(() =>
      expect(inviteMock).toHaveBeenCalledWith('my-study', {
        userIdOrUsername: 'NewKid',
      }),
    );
    // Список обновился (3 items).
    await waitFor(() =>
      expect(
        screen.getByTestId(`study-members-item-${NEW.userId}`),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('study-members-invite-success'),
    ).toBeInTheDocument();
  });

  it('invite: ошибка API → error виден, список не меняется', async () => {
    inviteMock.mockRejectedValueOnce(new Error('User not found'));
    renderWithProviders(
      <StudyMembersDialog slug="my-study" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('study-members-invite-input'), {
      target: { value: 'ghost' },
    });
    fireEvent.click(screen.getByTestId('study-members-invite-submit'));
    await waitFor(() =>
      expect(
        screen.getByTestId('study-members-invite-error').textContent,
      ).toMatch(/User not found/),
    );
    // Изначальный список без изменений.
    expect(screen.getAllByTestId(/study-members-item-/).length).toBe(2);
  });

  it('remove contributor: DELETE → элемент исчезает из списка', async () => {
    removeMock.mockResolvedValueOnce(undefined);
    renderWithProviders(
      <StudyMembersDialog slug="my-study" onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`study-members-item-${CONTRIB.userId}`),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByTestId(`study-members-remove-${CONTRIB.userId}`),
    );
    await waitFor(() =>
      expect(removeMock).toHaveBeenCalledWith('my-study', CONTRIB.userId),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId(`study-members-item-${CONTRIB.userId}`),
      ).toBeNull(),
    );
  });

  it('remove: ошибка API → элемент остаётся, error виден', async () => {
    removeMock.mockRejectedValueOnce(new Error('Forbidden'));
    renderWithProviders(
      <StudyMembersDialog slug="my-study" onClose={vi.fn()} />,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.click(
      screen.getByTestId(`study-members-remove-${CONTRIB.userId}`),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('study-members-remove-error').textContent,
      ).toMatch(/Forbidden/),
    );
    expect(
      screen.getByTestId(`study-members-item-${CONTRIB.userId}`),
    ).toBeInTheDocument();
  });

  it('generate invite-link: успех → URL виден, copy → useCopyToClipboard', async () => {
    linkMock.mockResolvedValueOnce({
      token: 'abc123',
      expiresAt: '2026-05-21T00:00:00.000Z',
      // backend может отдать готовый url, либо фронт собирает сам.
      url: 'https://kingside.test/studies/invites/abc123',
    });
    renderWithProviders(
      <StudyMembersDialog
        slug="my-study"
        origin="https://kingside.test"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.click(
      screen.getByTestId('study-members-invite-link-generate'),
    );
    await waitFor(() => expect(linkMock).toHaveBeenCalledWith('my-study'));
    const linkInput = (await screen.findByTestId(
      'study-members-invite-link-input',
    )) as HTMLInputElement;
    expect(linkInput.value).toBe(
      'https://kingside.test/studies/invites/abc123',
    );
    fireEvent.click(screen.getByTestId('study-members-invite-link-copy'));
    await waitFor(() =>
      expect(copyMock).toHaveBeenCalledWith(
        'https://kingside.test/studies/invites/abc123',
      ),
    );
  });

  it('invite-link: backend без url → фронт собирает из origin + token', async () => {
    linkMock.mockResolvedValueOnce({
      token: 'xyz789',
      expiresAt: '2026-05-21T00:00:00.000Z',
      // url отсутствует — фронт-фолбэк.
    });
    renderWithProviders(
      <StudyMembersDialog
        slug="my-study"
        origin="https://kingside.test"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.click(
      screen.getByTestId('study-members-invite-link-generate'),
    );
    const linkInput = (await screen.findByTestId(
      'study-members-invite-link-input',
    )) as HTMLInputElement;
    expect(linkInput.value).toBe(
      'https://kingside.test/studies/invites/xyz789',
    );
  });

  it('listMembers ошибка → error-state', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(
      <StudyMembersDialog slug="my-study" onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('study-members-list-error'),
      ).toBeInTheDocument(),
    );
  });
});
