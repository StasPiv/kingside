import { useCallback } from 'react';
import type { AnalysisResponse } from '@kingside/shared';
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
    async (pgn: string, title?: string): Promise<AnalysisResponse> => {
      return api.post<AnalysisResponse>('/api/analyses', {
        pgn,
        title: title ?? getDefaultTitle(),
      });
    },
    [],
  );

  const update = useCallback(
    async (id: string, updates: { pgn?: string; title?: string; currentPosition?: number | null }): Promise<void> => {
      await api.put<AnalysisResponse>(`/api/analyses/${id}`, updates);
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/api/analyses/${id}`);
  }, []);

  const getById = useCallback(async (id: string): Promise<AnalysisResponse | null> => {
    try {
      return await api.get<AnalysisResponse>(`/api/analyses/${id}`);
    } catch {
      return null;
    }
  }, []);

  return { create, update, remove, getById };
}
