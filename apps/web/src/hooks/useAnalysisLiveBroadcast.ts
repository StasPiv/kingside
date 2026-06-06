import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateLiveAnalysisDto,
  LiveAnalysisClosedEvent,
  LiveAnalysisErrorEvent,
  LiveAnalysisOrientation,
  LiveAnalysisResponse,
  LiveAnalysisViewersEvent,
} from '@kingside/shared';
import { api } from '../api';
import { ApiError } from '../ApiError';
import { useLiveAnalysisSocket } from './useLiveAnalysisSocket';

/**
 * KS-3736 / ADR-110 §3-§4. Доменный хук «трансляция анализа» для
 * `AnalysisPage`. Связывает REST (`POST /live-analyses`), сокет-обвязку
 * (`useLiveAnalysisSocket`) и localStorage-восстановление в один state-
 * автомат, чтобы страница использовала простой API:
 *
 *   const live = useAnalysisLiveBroadcast({ currentFen, orientation, title });
 *   live.isLive        // bool, для отображения индикатора
 *   live.viewerCount   // number, счётчик зрителей
 *   live.publicUrl     // string | null, для кнопки «Скопировать ссылку»
 *   live.start()       // POST /live-analyses + сохранение slug
 *   live.stop()        // WS close + чистка localStorage
 *   live.emitMove(uci) // дёргается из обёртки makeVariantMove
 *
 * ### localStorage-восстановление (acceptance §«при reload»)
 *
 * После старта slug кладётся в `localStorage` под ключом
 * `live-analysis:active-slug`. При mount хук читает ключ:
 *   1. Если есть — параллельно делает `GET /live-analyses/:slug`,
 *      чтобы убедиться, что трансляция жива (active) и владелец тот же.
 *   2. Если status=active И ownerId совпал с текущим юзером — режим
 *      «трансляция продолжается»: подписываемся через socket-хук,
 *      сервер пришлёт `sync`, дальше — обычный поток.
 *   3. Если status=closed или 404 — чистим ключ, обычный idle-режим.
 *
 * ### Поведение `emitMove`
 *
 * На каждый успешный `makeVariantMove` страница вызывает `emitMove(uci)`.
 * Хук эмитит `live-analysis:move`. Если сервер вернёт `illegal-move` —
 * это значит у нас на стороне автора было переключение между линиями
 * вариантов (currentFen не «следующий» после серверного currentFen).
 * В этом случае хук автоматически шлёт `reset({ fen: currentFen })`,
 * чтобы синхронизировать зрителей на актуальную позицию автора.
 */

const LIVE_SLUG_STORAGE_KEY = 'live-analysis:active-slug';

function readPersistedSlug(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LIVE_SLUG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePersistedSlug(slug: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (slug) {
      window.localStorage.setItem(LIVE_SLUG_STORAGE_KEY, slug);
    } else {
      window.localStorage.removeItem(LIVE_SLUG_STORAGE_KEY);
    }
  } catch {
    /* localStorage может быть выключен (приват-режим Safari) — не критично,
       просто не будет работать восстановление при reload. */
  }
}

export interface UseAnalysisLiveBroadcastArgs {
  /** Актуальная позиция автора (используется для start + для reset-fallback). */
  currentFen: string;
  /** Стартовая позиция анализа (для `startingFen` в POST). */
  initialFen: string;
  /** Ориентация доски автора (передаётся серверу — зрители видят так же). */
  orientation: LiveAnalysisOrientation;
  /** Заголовок трансляции (можно использовать analysisTitle). */
  title?: string | null;
  /** ID текущего юзера или `null`. Без авторизации трансляцию запускать нельзя. */
  userId: string | null;
}

export interface UseAnalysisLiveBroadcastState {
  /** `true` если активна трансляция (есть slug, сокет подключён или подключается). */
  isLive: boolean;
  /** `true` пока выполняется POST /live-analyses (для disabled-кнопки). */
  isStarting: boolean;
  /** Slug текущей трансляции (`null` если её нет). */
  slug: string | null;
  /** Полная публичная ссылка для копирования (`https://kingside.site/live/<slug>`). */
  publicUrl: string | null;
  /** Текущее число зрителей. 0 если трансляция не активна или сервер ещё не прислал. */
  viewerCount: number;
  /** Последняя серверная ошибка (для тоста). Сбрасывается на каждом действии. */
  error: string | null;
  /** Запустить трансляцию (POST /live-analyses + сохранить slug). */
  start: () => Promise<LiveAnalysisResponse | null>;
  /** Завершить трансляцию (WS close + чистка localStorage). */
  stop: () => void;
  /** Эмит хода автора. Безопасно вызывать когда `isLive=false` — будет no-op. */
  emitMove: (uci: string) => void;
  /**
   * KS-3749 / ADR-111 §7. Эмит `state-patch` (trailing-edge debounce
   * 500 мс). Родитель вызывает на каждое изменение review-state
   * (новый PGN после комментария / NAG / вариации, смена headers,
   * переключение currentPly, ориентация). Хук замораживает таймер;
   * по истечению 500 мс уходит ровно один `state-patch` с последним
   * snapshot'ом. Безопасно вызывать когда `isLive=false` — будет no-op.
   *
   * Дебаунс синхронизирован с серверным rate-limit (ADR-111 §2.4:
   * 5/сек burst 10): при типичном редактировании 1-2 patch'а в
   * секунду, лимит не пробивается даже при шквале правок.
   */
  emitStatePatch: (params: {
    pgn: string;
    headers?: Record<string, string>;
    currentPly?: number;
    orientation?: LiveAnalysisOrientation;
  }) => void;
}

/** KS-3749: debounce для emit state-patch, синхронизирован с серверным rate-limit. */
const STATE_PATCH_DEBOUNCE_MS = 500;

export function useAnalysisLiveBroadcast({
  currentFen,
  initialFen,
  orientation,
  title,
  userId,
}: UseAnalysisLiveBroadcastArgs): UseAnalysisLiveBroadcastState {
  const [slug, setSlug] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // currentFen в ref — нужно в стабильных колбэках (emitMove / onError),
  // не хочется перезаписывать listener'ы socket-хука на каждое движение.
  const currentFenRef = useRef(currentFen);
  useEffect(() => {
    currentFenRef.current = currentFen;
  }, [currentFen]);

  // emitReset в ref — обход циклической зависимости: onError-колбэку
  // нужно дёргать emitReset, но сам emitReset приходит из
  // useLiveAnalysisSocket, который принимает onError в args. Стабильный
  // ref-обёртка перезаполняется через useEffect ниже, когда emitReset
  // уже определён.
  const emitResetRef = useRef<(p?: { fen?: string; pgn?: string }) => void>(
    () => {},
  );

  // ─── Восстановление после reload ──────────────────────────────────
  // Один раз при mount: если в localStorage лежит slug, проверяем что
  // трансляция жива и наша. Перепроверка нужна потому что между
  // closed→reload могло пройти много времени (вкладка спала, сервер
  // закрыл по inactivity и т.д.).
  useEffect(() => {
    const persisted = readPersistedSlug();
    if (!persisted || !userId) {
      // Нет сохранённого slug — обычный idle. Если есть, но юзер не
      // авторизован сейчас — тоже не восстанавливаем (см. ADR-110 §2.6:
      // move/reset/close идут от owner-а, без токена сервер их отклонит).
      if (persisted && !userId) writePersistedSlug(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.get<LiveAnalysisResponse>(
          `/live-analyses/${persisted}`,
        );
        if (cancelled) return;
        if (resp.status !== 'active' || resp.ownerId !== userId) {
          // Закрыта или не наша — чистим, иначе будем светить чужой
          // индикатор «В эфире» у пользователя.
          writePersistedSlug(null);
          return;
        }
        setSlug(resp.slug);
        setPublicUrl(resp.url);
        setViewerCount(resp.viewerCount);
      } catch (e) {
        // 404 / SESSION_EXPIRED / network — в любом случае ключ
        // больше не имеет смысла. На SESSION_EXPIRED auth-flow уже
        // редиректнет на /login через notifySessionExpired, нам не
        // нужно дополнительно реагировать.
        if (e instanceof ApiError && e.status === 404) {
          writePersistedSlug(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Один раз при mount; смена userId после логина в этой же вкладке
    // обновит контекст и страница перемонтируется выше.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Сокет: подписка + обработчики ────────────────────────────────
  const handleViewers = useCallback((payload: LiveAnalysisViewersEvent) => {
    setViewerCount(payload.count);
  }, []);

  const handleClosed = useCallback((_payload: LiveAnalysisClosedEvent) => {
    // Сервер закрыл (inactivity / by_owner с другой вкладки).
    // Чистим локальный state и storage, индикатор гаснет.
    setSlug(null);
    setPublicUrl(null);
    setViewerCount(0);
    writePersistedSlug(null);
  }, []);

  const handleError = useCallback((payload: LiveAnalysisErrorEvent) => {
    if (payload.code === 'illegal-move') {
      // У автора переключение между вариантами (или сервер потерял
      // sync). Шлём reset с текущим FEN — зрители перерисуют доску
      // на актуальное состояние. Не показываем юзеру ошибку: для
      // него это прозрачно.
      emitResetRef.current({ fen: currentFenRef.current });
      return;
    }
    if (payload.code === 'slug-not-found') {
      // Сервер не знает наш slug — трансляция исчезла. Чистимся.
      setSlug(null);
      setPublicUrl(null);
      setViewerCount(0);
      writePersistedSlug(null);
      return;
    }
    // forbidden / rate-limit / invalid-payload — показываем тост.
    setError(payload.message || payload.code);
  }, []);

  const {
    snapshot,
    emitMove: socketEmitMove,
    emitReset,
    emitClose,
    emitStatePatch: socketEmitStatePatch,
  } = useLiveAnalysisSocket({
    slug,
    onViewers: handleViewers,
    onClosed: handleClosed,
    onError: handleError,
  });

  // Перезаполняем ref-обёртку как только emitReset «стабилизировался»
  // на новом slug.
  useEffect(() => {
    emitResetRef.current = emitReset;
  }, [emitReset]);

  // Когда сервер прислал sync (например, после reconnect или
  // восстановления при reload) — обновляем счётчик нечего синхронизировать
  // дополнительно. `snapshot` использует страница только косвенно (через
  // подтверждение что подписка установлена).
  useEffect(() => {
    if (!snapshot) return;
    // Sync содержит только текущую позицию, без viewerCount — счётчик
    // придёт отдельным `viewers`-event-ом, сервер сам шлёт его на
    // subscribe. Здесь просто сбрасываем ошибку, потому что подписка
    // живая и валидная.
    setError(null);
  }, [snapshot]);

  // ─── KS-3749: debounced emitStatePatch для автора ─────────────────
  // Push-метод: AnalysisPage сам вычисляет PGN/headers/currentPly/
  // orientation (через useEffect на изменения review-state) и зовёт
  // `emitStatePatch(...)`. Хук собирает входы в trailing-edge debounce
  // 500 мс — синхронизирован с серверным rate-limit (ADR-111 §2.4).
  //
  // Дополнительная защита от лишнего трафика: сравниваем payload с
  // последним отправленным (через JSON-хеш). Идентичные patch'ы (та же
  // позиция/ply/orientation) не уходят повторно — экономит трафик и
  // bandwidth у зрителей.
  const statePatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStatePatchRef = useRef<{
    pgn: string;
    headers?: Record<string, string>;
    currentPly?: number;
    orientation?: LiveAnalysisOrientation;
  } | null>(null);
  const lastSentSignatureRef = useRef<string | null>(null);
  const socketEmitStatePatchRef = useRef(socketEmitStatePatch);
  useEffect(() => {
    socketEmitStatePatchRef.current = socketEmitStatePatch;
  }, [socketEmitStatePatch]);

  // Сброс при смене трансляции (slug стал null или сменился) —
  // очищаем pending и last-sent baseline. Иначе при перезапуске
  // трансляции мы бы пропустили первый patch как «уже отправленный».
  useEffect(() => {
    if (statePatchTimerRef.current) {
      clearTimeout(statePatchTimerRef.current);
      statePatchTimerRef.current = null;
    }
    pendingStatePatchRef.current = null;
    lastSentSignatureRef.current = null;
  }, [slug]);

  // Очистка таймера на unmount хука.
  useEffect(() => {
    return () => {
      if (statePatchTimerRef.current) {
        clearTimeout(statePatchTimerRef.current);
        statePatchTimerRef.current = null;
      }
    };
  }, []);

  const emitStatePatch = useCallback<
    UseAnalysisLiveBroadcastState['emitStatePatch']
  >(
    (params) => {
      if (!slug) return;
      if (!params.pgn) return;
      // Dedupe: если ничего не поменялось относительно последней
      // отправки — не ставим таймер, экономим re-render у зрителей.
      const signature = JSON.stringify({
        p: params.pgn,
        h: params.headers ?? null,
        c: params.currentPly ?? null,
        o: params.orientation ?? null,
      });
      if (signature === lastSentSignatureRef.current) return;
      pendingStatePatchRef.current = params;
      if (statePatchTimerRef.current) {
        clearTimeout(statePatchTimerRef.current);
      }
      statePatchTimerRef.current = setTimeout(() => {
        statePatchTimerRef.current = null;
        const payload = pendingStatePatchRef.current;
        pendingStatePatchRef.current = null;
        if (!payload) return;
        socketEmitStatePatchRef.current(payload);
        lastSentSignatureRef.current = JSON.stringify({
          p: payload.pgn,
          h: payload.headers ?? null,
          c: payload.currentPly ?? null,
          o: payload.orientation ?? null,
        });
      }, STATE_PATCH_DEBOUNCE_MS);
    },
    [slug],
  );

  // ─── Действия ─────────────────────────────────────────────────────

  const start = useCallback(async (): Promise<LiveAnalysisResponse | null> => {
    if (!userId) {
      setError('not-authenticated');
      return null;
    }
    if (slug) {
      // Уже идёт трансляция — не создаём повторно.
      return null;
    }
    setIsStarting(true);
    setError(null);
    try {
      const body: CreateLiveAnalysisDto = {
        startingFen: initialFen,
        orientation,
        title: title ?? undefined,
      };
      const resp = await api.post<LiveAnalysisResponse>(
        '/live-analyses',
        body,
      );
      setSlug(resp.slug);
      setPublicUrl(resp.url);
      setViewerCount(resp.viewerCount);
      writePersistedSlug(resp.slug);
      return resp;
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : 'failed-to-start-broadcast';
      setError(msg);
      return null;
    } finally {
      setIsStarting(false);
    }
  }, [initialFen, orientation, slug, title, userId]);

  const stop = useCallback(() => {
    if (!slug) return;
    try {
      emitClose();
    } catch {
      /* сокет мог отвалиться — ключевое тут — чистка локального state */
    }
    setSlug(null);
    setPublicUrl(null);
    setViewerCount(0);
    writePersistedSlug(null);
  }, [emitClose, slug]);

  const emitMove = useCallback(
    (uci: string) => {
      if (!slug) return;
      socketEmitMove(uci);
    },
    [slug, socketEmitMove],
  );

  return {
    isLive: !!slug,
    isStarting,
    slug,
    publicUrl,
    viewerCount,
    error,
    start,
    stop,
    emitMove,
    emitStatePatch,
  };
}
