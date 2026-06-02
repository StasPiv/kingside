/**
 * KS-3584 (ADR-096). Постоянный анализ Maia в engine-panel.
 *
 * State:
 *  - `elo` — текущий рейтинг для прогона (1100..2400, шаг 100);
 *  - `lines` — top-5 ходов от Maia (sorted desc по probability);
 *  - `status` — `idle` (до первого прогона) / `loading` (в полёте) /
 *    `ready` (пришли свежие линии) / `error` (worker reject);
 *  - `error` — техдеталь, для логов, не для UI.
 *
 * Init ELO (приоритеты):
 *  1. `user.rating{Blitz|Rapid|Classical|Bullet}` (clamp в 1100..2400);
 *  2. localStorage `analysis.maia.elo`;
 *  3. fallback 1500.
 *
 * Поведение:
 *  - На смену `fen` или `elo` — debounce 250 мс → `predictMoves(fen, elo, elo)`.
 *  - Maia независима от Stockfish `analysisEnabled` — собственный жизненный
 *    цикл worker'а, cleanup на unmount.
 *  - Гард от устаревших ответов через `requestIdRef`.
 *  - При «в полёте» обновлении старые `lines` остаются — компонент сам
 *    решит, как показать «прежние данные с opacity» (ADR-096 §5.5).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { User } from '@kingside/shared';

import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import type { MovePrediction } from '../lib/maia/workerEngine';

const MAIA_ELO_MIN = 1100;
const MAIA_ELO_MAX = 2400;
const MAIA_ELO_DEFAULT = 1500;
const MAIA_ELO_STORAGE_KEY = 'analysis.maia.elo';
const TOP_N = 5;
const DEBOUNCE_MS = 250;

export const MAIA_ELO_OPTIONS: readonly number[] = (() => {
  const list: number[] = [];
  for (let v = MAIA_ELO_MIN; v <= MAIA_ELO_MAX; v += 100) list.push(v);
  return list;
})();

export type MaiaAnalysisStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface MaiaAnalysisState {
  elo: number;
  lines: MovePrediction[];
  status: MaiaAnalysisStatus;
  error: string | null;
}

/** Узкий интерфейс engine'а — что нужно хуку. Позволяет подменить
 *  в тесте без поднятия worker'а. */
export interface MaiaSinglePredictionEngine {
  predictMoves(
    fen: string,
    eloSelf: number,
    eloOppo: number,
  ): Promise<{ policy: MovePrediction[]; winProbability: number }>;
  terminate?(): void;
}

export interface UseMaiaAnalysisOptions {
  /** Текущий FEN на доске. Хук перезапрашивает Maia на смену. */
  fen: string;
  /** Пользовательский профиль (опц.) — берём рейтинг как initial ELO. */
  user?: Pick<
    User,
    | 'ratingBlitz'
    | 'ratingRapid'
    | 'ratingClassical'
    | 'ratingBullet'
    | 'ratingPuzzle'
  > | null;
  /** Кастомный engine (для тестов). По умолчанию — `MaiaWorkerEngine`. */
  engine?: MaiaSinglePredictionEngine;
}

function clampElo(value: number): number {
  if (!Number.isFinite(value)) return MAIA_ELO_DEFAULT;
  // KS-3584: clamp в шкалу Maia. ELO кратное 100 — берём ближайшее.
  const rounded = Math.round(value / 100) * 100;
  return Math.max(MAIA_ELO_MIN, Math.min(MAIA_ELO_MAX, rounded));
}

/** Подбор «общего» ELO юзера из имеющихся категорий. Приоритет:
 *  Blitz → Rapid → Classical → Bullet → Puzzle. */
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
  return (
    pickUserElo(user) ??
    readStoredElo() ??
    MAIA_ELO_DEFAULT
  );
}

export function useMaiaAnalysis(options: UseMaiaAnalysisOptions) {
  const { fen, user, engine: injectedEngine } = options;

  const [elo, setEloState] = useState<number>(() => resolveInitialElo(user));
  const [lines, setLines] = useState<MovePrediction[]>([]);
  const [status, setStatus] = useState<MaiaAnalysisStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<MaiaSinglePredictionEngine | null>(
    injectedEngine ?? null,
  );
  const ownsEngineRef = useRef<boolean>(false);
  const requestIdRef = useRef(0);
  // KS-3584: счётчик retry, чтобы при клике «Попробовать снова» повторно
  // запустить эффект с тем же fen/elo.
  const [retryToken, setRetryToken] = useState(0);

  // Setter ELO с записью в localStorage. clamp для защиты от мусорных
  // значений из select'а (которые в нашем UI и не могут прийти, но
  // тест может проверить).
  const setElo = useCallback((next: number) => {
    const value = clampElo(next);
    setEloState((prev) => {
      if (prev === value) return prev;
      writeStoredElo(value);
      return value;
    });
  }, []);

  // Главный эффект: на смену fen/elo/retryToken — debounce и прогон.
  useEffect(() => {
    if (!fen) return;

    const requestId = ++requestIdRef.current;
    setStatus('loading');
    setError(null);

    const timer = setTimeout(async () => {
      try {
        if (!engineRef.current) {
          engineRef.current = new MaiaWorkerEngine();
          ownsEngineRef.current = true;
        }
        const result = await engineRef.current.predictMoves(fen, elo, elo);

        // Игнорируем устаревший ответ.
        if (requestId !== requestIdRef.current) return;

        const topLines = result.policy.slice(0, TOP_N);
        setLines(topLines);
        setStatus('ready');
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }, DEBOUNCE_MS);

    return () => {
      // Cleanup debounce: новый fen/elo пришёл раньше чем 250 мс —
      // отменяем старый таймер, requestId уже инкрементировался, так
      // что in-flight ответы будут отброшены.
      clearTimeout(timer);
    };
  }, [fen, elo, retryToken]);

  // Cleanup воркера при unmount хука.
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

  return {
    elo,
    setElo,
    lines,
    status,
    error,
    retry,
  };
}

export const MAIA_INTERNAL = {
  /** Для тестов. */
  STORAGE_KEY: MAIA_ELO_STORAGE_KEY,
  DEFAULT: MAIA_ELO_DEFAULT,
  DEBOUNCE_MS,
  TOP_N,
};
