import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveBucket, ArchiveTreeResponse } from '@kingside/shared';
import { ARCHIVE_URL } from '../config/archiveUrl';

const DEBOUNCE_MS = 300;
/**
 * In-memory cache TTL. Без него stale значение залипало между обновлениями
 * данных на стороне archive-service (KS-1689: пользователь видел 9978 вместо
 * актуальных 20019 после импорта TWIC). 60 секунд — компромисс между
 * дёшевизной навигации по позициям и свежестью счётчиков.
 */
const CACHE_TTL_MS = 60_000;
/**
 * Минимальный интервал между инвалидациями по `visibilitychange`/`focus`.
 * `focus` может срабатывать при каждом переключении активного окна ОС — без
 * throttle пользователь, бегающий по alt-tab, получит лишние запросы.
 */
const INVALIDATE_THROTTLE_MS = 10_000;
/**
 * KS-2153: hard-timeout одного fetch к archive-service. Без таймаута зависший
 * сокет (CDN/edge dropped connection) висит до общего fetch-таймаута браузера
 * (~5 минут на Chrome) — UI всё это время в loading. 8 секунд достаточно
 * с большим запасом: TargetResponseTime у archive ALB 10–35мс, p99 ≪ 500мс.
 */
const REQUEST_TIMEOUT_MS = 8_000;
/**
 * KS-2153: задержка перед автоматической второй попыткой при сетевой
 * ошибке/таймауте/5xx. Одного retry хватает для случайных edge-падений и
 * не превращает ошибку в спам.
 */
const RETRY_DELAY_MS = 1_000;

export interface UseArchiveTreeFilters {
  bucket?: ArchiveBucket;
  minElo?: number;
  since?: string;
}

export interface UseArchiveTreeResult {
  data: ArchiveTreeResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

interface CacheEntry {
  data: ArchiveTreeResponse;
  /** Epoch ms в момент успешного fetch. */
  timestamp: number;
}

function serializeFilters(fen: string, f: UseArchiveTreeFilters): string {
  return [fen, f.bucket ?? '', f.minElo ?? '', f.since ?? ''].join('|');
}

/**
 * Queries the archive variation tree for a given FEN with debounce, abort,
 * and in-memory caching.
 *
 * - 300ms debounce before issuing the request.
 * - Any in-flight request is aborted when `fen`/filters change.
 * - Successful responses are cached by key `fen|bucket|minElo|since` for
 *   `CACHE_TTL_MS`. После TTL запись считается stale и вызывает re-fetch.
 * - Cache сбрасывается при возврате вкладки в foreground (`visibilitychange`
 *   → visible, `focus`) с throttle в `INVALIDATE_THROTTLE_MS`. Это защищает
 *   от ситуации, когда вкладка висела свёрнутой, а на сервере за это время
 *   обновились данные (KS-1689).
 * - `refetch()` invalidates the current key and re-queries.
 */
export function useArchiveTree(
  fen: string,
  filters: UseArchiveTreeFilters = {},
): UseArchiveTreeResult {
  const [data, setData] = useState<ArchiveTreeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchToken, setRefetchToken] = useState(0);

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInvalidatedAtRef = useRef<number>(0);

  const cacheKey = useMemo(
    () => serializeFilters(fen, filters),
    // bucket/minElo/since values matter, not the object identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fen, filters.bucket, filters.minElo, filters.since],
  );

  useEffect(() => {
    if (!fen) return undefined;

    const cached = cacheRef.current.get(cacheKey);
    const isFresh = cached ? Date.now() - cached.timestamp < CACHE_TTL_MS : false;
    if (cached && isFresh) {
      abortRef.current?.abort();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setData(cached.data);
      setError(null);
      setIsLoading(false);
      return undefined;
    }
    if (cached && !isFresh) {
      // stale — удаляем, чтобы не мешала TypeScript-narrowing в других местах
      // и не висела в памяти лишней записью на случай если fetch упадёт.
      cacheRef.current.delete(cacheKey);
    }

    setIsLoading(true);
    setError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      // outerController живёт на весь жизненный цикл запроса (включая retry).
      // abort() выполняется только при смене позиции/фильтра/refetch
      // (через abortRef.current?.abort() в начале нового цикла) или unmount.
      const outerController = new AbortController();
      abortRef.current = outerController;

      const params = new URLSearchParams({ fen });
      if (filters.bucket) params.set('bucket', filters.bucket);
      if (typeof filters.minElo === 'number') params.set('minElo', String(filters.minElo));
      if (filters.since) params.set('since', filters.since);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      try {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch {
        /* ignore */
      }

      const url = `${ARCHIVE_URL}/tree?${params.toString()}`;

      // KS-2153: один запрос с hard-timeout.
      //
      // У каждой попытки свой `attemptController` для timeout — иначе abort()
      // по таймауту первой попытки навсегда закрывает outerController и
      // блокирует retry. Сигнал outerController пробрасывается во внутренний
      // через слушатель: при abort outerController инициируем abort на
      // attemptController.
      //
      // AbortError из-за смены позиции (outerController) отдаётся
      // отдельным `aborted: true`, чтобы вызывающий код не считал его
      // настоящей ошибкой и не показывал «База недоступна».
      const doFetch = async (
        attempt: number,
      ): Promise<
        | { ok: true; data: ArchiveTreeResponse }
        | { ok: false; aborted: true }
        | { ok: false; aborted: false; status: number | null; reason: 'http' | 'timeout' | 'network'; message: string }
      > => {
        const attemptController = new AbortController();
        const onOuterAbort = () => attemptController.abort();
        outerController.signal.addEventListener('abort', onOuterAbort);

        let timedOut = false;
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, REQUEST_TIMEOUT_MS);

        const cleanup = () => {
          clearTimeout(timeoutTimer);
          outerController.signal.removeEventListener('abort', onOuterAbort);
        };

        try {
          const res = await fetch(url, {
            method: 'GET',
            signal: attemptController.signal,
            headers,
          });
          cleanup();

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error('[archive-tree] HTTP error', {
              attempt,
              method: 'GET',
              url,
              status: res.status,
              statusText: res.statusText,
              body: text.slice(0, 500),
            });
            return {
              ok: false,
              aborted: false,
              status: res.status,
              reason: 'http',
              message: `archive: ${res.status}`,
            };
          }

          const json = (await res.json()) as ArchiveTreeResponse;
          return { ok: true, data: json };
        } catch (err: unknown) {
          cleanup();

          // AbortError может быть от: 1) пользователь сменил позицию (outer abort),
          // 2) истёк наш per-attempt timeout, 3) unmount.
          const isAbort = (err as Error | undefined)?.name === 'AbortError';
          if (isAbort && outerController.signal.aborted) {
            // Пользователь сменил позицию/фильтр — это не ошибка
            return { ok: false, aborted: true };
          }
          if (timedOut) {
            console.error('[archive-tree] timeout', {
              attempt,
              method: 'GET',
              url,
              timeoutMs: REQUEST_TIMEOUT_MS,
            });
            return {
              ok: false,
              aborted: false,
              status: null,
              reason: 'timeout',
              message: `archive: таймаут ${REQUEST_TIMEOUT_MS}мс`,
            };
          }
          // Сетевые ошибки (DNS/CORS/connection refused/offline)
          const message = (err as Error | undefined)?.message ?? 'network error';
          console.error('[archive-tree] network error', {
            attempt,
            method: 'GET',
            url,
            error: err,
          });
          return {
            ok: false,
            aborted: false,
            status: null,
            reason: 'network',
            message: `archive: сеть (${message})`,
          };
        }
      };

      // KS-2153: основной вызов + одна повторная попытка при transient ошибках
      // (5xx/timeout/network). 4xx (включая 401/403/404) — НЕ retry,
      // повторный запрос даст тот же результат.
      const run = async () => {
        const first = await doFetch(1);

        const isTransient = (
          r: Awaited<ReturnType<typeof doFetch>>,
        ): boolean => {
          if (r.ok) return false;
          if (r.aborted) return false;
          if (r.reason === 'network' || r.reason === 'timeout') return true;
          if (r.reason === 'http' && typeof r.status === 'number' && r.status >= 500) {
            return true;
          }
          return false;
        };

        let final = first;
        if (isTransient(first)) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          // Если за это время позицию сменили — outerController уже abort'нут
          // и второй doFetch сразу вернёт aborted:true.
          if (!outerController.signal.aborted) {
            final = await doFetch(2);
          } else {
            final = { ok: false, aborted: true };
          }
        }

        if (final.ok === false && final.aborted) return;

        if (final.ok) {
          cacheRef.current.set(cacheKey, { data: final.data, timestamp: Date.now() });
          setData(final.data);
          setError(null);
          setIsLoading(false);
          return;
        }

        setError(final.message);
        setIsLoading(false);
      };

      void run();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [fen, cacheKey, filters.bucket, filters.minElo, filters.since, refetchToken]);

  // Инвалидация кэша при возврате вкладки/окна в foreground.
  // Триггеры: visibilitychange → visible, window focus.
  // Throttle — чтобы alt-tab туда-сюда не спамил сеть.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;

    const invalidate = () => {
      const now = Date.now();
      if (now - lastInvalidatedAtRef.current < INVALIDATE_THROTTLE_MS) return;
      lastInvalidatedAtRef.current = now;
      cacheRef.current.clear();
      setRefetchToken((t) => t + 1);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') invalidate();
    };
    const onFocus = () => invalidate();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Cleanup on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const refetch = useCallback(() => {
    cacheRef.current.delete(cacheKey);
    setRefetchToken((t) => t + 1);
  }, [cacheKey]);

  return { data, isLoading, error, refetch };
}
