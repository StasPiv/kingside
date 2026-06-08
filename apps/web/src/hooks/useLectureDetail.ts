import { useEffect, useRef, useState } from 'react';
import type { LectureDetail } from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * KS-3963 / ADR-119 §8 эпик A. Тонкий хук-обёртка над
 * `GET /lectures/:id`. Возвращает `LectureDetail` или статус
 * ошибки (`not-found` / `forbidden` / `load-failed`).
 *
 * Семантика для `LectureLandingPage`:
 *  - 401/403 → `forbidden` (лекция приватная, гость или чужой).
 *  - 404 → `not-found` (лекция удалена/не существует).
 *  - прочее (5xx / network / abort) → `load-failed`.
 *  - `lecture === null` означает «ещё грузится» (см. `loading`).
 *
 * Гард от устаревших ответов через `requestIdRef` — при смене id
 * результаты прошлых запросов игнорируются.
 */

export type UseLectureDetailError =
  | 'not-found'
  | 'forbidden'
  | 'load-failed';

export interface UseLectureDetailState {
  loading: boolean;
  lecture: LectureDetail | null;
  error: UseLectureDetailError | null;
  refetch: () => void;
}

export function useLectureDetail(
  id: string | null | undefined,
): UseLectureDetailState {
  const [loading, setLoading] = useState<boolean>(Boolean(id));
  const [lecture, setLecture] = useState<LectureDetail | null>(null);
  const [error, setError] = useState<UseLectureDetailError | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setLecture(null);
      setError(null);
      return;
    }
    const myReq = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setLecture(null);
    api
      .get<LectureDetail>(`/lectures/${encodeURIComponent(id)}`)
      .then((resp) => {
        if (myReq !== requestIdRef.current) return;
        setLecture(resp);
        setLoading(false);
      })
      .catch((e) => {
        if (myReq !== requestIdRef.current) return;
        if (e instanceof ApiError) {
          if (e.status === 404) {
            setError('not-found');
          } else if (e.status === 401 || e.status === 403) {
            setError('forbidden');
          } else {
            setError('load-failed');
          }
        } else {
          setError('load-failed');
        }
        setLoading(false);
      });
  }, [id, reloadTick]);

  const refetch = () => {
    setReloadTick((n) => n + 1);
  };

  return { loading, lecture, error, refetch };
}
