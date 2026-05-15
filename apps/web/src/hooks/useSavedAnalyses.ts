import { useCallback } from 'react';
import type { AnalysisResponse, UpdateAnalysisRequest } from '@kingside/shared';
import { api } from '../api';

export type SavedAnalysis = AnalysisResponse;

export function getDefaultTitle(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `New analysis ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pgn)) !== null) {
    headers[match[1]] = match[2];
  }
  return headers;
}

export function useSavedAnalyses() {
  const create = useCallback(
    async (pgn: string, title?: string, category?: string): Promise<AnalysisResponse> => {
      return api.post<AnalysisResponse>('/analyses', {
        pgn,
        title: title ?? getDefaultTitle(),
        ...(category ? { category } : {}),
      });
    },
    [],
  );

  const update = useCallback(
    async (id: string, updates: UpdateAnalysisRequest): Promise<void> => {
      await api.patch<AnalysisResponse>(`/analyses/${id}`, updates);
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/analyses/${id}`);
  }, []);

  const getById = useCallback(async (id: string): Promise<AnalysisResponse | null> => {
    try {
      return await api.get<AnalysisResponse>(`/analyses/${id}`);
    } catch {
      return null;
    }
  }, []);

  /**
   * KS-2672: публичный read-only анализ. Эндпоинт без auth, отвечает
   * 404 для приватных. Используется на маршруте `/analysis/public/:id`
   * для не-владельцев и анонимов.
   */
  const getPublicById = useCallback(
    async (id: string): Promise<AnalysisResponse | null> => {
      try {
        return await api.get<AnalysisResponse>(`/analyses/public/${id}`);
      } catch {
        return null;
      }
    },
    [],
  );

  /**
   * KS-2666 / ADR-051 §3 share-2: toggle публичности анализа.
   * Backend (KS-2601) возвращает обновлённый AnalysisResponse с
   * актуальным `isPublic`; UI ловит ответ для оптимистичного апдейта.
   */
  const share = useCallback(
    async (id: string, isPublic: boolean): Promise<AnalysisResponse> => {
      return api.patch<AnalysisResponse>(`/analyses/${id}/share`, {
        isPublic,
      });
    },
    [],
  );

  return { create, update, remove, getById, getPublicById, share };
}
