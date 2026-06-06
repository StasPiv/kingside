import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LiveAnalysisClosedEvent,
  type LiveAnalysisCloseReason,
  type LiveAnalysisErrorEvent,
  type LiveAnalysisMoveEvent,
  type LiveAnalysisOrientation,
  type LiveAnalysisSyncSnapshot,
  type LiveAnalysisViewersEvent,
} from '@kingside/shared';
import { useLiveAnalysisSocket } from './useLiveAnalysisSocket';

/**
 * KS-3746 / ADR-111 §7. Общий примитив поверх `useLiveAnalysisSocket`,
 * который собирает state-машину «полной» трансляции анализа (PGN +
 * headers + currentPly + orientation) и инкапсулирует логику двух
 * режимов: зритель (`'viewer'`) и автор (`'owner'`).
 *
 * Назначение:
 *  - Зрителю в режиме `'viewer'` дать готовое состояние трансляции
 *    (`pgn`, `headers`, `currentPly`, `orientation`, `viewerCount`,
 *    `connected`, `error`, `closed`) без ручной обвязки сокета.
 *  - Автору в режиме `'owner'` дать debounce-эмит `state-patch`
 *    (500 мс, trailing-edge), мгновенный `move`, `reset`, `close`.
 *
 * Что хук НЕ делает:
 *  - REST-вызовы (`POST /live-analyses`, `GET /live-analyses/:slug`,
 *    `DELETE`). Это другой слой (`useAnalysisLiveBroadcast` для
 *    AnalysisPage, `LiveAnalysisViewerPage` для зрителя). Хук
 *    оперирует только WS-подпиской.
 *  - localStorage-persistence. Это тоже не его зона.
 *  - Парсинг PGN в дерево ходов. Это делает потребитель через
 *    свой review-state.
 *
 * Дизайн вызова:
 *  ```ts
 *  const live = useLiveAnalysisBroadcast({ slug, mode: 'viewer' });
 *  // live.pgn, live.headers, live.currentPly, live.orientation,
 *  // live.viewerCount, live.connected, live.error, live.closed
 *
 *  const live = useLiveAnalysisBroadcast({ slug, mode: 'owner' });
 *  live.emitStatePatch(currentPgn, headers); // debounced 500 ms
 *  live.emitMove('e2e4');                     // мгновенно
 *  live.emitReset({ fen });                   // мгновенно
 *  live.emitClose();                          // мгновенно
 *  ```
 *
 * В viewer-режиме методы emit остаются доступны (тип одинаков для
 * обоих режимов), но фактически они no-op-нут: сервер вернёт
 * `error { code: 'forbidden' }`, потому что зритель не owner.
 */

export type LiveAnalysisBroadcastMode = 'viewer' | 'owner';

export interface UseLiveAnalysisBroadcastArgs {
  /** Slug трансляции. `null`/`undefined` — хук «спит». */
  slug: string | null | undefined;
  /** Режим: зритель или автор. Определяет какие эмиты имеют смысл. */
  mode: LiveAnalysisBroadcastMode;
  /**
   * Дебаунс для `state-patch` в миллисекундах. По умолчанию 500 мс
   * (ADR-111 §2.4, синхронизировано с серверным rate-limit'ом
   * 5/сек burst 10). Оставлено параметром для тестов.
   */
  statePatchDebounceMs?: number;
}

export interface UseLiveAnalysisBroadcastState {
  /** Текущий annotated PGN трансляции (из последнего `sync.currentPgn`). `null` пока не пришёл. */
  pgn: string | null;
  /** PGN-headers (из `sync.headers`). `null` пока не пришли. */
  headers: Record<string, string> | null;
  /** Текущая позиция автора в дереве (из `sync.currentPly` или последнего `move.ply`). */
  currentPly: number;
  /**
   * KS-3750 / ADR-111 §7. Текущий FEN автора (из `sync.currentFen` или
   * последнего `move.fen`). Нужен зрителю чтобы понять, находится ли он
   * на main-line автора или в локальной ветке. `null` пока не пришёл
   * первый sync/move.
   */
  currentFen: string | null;
  /** Ориентация доски, как её сохранил автор. */
  orientation: LiveAnalysisOrientation;
  /** Текущее число зрителей (по `viewers`-event). */
  viewerCount: number;
  /** `true` если socket.io connected и subscribe для текущего slug-а отправлен. */
  connected: boolean;
  /** Последняя серверная ошибка. Сбрасывается при следующем успешном sync. */
  error: LiveAnalysisErrorEvent | null;
  /** Причина закрытия трансляции (`null` если трансляция ещё активна). */
  closed: LiveAnalysisCloseReason | null;
  /**
   * Эмит `state-patch` с дебаунсом 500 мс (trailing-edge). Внутри
   * запоминаются последние `pgn`/`headers`/`currentPly`/`orientation`,
   * и таймер сбрасывается. По истечению дебаунса уходит ровно один
   * патч. Без аргумента `pgn` ничего не отправляется — это безопасный
   * no-op. Owner-only.
   */
  emitStatePatch: (
    pgn: string,
    extras?: {
      headers?: Record<string, string>;
      currentPly?: number;
      orientation?: LiveAnalysisOrientation;
    },
  ) => void;
  /** Мгновенный эмит `move` (без дебаунса). Owner-only. */
  emitMove: (uci: string) => void;
  /** Мгновенный эмит `reset`. Owner-only. */
  emitReset: (params?: { fen?: string; pgn?: string }) => void;
  /** Мгновенный эмит `close`. Owner-only. */
  emitClose: () => void;
}

const DEFAULT_STATE_PATCH_DEBOUNCE_MS = 500;

export function useLiveAnalysisBroadcast({
  slug,
  mode,
  statePatchDebounceMs = DEFAULT_STATE_PATCH_DEBOUNCE_MS,
}: UseLiveAnalysisBroadcastArgs): UseLiveAnalysisBroadcastState {
  // ─── State ────────────────────────────────────────────────────────
  const [pgn, setPgn] = useState<string | null>(null);
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  const [currentPly, setCurrentPly] = useState(0);
  const [currentFen, setCurrentFen] = useState<string | null>(null);
  const [orientation, setOrientation] =
    useState<LiveAnalysisOrientation>('white');
  const [viewerCount, setViewerCount] = useState(0);
  const [error, setError] = useState<LiveAnalysisErrorEvent | null>(null);
  const [closed, setClosed] = useState<LiveAnalysisCloseReason | null>(null);

  // ─── Подписка на сокет ────────────────────────────────────────────
  const {
    connected,
    emitMove: socketEmitMove,
    emitReset: socketEmitReset,
    emitClose: socketEmitClose,
    emitStatePatch: socketEmitStatePatch,
  } = useLiveAnalysisSocket({
    // При закрытии трансляции (closed != null) отписываемся —
    // новых событий не будет, держать listener'ы смысла нет.
    slug: closed ? null : slug ?? null,
    onSync: useCallback((payload: LiveAnalysisSyncSnapshot) => {
      // `sync` — авторитетный snapshot. Применяем полностью.
      if (typeof payload.currentPgn === 'string') {
        setPgn(payload.currentPgn);
      } else {
        // Сервер не прислал currentPgn (старый snapshot без state-patch
        // ещё ни разу не приходил, ADR-111 §2.3) — оставляем null,
        // потребитель строит дерево из startingFen+moves.
        setPgn(null);
      }
      setHeaders(payload.headers ?? null);
      setCurrentPly(payload.currentPly);
      setCurrentFen(payload.currentFen);
      setOrientation(payload.orientation);
      // На приход sync сбрасываем последнюю ошибку — текущее состояние
      // снова консистентно с сервером.
      setError(null);
    }, []),
    onMove: useCallback((payload: LiveAnalysisMoveEvent) => {
      // На голый `move` сервер не пересылает PGN целиком (см. ADR-111
      // §2.2: «move» — это лёгкий апдейт). Поэтому здесь только сдвигаем
      // currentPly + currentFen. PGN-дерево обновится на следующем
      // `state-patch` от автора (либо потребитель сам применяет UCI
      // поверх локального PGN). Защита от out-of-order: применяем
      // только если ply вырос.
      setCurrentPly((prev) => {
        if (payload.ply > prev) {
          setCurrentFen(payload.fen);
          return payload.ply;
        }
        return prev;
      });
    }, []),
    onViewers: useCallback((payload: LiveAnalysisViewersEvent) => {
      setViewerCount(payload.count);
    }, []),
    onClosed: useCallback((payload: LiveAnalysisClosedEvent) => {
      setClosed(payload.reason);
    }, []),
    onError: useCallback((payload: LiveAnalysisErrorEvent) => {
      setError(payload);
    }, []),
  });

  // ─── Дебаунс state-patch (owner-only) ─────────────────────────────
  // Trailing-edge debounce: сохраняем последний payload, сбрасываем
  // таймер при каждом новом вызове, через `statePatchDebounceMs` мс
  // отправляем то, что лежит в pending. Это минимизирует трафик и
  // совпадает с серверным rate-limit'ом (ADR-111 §2.4).
  type PendingPatch = {
    pgn: string;
    headers?: Record<string, string>;
    currentPly?: number;
    orientation?: LiveAnalysisOrientation;
  };
  const pendingRef = useRef<PendingPatch | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // socketEmitStatePatch меняется на смене slug; держим в ref, чтобы
  // таймер всегда вызывал актуальный.
  const socketEmitStatePatchRef = useRef(socketEmitStatePatch);
  useEffect(() => {
    socketEmitStatePatchRef.current = socketEmitStatePatch;
  }, [socketEmitStatePatch]);

  // Очистка таймера при unmount / смене slug — иначе после ухода
  // со страницы пришёл бы отложенный `state-patch` с уже неактуальным
  // slug-ом. Не flush'им pending: trailing-edge без forced-flush —
  // стандартное поведение debounce-а.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
    };
  }, [slug]);

  const isOwner = mode === 'owner';

  const emitStatePatch = useCallback<
    UseLiveAnalysisBroadcastState['emitStatePatch']
  >(
    (nextPgn, extras) => {
      if (!isOwner) return;
      if (!nextPgn) return;
      pendingRef.current = {
        pgn: nextPgn,
        headers: extras?.headers,
        currentPly: extras?.currentPly,
        orientation: extras?.orientation,
      };
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        const payload = pendingRef.current;
        pendingRef.current = null;
        timerRef.current = null;
        if (!payload) return;
        // На случай если slug стал null между вызовом и таймером —
        // socket-хук сам это проверит (`if (!slug) return`).
        socketEmitStatePatchRef.current(payload);
      }, statePatchDebounceMs);
    },
    [isOwner, statePatchDebounceMs],
  );

  const emitMove = useCallback(
    (uci: string) => {
      if (!isOwner) return;
      socketEmitMove(uci);
    },
    [isOwner, socketEmitMove],
  );

  const emitReset = useCallback(
    (params?: { fen?: string; pgn?: string }) => {
      if (!isOwner) return;
      socketEmitReset(params);
    },
    [isOwner, socketEmitReset],
  );

  const emitClose = useCallback(() => {
    if (!isOwner) return;
    // Если у автора есть pending state-patch — отбрасываем его, ничего
    // отправлять уже не нужно (через секунду трансляция будет closed).
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    socketEmitClose();
  }, [isOwner, socketEmitClose]);

  return useMemo(
    () => ({
      pgn,
      headers,
      currentPly,
      currentFen,
      orientation,
      viewerCount,
      connected,
      error,
      closed,
      emitStatePatch,
      emitMove,
      emitReset,
      emitClose,
    }),
    [
      pgn,
      headers,
      currentPly,
      currentFen,
      orientation,
      viewerCount,
      connected,
      error,
      closed,
      emitStatePatch,
      emitMove,
      emitReset,
      emitClose,
    ],
  );
}
