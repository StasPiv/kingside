/**
 * KS-4150: источник данных для локальной партии с ботом
 * (`/play/local-bot`). Полностью клиентский: chess.js хранит позицию,
 * `useBotEngine` (Stockfish 18 WASM) играет за оппонента,
 * клиентские часы ведут отсчёт.
 *
 * Хук возвращает плоский набор полей и действий, которые
 * `LocalBotGamePage` подставляет в общую визуальную оболочку
 * `GameShell` — ту же, что использует онлайн-партия `/game/:id`.
 * Сетевых вызовов нет: ни REST, ни WebSocket. Партия живёт только
 * в памяти страницы и теряется при перезагрузке.
 *
 * KS-4655 / ADR-144 §3.4. Часы хранятся в мс + `snapshotAt`
 * (`performance.now()`): локального `setInterval(250)` больше нет,
 * точный отсчёт между ходами делает `useGameClockDisplay` на
 * стороне `LocalBotGamePage` (тот же подход, что в live-партии,
 * KS-4652). Флаг по нулю часов запускается отдельным `setTimeout`
 * на время «текущий остаток активной стороны»: если до его
 * срабатывания приходит ход — таймер отменяется и пересоздаётся
 * для нового активного цвета.
 *
 * KS-4151: единый `Chess` инстанс мутируется через `.move()/.reset()`,
 * новый объект не создаётся. Это сохраняет идентичность ссылки между
 * рендерами и не пересоздаёт колбэки в `useBoardHighlights` →
 * `boardOptions` остаётся стабильным, доска не дёргается.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';

import { useBotEngine, type BotEngineErrorReason } from './useBotEngine';
import { sendClientLog } from '../utils/clientLogger';
import { logBotEngineDebug } from '../lib/botEngineDebug';

// KS-4308: дублирующее логирование в UI-видимый буфер отладочной
// панели (`BotEngineDebugPanel`).
function dualLog(level: 'info' | 'warn' | 'error', message: string): void {
  sendClientLog(level, message);
  logBotEngineDebug(level, message);
}

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

/**
 * KS-4655 / ADR-144 §3.4. Серверный (для local-bot — клиентский)
 * мс-снимок часов: `whiteMs`/`blackMs` — последний зафиксированный
 * остаток; `snapshotAt` — `performance.now()` в момент фиксации
 * (после хода игрока/бота, при старте партии, при resign).
 *
 * `useGameClockDisplay` экстраполирует от `snapshotAt` до текущего
 * `performance.now()` и считает urgency/mode.
 */
export interface LocalBotClocksMs {
  whiteMs: number;
  blackMs: number;
  snapshotAt: number;
}

export interface LocalBotGameState {
  chess: Chess;
  fen: string;
  moves: string[];
  /**
   * KS-4655. Часы в миллисекундах + момент последней фиксации
   * (`performance.now()`). Заменяет старое поле `clocks: {white,
   * black}` (секунды). Потребитель передаёт это в
   * `useGameClockDisplay` (тот же контракт, что у live, KS-4652).
   */
  clocksMs: LocalBotClocksMs;
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
   * кнопкой. null когда движок здоров.
   */
  engineError: BotEngineErrorReason | null;
  /** KS-4303: пересоздать воркер Stockfish после ошибки инициализации. */
  retryEngine: () => void;
  /** KS-4153: партия без часов — UI должен скрыть таймер или показать прочерк. */
  noClock: boolean;
  /**
   * KS-4655. Начальное время контроля в миллисекундах — потребляется
   * `useGameClockDisplay` (`initialMs`) для расчёта порогов
   * urgency. При `noClock=true` — 0 (значение игнорируется).
   */
  initialMs: number;
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

/**
 * KS-4655. Рассчитать остаток времени активной стороны на момент
 * `now` с учётом фиксированного `snapshotAt`. Чистая функция,
 * экспортируется для тестов.
 */
function remainingOf(
  clocks: LocalBotClocksMs,
  color: GameColor,
  now: number,
): number {
  const base = color === 'white' ? clocks.whiteMs : clocks.blackMs;
  const elapsed = Math.max(0, now - clocks.snapshotAt);
  return Math.max(0, base - elapsed);
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
  // KS-4655. Единые мс-величины — используются и в state, и в
  // экспортируемом `initialMs`, и в инкрементной формуле.
  const initialMs = initialSec * 1000;
  const incrementMs = incrementSec * 1000;

  const [playerColor] = useState<GameColor>(() => resolveColor(color));
  const [botLevel] = useState<number>(() => clampLevel(level));
  const [resetSeq, setResetSeq] = useState(0);

  // KS-4151: единый chess-инстанс — мутируется, никогда не заменяется.
  const [chess] = useState<Chess>(() => new Chess());
  const [fen, setFen] = useState<string>(() => chess.fen());
  const [moves, setMoves] = useState<string[]>([]);
  const [status, setStatus] = useState<'waiting' | 'active' | 'finished'>(
    'active',
  );
  const [result, setResult] = useState<string | null>(null);
  // KS-4655. Часы в мс + snapshotAt. Изначально равные, `snapshotAt`
  // фиксируется в момент монтирования.
  const [clocksMs, setClocksMs] = useState<LocalBotClocksMs>(() => ({
    whiteMs: initialMs,
    blackMs: initialMs,
    snapshotAt: performance.now(),
  }));
  // KS-4655. Ref на текущий снимок часов — для эффекта хода бота:
  // читаем `clocksMs.whiteMs/blackMs` при составлении `clockInfo`,
  // но не хотим перезапускать эффект при каждой смене снимка
  // (пере-render'ы от ходов в любом случае триггерят эффект через `fen`).
  const clocksMsRef = useRef<LocalBotClocksMs>({
    whiteMs: initialMs,
    blackMs: initialMs,
    snapshotAt: 0,
  });
  const [botThinking, setBotThinking] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<
    { from: Square; to: Square; san: string; ply: number } | null
  >(null);

  // KS-4655. Синхронизируем ref после каждого изменения состояния
  // часов — чтобы эффект хода бота читал актуальный снимок без
  // включения `clocksMs` в свои deps (иначе двойной перезапуск
  // эффекта на каждом ходу — он и так перезапускается на `fen`).
  useEffect(() => {
    clocksMsRef.current = clocksMs;
  }, [clocksMs]);

  // useBotEngine хочет gameId для логов — берём стабильный «local-<N>».
  const localGameId = `local-${resetSeq}`;
  const { getBotMove, engineError, retryEngine: retryEngineRaw } = useBotEngine(
    localGameId,
    botLevel,
    status === 'active',
  );
  // KS-4303: при retry движка ещё и сбрасываем `botError`.
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
        const loser: GameColor = g.turn() === 'w' ? 'white' : 'black';
        r = loser === 'white' ? 'black' : 'white';
      } else {
        r = 'draw';
      }
      setStatus('finished');
      setResult(r);
    },
    [],
  );

  /**
   * KS-4655 / ADR-144. После хода `mover`-цвета фиксируем новый
   * мс-снимок: списываем elapsed с его часов, прибавляем инкремент,
   * обновляем `snapshotAt`. Часы другого цвета остаются как были
   * (он не тратил время).
   */
  const fixClocksAfterMove = useCallback(
    (mover: GameColor) => {
      if (noClock) return;
      const now = performance.now();
      setClocksMs((prev) => {
        const remaining = remainingOf(prev, mover, now);
        const updated = remaining + incrementMs;
        return mover === 'white'
          ? { whiteMs: updated, blackMs: prev.blackMs, snapshotAt: now }
          : { whiteMs: prev.whiteMs, blackMs: updated, snapshotAt: now };
      });
    },
    [noClock, incrementMs],
  );

  // KS-4655 / ADR-144. Флаг по нулю часов: вместо `setInterval(250)`
  // ставим `setTimeout` ровно на остаток времени активной стороны.
  // При смене активной стороны (новый ход) или конце партии таймер
  // снимается и пересоздаётся для нового активного цвета.
  useEffect(() => {
    if (noClock) return;
    if (status !== 'active') return;
    const active: GameColor = chess.turn() === 'w' ? 'white' : 'black';
    const remaining = remainingOf(clocksMs, active, performance.now());
    const id = setTimeout(() => {
      // Партия могла закончиться раньше (ход прошёл и эффект перезапустился),
      // защищаемся проверкой status в callback'е через closure: на момент
      // вызова setTimeout `status === 'active'`. Если успел смениться —
      // setTimeout уже снят cleanup'ом.
      setStatus('finished');
      setResult(active === 'white' ? 'black' : 'white');
    }, remaining);
    return () => clearTimeout(id);
  }, [status, noClock, chess, fen, clocksMs]);

  // Ход бота — когда сейчас ход не наш и партия идёт.
  useEffect(() => {
    if (status !== 'active') return;
    const turnColor: GameColor = chess.turn() === 'w' ? 'white' : 'black';
    if (turnColor === playerColor) return;
    let cancelled = false;
    setBotThinking(true);
    (async () => {
      // KS-4305: ретраи запроса хода — Stockfish иногда падает первым
      // запросом, пока не завершил uci-handshake.
      const MAX_ATTEMPTS = 3;
      let uci: string | null = null;
      let lastErr: unknown = null;
      // KS-4335 (follow-up): первые 10 ходов бота — без clockInfo (быстрый
      // дебют). С 11-го — передаём текущий остаток и инкремент.
      const playedPlies = chess.history().length;
      const isBotWhite = playerColor === 'black';
      const botMovesDone = isBotWhite
        ? Math.ceil(playedPlies / 2)
        : Math.floor(playedPlies / 2);
      // KS-4655. Берём ms-остатки из ref'а — он отражает последний
      // снимок без необходимости включать `clocksMs` в deps эффекта.
      const clockInfo =
        noClock || botMovesDone < 10
          ? undefined
          : {
              wtimeMs: Math.max(1, Math.round(clocksMsRef.current.whiteMs)),
              btimeMs: Math.max(1, Math.round(clocksMsRef.current.blackMs)),
              wincMs: Math.max(0, Math.round(incrementMs)),
              bincMs: Math.max(0, Math.round(incrementMs)),
            };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (cancelled) return;
        try {
          uci = await getBotMove(chess.fen(), clockInfo);
          break;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          dualLog(
            'warn',
            `[local-bot] getBotMove attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
          );
          if (attempt < MAX_ATTEMPTS && !cancelled) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
      if (cancelled) return;
      if (uci === null) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        dualLog('error', `[local-bot] engine error after retries: ${msg}`);
        setBotError(msg);
        setBotThinking(false);
        return;
      }
      try {
        const from = uci.slice(0, 2) as Square;
        const to = uci.slice(2, 4) as Square;
        const promotion = uci.length >= 5 ? uci[4] : undefined;
        const move = chess.move({ from, to, promotion });
        if (!move) {
          dualLog('error', `[local-bot] illegal uci from engine: ${uci}`);
          return;
        }
        const ply = chess.history().length;
        setFen(chess.fen());
        setMoves((prev) => [...prev, move.san]);
        setLastMove({ from, to, san: move.san, ply });
        // KS-4655. Зафиксировать новый снимок часов после хода бота.
        fixClocksAfterMove(turnColor);
        if (chess.isGameOver()) finalize(chess);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          dualLog('error', `[local-bot] engine error: ${msg}`);
          setBotError(msg);
        }
      } finally {
        if (!cancelled) setBotThinking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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
      // KS-4655. Фиксация мс-снимка после хода игрока.
      fixClocksAfterMove(turnColor);
      if (chess.isGameOver()) finalize(chess);
      return true;
    },
    [chess, status, playerColor, finalize, fixClocksAfterMove],
  );

  const onResign = useCallback(() => {
    if (status !== 'active') return;
    setStatus('finished');
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
    // KS-4655. Новый snapshot и полные часы.
    setClocksMs({
      whiteMs: initialMs,
      blackMs: initialMs,
      snapshotAt: performance.now(),
    });
    setResetSeq((s) => s + 1);
  }, [chess, initialMs]);

  return {
    chess,
    fen,
    moves,
    clocksMs,
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
    initialMs,
    onMove,
    onResign,
    onNewGame,
  };
}
