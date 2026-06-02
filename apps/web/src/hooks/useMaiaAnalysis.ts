/**
 * KS-3588 (ADR-097). Maia становится inline-вероятностью в Stockfish-
 * линиях, не отдельной секцией. API хука перешёл от `lines[]` к
 * lookup-функции `getProbability(uci)`: каждая Stockfish-линия сама
 * спрашивает у Maia вероятность своего первого хода.
 *
 * State:
 *  - `elo` — текущий рейтинг прогона;
 *  - `policyByMove` — карта `{ uci → probability }` от последнего
 *    успешного прогона;
 *  - `status` — `idle` / `loading` / `ready` / `error`;
 *  - `error` — техдеталь.
 *
 * Init ELO (приоритеты, как было в KS-3584):
 *  1. `user.rating{Blitz|Rapid|Classical|Bullet|Puzzle}` (clamp 1100..2400);
 *  2. localStorage `analysis.maia.elo`;
 *  3. 1500.
 *
 * Поведение:
 *  - Эффект на смену `fen`/`elo` — debounce 250 мс → `predictMoves`.
 *  - Гард от устаревших ответов (`requestIdRef`).
 *  - На смену fen старая `policyByMove` затирается (state сбрасывается
 *    в момент start запроса) — иначе UI показал бы вероятности от
 *    предыдущей позиции для новых ходов Stockfish.
 *  - Cleanup воркера на unmount.
 *  - Maia работает независимо от Stockfish `analysisEnabled`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { User } from '@kingside/shared';

import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import type { MovePrediction } from '../lib/maia/workerEngine';

const MAIA_ELO_MIN = 1100;
const MAIA_ELO_MAX = 2400;
const MAIA_ELO_DEFAULT = 1500;
const MAIA_ELO_STORAGE_KEY = 'analysis.maia.elo';
const DEBOUNCE_MS = 250;

export const MAIA_ELO_OPTIONS: readonly number[] = (() => {
  const list: number[] = [];
  for (let v = MAIA_ELO_MIN; v <= MAIA_ELO_MAX; v += 100) list.push(v);
  return list;
})();

export type MaiaAnalysisStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface MaiaSinglePredictionEngine {
  predictMoves(
    fen: string,
    eloSelf: number,
    eloOppo: number,
  ): Promise<{ policy: MovePrediction[]; winProbability: number }>;
  terminate?(): void;
}

export interface UseMaiaAnalysisOptions {
  fen: string;
  user?: Pick<
    User,
    | 'ratingBlitz'
    | 'ratingRapid'
    | 'ratingClassical'
    | 'ratingBullet'
    | 'ratingPuzzle'
  > | null;
  engine?: MaiaSinglePredictionEngine;
}

function clampElo(value: number): number {
  if (!Number.isFinite(value)) return MAIA_ELO_DEFAULT;
  const rounded = Math.round(value / 100) * 100;
  return Math.max(MAIA_ELO_MIN, Math.min(MAIA_ELO_MAX, rounded));
}

function pickUserElo(
  user: UseMaiaAnalysisOptions['user'],
): number | null {
  if (!user) return null;
  const candidates = [
    user.ratingBlitz,
    user.ratingRapid,
    user.ratingClassical,
    user.ratingBullet,
    user.ratingPuzzle,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      return clampElo(c);
    }
  }
  return null;
}

function readStoredElo(): number | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(MAIA_ELO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return clampElo(parsed);
  } catch {
    return null;
  }
}

function writeStoredElo(value: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MAIA_ELO_STORAGE_KEY, String(value));
  } catch {
    // ignore quota/privacy errors
  }
}

/** Полная функция выбора initial ELO. Экспортируется для теста. */
export function resolveInitialElo(
  user: UseMaiaAnalysisOptions['user'],
): number {
  return pickUserElo(user) ?? readStoredElo() ?? MAIA_ELO_DEFAULT;
}

export function useMaiaAnalysis(options: UseMaiaAnalysisOptions) {
  const { fen, user, engine: injectedEngine } = options;

  const [elo, setEloState] = useState<number>(() => resolveInitialElo(user));
  const [policyByMove, setPolicyByMove] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<MaiaAnalysisStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<MaiaSinglePredictionEngine | null>(
    injectedEngine ?? null,
  );
  const ownsEngineRef = useRef<boolean>(false);
  const requestIdRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);

  const setElo = useCallback((next: number) => {
    const value = clampElo(next);
    setEloState((prev) => {
      if (prev === value) return prev;
      writeStoredElo(value);
      return value;
    });
  }, []);

  useEffect(() => {
    if (!fen) return;

    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError(null);
    // KS-3588: при смене позиции старые вероятности больше не валидны —
    // если оставить, UI покажет «стейл» для новых Stockfish-ходов.
    // Placeholder `(--)` лучше неверного процента.
    setPolicyByMove({});

    const timer = setTimeout(async () => {
      try {
        if (!engineRef.current) {
          engineRef.current = new MaiaWorkerEngine();
          ownsEngineRef.current = true;
        }
        const result = await engineRef.current.predictMoves(fen, elo, elo);

        if (requestId !== requestIdRef.current) return;

        const next: Record<string, number> = {};
        for (const m of result.policy) {
          next[m.move] = m.probability;
        }
        setPolicyByMove(next);
        setStatus('ready');
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [fen, elo, retryToken]);

  useEffect(() => {
    return () => {
      if (ownsEngineRef.current && engineRef.current?.terminate) {
        engineRef.current.terminate();
      }
    };
  }, []);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  const getProbability = useCallback(
    (uci: string | null | undefined): number | undefined => {
      if (!uci) return undefined;
      return policyByMove[uci];
    },
    [policyByMove],
  );

  return useMemo(
    () => ({
      elo,
      setElo,
      status,
      error,
      retry,
      getProbability,
    }),
    [elo, setElo, status, error, retry, getProbability],
  );
}

export const MAIA_INTERNAL = {
  STORAGE_KEY: MAIA_ELO_STORAGE_KEY,
  DEFAULT: MAIA_ELO_DEFAULT,
  DEBOUNCE_MS,
};
