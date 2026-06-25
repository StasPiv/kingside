/**
 * KS-4150: онлайн-партия `/game/:id`. Сетевая логика (WebSocket
 * `/game`, REST `/games/:id`, рейтинговые предложения реванша)
 * остаётся здесь; визуальное оформление полностью делегировано
 * `GameShell`. Та же оболочка отрисовывает локальную партию с ботом
 * (`/play/local-bot`) — различие только в источнике данных.
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import {
  INITIAL_FEN,
  GameEvents,
  type ClockPayload,
  type WsGameStatePayload,
  type WsGameMoveServerPayload,
  type WsGameEndPayload,
  type WsChatMessagePayload,
  type WsErrorPayload,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { useChallenge } from '../hooks/useChallenge';
import { useBotEngine } from '../hooks/useBotEngine';
import { useLazySocket } from '../hooks/useLazySocket';
import { useSounds } from '../hooks/useSounds';
// KS-4652 / ADR-144 §3.4 — миллисекундный snapshot часов +
// экстраполяция через `performance.now()` вместо setInterval(1000).
import { useGameClockDisplay } from '../hooks/useGameClockDisplay';
import { socket, messagesSocket } from '../socket';
import { sendClientLog } from '../utils/clientLogger';
import { openAnalysis } from '../utils/openAnalysis';
import { buildGamePgn, buildGameAnalysisTitle } from './buildGamePgn';
import { GameShell } from '../components/game/GameShell';
import { BotEngineDebugPanel } from '../components/BotEngineDebugPanel';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/**
 * KS-4652 / ADR-144 §3.4. Серверный снимок часов в мс + момент его
 * приёма (`performance.now()`). Этого пакета достаточно
 * `useGameClockDisplay`, чтобы экстраполировать остатки между
 * серверными снимками и пересчитывать urgency/mode.
 */
interface ClocksSnapshotMs {
  whiteMs: number;
  blackMs: number;
  snapshotAt: number;
}

function clocksFromPayload(clocks: ClockPayload | undefined): ClocksSnapshotMs {
  return {
    whiteMs: clocks?.whiteMs ?? 0,
    blackMs: clocks?.blackMs ?? 0,
    snapshotAt: performance.now(),
  };
}

export function GamePage() {
  useLazySocket(socket);
  useLazySocket(messagesSocket); // challenges
  const { id: gameId } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [urlParams] = useState(() => new URLSearchParams(location.search));
  const tournamentId = urlParams.get('tournamentId');
  const [tournamentType, setTournamentType] = useState<string | null>(null);
  const routeColor = (location.state as { color?: 'white' | 'black' } | null)?.color;
  const { user, refreshUser } = useAuth();
  const { t } = useTranslation();
  const { playSound } = useSounds();

  const [game] = useState(() => new Chess());
  const [fen, setFen] = useState(INITIAL_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  // KS-4652 / ADR-144 §3.4. Часы в миллисекундах + момент приёма.
  // Изначально 300 000 мс — стандартный 5+0; перезаписывается первым
  // же `game:state` от сервера (snapshotAt тоже фиксируется в момент
  // приёма).
  const [clocksMs, setClocksMs] = useState<ClocksSnapshotMs>(() => ({
    whiteMs: 300_000,
    blackMs: 300_000,
    snapshotAt: performance.now(),
  }));
  const [status, setStatus] = useState<'waiting' | 'active' | 'finished'>(
    'waiting',
  );
  const stateReceivedRef = useRef(false);
  const [result, setResult] = useState<string | null>(null);
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>(
    routeColor ?? 'white',
  );
  const [messages, setMessages] = useState<WsChatMessagePayload[]>([]);
  const [players, setPlayers] = useState<{ white: string; black: string }>({
    white: '',
    black: '',
  });
  const [drawOffered, setDrawOffered] = useState(false);
  const [isOpponentMove, setIsOpponentMove] = useState(false);
  const [lastMove, setLastMove] = useState<
    { from: Square; to: Square; san: string; ply: number } | null
  >(null);
  // KS-4150: актуальная длина ходов — для определения ply нового хода
  // без пересоздания WS-подписки на каждый ход.
  const movesLenRef = useRef(0);
  movesLenRef.current = moves.length;
  const [isBot, setIsBot] = useState(false);
  const isBotRef = useRef(false);
  isBotRef.current = isBot;
  // KS-4310: серверного бота на проекте не будет, любая bot-партия
  // идёт через локальный `useBotEngine` по флагу `isBot`. До KS-4308
  // здесь существовала дихотомия `botClientSide` (KS-3559), которая
  // оказалась активным источником багов и удалена вместе с полем
  // в `WsGameStatePayload` (backend KS-4309).
  const [botLevel, setBotLevel] = useState<number | null>(null);
  const [ratingChange, setRatingChange] = useState<
    WsGameEndPayload['ratingChange']
  >(undefined);
  const [whiteBerserk, setWhiteBerserk] = useState(false);
  const [blackBerserk, setBlackBerserk] = useState(false);
  const [showResultModal, setShowResultModal] = useState(false);
  // KS-2949: флаг «уже инициировали авто-редирект в анализ» — чтобы при
  // повторных state-апдейтах не делать двойной POST /analyses + navigate.
  const analysisRedirectingRef = useRef(false);

  const { getBotMove } = useBotEngine(gameId, botLevel, isBot);
  const getBotMoveRef = useRef(getBotMove);
  getBotMoveRef.current = getBotMove;

  // KS-4335 / KS-4652: актуальный мс-снимок часов и инкремент для
  // передачи Stockfish'у через UCI `go wtime btime winc binc`.
  // Раньше ref хранил секунды; теперь сразу мс — Stockfish тоже их
  // получает.
  const clocksMsRef = useRef(clocksMs);
  const incrementSecRef = useRef(0);

  /**
   * Request a bot move for the given FEN and emit it to the server.
   * Retries on transient engine failures so the first move after matchmaking
   * doesn't get lost when Stockfish is still initializing.
   * Errors are logged (not silently swallowed); the server-side fallback
   * kicks in after 5s if the client still fails.
   *
   * KS-4335: вместе с fen отдаём Stockfish'у остатки на часах в мс —
   * `go wtime btime winc binc`. Движок сам выбирает «человеческое» время
   * на ход (в дебюте быстрее, в критичных позициях дольше, в цейтноте
   * почти мгновенно). До правки бот в `/game/:id` отвечал мгновенно
   * независимо от контроля времени.
   */
  // KS-4335 (follow-up): актуальный цвет игрока для оценки «сколько
  // ходов бот уже сыграл». Через ref, чтобы не пересоздавать
  // `triggerBotMove` при смене цвета на инициализации.
  const playerColorRef = useRef(playerColor);
  playerColorRef.current = playerColor;

  const triggerBotMove = useCallback(
    async (fen: string) => {
      if (!gameId) return;
      const maxAttempts = 3;
      // KS-4335 (follow-up): первые 10 ходов бота — без передачи остатка
      // часов, чтобы дебют игрался быстро (как было до KS-4335). Начиная
      // с 11-го хода бот получает clockInfo и распределяет время по
      // часам через `go wtime btime winc binc`.
      const playedPlies = movesLenRef.current;
      const isBotWhite = playerColorRef.current === 'black';
      const botMovesDone = isBotWhite
        ? Math.ceil(playedPlies / 2)
        : Math.floor(playedPlies / 2);
      const incMs = Math.max(0, Math.round(incrementSecRef.current * 1000));
      const wMs = Math.max(1, Math.round(clocksMsRef.current.whiteMs));
      const bMs = Math.max(1, Math.round(clocksMsRef.current.blackMs));
      const clockInfo =
        botMovesDone >= 10
          ? {
              wtimeMs: wMs,
              btimeMs: bMs,
              wincMs: incMs,
              bincMs: incMs,
            }
          : undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const uci = await getBotMoveRef.current(fen, clockInfo);
          socket.emit('game:bot-move', { gameId, uci });
          return;
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          sendClientLog(
            'error',
            `[bot] triggerBotMove attempt ${attempt}/${maxAttempts} failed: ${msg}`,
          );
          if (attempt === maxAttempts) {
            console.error(
              '[bot] all retries failed, server fallback will take over',
              err,
            );
            return;
          }
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    },
    [gameId],
  );
  const triggerBotMoveRef = useRef(triggerBotMove);
  triggerBotMoveRef.current = triggerBotMove;

  /**
   * KS-2946: открыть анализ сыгранной партии. Раньше модалка результата
   * содержала `<Link to={`/analysis/${gameId}`}>`, где `gameId` — id
   * live-игры, а не id записи в таблице `analyses`. `AnalysisPage`
   * получал 404 на GET /analyses/<gameId> и уходил в режим «новый
   * чистый анализ» — отсюда пустая доска и пустой move-list.
   *
   * Чиним так же, как `handleRowClick` в `ArchiveGamesPage` (KS-2403
   * follow-up): собираем полный PGN из текущего state'а партии
   * (moves + players + result), создаём запись `POST /analyses`
   * через helper `openAnalysis` (ADR-051 §4 B1), затем navigate на
   * `/analysis/<created.id>`. При ошибке helper показывает alert и
   * не уводит пользователя со страницы партии.
   */
  const handleAnalyze = useCallback(() => {
    const pgn = buildGamePgn({
      players,
      moves,
      result,
      gameId: gameId ?? null,
    });
    void openAnalysis(navigate, {
      pgn,
      title: buildGameAnalysisTitle(players),
      t,
    });
  }, [navigate, players, moves, result, gameId, t]);

  const [gameMeta, setGameMeta] = useState<{
    opponentId: string;
    timeInitial: number;
    increment: number;
  } | null>(null);
  const { sendChallenge, state: challengeState } = useChallenge();

  // KS-4335 / KS-4652: синхронизация refs для clockInfo. Делаем именно
  // в эффектах, а не присваиванием прямо в теле компонента, чтобы
  // избежать TDZ — `gameMeta` объявлен ниже `triggerBotMove`. Ref
  // хранит мс-снимок (используется `triggerBotMove` для UCI
  // `go wtime btime`).
  useEffect(() => {
    clocksMsRef.current = clocksMs;
  }, [clocksMs]);
  useEffect(() => {
    incrementSecRef.current = gameMeta?.increment ?? 0;
  }, [gameMeta]);

  // Fetch game meta (opponent id, time control) for rematch
  useEffect(() => {
    if (!gameId || !user) return;
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/games/${gameId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((g) => {
        if (!g) return;
        const opponentId = g.whiteId === user.id ? g.blackId : g.whiteId;
        setGameMeta({
          opponentId,
          timeInitial: g.timeInitialSec ?? 300,
          increment: g.timeIncrementSec ?? 0,
        });
      })
      .catch(() => {});
  }, [gameId, user]);

  // Fetch tournament type for berserk visibility
  useEffect(() => {
    if (!tournamentId) return;
    api
      .get<{ type: string }>(`/arena/${tournamentId}`)
      .then((t) => setTournamentType(t.type))
      .catch(() => {});
  }, [tournamentId]);

  const handleRematch = useCallback(() => {
    if (!gameMeta) return;
    sendChallenge({
      targetUserId: gameMeta.opponentId,
      timeInitial: gameMeta.timeInitial,
      increment: gameMeta.increment,
      color: 'random',
    });
  }, [gameMeta, sendChallenge]);

  const updateFromState = useCallback(
    (state: WsGameStatePayload) => {
      game.load(state.fen);
      setFen(state.fen);
      setMoves(state.moves);
      setClocksMs(clocksFromPayload(state.clocks));
      setStatus(state.status as 'waiting' | 'active' | 'finished');
      if (state.result) setResult(state.result);
      // KS-4150: исходный state не содержит координат последнего хода
      // отдельным полем; они нужны для подсветки/звука, поэтому
      // оставляем lastMove на текущем значении до прихода `game:move`.
    },
    [game],
  );

  // Сброс флага isOpponentMove на следующий тик после применения хода
  useEffect(() => {
    if (isOpponentMove) setIsOpponentMove(false);
  }, [isOpponentMove]);

  useEffect(() => {
    const onGameState = (state: WsGameStatePayload) => {
      console.log(
        '[WS] game:state received, status=' +
          state.status +
          ', clocks=' +
          JSON.stringify(state.clocks),
      );
      const isFirstState = !stateReceivedRef.current;
      stateReceivedRef.current = true;
      if (state.color) setPlayerColor(state.color);
      if (state.players) setPlayers(state.players);
      if (state.isBot !== undefined) setIsBot(state.isBot);
      if (state.botLevel !== undefined) setBotLevel(state.botLevel ?? null);
      updateFromState(state);
      if (isFirstState && state.status === 'active') {
        playSound('game-start');
        // Если бот играет белыми — триггерим первый ход. Любая
        // bot-партия с KS-4308/KS-4310 идёт через локальный
        // `useBotEngine`, серверного варианта больше нет.
        if (
          state.isBot === true &&
          gameId &&
          state.moves.length === 0 &&
          state.color === 'black'
        ) {
          const fen = new Chess().fen(); // starting position
          triggerBotMoveRef.current(fen);
        }
      }
      // KS-2949: если партия уже завершена на момент посещения /game/:id
      // (пользователь открыл ссылку на сыгранную партию), сразу редирект
      // в анализ. Окончание НЕ происходит в текущей сессии — модалка не
      // показывается. На live-партиях (status='active') редирект не
      // срабатывает.
      if (
        isFirstState &&
        state.status === 'finished' &&
        !analysisRedirectingRef.current
      ) {
        analysisRedirectingRef.current = true;
        const playersForPgn = state.players ?? { white: '', black: '' };
        const pgn = buildGamePgn({
          players: playersForPgn,
          moves: state.moves,
          result: state.result ?? null,
          gameId: gameId ?? null,
        });
        void openAnalysis(navigate, {
          pgn,
          title: buildGameAnalysisTitle(playersForPgn),
          t,
          replace: true,
        });
      }
    };

    const onGameMove = (data: WsGameMoveServerPayload) => {
      console.log(
        '[WS] game:move received, san=' +
          data.san +
          ', clocks=' +
          JSON.stringify(data.clocks),
      );
      // If the FEN already matches, this is a server echo of our own
      // move (already applied optimistically).  Only update clocks
      // (for server-authoritative time) — skip board state changes
      // to avoid a redundant re-render that causes piece flicker.
      if (game.fen() === data.fen) {
        setClocksMs(clocksFromPayload(data.clocks));
        // Триггерим ход бота для любой bot-партии — локальный
        // `useBotEngine` (KS-4308/KS-4310).
        if (isBotRef.current && gameId) {
          triggerBotMoveRef.current(data.fen);
        }
        return;
      }
      game.load(data.fen);
      setIsOpponentMove(true);
      setFen(data.fen);
      const nextPly = movesLenRef.current + 1;
      setMoves((prev) => [...prev, data.san]);
      setLastMove({
        from: data.uci.slice(0, 2) as Square,
        to: data.uci.slice(2, 4) as Square,
        san: data.san,
        ply: nextPly,
      });
      setClocksMs(clocksFromPayload(data.clocks));
    };

    const onGameEnd = (data: WsGameEndPayload) => {
      console.log('[WS] game:end received', JSON.stringify(data));
      setStatus('finished');
      setResult(data.result);
      if (data.ratingChange) setRatingChange(data.ratingChange);
      setShowResultModal(true);
      refreshUser();
      playSound('game-end');
      window.dispatchEvent(new Event('game:ended'));
    };

    const onDrawOffered = () => setDrawOffered(true);
    const onChatMessage = (msg: WsChatMessagePayload) =>
      setMessages((prev) => [...prev, msg]);
    const onError = (data: WsErrorPayload) => {
      console.error('[WS] Game error:', data.message);
    };
    const onBerserk = (data: { color: string; clocks: ClockPayload }) => {
      if (data.color === 'white') setWhiteBerserk(true);
      if (data.color === 'black') setBlackBerserk(true);
      setClocksMs(clocksFromPayload(data.clocks));
    };

    socket.on(GameEvents.STATE, onGameState);
    socket.on(GameEvents.MOVE_SERVER, onGameMove);
    socket.on(GameEvents.END, onGameEnd);
    socket.on(GameEvents.DRAW_OFFERED, onDrawOffered);
    socket.on(GameEvents.CHAT_MESSAGE, onChatMessage);
    socket.on(GameEvents.ERROR, onError);
    socket.on('game:berserk', onBerserk);

    socket.emit(GameEvents.JOIN, { gameId });

    return () => {
      socket.off(GameEvents.STATE, onGameState);
      socket.off(GameEvents.MOVE_SERVER, onGameMove);
      socket.off(GameEvents.END, onGameEnd);
      socket.off(GameEvents.DRAW_OFFERED, onDrawOffered);
      socket.off(GameEvents.CHAT_MESSAGE, onChatMessage);
      socket.off(GameEvents.ERROR, onError);
      socket.off('game:berserk', onBerserk);
    };
  }, [gameId, game, updateFromState, refreshUser, playSound, navigate, t]);

  // KS-4652 / ADR-144 §3.4. Локальный `setInterval(1000)`, декрементивший
  // активной стороне 1 секунду, удалён. Точный отсчёт по
  // `performance.now()` живёт в `useGameClockDisplay` (вызывается ниже)
  // — он же выбирает частоту тика (250 мс / rAF) в зависимости от
  // urgency. Серверный `whiteMs/blackMs` остаётся источником истины и
  // переписывает экстраполяцию при каждом `game:state`/`game:move`.

  // KS-4652 / ADR-144. Активная сторона по `chess.turn()` — нужна
  // хуку часов для экстраполяции; пока партия не активна или нет
  // серверного снимка — `null` (часы рендерятся статично).
  const activeColor: 'white' | 'black' | null =
    status === 'active' && stateReceivedRef.current
      ? game.turn() === 'w'
        ? 'white'
        : 'black'
      : null;

  // KS-4652: `initialMs` для расчёта порогов urgency. Берём из REST
  // GET /games/:id (g.timeInitialSec * 1000), который GamePage уже
  // тянет в `gameMeta`. До прихода ответа — `null` → хук применит
  // fallback emergency1=30_000, emergency2=8_000 (см. ADR §3.2 и
  // комментарий к задаче KS-4652). REST приходит за сотни мс — в
  // окно от старта партии до достижения порогов это укладывается с
  // огромным запасом.
  const initialMs =
    gameMeta?.timeInitial != null ? gameMeta.timeInitial * 1000 : null;

  const clockDisplay = useGameClockDisplay({
    whiteMs: clocksMs.whiteMs,
    blackMs: clocksMs.blackMs,
    activeColor,
    snapshotAt: clocksMs.snapshotAt,
    initialMs,
    isFinished: status === 'finished',
  });

  // KS-4652. Claim-timeout. Раньше триггерился по `clocks.white === 0
  // || clocks.black === 0` (секундная модель). Теперь источник —
  // серверный мс-снимок: claim-timeout запускается, когда любой из
  // `whiteMs`/`blackMs` <= 0. Локальный экстраполированный display не
  // используется — иначе на rounding'е клиент опередит сервер. Retry
  // каждые 2 с сохранён.
  const anyClockExpired = clocksMs.whiteMs <= 0 || clocksMs.blackMs <= 0;
  useEffect(() => {
    if (status !== 'active' || !stateReceivedRef.current) return;
    if (!anyClockExpired) return;

    console.log(
      '[Timeout] clock at 0, starting claim interval. whiteMs=' +
        clocksMs.whiteMs +
        ' blackMs=' +
        clocksMs.blackMs,
    );
    const sendClaim = () => {
      console.log(
        '[Timeout] SENDING game:claim-timeout for game ' + gameId,
      );
      socket.emit('game:claim-timeout', { gameId });
    };
    sendClaim();
    const interval = setInterval(sendClaim, 2000);
    return () => clearInterval(interval);
  }, [status, anyClockExpired, gameId, clocksMs.whiteMs, clocksMs.blackMs]);

  // ─── onMove (ход игрока): применяем локально и отправляем на сервер
  const handleMove = useCallback(
    (
      sourceSquare: Square,
      targetSquare: Square,
      promotion?: 'q' | 'r' | 'b' | 'n',
    ): boolean => {
      try {
        const move = game.move({
          from: sourceSquare,
          to: targetSquare,
          promotion,
        });
        if (!move) return false;
        const nextPly = movesLenRef.current + 1;
        setFen(game.fen());
        setMoves((prev) => [...prev, move.san]);
        setLastMove({
          from: sourceSquare,
          to: targetSquare,
          san: move.san,
          ply: nextPly,
        });
        const uci = promotion
          ? `${sourceSquare}${targetSquare}${promotion}`
          : `${sourceSquare}${targetSquare}`;
        socket.emit(GameEvents.MOVE, { gameId, uci });
        return true;
      } catch {
        return false;
      }
    },
    [game, gameId],
  );

  // Действия игрока
  const handleResign = useCallback(() => {
    socket.emit(GameEvents.RESIGN, { gameId });
  }, [gameId]);
  const handleDrawOffer = useCallback(() => {
    socket.emit(GameEvents.DRAW_OFFER, { gameId });
  }, [gameId]);
  const handleDrawAccept = useCallback(() => {
    socket.emit(GameEvents.DRAW_ACCEPT, { gameId });
    setDrawOffered(false);
  }, [gameId]);
  const handleDrawDecline = useCallback(() => {
    socket.emit(GameEvents.DRAW_DECLINE, { gameId });
    setDrawOffered(false);
  }, [gameId]);
  const handleBerserk = useCallback(() => {
    socket.emit('game:berserk', { gameId });
  }, [gameId]);
  const handleChatSend = useCallback(
    (text: string) => {
      socket.emit(GameEvents.CHAT_SEND, { gameId, content: text });
    },
    [gameId],
  );

  const showBerserkButton =
    !!tournamentId &&
    tournamentType === 'arena' &&
    status === 'active' &&
    (playerColor === 'white' ? moves.length === 0 : moves.length <= 1) &&
    !(playerColor === 'white' ? whiteBerserk : blackBerserk);

  return (
    <>
      {/* KS-4308: отладочная панель `BotEngineDebugPanel` для пользователя
          `Stanislav`. Рендерится во всех партиях с ботом — проверка по
          `user.username === 'Stanislav'` внутри компонента, для всех
          остальных возвращает `null`. На партии человек-vs-человек не
          рендерится (`isBot=false`). */}
      {isBot && <BotEngineDebugPanel />}
      <GameShell
      chess={game}
      fen={fen}
      moves={moves}
      whiteClockMs={clockDisplay.whiteDisplayMs}
      blackClockMs={clockDisplay.blackDisplayMs}
      whiteClockMode={clockDisplay.whiteMode}
      blackClockMode={clockDisplay.blackMode}
      whiteClockUrgency={clockDisplay.whiteUrgency}
      blackClockUrgency={clockDisplay.blackUrgency}
      status={status}
      result={result}
      playerColor={playerColor}
      players={players}
      onMove={handleMove}
      enablePremove
      isOpponentMove={isOpponentMove}
      lastMove={lastMove}
      isBot={isBot}
      botLevel={botLevel}
      showBotBanner={isBot}
      drawOffered={drawOffered}
      canOfferDraw={!isBot}
      canResign
      onResign={handleResign}
      onDrawOffer={handleDrawOffer}
      onDrawAccept={handleDrawAccept}
      onDrawDecline={handleDrawDecline}
      showBerserkButton={showBerserkButton}
      onBerserk={handleBerserk}
      whiteBerserk={whiteBerserk}
      blackBerserk={blackBerserk}
      showResultModal={showResultModal}
      onCloseResultModal={() => setShowResultModal(false)}
      ratingChange={ratingChange}
      onRematch={handleRematch}
      canRematch={!isBot && !!gameMeta}
      rematchPending={challengeState === 'waiting'}
      onAnalyze={handleAnalyze}
      showAnalyzeButton
      newGameLink={
        tournamentId
          ? undefined
          : { to: '/lobby', label: t('gameResult.newGame') }
      }
      homeLink={
        tournamentId
          ? undefined
          : { to: '/', label: t('gameResult.home') }
      }
      tournamentReturn={
        tournamentId
          ? {
              to: `/tournaments/${tournamentId}`,
              label: t('gameResult.backToTournament', 'Back to Tournament'),
            }
          : undefined
      }
      chat={
        !isBot
          ? {
              messages,
              onSend: handleChatSend,
              currentUserId: user?.id,
            }
          : undefined
      }
      backLink={{ to: '/', label: t('game.backToLobby') }}
      showHelpButton
    />
    </>
  );
}
