import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * KS-3970 / ADR-119 §8 эпик C (C01). Хук-обёртка над эндпоинтом
 * `GET /users/search?q=...` (ADR-118 KS-3938). Возвращает короткий
 * список пользователей (username, displayName, avatarUrl), которым
 * тренер может выдать доступ к лекции через
 * `POST /lectures/:id/access`.
 *
 * Контракт:
 *  - Запрос отправляется с дебаунсом 200 мс — пользователь набирает
 *    в инпуте, фронт ждёт паузу, только потом дёргает backend.
 *  - При `q.length < MIN_QUERY_LENGTH` (по умолчанию 2) запрос не
 *    отправляется, `results` возвращается пустым.
 *  - При смене `q` старые ответы игнорируются через `seqRef`.
 *  - Ошибки маппятся: 401/403 — `forbidden`, прочее — `load-failed`.
 *    Для ученика, у которого нет доступа к поиску, backend вернёт
 *    403, и страница тренерского UI покажет fallback.
 *
 * Хук специально «тонкий»: ни кэширования, ни persistence —
 * результаты живут в памяти текущего компонента. Если результаты
 * понадобятся в нескольких местах одновременно, родитель сам
 * передаст их вниз через props.
 */

export interface UserSearchItem {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}

export type UserSearchError = 'forbidden' | 'load-failed';

export interface UseUserSearchState {
  query: string;
  results: UserSearchItem[];
  loading: boolean;
  error: UserSearchError | null;
}

const DEFAULT_DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 8;

export interface UseUserSearchOptions {
  /** Сдвиг debounce, мс. По умолчанию 200. */
  debounceMs?: number;
  /** Максимум элементов в выдаче. По умолчанию 8. */
  limit?: number;
  /** Минимальная длина запроса. По умолчанию 2. */
  minLength?: number;
}

export function useUserSearch(
  query: string,
  options: UseUserSearchOptions = {},
): UseUserSearchState {
  const {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    limit = DEFAULT_LIMIT,
    minLength = MIN_QUERY_LENGTH,
  } = options;

  const [results, setResults] = useState<UserSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UserSearchError | null>(null);
  const seqRef = useRef(0);

  // Нормализуем `query` единожды: trim, чтобы пробел не считался
  // значимым символом и не дёргал backend на каждый кадр.
  const normalized = query.trim();

  useEffect(() => {
    if (normalized.length < minLength) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const mySeq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams();
      params.set('q', normalized);
      params.set('limit', String(limit));
      api
        .get<UserSearchItem[]>(`/users/search?${params.toString()}`)
        .then((res) => {
          if (mySeq !== seqRef.current) return;
          setResults(Array.isArray(res) ? res : []);
        })
        .catch((e) => {
          if (mySeq !== seqRef.current) return;
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
            setError('forbidden');
          } else {
            setError('load-failed');
          }
          setResults([]);
        })
        .finally(() => {
          if (mySeq !== seqRef.current) return;
          setLoading(false);
        });
    }, debounceMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [normalized, debounceMs, limit, minLength]);

  return { query: normalized, results, loading, error };
}
