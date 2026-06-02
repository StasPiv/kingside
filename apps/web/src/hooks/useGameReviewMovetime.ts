/**
 * KS-3617. Хук-настройка времени на ход для «Разобрать партию».
 *
 * Хранится в localStorage по ключу `analysis.review.movetimeMs`,
 * дефолт 1000 мс (1 секунда). Используется в `useGameReview` через
 * `useGameReviewLauncher`. Минимум — 200 мс (Stockfish и так лагает
 * быстрее), максимум — 10000 мс (10 секунд на ход, ~13 минут на
 * партию 80 полуходов).
 */
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'analysis.review.movetimeMs';
export const DEFAULT_MOVETIME_MS = 1000;
export const MIN_MOVETIME_MS = 200;
export const MAX_MOVETIME_MS = 10_000;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MOVETIME_MS;
  return Math.min(MAX_MOVETIME_MS, Math.max(MIN_MOVETIME_MS, Math.round(value)));
}

function readStored(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_MOVETIME_MS;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_MOVETIME_MS;
    return clamp(Number(raw));
  } catch {
    return DEFAULT_MOVETIME_MS;
  }
}

function writeStored(value: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* ignore */
  }
}

export function useGameReviewMovetime(): {
  movetimeMs: number;
  setMovetimeMs: (next: number) => void;
} {
  const [movetimeMs, setState] = useState<number>(() => readStored());
  const setMovetimeMs = useCallback((next: number) => {
    const value = clamp(next);
    setState((prev) => {
      if (prev === value) return prev;
      writeStored(value);
      return value;
    });
  }, []);
  return { movetimeMs, setMovetimeMs };
}
