import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { BroadcastGameSummary } from '@kingside/shared';
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
 * Статусы (§2.4):
 *  - `idle`       — не активен (флаг выключен, нет `lichessRoundId`,
 *                   раунд не ongoing, вкладка в фоне).
 *  - `connecting` — открыли `fetch`, ждём первый chunk.
 *  - `streaming`  — получили ≥1 валидный chunk; UI-плашки не показываем.
 *  - `fallback`   — 5 неудачных попыток подряд; полагаемся на WS.
 *  - `offline`    — ни direct-stream, ни WS не отвечают (устанавливается
 *                   родителем на основе `connected` из useBroadcastSocket).
 *
 * Retry (§2.2): 2s → 5s → 15s → 30s → 60s (потолок). Счётчик обнуляется
 * после первого валидного chunk'а. После 5 неуспешных попыток подряд —
 * `status='fallback'`, родитель показывает «Обновления замедлены».
 *
 * Visibility (§2.2): при `document.visibilityState === 'hidden'`
 * закрываем `fetch` (экономим слот из 8 у клиентского IP). При
 * возврате — переоткрываем.
 *
 * Общий PGN-парсер вынесен в `packages/shared/pgn-stream/` в рамках
 * KS-4855 (ADR-159 §7 п.1). До закрытия зависимости используем локальный
 * MVP-парсер: header по regex + chess.js для `currentFen` + `%clk` для
 * часов. После KS-4855 импорт заменится одной строкой, поведение
 * останется тем же — chess.js на клиенте и на backend'е даёт
 * одинаковые `fen`/`san` для валидного PGN.
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
   * родитель в это время должен показывать данные из REST-снимка.
   */
  games: BroadcastGameSummary[] | null;
  status: LichessPgnStreamStatus;
  /** Число последовательных неудачных попыток. Обнуляется после первого валидного chunk'а. */
  failureCount: number;
  /** Сообщение последней ошибки — только для диагностики (в UI не показываем). */
  error: string | null;
}

export interface UseLichessPgnStreamArgs {
  /**
   * Идентификатор раунда на Lichess (`BroadcastRound.lichessRoundId`
   * из БД, отдаётся API после KS-4855). Если `null` / `undefined` —
   * хук ничего не делает.
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
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // Пока в фоне — не открываем; visibilitychange восстановит.
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
            // Стрим закрылся штатно (раунд завершён). Не считаем
            // ошибкой, но всё же попробуем переоткрыть — Lichess
            // может отдавать пустой финальный chunk и сразу
            // закрывать соединение при отсутствии дальнейших
            // обновлений. Backoff мягкий.
            scheduleRetry('stream closed');
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          // Разделитель между кумулятивными снимками PGN — `\n\n\n`.
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
        // Уходим со сцены — закрываем поток. Retry-таймер тоже
        // отменяем, при возвращении откроем чистый.
        abortController?.abort();
        if (retryTimeoutId) {
          clearTimeout(retryTimeoutId);
          retryTimeoutId = null;
        }
      } else if (document.visibilityState === 'visible') {
        // Пришли обратно — сбрасываем счётчик неудач (новая сессия)
        // и открываем заново.
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
 * MVP-парсер PGN, отдаваемого Lichess в `/api/stream/broadcast/round/*.pgn`.
 *
 * Возвращает частично заполненный `BroadcastGameSummary[]`. Поля, которых
 * Lichess не отдаёт в PGN (`bracketStage`, `bracketPairId`, `matchScore`,
 * `updatedAt`), выставляются в `null` — родитель мержит их с серверным
 * снимком по `lichessGameId` (ADR-159 §3.2 п.2 стратегия слияния).
 *
 * После закрытия KS-4855 замещается импортом из общего пакета — интерфейс
 * возвращаемого значения совпадает по контракту.
 */
export function parseLichessBroadcastPgn(
  raw: string,
): BroadcastGameSummary[] {
  if (!raw.trim()) return [];
  // Каждая партия начинается с header-блока. Разделитель между партиями
  // Lichess ставит либо `\n\n\n` (снятый выше на уровне chunk'а), либо
  // пустая строка между PGN'ами внутри одного chunk'а — считаем что chunk
  // может содержать одну или несколько партий, разделим по границе
  // `\n\n[Event ` (начало нового header'а).
  const parts = raw
    .split(/\n\n(?=\[Event )/)
    .map((s) => s.trim())
    .filter(Boolean);
  const games: BroadcastGameSummary[] = [];
  for (const part of parts) {
    const game = parseSingleGamePgn(part);
    if (game) games.push(game);
  }
  return games;
}

function parseSingleGamePgn(pgn: string): BroadcastGameSummary | null {
  const whitePlayer = extractHeader(pgn, 'White');
  const blackPlayer = extractHeader(pgn, 'Black');
  const whiteEloRaw = extractHeader(pgn, 'WhiteElo');
  const blackEloRaw = extractHeader(pgn, 'BlackElo');
  const resultRaw = extractHeader(pgn, 'Result');
  const gameId = extractHeader(pgn, 'GameId') ?? extractHeader(pgn, 'LichessId');
  if (!whitePlayer && !blackPlayer && !gameId) return null;

  const currentFen = computeFenFromPgn(pgn);
  const { whiteClockMs, blackClockMs, hasClocks } = extractLastClocks(pgn);

  const summary: BroadcastGameSummary = {
    id: gameId ?? '',
    lichessGameId: gameId ?? null,
    whitePlayer: whitePlayer ?? null,
    blackPlayer: blackPlayer ?? null,
    whiteElo: parseIntOrNull(whiteEloRaw),
    blackElo: parseIntOrNull(blackEloRaw),
    result: resultRaw && resultRaw !== '*' ? resultRaw : resultRaw ?? null,
    pgn,
    currentFen,
    updatedAt: new Date(0).toISOString(),
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
    whiteClockMs,
    blackClockMs,
    clockUpdatedAt: hasClocks ? new Date().toISOString() : null,
    lastMoveAt: null,
  };
  return summary;
}

function extractHeader(pgn: string, name: string): string | null {
  const re = new RegExp(`\\[${name} "([^"]*)"\\]`);
  const match = pgn.match(re);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function parseIntOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

const INITIAL_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function computeFenFromPgn(pgn: string): string {
  const cleaned = pgn.replace(/\{[^}]*\}/g, '');
  const chess = new Chess();
  try {
    chess.loadPgn(cleaned);
    return chess.fen();
  } catch {
    return INITIAL_FEN;
  }
}

/**
 * Возвращает последнее найденное `[%clk H:MM:SS]` для белых и чёрных.
 * Комментарии `%clk` идут в порядке ходов (белый, чёрный, белый, чёрный).
 */
function extractLastClocks(pgn: string): {
  whiteClockMs: number | null;
  blackClockMs: number | null;
  hasClocks: boolean;
} {
  const clkRe = /\{[^}]*?\[%clk\s+(\d+):(\d{2}):(\d{2})\][^}]*?\}/g;
  const clocks: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = clkRe.exec(pgn)) !== null) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const s = parseInt(m[3], 10);
    clocks.push((h * 3600 + min * 60 + s) * 1000);
  }
  if (clocks.length === 0) {
    return { whiteClockMs: null, blackClockMs: null, hasClocks: false };
  }
  // Индексы: 0 → белые, 1 → чёрные, 2 → белые, ...
  // Последний ход белых = максимальный чётный индекс.
  // Последний ход чёрных = максимальный нечётный индекс.
  let lastWhite: number | null = null;
  let lastBlack: number | null = null;
  for (let i = 0; i < clocks.length; i++) {
    if (i % 2 === 0) lastWhite = clocks[i];
    else lastBlack = clocks[i];
  }
  return {
    whiteClockMs: lastWhite,
    blackClockMs: lastBlack,
    hasClocks: true,
  };
}
