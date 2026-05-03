import { useCallback, useEffect, useRef } from 'react';

import { serializeToAnnotatedPgn } from '../review/utils/PgnSerializer';
import type { ChessMove, NodeAnnotations } from '../review/types';

/**
 * KS-2281 (ADR-037 §6, E5 deferred) — local autosave для ad-hoc
 * `/analysis` (без `gameId` и без сохранённого `analysisId`).
 *
 * Зачем: для review-mode (gameId) уже есть `useAnalysisPersistence`
 * (PUT /games/:id/analysis), для saved-analysis — `useSavedAnalyses`
 * (IndexedDB через get/update). Для ad-hoc (puzzle FEN, custom
 * position, "/analysis" с пустой партией) ничего не было — пользователь
 * проставлял NAG-аннотации, перезагружал страницу и терял их.
 *
 * Реализация: throttle-save в localStorage с ключом по `initialFen`
 * (`analysis:adhoc:<base64(initialFen)>`). На mount — восстанавливаем,
 * если запись есть.
 *
 * # Throttle vs debounce
 *
 * Используем throttle (а не debounce) — пользователь, кликающий 10
 * NAG'ов подряд, должен видеть промежуточные сохранения, не только
 * после остановки. Интервал ~1500 мс — компромисс между нагрузкой
 * на localStorage (synchronous, блокирует main thread) и риском
 * потери при внезапном reload.
 *
 * # Format
 *
 * `serializeToAnnotatedPgn(history, initialAnnotations,
 * annotationsByIndex)` — тот же формат, что и `useAnalysisPersistence`.
 * Каркас восстановления вынесен в callback `onRestore(pgn)`, чтобы
 * хук остался не привязанным к конкретному review-state-API
 * (`loadFromPgn` живёт в useReviewState).
 *
 * # Когда НЕ сохраняем / НЕ восстанавливаем
 *
 * - `enabled=false` (gameId или analysisId есть) — выходим сразу.
 * - `history.length === 0 && !initialAnnotations` — пустая страница,
 *   нечего хранить (а если в localStorage уже была запись — перезатирать
 *   её пустотой не будем, оставляем последний снимок до явного reset).
 *   Это даёт пользователю простой path: «открыл аннотации, передумал,
 *   нажал "В начало"» — данные не пропадут.
 *   Для жёсткого сброса есть `clearAdHocAnalysisStorage(initialFen)`.
 *
 * # Quota / privacy
 *
 * `localStorage.setItem` бросает `QuotaExceededError` при превышении
 * (~5 MB на origin). PGN короткой партии — единицы KB, реальный
 * предел не достигается, но ошибку ловим и игнорируем — autosave
 * — best-effort, не должен ломать рендер.
 */

const STORAGE_PREFIX = 'analysis:adhoc:';
const THROTTLE_MS = 1500;

interface AutosaveOptions {
  /** Сохраняем только когда true (ad-hoc /analysis: !gameId && !analysisId). */
  enabled: boolean;
  /** Стартовая позиция, ключ хранения. */
  initialFen: string;
  history: ChessMove[];
  initialAnnotations?: NodeAnnotations;
  annotationsByIndex?: Record<number, NodeAnnotations>;
  /**
   * Вызывается ОДИН раз на mount, если в localStorage есть сохранённый
   * PGN под ключом `initialFen`. Получает PGN-строку — вызывающий
   * сам парсит и применяет (`loadFromPgn` + `extractInitialAnnotations`).
   */
  onRestore?: (pgn: string) => void;
}

function storageKey(initialFen: string): string {
  // base64 — однозначно сериализует FEN с пробелами / спец-символами.
  // Если window/btoa недоступны (SSR) — fallback на raw fen (не идеален,
  // но autosave всё равно SSR не нужен).
  if (typeof btoa === 'function') {
    return STORAGE_PREFIX + btoa(unescape(encodeURIComponent(initialFen)));
  }
  return STORAGE_PREFIX + initialFen;
}

/** Чистый утилитарный геттер — для тестов / хост-кода. */
export function readAdHocAnalysisStorage(initialFen: string): string | null {
  try {
    return localStorage.getItem(storageKey(initialFen));
  } catch {
    return null;
  }
}

/** Сброс сохранённой записи — например, по кнопке «New analysis». */
export function clearAdHocAnalysisStorage(initialFen: string): void {
  try {
    localStorage.removeItem(storageKey(initialFen));
  } catch {
    /* ignore */
  }
}

export function useAdHocAnalysisAutosave({
  enabled,
  initialFen,
  history,
  initialAnnotations,
  annotationsByIndex,
  onRestore,
}: AutosaveOptions): void {
  const lastSaveAtRef = useRef<number>(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredRef = useRef(false);
  // Latest-snapshots для flush на unmount.
  const enabledRef = useRef(enabled);
  const fenRef = useRef(initialFen);
  const histRef = useRef(history);
  const initAnnRef = useRef(initialAnnotations);
  const annByIdxRef = useRef(annotationsByIndex);
  useEffect(() => {
    enabledRef.current = enabled;
    fenRef.current = initialFen;
    histRef.current = history;
    initAnnRef.current = initialAnnotations;
    annByIdxRef.current = annotationsByIndex;
  });

  // ─── Restore on mount ────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!onRestore) return;
    const pgn = readAdHocAnalysisStorage(initialFen);
    if (pgn && pgn.trim().length > 0) {
      try {
        onRestore(pgn);
      } catch {
        // parse-failure не должен ронять страницу — игнорируем,
        // запись в localStorage оставляем (вдруг другая версия фронта
        // прочитает корректно).
      }
    }
    // Зависим только от `enabled` и `initialFen` — onRestore из props
    // может пересоздаваться на каждом рендере (новая ссылка), но
    // restoredRef-guard гарантирует один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, initialFen]);

  // ─── Throttled save ─────────────────────────────────────────────
  const flushNow = useCallback(() => {
    if (!enabledRef.current) return;
    const hist = histRef.current;
    const initAnn = initAnnRef.current;
    if (hist.length === 0 && !initAnn) {
      // Пустая партия + нет startup-annotations: ничего не сохраняем.
      return;
    }
    try {
      const pgn = serializeToAnnotatedPgn(hist, initAnn, annByIdxRef.current);
      localStorage.setItem(storageKey(fenRef.current), pgn);
      lastSaveAtRef.current = Date.now();
    } catch {
      // QuotaExceededError / SecurityError — best-effort, тихо.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (history.length === 0 && !initialAnnotations) return;

    const now = Date.now();
    const timeSinceLast = now - lastSaveAtRef.current;
    if (timeSinceLast >= THROTTLE_MS) {
      // Прошло достаточно — сохраняем сразу.
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      flushNow();
      return;
    }
    // Иначе — планируем сохранение в конце окна (если ещё не запланировано).
    if (pendingTimerRef.current) return;
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      flushNow();
    }, THROTTLE_MS - timeSinceLast);

    return () => {
      // Не очищаем pendingTimer на каждом изменении — иначе throttle
      // превратится в debounce. Очищаем только при unmount эффекта
      // конкретно по smen `enabled`/initialFen.
    };
  }, [enabled, history, initialAnnotations, annotationsByIndex, flushNow]);

  // ─── Flush on unmount + смена ключа ──────────────────────────────
  useEffect(() => {
    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      // Финальный flush — гарантия, что последний клик не потерян.
      flushNow();
    };
  }, [flushNow]);
}
