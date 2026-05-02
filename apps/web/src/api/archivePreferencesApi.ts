/**
 * KS-2210: HTTP-клиент для сохранения/получения фильтров архива на сервере.
 *
 *   GET /user/preferences/archive-filters  — загрузить
 *   PUT /user/preferences/archive-filters  — сохранить
 *
 * Авторизация — через `api` (Bearer из localStorage, автообновление токена).
 */

import type { ArchiveFilters, ArchiveFiltersResponse } from '@kingside/shared';
import { api } from '../api';

export const archivePreferencesApi = {
  getFilters: (): Promise<ArchiveFiltersResponse> =>
    api.get<ArchiveFiltersResponse>('/user/preferences/archive-filters'),

  putFilters: (filters: ArchiveFilters): Promise<ArchiveFiltersResponse> =>
    api.put<ArchiveFiltersResponse>('/user/preferences/archive-filters', filters),
};
