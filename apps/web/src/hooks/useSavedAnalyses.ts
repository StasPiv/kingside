import { useCallback } from 'react';

export type SavedAnalysis = {
  id: string;
  title: string;
  pgn: string;
  createdAt: string;
  updatedAt: string;
  opening?: string;
  whitePgn?: string;
  blackPgn?: string;
};

const STORAGE_KEY = 'kingside-saved-analyses';

function generateId(): string {
  return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

function loadAll(): SavedAnalysis[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedAnalysis[];
  } catch {
    return [];
  }
}

function saveAll(analyses: SavedAnalysis[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(analyses));
  } catch {
    // ignore storage errors
  }
}

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
  const getAll = useCallback((): SavedAnalysis[] => {
    return loadAll().sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, []);

  const create = useCallback(
    (
      pgn: string,
      title?: string,
      meta?: { opening?: string; whitePgn?: string; blackPgn?: string },
    ): SavedAnalysis => {
      const now = new Date().toISOString();
      const entry: SavedAnalysis = {
        id: generateId(),
        title: title ?? getDefaultTitle(),
        pgn,
        createdAt: now,
        updatedAt: now,
        ...meta,
      };
      const all = loadAll();
      all.push(entry);
      saveAll(all);
      return entry;
    },
    [],
  );

  const update = useCallback(
    (
      id: string,
      updates: Partial<Pick<SavedAnalysis, 'pgn' | 'title' | 'opening' | 'whitePgn' | 'blackPgn'>>,
    ): void => {
      const all = loadAll();
      const idx = all.findIndex((a) => a.id === id);
      if (idx === -1) return;
      all[idx] = { ...all[idx], ...updates, updatedAt: new Date().toISOString() };
      saveAll(all);
    },
    [],
  );

  const remove = useCallback((id: string): void => {
    const all = loadAll().filter((a) => a.id !== id);
    saveAll(all);
  }, []);

  const getById = useCallback((id: string): SavedAnalysis | null => {
    return loadAll().find((a) => a.id === id) ?? null;
  }, []);

  return { getAll, create, update, remove, getById };
}
