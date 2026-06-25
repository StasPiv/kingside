import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LiveAnalysisEvents,
  type LiveAnalysisAnalysisSwitchEvent,
  type LiveAnalysisClosedEvent,
  type LiveAnalysisErrorEvent,
  type LiveAnalysisMoveEvent,
  type LiveAnalysisSyncSnapshot,
  type LiveAnalysisViewersEvent,
} from '@kingside/shared';
import { liveAnalysisSocket } from '../socket';

/**
 * KS-3735 / ADR-110. Тонкая обвязка над глобальным `liveAnalysisSocket`
 * (namespace `/live-analysis`).
 *
 * Поведение:
 *  1. На монт читает JWT из `localStorage.token`. Если есть — кладёт в
 *     `socket.auth` до connect-а (сервер опознаёт пользователя как
 *     потенциального owner-а). Если нет — connect анонимный (только
 *     viewer). Это до connect-а, иначе server-side guard не увидит токен.
 *  2. На каждый `connect` (initial + reconnect) автоматически emit-ит
 *     `subscribe { slug }`. Сервер в ответ присылает `sync` — снапшот
 *     состояния (см. `LiveAnalysisSyncSnapshot`), который мы кладём в
 *     стейт. Это покрывает требование «получение sync на reconnect».
 *  3. На unmount / смене slug — emit `unsubscribe`, снятие listener'ов.
 *     Сам socket НЕ disconnect-ится: он глобальный, может использоваться
 *     одновременно автором (Analysis) и зрителем (`/live/:slug`) в
 *     соседних вкладках одного домена.
 *  4. Возвращает методы `emitMove/emitReset/emitClose` для owner-ских
 *     действий. Серверная авторизация — на стороне gateway (ADR-110
 *     §2.6); фронт ничего не проверяет, просто шлёт payload. Если эмит
 *     прилетит не-owner-у — сервер вернёт `error { code: 'forbidden' }`
 *     в обработчик `onError`.
 *
 * Контракт хука осознанно «тонкий»: применение ходов к доске, sync-
 * проверки FEN-а, UI-логика — на стороне страницы-потребителя.
 */

export interface UseLiveAnalysisSocketArgs {
  /** Slug трансляции. `null`/`undefined` — хук «спит» (без connect / subscribe). */
  slug: string | null | undefined;
  /** Колбэк на каждый `move`-event (broadcast хода автора). */
  onMove?: (payload: LiveAnalysisMoveEvent) => void;
  /** Колбэк на каждый `sync` (initial после subscribe + reset + явный sync). */
  onSync?: (payload: LiveAnalysisSyncSnapshot) => void;
  /** Колбэк на изменение числа зрителей (дросселирован сервером). */
  onViewers?: (payload: LiveAnalysisViewersEvent) => void;
  /** Колбэк на завершение трансляции (by_owner / inactivity). */
  onClosed?: (payload: LiveAnalysisClosedEvent) => void;
  /** Колбэк на server-error (`slug-not-found`, `forbidden`, `illegal-move`, …). */
  onError?: (payload: LiveAnalysisErrorEvent) => void;
  /**
   * KS-4629 / ADR-142 §2.7. Колбэк на `analysis-switch` — тренер
   * сменил активное окно анализа. Зритель должен сбросить дерево и
   * применить новые `startingFen` / `tree` / `orientation` / `title`.
   */
  onAnalysisSwitch?: (payload: LiveAnalysisAnalysisSwitchEvent) => void;
}

export interface UseLiveAnalysisSocketState {
  /** `true` если socket.io connected и subscribe для текущего slug-а уже отправлен. */
  connected: boolean;
  /**
   * Последний полученный snapshot. Обновляется на initial sync после
   * subscribe и на каждый последующий sync (reset / явный sync-запрос).
   * Для применения ходов потребитель сам собирает позицию из snapshot +
   * последующих `onMove` (либо хранит свой FEN и доверяет `move.fen`).
   */
  snapshot: LiveAnalysisSyncSnapshot | null;
  /** Эмит `move` (owner-only, server-side guard). */
  emitMove: (uci: string) => void;
  /** Эмит `reset` (owner-only). Опциональный новый стартовый FEN или PGN. */
  emitReset: (params?: { fen?: string; pgn?: string }) => void;
  /** Эмит `close` (owner-only). Эквивалент `DELETE /live-analyses/:id`. */
  emitClose: () => void;
  /** Принудительный запрос snapshot-а (страховка при подозрении на рассинхрон). */
  requestSync: () => void;
  /**
   * KS-3742 / ADR-111 §2.2. Эмит `state-patch` (owner-only) —
   * annotated PGN с опциональными headers/currentPly/orientation.
   * Без дебаунса: дебаунс-логика — на стороне потребителя
   * (`useLiveAnalysisBroadcast`), здесь только сырая отправка.
   */
  emitStatePatch: (params: {
    /**
     * KS-3780: JSON-сериализованное дерево анализа автора
     * (см. `serializeLiveTree`). Backend хранит как непрозрачную
     * строку. Заменило поле `pgn` — теперь дерево с уже
     * проставленными `globalIndex` едет как есть, без двойного
     * разбора через парсер у зрителя.
     */
    tree: string;
    /**
     * KS-3775: уникальный сквозной индекс узла дерева анализа
     * (включая боковые варианты). После KS-3780 индекс берётся
     * прямо из reducer'а автора — никакой переиндексации, у
     * зрителя `searchInHistory(history, currentGlobalIndex)`
     * всегда находит нужный узел.
     */
    currentGlobalIndex?: number;
    orientation?: 'white' | 'black';
  }) => void;
}

export function useLiveAnalysisSocket({
  slug,
  onMove,
  onSync,
  onViewers,
  onClosed,
  onError,
  onAnalysisSwitch,
}: UseLiveAnalysisSocketArgs): UseLiveAnalysisSocketState {
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<LiveAnalysisSyncSnapshot | null>(null);

  // Колбэки храним через ref, чтобы родитель мог менять замыкание (например,
  // обновлять локальный FEN после применения хода) без переподписки.
  const onMoveRef = useRef(onMove);
  const onSyncRef = useRef(onSync);
  const onViewersRef = useRef(onViewers);
  const onClosedRef = useRef(onClosed);
  const onErrorRef = useRef(onError);
  const onAnalysisSwitchRef = useRef(onAnalysisSwitch);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);
  useEffect(() => {
    onSyncRef.current = onSync;
  }, [onSync]);
  useEffect(() => {
    onViewersRef.current = onViewers;
  }, [onViewers]);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onAnalysisSwitchRef.current = onAnalysisSwitch;
  }, [onAnalysisSwitch]);

  useEffect(() => {
    if (!slug) {
      setConnected(false);
      setSnapshot(null);
      return;
    }
    const s = liveAnalysisSocket;

    // KS-4005. JWT в handshake — опциональный (если есть, сервер опознаёт
    // owner-а; если нет — анонимный viewer, ADR-110 §2.6). Ручное
    // `s.auth = {token}` убрано — сокет создаётся с `auth`-callback в
    // `socket.ts`, который читает свежий токен из localStorage на каждый
    // handshake (initial + reconnect). См. подробный комментарий там.

    // KS-4014. Лог анонимности нужен в трассировке открытия подписки —
    // помогает быстро отличить «зритель залогинен, gateway его опознал
    // не как owner» от «зритель аноним, owner-detection не сработал
    // by design». Считаем по тому же признаку, что использует
    // socket.ts (auth-callback читает `localStorage.token`).
    const isAnonymous = (() => {
      try {
        return typeof window === 'undefined'
          ? false
          : !window.localStorage.getItem('token');
      } catch {
        return true;
      }
    })();

    const subscribe = () => {
      s.emit(LiveAnalysisEvents.SUBSCRIBE, { slug });
      setConnected(true);
      // KS-4014. Структурированный лог открытия подписки —
      // первый сигнал в цепочке трассировки подключения зрителя.
      // Если у пользователя в DevTools этой строки нет, проблема
      // дальше gateway уже не нужно искать.
      console.info('[live-analysis-sock] subscribe-emitted', {
        slug,
        socketId: s.id ?? null,
        socketConnected: s.connected,
        isAnonymous,
      });
    };
    const handleConnect = () => {
      console.info('[live-analysis-sock] connect-event', {
        slug,
        socketId: s.id ?? null,
        isAnonymous,
      });
      subscribe();
    };
    const handleDisconnect = (reason: string) => {
      console.warn('[live-analysis-sock] disconnect-event', { slug, reason });
      setConnected(false);
    };
    const handleConnectError = (err: Error) => {
      console.warn('[live-analysis-sock] connect_error', {
        slug,
        message: err.message,
      });
    };
    const handleSync = (payload: LiveAnalysisSyncSnapshot) => {
      // Cross-room защита: глобальный socket может в редких сценариях
      // получить событие чужой комнаты (например, при быстрой смене slug-а).
      if (payload?.slug !== slug) return;
      setSnapshot(payload);
      onSyncRef.current?.(payload);
    };
    const handleMove = (payload: LiveAnalysisMoveEvent) => {
      if (payload?.slug !== slug) return;
      onMoveRef.current?.(payload);
    };
    const handleViewers = (payload: LiveAnalysisViewersEvent) => {
      if (payload?.slug !== slug) return;
      onViewersRef.current?.(payload);
    };
    const handleClosed = (payload: LiveAnalysisClosedEvent) => {
      if (payload?.slug !== slug) return;
      onClosedRef.current?.(payload);
    };
    const handleError = (payload: LiveAnalysisErrorEvent) => {
      onErrorRef.current?.(payload);
    };
    // KS-4629 / ADR-142 §2.7. Server → client: тренер переключил
    // активное окно анализа. Тот же cross-room guard, что и у sync/move.
    const handleAnalysisSwitch = (payload: LiveAnalysisAnalysisSwitchEvent) => {
      if (payload?.slug !== slug) return;
      onAnalysisSwitchRef.current?.(payload);
    };

    s.on('connect', handleConnect);
    s.on('disconnect', handleDisconnect);
    s.on('connect_error', handleConnectError);
    s.on(LiveAnalysisEvents.SYNC, handleSync);
    s.on(LiveAnalysisEvents.MOVE, handleMove);
    s.on(LiveAnalysisEvents.VIEWERS, handleViewers);
    s.on(LiveAnalysisEvents.CLOSED, handleClosed);
    s.on(LiveAnalysisEvents.ERROR, handleError);
    s.on(LiveAnalysisEvents.ANALYSIS_SWITCH, handleAnalysisSwitch);

    console.info('[live-analysis-sock] mount', {
      slug,
      socketConnected: s.connected,
      socketId: s.id ?? null,
      isAnonymous,
    });
    if (s.connected) {
      subscribe();
    } else {
      s.connect();
      console.info('[live-analysis-sock] socket.connect() invoked', { slug });
    }

    return () => {
      try {
        s.emit(LiveAnalysisEvents.UNSUBSCRIBE, { slug });
      } catch {
        /* socket мог упасть — игнорируем */
      }
      s.off('connect', handleConnect);
      s.off('disconnect', handleDisconnect);
      s.off('connect_error', handleConnectError);
      s.off(LiveAnalysisEvents.SYNC, handleSync);
      s.off(LiveAnalysisEvents.MOVE, handleMove);
      s.off(LiveAnalysisEvents.VIEWERS, handleViewers);
      s.off(LiveAnalysisEvents.CLOSED, handleClosed);
      s.off(LiveAnalysisEvents.ERROR, handleError);
      s.off(LiveAnalysisEvents.ANALYSIS_SWITCH, handleAnalysisSwitch);
      // Не disconnect-аем: socket глобальный (см. broadcastSocket-комментарий).
    };
  }, [slug]);

  const emitMove = useCallback(
    (uci: string) => {
      if (!slug) return;
      liveAnalysisSocket.emit(LiveAnalysisEvents.MOVE, { slug, uci });
    },
    [slug],
  );

  const emitReset = useCallback(
    (params?: { fen?: string; pgn?: string }) => {
      if (!slug) return;
      liveAnalysisSocket.emit(LiveAnalysisEvents.RESET, { slug, ...params });
    },
    [slug],
  );

  const emitClose = useCallback(() => {
    if (!slug) return;
    liveAnalysisSocket.emit(LiveAnalysisEvents.CLOSE, { slug });
  }, [slug]);

  const requestSync = useCallback(() => {
    if (!slug) return;
    liveAnalysisSocket.emit(LiveAnalysisEvents.SYNC_REQUEST, { slug });
  }, [slug]);

  const emitStatePatch = useCallback(
    (params: {
      // KS-3780: см. описание в типе UseLiveAnalysisSocketState.
      tree: string;
      currentGlobalIndex?: number;
      orientation?: 'white' | 'black';
    }) => {
      if (!slug) return;
      liveAnalysisSocket.emit(LiveAnalysisEvents.STATE_PATCH, {
        slug,
        ...params,
      });
    },
    [slug],
  );

  return {
    connected,
    snapshot,
    emitMove,
    emitReset,
    emitClose,
    requestSync,
    emitStatePatch,
  };
}
