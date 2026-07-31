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
 * Init ELO (KS-3600): только из настроек пользователя — localStorage
 * ключ `analysis.maia.elo` (см. SettingsPage) → fallback 1500.
 * `user.rating*` больше НЕ читается: рейтинг для блица/рапида к
 * силе Maia не имеет смыслового отношения, и автоматический выбор
 * вводил пользователей в заблуждение. Селектор перенесён в общие
 * настройки (KS-3600), здесь только чтение значения.
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

import { MaiaWorkerEngine } from '../lib/maia/workerEngine';
import type { MovePrediction } from '../lib/maia/workerEngine';
import {
  fetchMaiaModelWithRetry,
  type MaiaLoadErrorReason,
} from '../lib/maia/maiaLoader';

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

/**
 * KS-5016: статус разовой загрузки ONNX-модели Maia (отдельно от
 * `status`, который отражает per-move инференс). `loading` — идёт
 * тяжёлая загрузка ≈45 МБ (окно «Maia загружается» с прогрессом);
 * `ready` — модель в памяти, дальше инференс быстрый; `error` —
 * загрузка провалилась даже после повторов (кнопка «Попробовать
 * снова»).
 */
export type MaiaModelStatus = 'idle' | 'loading' | 'ready' | 'error';

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
  engine?: MaiaSinglePredictionEngine;
}

function clampElo(value: number): number {
  if (!Number.isFinite(value)) return MAIA_ELO_DEFAULT;
  const rounded = Math.round(value / 100) * 100;
  return Math.max(MAIA_ELO_MIN, Math.min(MAIA_ELO_MAX, rounded));
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

/** Полная функция выбора initial ELO. Экспортируется для теста.
 *  KS-3600: только localStorage → 1500 (профиль больше не учитываем). */
export function resolveInitialElo(): number {
  return readStoredElo() ?? MAIA_ELO_DEFAULT;
}

/**
 * KS-3600. Лёгкий self-contained хук «уровень Maia» для SettingsPage —
 * только чтение/запись в тот же localStorage-ключ `analysis.maia.elo`,
 * без worker'а и без подключения к доске. Возвращает текущее ELO
 * (clamp в шкалу) и сеттер с persistence.
 */
export function useMaiaEloSetting(): {
  elo: number;
  setElo: (next: number) => void;
} {
  const [elo, setEloState] = useState<number>(() => resolveInitialElo());
  const setElo = useCallback((next: number) => {
    const value = clampElo(next);
    setEloState((prev) => {
      if (prev === value) return prev;
      writeStoredElo(value);
      return value;
    });
  }, []);
  return { elo, setElo };
}

export function useMaiaAnalysis(options: UseMaiaAnalysisOptions) {
  const { fen, engine: injectedEngine } = options;

  const [elo, setEloState] = useState<number>(() => resolveInitialElo());
  const [policyByMove, setPolicyByMove] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<MaiaAnalysisStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // KS-5016: состояние разовой загрузки модели. Если движок инжектнут
  // (тесты / кастомный движок) — грузить нечего, модель считается
  // готовой сразу.
  const hasInjectedEngine = !!injectedEngine;
  const [modelStatus, setModelStatus] = useState<MaiaModelStatus>(
    hasInjectedEngine ? 'ready' : 'idle',
  );
  const [loadProgress, setLoadProgress] = useState(hasInjectedEngine ? 1 : 0);
  const [modelErrorReason, setModelErrorReason] =
    useState<MaiaLoadErrorReason>(null);
  const [modelRetryToken, setModelRetryToken] = useState(0);
  const modelStatusRef = useRef<MaiaModelStatus>(modelStatus);
  modelStatusRef.current = modelStatus;
  const modelBufferRef = useRef<ArrayBuffer | null>(null);

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

  // KS-5016: разовая устойчивая загрузка ONNX-модели по образцу
  // Stockfish (prefetch + прогресс + повтор при сетевом сбое). Пока не
  // готова — UI показывает окно «Maia загружается». Буфер затем
  // отдаётся воркеру напрямую (без второго сетевого запроса).
  useEffect(() => {
    if (hasInjectedEngine) return; // движок инжектнут — грузить нечего
    if (modelBufferRef.current) return; // уже загружено — не повторяем

    const abort = new AbortController();
    setModelStatus('loading');
    setModelErrorReason(null);
    setLoadProgress(0);

    fetchMaiaModelWithRetry(abort.signal, (loaded, total) => {
      if (abort.signal.aborted) return;
      setLoadProgress(total > 0 ? Math.min(0.99, loaded / total) : 0);
    })
      .then((buffer) => {
        if (abort.signal.aborted) return;
        modelBufferRef.current = buffer;
        setLoadProgress(1);
        setModelStatus('ready');
      })
      .catch((err) => {
        if (abort.signal.aborted || (err as Error)?.name === 'AbortError') {
          return;
        }
        setModelErrorReason('load_failed');
        setModelStatus('error');
      });

    return () => {
      abort.abort();
    };
  }, [hasInjectedEngine, modelRetryToken]);

  useEffect(() => {
    if (!fen) return;
    // KS-5016: не запускаем инференс, пока модель не загружена —
    // иначе воркер полез бы за моделью сам (без нашей устойчивости).
    if (modelStatus !== 'ready') return;

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
          // KS-5016: отдаём предзагруженный буфер движку — воркер
          // использует его напрямую, второго сетевого запроса за
          // моделью нет. `?? undefined` — на случай инжектнутого движка
          // (сюда не попадём, но типобезопасно).
          engineRef.current = new MaiaWorkerEngine({
            modelBuffer: modelBufferRef.current ?? undefined,
          });
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
  }, [fen, elo, retryToken, modelStatus]);

  useEffect(() => {
    return () => {
      if (ownsEngineRef.current && engineRef.current?.terminate) {
        engineRef.current.terminate();
      }
    };
  }, []);

  const retry = useCallback(() => {
    // KS-5016: если провалилась именно загрузка модели — перезапускаем
    // её (окно «Maia загружается» → повтор). Иначе повторяем инференс.
    if (modelStatusRef.current === 'error') {
      setModelRetryToken((t) => t + 1);
    } else {
      setRetryToken((t) => t + 1);
    }
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
      // KS-5016: состояние разовой загрузки ONNX-модели для окна
      // «Maia загружается» + прогресс + причина ошибки (для UI-ретрая).
      modelStatus,
      loadProgress,
      modelErrorReason,
      // KS-3597 (ADR-099 F2): raw карта `uci → probability` для
      // выбора Maia top-N как `searchmoves`. Между прогонами и при
      // `status !== 'ready'` объект пустой (см. useEffect выше:
      // `setPolicyByMove({})` на смену fen). UI читает её через
      // `Object.entries(policyByMove)` для построения списка ходов.
      policyByMove,
    }),
    [
      elo,
      setElo,
      status,
      error,
      retry,
      getProbability,
      modelStatus,
      loadProgress,
      modelErrorReason,
      policyByMove,
    ],
  );
}

export const MAIA_INTERNAL = {
  STORAGE_KEY: MAIA_ELO_STORAGE_KEY,
  DEFAULT: MAIA_ELO_DEFAULT,
  DEBOUNCE_MS,
};
