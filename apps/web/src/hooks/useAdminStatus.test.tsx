import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useAdminStatus } from './useAdminStatus';

/**
 * KS-2109 / KS-2919 — поведение `useAdminStatus`.
 *
 * Источников admin-статуса теперь два:
 *   1. backend `GET /profile/me/admin-status` (KS-2108);
 *   2. frontend whitelist по `user.username` (KS-2919 fallback —
 *      зеркало `KS_ADMIN_USERS` из `scripts/deploy-aws.sh`).
 *
 * UI-видимость пункта «Админка» = `backendIsAdmin OR whitelistMatch`.
 * Backend-гард на admin-эндпоинтах остаётся источником истины
 * для собственно операций — фронтовый OR не понижает безопасность,
 * только обеспечивает что кнопка не пропадает у настоящего админа.
 */

const getAdminStatusMock = vi.fn<() => Promise<{ isAdmin: boolean }>>();
vi.mock('../api/configApi', () => ({
  configApi: {
    getAdminStatus: () => getAdminStatusMock(),
  },
}));

const authState: { user: { id: string; username: string } | null } = {
  user: null,
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
}));

beforeEach(() => {
  getAdminStatusMock.mockReset();
  authState.user = null;
});

describe('useAdminStatus', () => {
  it('гость → isAdmin=false, loading=false, бэк не дёргается', () => {
    authState.user = null;
    getAdminStatusMock.mockResolvedValue({ isAdmin: true });
    const { result } = renderHook(() => useAdminStatus());
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(getAdminStatusMock).not.toHaveBeenCalled();
  });

  it('бэк сказал isAdmin=true → isAdmin=true', async () => {
    authState.user = { id: 'u-1', username: 'someone' };
    getAdminStatusMock.mockResolvedValue({ isAdmin: true });
    const { result } = renderHook(() => useAdminStatus());
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  it('бэк сказал isAdmin=false, и username не в whitelist → isAdmin=false', async () => {
    authState.user = { id: 'u-1', username: 'random-player' };
    getAdminStatusMock.mockResolvedValue({ isAdmin: false });
    const { result } = renderHook(() => useAdminStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });

  it('бэк сказал isAdmin=false, но username в whitelist (KS-2919) → isAdmin=true', async () => {
    authState.user = { id: 'u-1', username: 'Stanislav' };
    getAdminStatusMock.mockResolvedValue({ isAdmin: false });
    const { result } = renderHook(() => useAdminStatus());
    // Whitelist даёт мгновенный true до того как успеет приехать ответ.
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.loading).toBe(false);
    await act(async () => {
      // Ждём резолва промиса, чтобы лишний раз убедиться: false с бэка
      // не понижает финальный isAdmin (whitelist остаётся true).
      await Promise.resolve();
    });
    expect(result.current.isAdmin).toBe(true);
  });

  it('бэк упал, но username в whitelist → isAdmin=true', async () => {
    authState.user = { id: 'u-1', username: 'Stanislav' };
    getAdminStatusMock.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useAdminStatus());
    expect(result.current.isAdmin).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isAdmin).toBe(true);
  });

  it('бэк упал, username не в whitelist → isAdmin=false (защитный фолбэк)', async () => {
    authState.user = { id: 'u-1', username: 'random' };
    getAdminStatusMock.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useAdminStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isAdmin).toBe(false);
  });
});
