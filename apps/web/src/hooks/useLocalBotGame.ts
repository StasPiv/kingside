/**
 * KS-4150: источник данных для локальной партии с ботом
 * (`/play/local-bot`). Полностью клиентский: chess.js хранит позицию,
 * `useBotEngine` (Stockfish 18 WASM) играет за оппонента,
 * клиентский таймер ведёт часы обоих игроков.
 *
 * Хук возвращает плоский набор полей и действий, которые
 * `LocalBotGamePage` подставляет в общую визуальную оболочку
 * `GameShell` — ту же, что использует онлайн-партия `/game/:id`.
 * Сетевых вызовов нет: ни REST, ни WebSocket. Партия живёт только
 * в памяти страницы и теряется при перезагрузке.
 *
 * Контроль времени:
 *   - таймер тикает каждые 250 мс, уменьшая часы того, чей сейчас ход;
 *   - при достижении 0 партия завершается победой соперника по времени;
 *   - после каждого хода к часам игрока добавляется инкремент.
 *
 * KS-4151: единый `Chess` инстанс мутируется через `.move()/.reset()`,
 * новый объект не создаётся. Это сохраняет идентичность ссылки между
 * рендерами и не пересоздаёт колбэки в `useBoardHighlights` →
 * `boardOptions` остаётся стабильным, доска не дёргается.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';

import { useBotEngine, type BotEngineErrorReason } from './useBotEngine';
import { sendClientLog } from '../utils/clientLogger';

type GameColor = 'white' | 'black';
export type LocalBotTimeControl = {
  /** Базовое время в секундах на каждого. По умолчанию 10 минут. */
  initialSec?: number;
  /** Прибавка за ход в секундах. По умолчанию 0. */
  incrementSec?: number;
  /**
   * KS-4153: режим «Без часов». Таймер не запускается, технического
   * поражения по времени не бывает, доска показывает прочерк.
   */
  noClock?: boolean;
};

export interface UseLocalBotGameOptions {
  /** Запрошенный цвет игрока: 'white' | 'black' | 'random'. */
  color?: GameColor | 'random';
  /** Уровень бота 1..10. */
  level?: number;
  /** Имя игрока для подписи (по умолчанию «Вы»). */
  playerName?: string;
  /** Имя бота (по умолчанию «Bot»). */
  botName?: string;
  /** Контроль времени. */
  timeControl?: LocalBotTimeControl;
}

export interface LocalBotGameState {
  chess: Chess;
  fen: string;
  moves: string[];
  clocks: { white: number; black: number };
  status: 'waiting' | 'active' | 'finished';
  /** 'white' | 'black' | 'draw' | null. */
  result: string | null;
  playerColor: GameColor;
  botLevel: number;
  players: { white: string; black: string };
  /** Координаты последнего сделанного хода для подсветки и звука. */
  lastMove: { from: Square; to: Square; san: string; ply: number } | null;
  /** «думает» ли бот — для статусной строки. */
  botThinking: boolean;
  /** Ошибка инициализации Stockfish или запроса хода, если есть. */
  botError: string | null;
  /**
   * KS-4303: причина ошибки инициализации движка — для UI с retry-
   * кнопкой. null когда движок здоров. Отдельно от `botError`, который
   * включает ещё и таймауты конкретного `go`-запроса.
   */
  engineError: BotEngineErrorReason | null;
  /** KS-4303: пересоздать воркер Stockfish после ошибки инициализации. */
  retryEngine: () => void;
  /** KS-4153: партия без часов — UI должен скрыть таймер или показать прочерк. */
  noClock: boolean;
  /** Применить ход игрока. Возвращает true, если ход легален. */
  onMove: (from: Square, to: Square, promotion?: 'q' | 'r' | 'b' | 'n') => boolean;
  /** Сдаться: засчитать поражение, статус → finished. */
  onResign: () => void;
  /** Начать новую партию с тем же цветом/уровнем/контролем. */
  onNewGame: () => void;
}

function resolveColor(c: GameColor | 'random' | undefined): GameColor {
  if (c === 'white' || c === 'black') return c;
  return Math.random() < 0.5 ? 'white' : 'black';
}

function clampLevel(level: number | undefined): number {
  const n = typeof level === 'number' ? level : 3;
  return Math.max(1, Math.min(10, n));
}

export function useLocalBotGame(
  options: UseLocalBotGameOptions,
): LocalBotGameState {
  const {
    color,
    level,
    playerName = 'You',
    botName = 'Bot',
    timeControl,
  } = options;

  const noClock = !!timeControl?.noClock;
  const initialSec = noClock
    ? 0
    : Math.max(10, timeControl?.initialSec ?? 600);
  const incrementSec = noClock ? 0 : Math.max(0, timeControl?.incrementSec ?? 0);

  const [playerColor] = useState<GameColor>(() => resolveColor(color));
  const [botLevel] = useState<number>(() => clampLevel(level));
  const [resetSeq, setResetSeq] = useState(0);

  // KS-4151: единый chess-инстанс — мутируется, никогда не заменяется.
  // Это сохраняет идентичность ссылки в зависимостях `useBoardHighlights`,
  // `useFastDrag` и других хуков GameShell, что предотвращает
  // пересоздание мемоизированного `boardOptions` и дрожание доски.
  const [chess] = useState<Chess>(() => new Chess());
  const [fen, setFen] = useState<string>(() => chess.fen());
  const [moves, setMoves] = useState<string[]>([]);
  const [status, setStatus] = useState<'waiting' | 'active' | 'finished'>(
    'active',
  );
  const [result, setResult] = useState<string | null>(null);
  const [clocks, setClocks] = useState({ white: initialSec, black: initialSec });
  const [botThinking, setBotThinking] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<
    { from: Square; to: Square; san: string; ply: number } | null
  >(null);

  // useBotEngine хочет gameId для логов — берём стабильный «local-<N>».
  const localGameId = `local-${resetSeq}`;
  const { getBotMove, engineError, retryEngine: retryEngineRaw } = useBotEngine(
    localGameId,
    botLevel,
    status === 'active',
  );
  // KS-4303: при retry движка ещё и сбрасываем `botError` (ошибку
  // конкретного `go`-запроса), чтобы UI не остался с устаревшим
  // сообщением, и эффект хода бота снова отработал на текущем fen.
  const retryEngine = useCallback(() => {
    setBotError(null);
    retryEngineRaw();
  }, [retryEngineRaw]);

  const players = useMemo(
    () =>
      playerColor === 'white'
        ? { white: playerName, black: botName }
        : { white: botName, black: playerName },
    [playerColor, playerName, botName],
  );

  const finalize = useCallback(
    (g: Chess) => {
      let r: string;
      if (g.isCheckmate()) {
        // chess.turn() — у кого ход сейчас. Этот игрок получил мат.
        const loser: GameColor = g.turn() === 'w' ? 'white' : 'black';
        r = loser === 'white' ? 'black' : 'white';
      } else {
        // Все ничейные исходы — ничья.
        r = 'draw';
      }
      setStatus('finished');
      setResult(r);
    },
    [],
  );

  // Часы: уменьшаем счётчик активного цвета каждые 250 мс.
  // KS-4153: в режиме «Без часов» таймер не запускается вообще.
  useEffect(() => {
    if (noClock) return;
    if (status !== 'active') return;
    const turn: GameColor = chess.turn() === 'w' ? 'white' : 'black';
    const id = setInterval(() => {
      setClocks((prev) => {
        const next = Math.max(0, +(prev[turn] - 0.25).toFixed(2));
        return { ...prev, [turn]: next };
      });
    }, 250);
    return () => clearInterval(id);
  }, [status, fen, chess, noClock]);

  // Если у кого-то ноль на часах — техническое поражение по времени.
  // KS-4153: в режиме «Без часов» проверка отключена.
  useEffect(() => {
    if (noClock) return;
    if (status !== 'active') return;
    if (clocks.white > 0 && clocks.black > 0) return;
    const loser: GameColor = clocks.white <= 0 ? 'white' : 'black';
    setStatus('finished');
    setResult(loser === 'white' ? 'black' : 'white');
  }, [clocks.white, clocks.black, status, noClock]);

  // KS-4306: общая обвязка запроса хода бота с 3 попытками
  // (`500 * attempt` мс задержки) — зеркало `GamePage.triggerBotMove`
  // (`apps/web/src/pages/GamePage.tsx`). Вынесена из эффекта, чтобы
  // её мог дёрнуть и отдельный эффект «бот ходит первым на mount».
  const runBotMove = useCallback(
    async (fenToPlay: string, isCancelled: () => boolean): Promise<void> => {
      setBotThinking(true);
      const MAX_ATTEMPTS = 3;
      let uci: string | null = null;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (isCancelled()) return;
        try {
          uci = await getBotMove(fenToPlay);
          break;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          sendClientLog(
            'error',
            `[local-bot] getBotMove attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
          );
          if (attempt < MAX_ATTEMPTS && !isCancelled()) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
      if (isCancelled()) return;
      if (uci === null) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        sendClientLog('error', `[local-bot] engine error after retries: ${msg}`);
        setBotError(msg);
        setBotThinking(false);
        return;
      }
      try {
        const turnColor: GameColor = chess.turn() === 'w' ? 'white' : 'black';
        const from = uci.slice(0, 2) as Square;
        const to = uci.slice(2, 4) as Square;
        const promotion = uci.length >= 5 ? uci[4] : undefined;
        const move = chess.move({ from, to, promotion });
        if (!move) {
          sendClientLog('error', `[local-bot] illegal uci from engine: ${uci}`);
          setBotThinking(false);
          return;
        }
        const ply = chess.history().length;
        setFen(chess.fen());
        setMoves((prev) => [...prev, move.san]);
        setLastMove({ from, to, san: move.san, ply });
        if (incrementSec > 0) {
          setClocks((prev) => ({
            ...prev,
            [turnColor]: prev[turnColor] + incrementSec,
          }));
        }
        if (chess.isGameOver()) finalize(chess);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sendClientLog('error', `[local-bot] apply move error: ${msg}`);
        setBotError(msg);
      } finally {
        if (!isCancelled()) setBotThinking(false);
      }
    },
    [chess, getBotMove, incrementSec, finalize],
  );

  // KS-4306: явный триггер «бот ходит первым на старте партии». Зеркало
  // `GamePage.onGameState` (см. `apps/web/src/pages/GamePage.tsx`):
  //   if (isClientBot && state.moves.length === 0 && state.color === 'black')
  //     triggerBotMoveRef.current(fen);
  // Раньше всё было в одном эффекте с `[fen, status, playerColor,
  // engineError]` — на холодной мобильной сети, если `useBotEngine` не
  // успевал и `setEngineError` срабатывал до того, как эффект
  // зацепился, первый ход бота пропадал. Отдельный mount-эффект
  // гарантирует попытку именно для стартовой позиции с ботом-белыми,
  // не зависит от engineError, а внутри `runBotMove` есть свои 3
  // попытки. Срабатывает только при `playerColor !== белый цвет
  // стартового хода`, т.е. ровно когда бот за белых.
  useEffect(() => {
    if (status !== 'active') return;
    if (moves.length !== 0) return;
    const turnColor: GameColor = chess.turn() === 'w' ? 'white' : 'black';
    if (turnColor === playerColor) return;
    let cancelled = false;
    void runBotMove(chess.fen(), () => cancelled);
    return () => {
      cancelled = true;
    };
    // ОДИН раз на mount — реагирует только на `resetSeq`/`playerColor`/
    // start-условия, не на каждый `fen` (тогда сработает второй эффект
    // ниже).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSeq, playerColor, status]);

  // Ход бота после хода игрока — когда позиция обновилась и сейчас не
  // наш ход. Этот эффект НЕ ловит стартовую позицию (для неё —
  // mount-эффект выше); поэтому игнорируем `moves.length === 0`.
  useEffect(() => {
    if (status !== 'active') return;
    if (moves.length === 0) return; // стартовая позиция — выше
    const turnColor: GameColor = chess.turn() === 'w' ? 'white' : 'black';
    if (turnColor === playerColor) return;
    let cancelled = false;
    void runBotMove(chess.fen(), () => cancelled);
    return () => {
      cancelled = true;
    };
    // KS-4303: `engineError` обнуляется при retry — даём эффекту шанс
    // переиграть текущий fen после восстановления движка.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, status, playerColor, engineError]);

  // Ход игрока. Возвращает true — ход легален и применён.
  const onMove = useCallback(
    (from: Square, to: Square, promotion?: 'q' | 'r' | 'b' | 'n'): boolean => {
      if (status !== 'active') return false;
      const turnColor: GameColor = chess.turn() === 'w' ? 'white' : 'black';
      if (turnColor !== playerColor) return false;
      let move;
      try {
        move = chess.move({
          from,
          to,
          ...(promotion ? { promotion } : {}),
        });
      } catch {
        return false;
      }
      if (!move) return false;
      const ply = chess.history().length;
      setFen(chess.fen());
      setMoves((prev) => [...prev, move.san]);
      setLastMove({ from, to, san: move.san, ply });
      if (incrementSec > 0) {
        setClocks((prev) => ({
          ...prev,
          [turnColor]: prev[turnColor] + incrementSec,
        }));
      }
      if (chess.isGameOver()) finalize(chess);
      return true;
    },
    [chess, status, playerColor, incrementSec, finalize],
  );

  const onResign = useCallback(() => {
    if (status !== 'active') return;
    setStatus('finished');
    // Победа соперника.
    setResult(playerColor === 'white' ? 'black' : 'white');
  }, [status, playerColor]);

  const onNewGame = useCallback(() => {
    chess.reset();
    setFen(chess.fen());
    setMoves([]);
    setLastMove(null);
    setStatus('active');
    setResult(null);
    setBotError(null);
    setClocks({ white: initialSec, black: initialSec });
    setResetSeq((s) => s + 1);
  }, [chess, initialSec]);

  return {
    chess,
    fen,
    moves,
    clocks,
    status,
    result,
    playerColor,
    botLevel,
    players,
    lastMove,
    botThinking,
    botError,
    engineError,
    retryEngine,
    noClock,
    onMove,
    onResign,
    onNewGame,
  };
}
