/**
 * KS-4024 / ADR-122 §3.1, §3.4. Оркестратор аналитики позиционных метрик
 * партии.
 *
 * Поведение:
 *   1. На mount → GET с серверной версией → если 200, кладём в кеш
 *      IndexedDB со статусом `synced` и отдаём как `data`.
 *   2. Если 404 → проверяем локальный кеш. Если есть — отдаём, при
 *      статусе `pending_upload` запускаем фоновый POST-ретрай.
 *   3. Если кеша нет → ждём, пока caller вызовет `start(moves)` —
 *      хук запускает расчёт ply за ply через `collectAiFactors`,
 *      сохраняет чекпоинт в IndexedDB каждые 10 ply и шлёт
 *      broadcast-сообщение другим вкладкам.
 *   4. По завершении расчёта POST на сервер; при сетевой ошибке
 *      статус локально — `pending_upload`.
 *
 * BroadcastChannel `kingside:positional-trace:<analysisId>` синхронизирует
 * прогресс между вкладками. Если другая вкладка уже считает — мы
 * подписываемся на её чекпоинты вместо параллельного дубль-расчёта
 * (он бы дал тот же результат, но WASM-нагрузка удвоилась бы).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  POSITIONAL_TRACE_VERSION,
  type AnalysisPositionalTraceDto,
  type PositionalSubterm,
  type PositionalTracePly,
} from '@kingside/shared';
import { ApiError } from '../ApiError';
import {
  getPositionalTrace,
  postPositionalTrace,
} from '../api/positionalTrace';
import {
  loadLocalTrace,
  saveLocalTrace,
  sweepExpiredTraces,
  type PositionalTraceLocalRecord,
  type PositionalTraceLocalStatus,
} from '../lib/review/positionalTraceStore';
import { evalTrace } from '../lib/review/stockfishTrace';

/** ADR-122 §3.4: чекпоинт в IndexedDB каждые 10 ply. */
const CHECKPOINT_EVERY_N_PLIES = 10;

export type UsePositionalTraceStatus =
  | 'idle'
  | 'loading-server'
  | 'computing'
  | 'computed'
  | 'syncing'
  | 'synced'
  | 'error';

export interface UsePositionalTraceState {
  status: UsePositionalTraceStatus;
  /** Готовая трасса для отрисовки графиков. `null` пока нет данных. */
  data: AnalysisPositionalTraceDto | null;
  /**
   * KS-4025: `true`, если хук «спит» из-за отсутствия `analysisId` —
   * UI показывает заглушку «Сделайте хотя бы один ход» / «Сохраните
   * анализ перед расчётом».
   */
  idle: boolean;
  /** Сколько ply посчитано (для прогресса). */
  computedPlies: number;
  /** Сколько ply должно быть посчитано всего. */
  totalPlies: number;
  /** Источник данных (`'server'` / `'idb'` / `'computed'` / `null`). */
  source: 'server' | 'idb' | 'computed' | null;
  /** Текст последней ошибки для UI; null если ошибок нет. */
  error: string | null;
  /**
   * Запустить расчёт по списку UCI-ходов партии. Если расчёт уже идёт
   * или данные уже есть — no-op.
   */
  start: (uciMoves: ReadonlyArray<string>) => void;
  /** Отменить текущий расчёт. */
  cancel: () => void;
  /**
   * Стереть локальный кеш и перезапустить (например, после
   * `DELETE /games/:id/positional-trace` от админа).
   */
  resetLocal: () => Promise<void>;
}

interface UsePositionalTraceArgs {
  /** UUID анализа. Если `null` — хук «спит». */
  analysisId: string | null | undefined;
  /**
   * Активен ли расчёт. По умолчанию `true`. Если `false` — хук всё
   * равно подгрузит уже посчитанные данные с сервера/из IndexedDB, но
   * не будет инициировать расчёт.
   */
  enabled?: boolean;
}

interface BroadcastMessage {
  type: 'checkpoint' | 'completed' | 'cancelled';
  analysisId: string;
  sfVersion: string;
  record?: PositionalTraceLocalRecord;
}

function getBroadcastChannelName(analysisId: string): string {
  return `kingside:positional-trace:${analysisId}`;
}

function recordToDto(rec: PositionalTraceLocalRecord): AnalysisPositionalTraceDto {
  return {
    analysisId: rec.analysisId,
    sfVersion: rec.sfVersion,
    plies: rec.plies,
    durationMs: rec.durationMs,
    createdAt: rec.updatedAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * Конвертировать `PositionalSubterm[]` от `evalTrace` в формат
 * `PositionalTracePly.subterms` (это тот же тип, без преобразований).
 */
function pliesToRecord(args: {
  analysisId: string;
  sfVersion: string;
  plies: PositionalTracePly[];
  totalPlies: number;
  status: PositionalTraceLocalStatus;
  durationMs: number;
}): PositionalTraceLocalRecord {
  return {
    key: `${args.analysisId}:${args.sfVersion}`,
    analysisId: args.analysisId,
    sfVersion: args.sfVersion,
    plies: args.plies,
    totalPlies: args.totalPlies,
    computedPlies: args.plies.length,
    status: args.status,
    durationMs: args.durationMs,
    updatedAt: new Date().toISOString(),
  };
}

export function usePositionalTrace({
  analysisId,
  enabled = true,
}: UsePositionalTraceArgs): UsePositionalTraceState {
  const [status, setStatus] = useState<UsePositionalTraceStatus>('idle');
  const [data, setData] = useState<AnalysisPositionalTraceDto | null>(null);
  const [computedPlies, setComputedPlies] = useState(0);
  const [totalPlies, setTotalPlies] = useState(0);
  const [source, setSource] = useState<'server' | 'idb' | 'computed' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  // ── BroadcastChannel — открываем один раз на analysisId ─────────────────
  useEffect(() => {
    if (!analysisId || typeof BroadcastChannel === 'undefined') {
      broadcastRef.current = null;
      return;
    }
    const ch = new BroadcastChannel(getBroadcastChannelName(analysisId));
    broadcastRef.current = ch;
    ch.onmessage = (ev: MessageEvent<BroadcastMessage>) => {
      const msg = ev.data;
      if (!msg || msg.analysisId !== analysisId) return;
      if (msg.sfVersion !== POSITIONAL_TRACE_VERSION) return;
      if (!msg.record) return;
      // Другая вкладка прислала свежий чекпоинт — используем его, наш
      // локальный расчёт можем отменить.
      setData(recordToDto(msg.record));
      setComputedPlies(msg.record.computedPlies);
      setTotalPlies(msg.record.totalPlies);
      setSource('idb');
      if (msg.type === 'completed') {
        setStatus(msg.record.status === 'synced' ? 'synced' : 'computed');
        cancelRef.current = true;
      } else if (msg.type === 'checkpoint') {
        setStatus('computing');
      }
    };
    return () => {
      ch.close();
      broadcastRef.current = null;
    };
  }, [analysisId]);

  // ── Запуск чтения сервер → IDB при mount/смене analysisId ──────────────
  useEffect(() => {
    if (!analysisId) {
      setStatus('idle');
      setData(null);
      setComputedPlies(0);
      setTotalPlies(0);
      setSource(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus('loading-server');
    setError(null);
    (async () => {
      // Лучший случай: данные на сервере.
      try {
        const fromServer = await getPositionalTrace(
          analysisId,
          POSITIONAL_TRACE_VERSION,
        );
        if (cancelled) return;
        if (fromServer) {
          setData(fromServer);
          setComputedPlies(fromServer.plies.length);
          setTotalPlies(fromServer.plies.length);
          setSource('server');
          setStatus('synced');
          // Подкладываем в IndexedDB на следующий открытий.
          void saveLocalTrace(
            pliesToRecord({
              analysisId,
              sfVersion: fromServer.sfVersion,
              plies: fromServer.plies,
              totalPlies: fromServer.plies.length,
              status: 'synced',
              durationMs: fromServer.durationMs ?? 0,
            }),
          );
          return;
        }
      } catch (err) {
        // 5xx/сеть — отметим, но попробуем IDB.
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? `Сервер вернул ошибку: ${err.status}`
            : String(err),
        );
      }
      // Сервер 404 / упал — пробуем локальный кеш.
      const local = await loadLocalTrace(analysisId, POSITIONAL_TRACE_VERSION);
      if (cancelled) return;
      if (local) {
        setData(recordToDto(local));
        setComputedPlies(local.computedPlies);
        setTotalPlies(local.totalPlies);
        setSource('idb');
        if (local.status === 'synced') {
          setStatus('synced');
        } else if (local.status === 'pending_upload') {
          setStatus('computed');
          // Фоновый ретрай на следующий tick.
          void retryUpload(analysisId, local);
        } else if (local.status === 'computed_locally') {
          setStatus('computed');
        } else {
          setStatus('computing');
        }
        return;
      }
      setStatus('idle');
    })();
    // Фоновый «уборщик» — раз в сессию.
    void sweepExpiredTraces();
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  /** Ретрай отправки данных на сервер с обновлением статуса локально. */
  const retryUpload = useCallback(
    async (
      gid: string,
      local: PositionalTraceLocalRecord,
    ): Promise<void> => {
      try {
        setStatus('syncing');
        const dto = await postPositionalTrace(gid, {
          sfVersion: local.sfVersion,
          plies: local.plies,
          durationMs: local.durationMs,
        });
        setData(dto);
        setStatus('synced');
        setSource('server');
        void saveLocalTrace({
          ...local,
          status: 'synced',
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Сетевой сбой — оставляем `pending_upload`, попробуем в
        // следующий заход.
        setStatus('computed');
      }
    },
    [],
  );

  const start = useCallback(
    (uciMoves: ReadonlyArray<string>) => {
      if (!analysisId || !enabled) return;
      if (runningRef.current) return;
      if (status === 'synced' || status === 'computed') return;
      if (totalPlies > 0 && computedPlies >= totalPlies) return;

      runningRef.current = true;
      cancelRef.current = false;
      setStatus('computing');
      setError(null);
      const startedAt = Date.now();
      const total = uciMoves.length + 1; // +1 для стартовой позиции (ply=0)
      setTotalPlies(total);

      (async () => {
        try {
          const chess = new Chess();
          const collected: PositionalTracePly[] = [];

          // ply=0 — стартовая позиция.
          const startSubterms = await evalTrace(chess.fen());
          if (cancelRef.current) return;
          collected.push({ ply: 0, subterms: startSubterms });
          setComputedPlies(collected.length);

          for (let i = 0; i < uciMoves.length; i += 1) {
            if (cancelRef.current) return;
            const uci = uciMoves[i];
            const from = uci.slice(0, 2);
            const to = uci.slice(2, 4);
            const promotion = uci.length === 5 ? uci[4] : undefined;
            try {
              chess.move({ from, to, promotion });
            } catch {
              // Нелегальный ход — останавливаем расчёт и сохраняем
              // что собрали.
              break;
            }
            const subterms: PositionalSubterm[] = await evalTrace(chess.fen());
            if (cancelRef.current) return;
            collected.push({ ply: i + 1, subterms });
            setComputedPlies(collected.length);

            if (
              collected.length % CHECKPOINT_EVERY_N_PLIES === 0 ||
              collected.length === total
            ) {
              const rec = pliesToRecord({
                analysisId,
                sfVersion: POSITIONAL_TRACE_VERSION,
                plies: collected,
                totalPlies: total,
                status:
                  collected.length === total
                    ? 'computed_locally'
                    : 'in_progress',
                durationMs: Date.now() - startedAt,
              });
              await saveLocalTrace(rec);
              broadcastRef.current?.postMessage({
                type:
                  collected.length === total ? 'completed' : 'checkpoint',
                analysisId,
                sfVersion: POSITIONAL_TRACE_VERSION,
                record: rec,
              } as BroadcastMessage);
            }
          }

          if (cancelRef.current) return;

          // Финальный snapshot.
          const finalRec = pliesToRecord({
            analysisId,
            sfVersion: POSITIONAL_TRACE_VERSION,
            plies: collected,
            totalPlies: total,
            status: 'computed_locally',
            durationMs: Date.now() - startedAt,
          });
          await saveLocalTrace(finalRec);
          setData(recordToDto(finalRec));
          setSource('computed');
          setStatus('computed');

          // Шлём на сервер.
          try {
            setStatus('syncing');
            const dto = await postPositionalTrace(analysisId, {
              sfVersion: POSITIONAL_TRACE_VERSION,
              plies: collected,
              durationMs: Date.now() - startedAt,
            });
            setData(dto);
            setStatus('synced');
            setSource('server');
            await saveLocalTrace({
              ...finalRec,
              status: 'synced',
              updatedAt: new Date().toISOString(),
            });
          } catch {
            setStatus('computed');
            await saveLocalTrace({
              ...finalRec,
              status: 'pending_upload',
            });
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        } finally {
          runningRef.current = false;
        }
      })();
    },
    [computedPlies, enabled, analysisId, status, totalPlies],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
    runningRef.current = false;
    setStatus((prev) => (prev === 'computing' ? 'idle' : prev));
  }, []);

  const resetLocal = useCallback(async () => {
    if (!analysisId) return;
    cancelRef.current = true;
    runningRef.current = false;
    setStatus('idle');
    setData(null);
    setComputedPlies(0);
    setTotalPlies(0);
    setSource(null);
    setError(null);
    // Импорт удалён интенсивно (см. позже), используем синхронный
    // вызов через хранилище.
    const { deleteLocalTrace } = await import(
      '../lib/review/positionalTraceStore'
    );
    await deleteLocalTrace(analysisId, POSITIONAL_TRACE_VERSION);
  }, [analysisId]);

  return useMemo(
    () => ({
      status,
      data,
      // KS-4025: idle=true когда analysisId не задан (например, новый
      // анализ ещё не сохранён). UI показывает заглушку.
      idle: !analysisId,
      computedPlies,
      totalPlies,
      source,
      error,
      start,
      cancel,
      resetLocal,
    }),
    [
      analysisId,
      status,
      data,
      computedPlies,
      totalPlies,
      source,
      error,
      start,
      cancel,
      resetLocal,
    ],
  );
}
