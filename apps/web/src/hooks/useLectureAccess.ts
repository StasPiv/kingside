import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LectureAccessErrorCode,
  LectureAccessGrantWithUser,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';

/**
 * KS-3971 / ADR-119 §8 эпик C (C02). CRUD-хук над access-API
 * лекций (ADR-118 §2.4.1):
 *   - `GET    /lectures/:id/access`            — список grant'ов;
 *   - `POST   /lectures/:id/access`            — выдать доступ;
 *   - `DELETE /lectures/:id/access/:grantId`   — отозвать.
 *
 * Хук работает с оптимистичными обновлениями: на `grantUser` мы
 * сразу добавляем временную запись в список, не дожидаясь ответа;
 * на `revokeGrant` сразу убираем запись. При ошибке откатываем.
 * Это требование KS-3972 (Access Panel) — UI должен реагировать
 * мгновенно, без визуальных рывков.
 *
 * Использование:
 *   const { grants, loading, error, grantUser, revokeGrant, refetch }
 *     = useLectureAccess(lectureId);
 *
 * Параметры:
 *   - `lectureId === null/undefined` — хук «спит», запрос не делается.
 *
 * Ошибки:
 *   - `forbidden`           — 401/403 при базовом запросе (не owner);
 *   - `not-found`           — 404 (лекция удалена);
 *   - `load-failed`         — прочее на загрузке;
 *   - `last-mutation-failed` — последняя mutation провалилась;
 *     для UI этого недостаточно, дополнительно из `lastMutationError`
 *     можно достать backend-`errorCode` (`LectureAccessErrorCode`)
 *     для точечных сообщений (например, `course_access_not_supported`).
 */

export type LectureAccessError = 'forbidden' | 'not-found' | 'load-failed';

export interface UseLectureAccessState {
  grants: LectureAccessGrantWithUser[];
  loading: boolean;
  error: LectureAccessError | null;
  /**
   * Текст ошибки последней mutation (`grantUser` / `revokeGrant`).
   * При успехе сбрасывается в null. Содержит исходный backend-
   * `errorCode` для прицельного UI-сообщения.
   */
  lastMutationError: {
    message: string;
    errorCode: LectureAccessErrorCode | string | undefined;
  } | null;
  grantUser: (userId: string) => Promise<void>;
  revokeGrant: (grantId: string) => Promise<void>;
  refetch: () => void;
}

const PENDING_PREFIX = 'pending-';

function makePendingGrant(
  lectureId: string,
  userId: string,
): LectureAccessGrantWithUser {
  const now = new Date().toISOString();
  return {
    grant: {
      id: `${PENDING_PREFIX}${userId}-${now}`,
      lectureId,
      subjectType: 'user',
      subjectId: userId,
      grantedById: '',
      grantedAt: now,
    },
    // Минимально-валидный user-stub — родитель (UI) при оптимистическом
    // апдейте должен передать настоящий user через `grantUser` обвязку
    // в `LectureAccessPanel`. Здесь хук не знает username/displayName,
    // поэтому ставим заглушку. Реальные значения подменим в ответе
    // POST'а.
    user: {
      id: userId,
      username: '…',
      displayName: '…',
    },
  };
}

export function useLectureAccess(
  lectureId: string | null | undefined,
): UseLectureAccessState {
  const [grants, setGrants] = useState<LectureAccessGrantWithUser[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(lectureId));
  const [error, setError] = useState<LectureAccessError | null>(null);
  const [lastMutationError, setLastMutationError] =
    useState<UseLectureAccessState['lastMutationError']>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const seqRef = useRef(0);
  // Ссылка на актуальные grants для использования внутри mutation-
  // обработчиков без замыкания через state.
  const grantsRef = useRef<LectureAccessGrantWithUser[]>([]);
  grantsRef.current = grants;

  useEffect(() => {
    if (!lectureId) {
      setLoading(false);
      setGrants([]);
      setError(null);
      return;
    }
    const mySeq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api
      .get<LectureAccessGrantWithUser[]>(
        `/lectures/${encodeURIComponent(lectureId)}/access`,
      )
      .then((res) => {
        if (mySeq !== seqRef.current) return;
        setGrants(Array.isArray(res) ? res : []);
      })
      .catch((e) => {
        if (mySeq !== seqRef.current) return;
        if (e instanceof ApiError) {
          if (e.status === 401 || e.status === 403) setError('forbidden');
          else if (e.status === 404) setError('not-found');
          else setError('load-failed');
        } else {
          setError('load-failed');
        }
        setGrants([]);
      })
      .finally(() => {
        if (mySeq !== seqRef.current) return;
        setLoading(false);
      });
  }, [lectureId, reloadTick]);

  const grantUser = useCallback(
    async (userId: string) => {
      if (!lectureId) return;
      // Идемпотентно: если такой grant уже есть, ничего не делаем.
      if (
        grantsRef.current.some(
          (g) =>
            g.grant.subjectType === 'user' && g.grant.subjectId === userId,
        )
      ) {
        return;
      }
      // Оптимистичная вставка — заглушка с pending-id; после ответа
      // backend заменим на настоящий объект.
      const optimistic = makePendingGrant(lectureId, userId);
      setGrants((prev) => [...prev, optimistic]);
      setLastMutationError(null);
      try {
        const created = await api.post<LectureAccessGrantWithUser>(
          `/lectures/${encodeURIComponent(lectureId)}/access`,
          { subjectType: 'user', subjectId: userId },
        );
        setGrants((prev) =>
          prev.map((g) =>
            g.grant.id === optimistic.grant.id ? created : g,
          ),
        );
      } catch (e) {
        // Откат — убираем optimistic-запись.
        setGrants((prev) =>
          prev.filter((g) => g.grant.id !== optimistic.grant.id),
        );
        const message =
          e instanceof Error ? e.message : 'Failed to grant access';
        const errorCode =
          e instanceof ApiError ? e.errorCode : undefined;
        setLastMutationError({ message, errorCode });
      }
    },
    [lectureId],
  );

  const revokeGrant = useCallback(
    async (grantId: string) => {
      if (!lectureId) return;
      const previous = grantsRef.current;
      // Оптимистичное удаление.
      setGrants((prev) => prev.filter((g) => g.grant.id !== grantId));
      setLastMutationError(null);
      try {
        await api.delete(
          `/lectures/${encodeURIComponent(lectureId)}/access/${encodeURIComponent(grantId)}`,
        );
      } catch (e) {
        // Откат — возвращаем grant обратно.
        setGrants(previous);
        const message =
          e instanceof Error ? e.message : 'Failed to revoke access';
        const errorCode =
          e instanceof ApiError ? e.errorCode : undefined;
        setLastMutationError({ message, errorCode });
      }
    },
    [lectureId],
  );

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return {
    grants,
    loading,
    error,
    lastMutationError,
    grantUser,
    revokeGrant,
    refetch,
  };
}
