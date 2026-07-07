import { useEffect, useRef, useState } from 'react';
import type { BroadcastGameSummary } from '@kingside/shared';
import { parsePgnGames } from '@kingside/shared';
import {
  LICHESS_BROADCAST_STREAM_BASE,
  isBroadcastDirectStreamEnabled,
} from '../config/broadcastDirectStream';

/**
 * KS-4856 / ADR-159 §2.2 + §2.4 + §3.2.
 *
 * Хук открывает fetch-стрим PGN трансляции напрямую с Lichess
 * (`https://lichess.org/api/stream/broadcast/round/{roundId}.pgn`),
 * читает нарастающий контент через `ReadableStream`, парсит и
 * возвращает свежий снимок `games[]`. При отказе — уходит в
 * fallback-режим, страница продолжает работать через WS+REST.
 *
 * Парсинг PGN — общая логика из `@kingside/shared/broadcast-pgn`
 * (KS-4855 / ADR-159 §7 п.1). Тот же код работает и на backend'е —
 * поведение fen/uci/clocks/lichessGameId одинаковое.
 *
 * Статусы (§2.4):
 *  - `idle`       — не активен (флаг выключен, нет `lichessRoundId`,
 *                   раунд не ongoing, вкладка в фоне).
 *  - `connecting` — открыли `fetch`, ждём первый chunk.
 *  - `streaming`  — получили ≥1 валидный chunk; UI-плашки не показываем.
 *  - `fallback`   — 5 неудачных попыток подряд; полагаемся на WS.
 *
 * Retry (§2.2): 2s → 5s → 15s → 30s → 60s (потолок). Счётчик обнуляется
 * после первого валидного chunk'а. После 5 неуспешных попыток подряд —
 * `status='fallback'`, родитель показывает «Обновления замедлены».
 *
 * Visibility (§2.2): при `document.visibilityState === 'hidden'`
 * закрываем `fetch` (экономим слот из 8 у клиентского IP). При
 * возврате — переоткрываем.
 */

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const MAX_FAILURES_BEFORE_FALLBACK = 5;

export type LichessPgnStreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'fallback';

export interface LichessPgnStreamState {
  /**
   * Свежий снимок партий раунда, распарсенный из последнего chunk'а
   * потока. `null`, пока не пришёл хотя бы один валидный chunk —
   * родитель в это время показывает данные из REST-снимка.
   */
  games: BroadcastGameSummary[] | null;
  status: LichessPgnStreamStatus;
  /** Число последовательных неудачных попыток. */
  failureCount: number;
  /** Сообщение последней ошибки — для диагностики (в UI не показываем). */
  error: string | null;
}

export interface UseLichessPgnStreamArgs {
  /**
   * Идентификатор раунда на Lichess
   * (`BroadcastRound.lichessRoundId` из БД, отдаётся API после
   * KS-4855). `null` / `undefined` → хук ничего не делает.
   */
  lichessRoundId: string | null | undefined;
  /**
   * Дополнительный enable-flag от родителя (обычно
   * `round.status === 'ongoing'`). Хук также проверяет глобальный
   * фиче-флаг `VITE_BROADCAST_DIRECT_STREAM_ENABLED` — если он
   * выключен, поток не открываем даже при `enabled=true`.
   */
  enabled: boolean;
}

export function useLichessPgnStream({
  lichessRoundId,
  enabled,
}: UseLichessPgnStreamArgs): LichessPgnStreamState {
  const [state, setState] = useState<LichessPgnStreamState>({
    games: null,
    status: 'idle',
    failureCount: 0,
    error: null,
  });

  // Держим последнее актуальное значение `state.failureCount` в ref,
  // чтобы не пересоздавать stream-effect при каждом инкременте счётчика.
  const failureCountRef = useRef(0);
  useEffect(() => {
    failureCountRef.current = state.failureCount;
  }, [state.failureCount]);

  useEffect(() => {
    const flagOn = isBroadcastDirectStreamEnabled();
    if (!flagOn || !enabled || !lichessRoundId) {
      setState({ games: null, status: 'idle', failureCount: 0, error: null });
      failureCountRef.current = 0;
      return;
    }

    let cancelled = false;
    let abortController: AbortController | null = null;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const openStream = async () => {
      if (cancelled) return;
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      abortController = new AbortController();
      setState((s) => ({ ...s, status: 'connecting', error: null }));
      const url = `${LICHESS_BROADCAST_STREAM_BASE}/${encodeURIComponent(lichessRoundId)}.pgn`;
      let response: Response;
      try {
        response = await fetch(url, { signal: abortController.signal });
      } catch (err) {
        if (cancelled || abortController.signal.aborted) return;
        scheduleRetry(err instanceof Error ? err.message : 'fetch failed');
        return;
      }
      if (!response.ok || !response.body) {
        scheduleRetry(`HTTP ${response.status}`);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (cancelled || abortController.signal.aborted) return;
          if (done) {
            scheduleRetry('stream closed');
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const games = parseLichessBroadcastPgn(chunk);
            if (!games.length) continue;
            failureCountRef.current = 0;
            setState({
              games,
              status: 'streaming',
              failureCount: 0,
              error: null,
            });
          }
        }
      } catch (err) {
        if (cancelled || abortController.signal.aborted) return;
        scheduleRetry(err instanceof Error ? err.message : 'read failed');
      }
    };

    const scheduleRetry = (errorMessage: string) => {
      if (cancelled) return;
      const nextFailure = failureCountRef.current + 1;
      failureCountRef.current = nextFailure;
      const status: LichessPgnStreamStatus =
        nextFailure >= MAX_FAILURES_BEFORE_FALLBACK ? 'fallback' : 'connecting';
      setState((s) => ({
        ...s,
        status,
        failureCount: nextFailure,
        error: errorMessage,
      }));
      const delay =
        BACKOFF_MS[Math.min(nextFailure - 1, BACKOFF_MS.length - 1)];
      retryTimeoutId = setTimeout(() => {
        retryTimeoutId = null;
        void openStream();
      }, delay);
    };

    const handleVisibility = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') {
        abortController?.abort();
        if (retryTimeoutId) {
          clearTimeout(retryTimeoutId);
          retryTimeoutId = null;
        }
      } else if (document.visibilityState === 'visible') {
        failureCountRef.current = 0;
        void openStream();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }
    void openStream();

    return () => {
      cancelled = true;
      abortController?.abort();
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [lichessRoundId, enabled]);

  return state;
}

/**
 * Обёртка над общим `parsePgnGames` из `@kingside/shared/broadcast-pgn`.
 * Мапит `ParsedGame → BroadcastGameSummary` под контракт REST-ответа
 * `/broadcasts/:id/rounds/:roundId/games` — родительский компонент
 * получает те же поля, что и от REST, и может мерджить один-в-один
 * через `mergeStreamedGames`.
 *
 * Поля, которых Lichess не отдаёт в PGN:
 *  - `bracketStage`, `bracketPairId`, `matchScore` → `null` (клиент
 *    сохранит серверные значения при merge, §3.2 п.2);
 *  - `updatedAt` → эпоха (сервер даёт реальное значение при merge);
 *  - `lastMoveAt` → `null` (Lichess не даёт wall-clock последнего хода
 *    в PGN; frontend будет опираться на серверный `lastMoveAt`);
 *  - `clockUpdatedAt` → `new Date().toISOString()` в момент парсинга,
 *    только если у партии реально есть `whiteClockMs` или
 *    `blackClockMs`. Клоки без времени применения бесполезны.
 *  - `id` — оставляем `lichessGameId`; серверный UUID (`BroadcastGame.id`)
 *    подтягивается при merge для полной совместимости с REST-путём
 *    (deep-link в `/analysis/...`).
 */
export function parseLichessBroadcastPgn(
  raw: string,
): BroadcastGameSummary[] {
  if (!raw.trim()) return [];
  const parsed = parsePgnGames(raw);
  const nowIso = new Date().toISOString();
  const summaries: BroadcastGameSummary[] = [];
  for (const p of parsed) {
    const hasClocks = p.whiteClockMs !== null || p.blackClockMs !== null;
    summaries.push({
      id: p.lichessGameId ?? '',
      lichessGameId: p.lichessGameId,
      whitePlayer: p.white,
      blackPlayer: p.black,
      whiteElo: p.whiteElo,
      blackElo: p.blackElo,
      result: p.result && p.result !== '*' ? p.result : (p.result ?? null),
      pgn: p.pgn,
      currentFen: p.fen,
      updatedAt: new Date(0).toISOString(),
      bracketStage: null,
      bracketPairId: null,
      matchScore: null,
      whiteClockMs: p.whiteClockMs,
      blackClockMs: p.blackClockMs,
      clockUpdatedAt: hasClocks ? nowIso : null,
      lastMoveAt: null,
    });
  }
  return summaries;
}
