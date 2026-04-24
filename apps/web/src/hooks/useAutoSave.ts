import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `useAutoSave` — обёртка debounced-PATCH для user-редактора
 * (KS-1848 §3.4, KS-1850 / FE-R2).
 *
 * API:
 *  - `save(payload)` — просит хук сохранить; откладывает фактический
 *    вызов `saveFn(payload)` на `delayMs` мс (default 500). Повторные
 *    `save(...)` в пределах окна сбрасывают таймер и заменяют payload.
 *  - `status` — текущее состояние: `idle` / `saving` / `saved` / `error`.
 *  - `lastSavedAt` — Date последнего успешного сохранения (для pill).
 *  - `error` — последняя ошибка (null при `status !== 'error'`).
 *  - `retry()` — повторяет последний неудачный `saveFn(payload)`. Полезно
 *    для кнопки «Повторить» в `<SaveStatusPill>` ошибочного состояния.
 *  - `flush()` — немедленно отправить отложенный save (напр. перед
 *    переходом по ссылке / размонтированием / финальным complete).
 *
 * # Зачем свой хук, а не `useDebouncedCallback`
 *
 * `useDebouncedCallback` — только про тайминг. `useAutoSave` добавляет
 * статусную машину (idle→saving→saved/error), retry-букетинг и flush.
 * Это то, что надо `<SaveStatusPill>` для видимого индикатора и
 * `UserCourseEditorPage` — пере-вызовы на unmount.
 */

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface UseAutoSaveOptions<TPayload> {
  /** Функция реального сохранения. Должна вернуть Promise. */
  saveFn: (payload: TPayload) => Promise<unknown>;
  /** Debounce в мс. По умолчанию 500 (ADR-026). */
  delayMs?: number;
}

export interface UseAutoSaveReturn<TPayload> {
  status: AutoSaveStatus;
  lastSavedAt: Date | null;
  error: Error | null;
  save: (payload: TPayload) => void;
  retry: () => void;
  flush: () => void;
}

export function useAutoSave<TPayload>({
  saveFn,
  delayMs = 500,
}: UseAutoSaveOptions<TPayload>): UseAutoSaveReturn<TPayload> {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPayloadRef = useRef<TPayload | null>(null);
  const lastPayloadRef = useRef<TPayload | null>(null);
  // `saveFn` может замыкаться на stale state в родительском компоненте —
  // держим актуальный ref, чтобы debounce-коллбек дёргал свежую функцию.
  const saveFnRef = useRef(saveFn);
  useEffect(() => {
    saveFnRef.current = saveFn;
  }, [saveFn]);

  const runSave = useCallback(async (payload: TPayload) => {
    setStatus('saving');
    setError(null);
    try {
      await saveFnRef.current(payload);
      setStatus('saved');
      setLastSavedAt(new Date());
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  const save = useCallback(
    (payload: TPayload) => {
      pendingPayloadRef.current = payload;
      lastPayloadRef.current = payload;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const pending = pendingPayloadRef.current;
        pendingPayloadRef.current = null;
        timerRef.current = null;
        if (pending !== null) void runSave(pending);
      }, delayMs);
    },
    [delayMs, runSave],
  );

  const flush = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingPayloadRef.current;
    pendingPayloadRef.current = null;
    if (pending !== null) void runSave(pending);
  }, [runSave]);

  const retry = useCallback(() => {
    const last = lastPayloadRef.current;
    if (last === null) return;
    void runSave(last);
  }, [runSave]);

  // Cleanup pending timer on unmount — иначе после размонтирования
  // таймер выстрелит и попытается set-state на исчезнувшем компоненте.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { status, lastSavedAt, error, save, retry, flush };
}
