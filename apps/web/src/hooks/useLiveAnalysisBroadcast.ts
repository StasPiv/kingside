import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LiveAnalysisAnalysisSwitchEvent,
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
  /**
   * KS-3780. Сериализованное дерево анализа автора (см.
   * `serializeLiveTree`/`deserializeLiveTree`). Содержимое
   * непрозрачно для хука — потребитель сам разбирает строку
   * через `deserializeLiveTree` и применяет к review-state.
   * `null` пока не пришёл первый sync.
   *
   * Поле заменило прежний `pgn` — теперь у зрителя нет
   * парсинга PGN-строки и переиндексации globalIndex, узлы
   * получают индексы автора напрямую из дерева.
   */
  tree: string | null;
  /**
   * KS-3775. Уникальный сквозной индекс узла дерева автора
   * (включая боковые варианты). Берётся из `sync.currentGlobalIndex`,
   * куда backend пишет значение `state-patch.currentGlobalIndex`.
   * Используется зрителем для прямого поиска узла через
   * `searchInHistory(history, currentGlobalIndex)` — без проблем
   * транспозиций (когда несколько узлов имеют одинаковый FEN).
   * `null` пока не пришёл первый sync.
   *
   * Поля `currentFen`, `currentPly`, `headers` убраны из контракта
   * (KS-3775 follow-up). Эти данные выводятся из самого PGN /
   * найденного узла по globalIndex.
   */
  currentGlobalIndex: number | null;
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
   * KS-4628 / ADR-142 §2.4. UUID активного `Analysis` (после switch'а
   * или из исходного `LiveAnalysis.analysisId`). Берётся из
   * `LiveAnalysisSyncSnapshot.activeAnalysisId`. `null` пока не пришёл
   * sync ИЛИ если backend не передал это поле (трансляция без
   * привязки к Analysis, тренер ещё не делал switch).
   */
  activeAnalysisId: string | null;
  /**
   * KS-4628 / ADR-142 §2.4. Заголовок активного окна — для UI
   * («Сейчас в эфире: <title>»). Берётся из `LiveAnalysisSyncSnapshot.activeTitle`.
   * `null` если backend не передал.
   */
  activeTitle: string | null;
  /**
   * KS-4629 / ADR-142 §2.7. Последнее событие смены активного окна
   * (или `null`, если switch'а ещё не было в текущей сессии). Содержит
   * полный payload broadcast'а: title, startingFen, orientation, tree,
   * currentGlobalIndex. Каждое новое событие — новая ссылка, чтобы
   * `useEffect`-консьюмер мог реагировать на каждый switch (даже если
   * activeAnalysisId не изменился — теоретически можно «переключиться
   * на то же окно с другого момента»).
   */
  lastAnalysisSwitch: LiveAnalysisAnalysisSwitchEvent | null;
  /**
   * Эмит `state-patch` с дебаунсом 500 мс (trailing-edge). Внутри
   * запоминается последний `tree`/`currentGlobalIndex`/`orientation`,
   * и таймер сбрасывается. По истечению дебаунса уходит ровно один
   * патч. Без аргумента `tree` ничего не отправляется — это безопасный
   * no-op. Owner-only.
   */
  emitStatePatch: (
    tree: string,
    extras?: {
      currentGlobalIndex?: number;
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
  // KS-3780: вместо PGN-строки храним сериализованное JSON-дерево
  // автора. Содержимое непрозрачно для хука — потребитель сам
  // разбирает через `deserializeLiveTree`.
  const [tree, setTree] = useState<string | null>(null);
  // KS-3775: уникальный индекс узла дерева автора (см. описание поля
  // в `UseLiveAnalysisBroadcastState`).
  const [currentGlobalIndex, setCurrentGlobalIndex] =
    useState<number | null>(null);
  const [orientation, setOrientation] =
    useState<LiveAnalysisOrientation>('white');
  const [viewerCount, setViewerCount] = useState(0);
  const [error, setError] = useState<LiveAnalysisErrorEvent | null>(null);
  const [closed, setClosed] = useState<LiveAnalysisCloseReason | null>(null);
  // KS-4628 / ADR-142 §2.4: активное окно анализа (после switch'а).
  const [activeAnalysisId, setActiveAnalysisId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  // KS-4629 / ADR-142 §2.7: последнее событие смены окна — для
  // потребителя (toast + сброс review-state).
  const [lastAnalysisSwitch, setLastAnalysisSwitch] =
    useState<LiveAnalysisAnalysisSwitchEvent | null>(null);

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
      // KS-3780: backend хранит дерево как непрозрачную строку и
      // отдаёт обратно в `tree`. До первого state-patch поле может
      // отсутствовать (трансляция только что создана и автор ещё
      // ничего не правил) — оставляем null, потребитель покажет
      // пустое дерево из startingFen.
      if (typeof payload.tree === 'string') {
        setTree(payload.tree);
      } else {
        setTree(null);
      }
      // KS-3775: backend сохраняет state-patch.currentGlobalIndex в
      // Redis и отдаёт его в snapshot. Поле опциональное — для старых
      // трансляций (до KS-3775) приходит undefined, viewer оставляет
      // курсор у себя без сдвига на позицию автора.
      setCurrentGlobalIndex(
        typeof payload.currentGlobalIndex === 'number'
          ? payload.currentGlobalIndex
          : null,
      );
      setOrientation(payload.orientation);
      // KS-4628 / ADR-142 §2.4: активное окно. Backend пишет в sync
      // snapshot, как только в Redis state hash появилось поле
      // `activeAnalysisId`. Если поле опущено — значит трансляция без
      // привязки к Analysis (тренер ещё не делал switch); оставляем
      // прежнее значение (snapshot не должен сбрасывать активное окно
      // только потому, что backend не прислал поле).
      if (typeof payload.activeAnalysisId !== 'undefined') {
        setActiveAnalysisId(payload.activeAnalysisId ?? null);
      }
      if (typeof payload.activeTitle === 'string') {
        setActiveTitle(payload.activeTitle);
      }
      // На приход sync сбрасываем последнюю ошибку — текущее состояние
      // снова консистентно с сервером.
      setError(null);
    }, []),
    onMove: useCallback((_payload: LiveAnalysisMoveEvent) => {
      // KS-3775 follow-up: `move`-event теперь не двигает локального
      // курсора зрителя — позицию автора отражает только следующий
      // `state-patch` с currentGlobalIndex. Между move и state-patch
      // (debounce 500 мс у автора) зритель видит прежнюю позицию
      // дерева. Это компромисс контракта; альтернатива — слать
      // globalIndex в move-event тоже — потребует расширения
      // payload-а и не покрывает кейс «автор листает без хода».
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
    // KS-4629 / ADR-142 §2.7. Тренер переключил активное окно.
    // Применяем все поля payload в наш state — потребитель (AnalysisPage)
    // через `lastAnalysisSwitch` получает сигнал «сбрось локальное дерево
    // и покажи toast». Полный sync snapshot с теми же полями прилетит
    // следом (backend публикует и `analysis-switch`, и `sync`), но
    // обработать оба идемпотентно ничего не стоит — повторная установка
    // того же tree/orientation/index — no-op.
    onAnalysisSwitch: useCallback(
      (payload: LiveAnalysisAnalysisSwitchEvent) => {
        setTree(payload.tree);
        setCurrentGlobalIndex(
          typeof payload.currentGlobalIndex === 'number'
            ? payload.currentGlobalIndex
            : null,
        );
        setOrientation(payload.orientation);
        setActiveAnalysisId(payload.analysisId);
        setActiveTitle(payload.title);
        setLastAnalysisSwitch(payload);
      },
      [],
    ),
  });

  // KS-4629 / ADR-142 §2.7. При смене slug — сбрасываем последний
  // switch-event, чтобы потребитель не реагировал на switch из старой
  // трансляции при переходе на новую (например, /live/A → /live/B).
  useEffect(() => {
    setLastAnalysisSwitch(null);
    setActiveAnalysisId(null);
    setActiveTitle(null);
  }, [slug]);

  // ─── Дебаунс state-patch (owner-only) ─────────────────────────────
  // Trailing-edge debounce: сохраняем последний payload, сбрасываем
  // таймер при каждом новом вызове, через `statePatchDebounceMs` мс
  // отправляем то, что лежит в pending. Это минимизирует трафик и
  // совпадает с серверным rate-limit'ом (ADR-111 §2.4).
  type PendingPatch = {
    tree: string;
    currentGlobalIndex?: number;
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
    (nextTree, extras) => {
      if (!isOwner) return;
      if (!nextTree) return;
      pendingRef.current = {
        tree: nextTree,
        currentGlobalIndex: extras?.currentGlobalIndex,
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
      tree,
      currentGlobalIndex,
      orientation,
      viewerCount,
      connected,
      error,
      closed,
      activeAnalysisId,
      activeTitle,
      lastAnalysisSwitch,
      emitStatePatch,
      emitMove,
      emitReset,
      emitClose,
    }),
    [
      tree,
      currentGlobalIndex,
      orientation,
      viewerCount,
      connected,
      error,
      closed,
      activeAnalysisId,
      activeTitle,
      lastAnalysisSwitch,
      emitStatePatch,
      emitMove,
      emitReset,
      emitClose,
    ],
  );
}
