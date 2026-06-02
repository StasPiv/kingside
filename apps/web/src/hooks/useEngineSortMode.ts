/**
 * KS-3593 (ADR-098). Persisted sort-режим для engine-panel линий.
 *
 * Чистый persisted state: чтение из `localStorage` при init, запись
 * при изменении. Никаких эффектов на смену fen/elo — сам режим не
 * зависит от позиции.
 *
 * Валидация значения из localStorage: только `'maia'` принимается как
 * не-дефолт, всё остальное (включая пустую строку, мусор, удалённый
 * ключ) → `'stockfish'`.
 */
import { useCallback, useState } from 'react';

export type EngineSortMode = 'stockfish' | 'maia';

const STORAGE_KEY = 'analysis.engine.sortMode';

function readInitial(): EngineSortMode {
  if (typeof localStorage === 'undefined') return 'stockfish';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'maia' ? 'maia' : 'stockfish';
  } catch {
    return 'stockfish';
  }
}

function writeStored(mode: EngineSortMode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore quota/private-mode errors
  }
}

export function useEngineSortMode(): {
  sortMode: EngineSortMode;
  setSortMode: (m: EngineSortMode) => void;
} {
  const [sortMode, setSortModeState] = useState<EngineSortMode>(readInitial);

  const setSortMode = useCallback((next: EngineSortMode) => {
    setSortModeState((prev) => {
      if (prev === next) return prev;
      writeStored(next);
      return next;
    });
  }, []);

  return { sortMode, setSortMode };
}

export const ENGINE_SORT_INTERNAL = {
  STORAGE_KEY,
};
