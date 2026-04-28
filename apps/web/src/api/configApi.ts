import type {
  AdminFeatureFlagItem,
  AdminStatusResponse,
  ConfigResponse,
  UpdateFeatureFlagRequest,
  UpdateFeatureFlagResponse,
  FeatureFlags,
} from '@kingside/shared';

import { api } from '../api';

/**
 * KS-2105: HTTP-клиент runtime feature-flags (KS-2104 backend).
 *
 * Эндпоинты Nest-контроллера смонтированы без префикса `/api` —
 * фактический путь `/config` (как и `/lessons`, `/auth`). В описании
 * задачи `/api/config` — это логический путь.
 *
 * `GET /config` — публичный, без auth: фронт дёргает на старте,
 * чтобы понять какие флаги включены до показа UI.
 *
 * `PATCH /admin/feature-flags/:key` — admin-only. Здесь не для
 * runtime-кода главного фронта (в проде админ переключает через
 * отдельный инструмент / curl), но клиент пригодится в будущем
 * админ-панели и в локальных тестах.
 */
export const configApi = {
  getConfig(): Promise<ConfigResponse> {
    return api.get<ConfigResponse>('/config');
  },

  updateFeatureFlag(
    key: keyof FeatureFlags,
    body: UpdateFeatureFlagRequest,
  ): Promise<UpdateFeatureFlagResponse> {
    return api.patch<UpdateFeatureFlagResponse>(
      `/admin/feature-flags/${encodeURIComponent(String(key))}`,
      body,
    );
  },

  /**
   * KS-2109 / KS-2108: список всех known-флагов с метаданными для
   * админ-страницы `/admin/feature-flags`. Гард на бэке `AdminUserGuard`
   * (whitelist `KS_ADMIN_USERS`) — для не-админа вернёт 403.
   */
  listAdminFeatureFlags(): Promise<AdminFeatureFlagItem[]> {
    return api.get<AdminFeatureFlagItem[]>('/admin/feature-flags');
  },

  /**
   * KS-2109 / KS-2108: статус админа текущего пользователя — фронт
   * скрывает пункт «Админка» и редиректит с `/admin/*` для не-админов.
   * Под аутентификацией; для гостей UI сам не зовёт эндпоинт.
   */
  getAdminStatus(): Promise<AdminStatusResponse> {
    return api.get<AdminStatusResponse>('/profile/me/admin-status');
  },
};
