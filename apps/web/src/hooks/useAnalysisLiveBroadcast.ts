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
 * KS-3763 / ADR-112 §4. Доменный хук «трансляция анализа» для
 * `AnalysisPage`. Связывает REST (`POST /live-analyses`,
 * `GET /live-analyses/by-analysis/:analysisId`) и сокет-обвязку
 * (`useLiveAnalysisSocket`) в один state-автомат.
 *
 * История изменений (важна для понимания инвариантов):
 *  - KS-3736 / ADR-110: первичная реализация. Slug кэшировался в
 *    браузерном хранилище, восстановление при mount шло по этому ключу.
 *  - KS-3754: обнаружен баг — кэшевое восстановление подцепляло slug
 *    на ЛЮБУЮ страницу анализа, и эффект отправки сливал PGN текущей
 *    (другой) страницы по чужому slug-у. Зрители видели «не ту партию».
 *  - KS-3763 / ADR-112: модель пересмотрена. Никакого браузерного
 *    кэша, одна active-трансляция на пару (`userId`, `analysisId`) —
 *    backend применяет partial-UNIQUE. Восстановление идёт через
 *    `GET /by-analysis/:id`: на странице анализа A это вернёт slug
 *    трансляции A (если она есть), на странице анализа B — slug
 *    трансляции B. Пересечения невозможны по определению.
 *
 * ### Контракт
 *
 *   const live = useAnalysisLiveBroadcast({
 *     analysisId, initialFen, orientation, title, userId,
 *   });
 *   live.isLive            // bool, для индикатора
 *   live.viewerCount       // number, счётчик зрителей
 *   live.publicUrl         // string | null, для кнопки «Скопировать»
 *   live.start(analysisId) // POST /live-analyses с analysisId
 *   live.stop()            // WS close
 *   live.emitMove(uci)     // мгновенный move
 *   live.emitStatePatch(p) // state-patch с debounce 500 мс (KS-3749)
 *
 * ### `emitMove` self-heal
 *
 * На каждый успешный `makeVariantMove` страница вызывает `emitMove(uci)`.
 * Хук эмитит `live-analysis:move`. Если сервер вернёт `illegal-move` —
 * у автора было переключение между линиями вариантов (currentFen не
 * «следующий» после серверного currentFen). Хук автоматически шлёт
 * `reset({ fen: currentFen })`, чтобы синхронизировать зрителей.
 */

export interface UseAnalysisLiveBroadcastArgs {
  /** Актуальная позиция автора (используется для start + reset-fallback). */
  currentFen: string;
  /** Стартовая позиция анализа (для `startingFen` в POST). */
  initialFen: string;
  /** Ориентация доски автора (передаётся серверу — зрители видят так же). */
  orientation: LiveAnalysisOrientation;
  /** Заголовок трансляции (можно использовать analysisTitle). */
  title?: string | null;
  /** ID текущего юзера или `null`. Без авторизации трансляцию запускать нельзя. */
  userId: string | null;
  /**
   * KS-3763 / ADR-112 §4. ID сохранённого анализа.
   *
   * Используется для двух вещей:
   *  1. REST-restore при mount: `GET /live-analyses/by-analysis/:id`.
   *     200 → подключаемся к найденному slug-у; 404 → idle.
   *  2. Аргумент `start()` (через push-через-callback аналогично).
   *
   * `null` для kind='review' / 'puzzle' / ad-hoc анализа без id —
   * тогда хук «спит» полностью: restore не делается, `start()` тоже
   * заблокирован (без analysisId сервер вернёт 400 после KS-3759).
   */
  analysisId: string | null;
  /**
   * KS-3770 / ADR-112: жёсткое отключение хука для viewer-режима.
   * AnalysisPage на `/live/:slug` запускается с `liveSession.mode='viewer'`
   * и одновременно вызывает `useLiveAnalysisBroadcast` (viewer-обвязка).
   * Этот же хук-стартёр (`useAnalysisLiveBroadcast` — owner-side) на
   * такой странице должен молчать: иначе у авторизованного владельца
   * REST-restore по analysisId найдёт его собственную активную
   * трансляцию, поднимет `isLive=true`, эффект эмита KS-3749 начнёт
   * слать обратно state-patch'и с PGN, собранным из state'а самой
   * `AnalysisPage` — а это уже зрительское состояние, не авторское.
   * Получаем feedback-цикл и зритель видит «старый PGN».
   *
   * Чтобы не выкручивать условные вызовы хуков (правила React),
   * передаём флаг и внутри гасим REST-restore + start.
   */
  disabled?: boolean;
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
  /**
   * Запустить трансляцию. `analysisId` обязателен — без него сервер
   * вернёт 400 (см. `CreateLiveAnalysisDto`). На странице с пропом
   * `analysisId === null` (kind='review'/'puzzle'/ad-hoc) start
   * вернёт `null` с error='no-analysis-id' без попытки POST.
   */
  start: (analysisId: string) => Promise<LiveAnalysisResponse | null>;
  /** Завершить трансляцию (WS close). */
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
    /**
     * KS-3775: уникальный сквозной индекс узла дерева анализа автора
     * (включая боковые варианты). Парсер `parseAnnotatedPgn`
     * присваивает его детерминированно, поэтому индекс одного и того
     * же узла у автора и у зрителя совпадает. Backend сохраняет его
     * как авторитативный и отдаёт в sync; зритель находит узел через
     * `searchInHistory(history, currentGlobalIndex)` — без поисков
     * по FEN, что устойчиво к транспозициям. Поля `currentPly` и
     * `headers` убраны из контракта (KS-3775 follow-up).
     */
    currentGlobalIndex?: number;
    orientation?: LiveAnalysisOrientation;
  }) => void;
}

/** KS-3749: debounce для emit state-patch, синхронизирован с серверным rate-limit. */
/**
 * KS-3776: задержка отправки полностью убрана. Прежняя
 * `STATE_PATCH_DEBOUNCE_MS` придумывалась как «защита от шквала», но
 * PGN-дерево пересобирается на коммит изменения (setComment по Enter
 * или blur, setNag, setArrow), а не на каждое нажатие клавиши —
 * реального шквала у автора не бывает, серверное ограничение частоты
 * 5/сек burst 10 в обычном сценарии не пробивается. Трансляция —
 * это «игра в игре», задержки между автором и зрителем быть не должно.
 */

export function useAnalysisLiveBroadcast({
  currentFen,
  initialFen,
  orientation,
  title,
  userId,
  analysisId,
  disabled = false,
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

  // ─── KS-3763 / ADR-112: REST-restore по analysisId ────────────────
  // На mount, на смену userId, на смену analysisId — спрашиваем backend
  // «есть ли активная трансляция этого анализа?». 200 → подключаемся;
  // 404 / нет analysisId / нет userId → idle. Никакого браузерного
  // кэша, никаких флагов «тихого восстановления»: backend сам
  // гарантирует партицию (userId, analysisId) → ровно одна
  // active-трансляция, и фронт получает её адресно. Пересечения
  // «slug чужого анализа на этой странице» невозможны.
  useEffect(() => {
    // KS-3770: на /live/:slug AnalysisPage запускает этот хук «вхолостую»
    // (mode='viewer'). REST-restore делать нельзя — для авторизованного
    // владельца это поднимет его же активную трансляцию и запустит
    // feedback-цикл с эмитом state-patch (см. описание в args выше).
    if (disabled) return;
    if (!analysisId || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.get<LiveAnalysisResponse>(
          `/live-analyses/by-analysis/${analysisId}`,
        );
        if (cancelled) return;
        if (resp.status !== 'active') {
          // По контракту 200 приходит только для active. Дополнительная
          // защита-проверка на случай нестандартного ответа сервера.
          return;
        }
        setSlug(resp.slug);
        setPublicUrl(resp.url);
        setViewerCount(resp.viewerCount);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          // 404 — нормальный idle-исход. Этот анализ не транслируется,
          // ничего не делаем; пользователь может запустить через start().
          return;
        }
        // Сетевые ошибки и прочее — молча, без кэшевого фолбэка
        // (KS-3754: фолбэк бы вернул баг с привязкой к чужой странице).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [analysisId, userId]);

  // ─── Сокет: подписка + обработчики ────────────────────────────────
  const handleViewers = useCallback((payload: LiveAnalysisViewersEvent) => {
    setViewerCount(payload.count);
  }, []);

  const handleClosed = useCallback((_payload: LiveAnalysisClosedEvent) => {
    // Сервер закрыл (inactivity / by_owner с другой вкладки). Чистим
    // локальный state — индикатор гаснет. Никакого storage больше нет.
    setSlug(null);
    setPublicUrl(null);
    setViewerCount(0);
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
      // Сервер не знает наш slug — трансляция исчезла.
      setSlug(null);
      setPublicUrl(null);
      setViewerCount(0);
      return;
    }
    // forbidden / rate-limit / invalid-payload / pgn-too-large — тост.
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
  // первичного subscribe) — сбрасываем ошибку, потому что подписка
  // живая и валидная.
  useEffect(() => {
    if (!snapshot) return;
    setError(null);
  }, [snapshot]);

  // ─── KS-3749/KS-3776: emitStatePatch для автора ──────────────────
  // Push-метод: AnalysisPage сам вычисляет PGN/currentGlobalIndex/
  // orientation (через useEffect на изменения review-state) и зовёт
  // `emitStatePatch(...)`. Хук отправляет мгновенно — без задержки
  // (KS-3776: трансляция — это «игра в игре», задержка между автором
  // и зрителем недопустима).
  //
  // Единственная защита от лишнего трафика — сравнение payload с
  // последним отправленным (через JSON-хеш). Идентичные сообщения
  // (та же позиция/индекс/ориентация) не уходят повторно — экономит
  // трафик и пропускную способность у зрителей.
  const lastSentSignatureRef = useRef<string | null>(null);
  const socketEmitStatePatchRef = useRef(socketEmitStatePatch);
  useEffect(() => {
    socketEmitStatePatchRef.current = socketEmitStatePatch;
  }, [socketEmitStatePatch]);

  // Сброс при смене трансляции (slug стал null или сменился) — иначе
  // при перезапуске первое сообщение могло бы быть отброшено как
  // «уже отправленное».
  useEffect(() => {
    lastSentSignatureRef.current = null;
  }, [slug]);

  const emitStatePatch = useCallback<
    UseAnalysisLiveBroadcastState['emitStatePatch']
  >(
    (params) => {
      if (!slug) return;
      if (!params.pgn) return;
      const signature = JSON.stringify({
        p: params.pgn,
        g: params.currentGlobalIndex ?? null,
        o: params.orientation ?? null,
      });
      if (signature === lastSentSignatureRef.current) return;
      socketEmitStatePatchRef.current(params);
      lastSentSignatureRef.current = signature;
    },
    [slug],
  );

  // ─── Действия ─────────────────────────────────────────────────────

  const start = useCallback(
    async (startAnalysisId: string): Promise<LiveAnalysisResponse | null> => {
      // KS-3770: на viewer-странице start() — no-op (см. описание disabled).
      if (disabled) return null;
      if (!userId) {
        setError('not-authenticated');
        return null;
      }
      if (!startAnalysisId) {
        // KS-3763 / ADR-112: без analysisId сервер вернёт 400. Заранее
        // отбиваем чтобы не делать заведомо неуспешный POST.
        setError('no-analysis-id');
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
          analysisId: startAnalysisId,
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
        return resp;
      } catch (e) {
        const msg =
          e instanceof ApiError ? e.message : 'failed-to-start-broadcast';
        setError(msg);
        return null;
      } finally {
        setIsStarting(false);
      }
    },
    [disabled, initialFen, orientation, slug, title, userId],
  );

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
