/**
 * KS-4706 / ADR-147 §3.3. Клиент к admin-CRUD `/admin/hints/*`
 * (backend KS-4702). Все эндпоинты защищены `AdminOrServiceGuard +
 * hints:write`, читаем под `<AdminRoute>` в `App.tsx`.
 */
import { api } from '../api';
import type { HintAnchor } from '@kingside/shared';

export type HintActorType = 'user' | 'guest';
export type HintLocale = 'ru' | 'en';
export type HintPlacement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'overlay'
  | 'bottom-sheet';

export interface HintI18nEntry {
  title: string;
  body: string;
  ctaLabel?: string;
}

export interface HintI18n {
  ru?: HintI18nEntry;
  en?: HintI18nEntry;
}

export interface HintCta {
  href?: string;
  event?: string;
}

export interface AdminHintSummary {
  id: string;
  key: string;
  anchor: string;
  placement: HintPlacement;
  enabled: boolean;
  priority: number;
  targetActorTypes: string[];
  titleRu: string | null;
  titleEn: string | null;
  createdAt: string;
  updatedAt: string;
  /** В summary backend поле не отдаёт; добавляем опционально для restore-UI. */
  deletedAt?: string | null;
}

export interface AdminHintDetail extends AdminHintSummary {
  i18n: HintI18n;
  cta: HintCta | null;
  rule: Record<string, unknown>;
  acceptedBy: string[];
  cooldownSec: number;
  ttlSec: number;
  maxShows: number;
  deletedAt: string | null;
}

export interface AdminHintsListQuery {
  enabled?: boolean;
  anchor?: string;
  actorType?: HintActorType;
  search?: string;
  includeDeleted?: boolean;
}

export interface CreateHintInput {
  key: string;
  i18n: HintI18n;
  cta?: HintCta;
  anchor: HintAnchor | string;
  placement: HintPlacement;
  rule: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
  acceptedBy?: string[];
  targetActorTypes?: HintActorType[];
  cooldownSec?: number;
  ttlSec?: number;
  maxShows?: number;
}

export type UpdateHintInput = Partial<CreateHintInput>;

export interface PreviewTriggerResponse {
  estimate: number;
  sampled: number;
  capped: boolean;
}

const BASE = '/admin/hints';

function buildQuery(q: AdminHintsListQuery): string {
  const sp = new URLSearchParams();
  if (q.enabled !== undefined) sp.set('enabled', String(q.enabled));
  if (q.anchor) sp.set('anchor', q.anchor);
  if (q.actorType) sp.set('actorType', q.actorType);
  if (q.search && q.search.trim()) sp.set('search', q.search.trim());
  if (q.includeDeleted) sp.set('includeDeleted', 'true');
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const hintsAdminApi = {
  list(q: AdminHintsListQuery = {}): Promise<AdminHintSummary[]> {
    return api.get<AdminHintSummary[]>(`${BASE}${buildQuery(q)}`);
  },
  getOne(id: string): Promise<AdminHintDetail> {
    return api.get<AdminHintDetail>(`${BASE}/${encodeURIComponent(id)}`);
  },
  create(input: CreateHintInput): Promise<AdminHintDetail> {
    return api.post<AdminHintDetail>(BASE, input);
  },
  update(id: string, input: UpdateHintInput): Promise<AdminHintDetail> {
    return api.put<AdminHintDetail>(`${BASE}/${encodeURIComponent(id)}`, input);
  },
  setStatus(id: string, enabled: boolean): Promise<AdminHintDetail> {
    return api.patch<AdminHintDetail>(
      `${BASE}/${encodeURIComponent(id)}/status`,
      { enabled },
    );
  },
  delete(id: string): Promise<void> {
    return api.delete<void>(`${BASE}/${encodeURIComponent(id)}`);
  },
  previewTrigger(rule: Record<string, unknown>): Promise<PreviewTriggerResponse> {
    return api.post<PreviewTriggerResponse>(`${BASE}/preview-trigger`, { rule });
  },
};
