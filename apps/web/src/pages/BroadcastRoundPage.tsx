import { useCallback, useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { useTranslation } from 'react-i18next';
import type {
  BroadcastGameSummary,
  BroadcastRoundItem,
} from '@kingside/shared';
import { broadcastApi } from '../api/broadcastApi';
import { openAnalysisFromPgn } from '../utils/openAnalysisFromPgn';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { BroadcastBoardCard } from '../components/broadcast/BroadcastBoardCard';
import {
  BroadcastLiveFeed,
  type BroadcastFeedItem,
} from '../components/broadcast/BroadcastLiveFeed';
import { sortGamesByWhite, gamesFingerprint } from '../utils/broadcastGameSort';
import { useBroadcastSocket } from '../hooks/useBroadcastSocket';
import { useBroadcastEvalQueue } from '../hooks/useBroadcastEvalQueue';
// KS-1823: условный рендер `PlayoffBracket` на странице раунда был
// регрессией (вкладка Rounds всегда должна показывать доски партий).
// Компонент остаётся в репо — он будет использован на вкладке
// Standings в KS-1825. Из BroadcastRoundPage импорт удалён.

/** Extract last move SAN from PGN for sound */
function loadPgnSafe(chess: InstanceType<typeof Chess>, pgn: string): boolean {
  try {
    chess.loadPgn(pgn);
    return true;
  } catch {
    try {
      chess.loadPgn(stripPgnComments(pgn));
      return true;
    } catch {
      return false;
    }
  }
}

function computeLastMoveSan(pgn: string): string | null {
  try {
    const chess = new Chess();
    if (!loadPgnSafe(chess, pgn)) return null;
    const hist = chess.history();
    return hist.length > 0 ? hist[hist.length - 1] : null;
  } catch {
    return null;
  }
}

/** KS-2705: достаём UCI последнего хода из PGN — это надёжнее
 *  diff'а FEN'ов и используется как fallback к `broadcast:move.uci`. */
function computeLastMoveUci(pgn: string): string | null {
  try {
    const chess = new Chess();
    if (!loadPgnSafe(chess, pgn)) return null;
    const hist = chess.history({ verbose: true });
    if (hist.length === 0) return null;
    const last = hist[hist.length - 1];
    return `${last.from}${last.to}${last.promotion ?? ''}`;
  } catch {
    return null;
  }
}

/**
 * KS-2712: робастная конверсия `uci → san` с тремя попытками. Возвращает
 * `{san, side, moveNumber}` если хотя бы одна сработала, иначе `null`
 * — вызывающий должен использовать UCI-fallback. Из всех источников
 * наиболее надёжный — pre-FEN до хода (там UCI легален и `chess.move`
 * сразу даёт SAN). Когда pre-FEN рассинхронизирован (race-condition
 * между двумя `broadcast:move`) — пробуем инвертировать side-to-move,
 * либо реверснуть post-FEN через chess.put/remove (chess.js не имеет
 * встроенного `undo` от FEN). Все ветки логируются.
 */
function uciToFeedSan(
  preFen: string | null,
  postFen: string,
  uci: string,
): { san: string; side: 'white' | 'black'; moveNumber: number } | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;

  // Попытка 1: канонический pre-FEN.
  if (preFen) {
    try {
      const c = new Chess(preFen);
      const m = c.move({ from, to, promotion });
      if (m) {
        const parts = preFen.split(' ');
        const side: 'white' | 'black' = parts[1] === 'b' ? 'black' : 'white';
        const moveNumber = parseInt(parts[5] ?? '1', 10) || 1;
        return { san: m.san, side, moveNumber };
      }
    } catch {
      /* try next */
    }
    // Попытка 2: pre-FEN с инвертированной стороной — на случай
    // рассинхрона state.currentFen с реальной side-to-move (race
    // между broadcast:move'ами или sync пропустил полуход).
    try {
      const parts = preFen.split(' ');
      const flippedSide = parts[1] === 'b' ? 'w' : 'b';
      parts[1] = flippedSide;
      const flippedFen = parts.join(' ');
      const c = new Chess(flippedFen);
      const m = c.move({ from, to, promotion });
      if (m) {
        const side: 'white' | 'black' =
          flippedSide === 'b' ? 'black' : 'white';
        const moveNumber = parseInt(parts[5] ?? '1', 10) || 1;
        // eslint-disable-next-line no-console
        console.log(
          `[feed-debug] uciToFeedSan recovered via inverted side: ${uci} → ${m.san}`,
        );
        return { san: m.san, side, moveNumber };
      }
    } catch {
      /* try next */
    }
  }

  // Попытка 3: восстановить pre-FEN из post-FEN'а (отменить ход).
  // chess.js не умеет грузить позицию + сделать undo одной операцией,
  // но можно перенести фигуру с `to` обратно на `from` и инвертировать
  // side-to-move. Capture'и нельзя восстановить (мы не знаем какую
  // фигуру сняли), но для определения SAN это и не нужно — chess.js
  // не повторно снимет «уже отсутствующую» фигуру.
  try {
    const c = new Chess(postFen);
    const piece = c.get(to as Parameters<typeof c.get>[0]);
    if (!piece) return null;
    c.remove(to as Parameters<typeof c.remove>[0]);
    c.put(piece, from as Parameters<typeof c.put>[0]);
    const parts = c.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    const reconstructed = parts.join(' ');
    const c2 = new Chess(reconstructed);
    const m = c2.move({ from, to, promotion });
    if (m) {
      const side: 'white' | 'black' = parts[1] === 'b' ? 'black' : 'white';
      const moveNumber = parseInt(parts[5] ?? '1', 10) || 1;
      // eslint-disable-next-line no-console
      console.log(
        `[feed-debug] uciToFeedSan recovered via postFen reconstruction: ${uci} → ${m.san}`,
      );
      return { san: m.san, side, moveNumber };
    }
  } catch {
    /* fall through */
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[feed-debug] uciToFeedSan failed all 3 attempts: uci=${uci} preFen=${preFen} postFen=${postFen}`,
  );
  return null;
}

/**
 * KS-2709: извлечь последний ход партии в виде {san, side, moveNumber}
 * из PGN. SAN — стандартная нотация (Bxd5, O-O, e4, Qxe7+ и т.п.).
 * moveNumber берём из FEN fullmove counter после применения хода:
 *  - если ход сделали чёрные → fullmove already incremented (next white move).
 *    moveNumber для строки ленты = postFullmove - 1.
 *  - если ход сделали белые → fullmove оставался прежним, инкрементится
 *    после хода чёрных. moveNumber = postFullmove.
 * Side вычисляем: после хода стороны меняются, side ходившего =
 *   opposite of postFen.side.
 */
function extractLastMoveFromPgn(
  pgn: string,
): { san: string; side: 'white' | 'black'; moveNumber: number } | null {
  try {
    const chess = new Chess();
    if (!loadPgnSafe(chess, pgn)) return null;
    const hist = chess.history({ verbose: true });
    if (hist.length === 0) return null;
    const last = hist[hist.length - 1];
    const postFen = chess.fen();
    const parts = postFen.split(' ');
    const postFullmove = parseInt(parts[5] ?? '1', 10) || 1;
    const postSide = parts[1] === 'b' ? 'black' : 'white';
    const playedSide: 'white' | 'black' =
      postSide === 'white' ? 'black' : 'white';
    const moveNumber =
      playedSide === 'black' ? postFullmove - 1 : postFullmove;
    return {
      san: last.san ?? `${last.from}${last.to}${last.promotion ?? ''}`,
      side: playedSide,
      moveNumber,
    };
  } catch {
    return null;
  }
}

/** Strip clock/eval comments that may cause chess.js loadPgn to fail */
function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

// Lichess types.
// NB: shared `BroadcastGameSummary` точнее шейпит bracket-поля (KS-1813);
// используем его, чтобы `PlayoffBracket` получил корректный тип.
type LichessGame = BroadcastGameSummary;


type LichessRoundInfo = BroadcastRoundItem;

type LichessBroadcastMeta = {
  id: string;
  title: string;
};

/**
 * KS-1747: Lichess-only round view. Рендерит список партий тура, с
 * подсветкой последнего хода и поллингом PGN каждые 15 секунд.
 */
export function BroadcastRoundPage() {
  const { tournamentId, roundId } = useParams<{ tournamentId: string; roundId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound, unlocked: soundUnlocked, unlockSounds } = useSounds();

  const [broadcast, setBroadcast] = useState<LichessBroadcastMeta | null>(null);
  const [rounds, setRounds] = useState<LichessRoundInfo[]>([]);
  const [games, setGames] = useState<LichessGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /**
   * Ключ партии (whitePlayer + blackPlayer + sourceId-fallback), которая
   * последней получила ход среди всех в раунде. До прежней версии
   * сравнение шло по `game.id`, но WS-payload broadcast:sync иногда
   * приходит без `id` → undefined === undefined → подсветка на всех.
   * Сейчас ключ всегда строится из имён игроков — они есть в любом
   * формате payload'а, что даёт стабильное сравнение.
   */
  const [lastMoveKey, setLastMoveKey] = useState<string | null>(null);
  /**
   * KS-2705. Карта `gameKey → lastMoveUci` (`e2e4`). Заполняется в
   * `handleMove` (приходит uci сразу) и в `applyFreshGames` (берём
   * последний ход из PGN). Передаём в `BroadcastBoardCard` как `lastMoveUci`,
   * чтобы подсветка рисовалась по реальному ходу одного игрока, а не
   * по diff FEN'ов (который ловил две разные фигуры разных цветов
   * при пропуске snapshot'а — см. жалобу).
   */
  const [lastMoveUciMap, setLastMoveUciMap] = useState<Record<string, string>>(
    () => ({}),
  );
  /** KS-2707. Feed последних ходов раунда (max 50, новые сверху). */
  const [liveFeed, setLiveFeed] = useState<BroadcastFeedItem[]>([]);
  /**
   * KS-2707. Карточка, кратковременно подсвеченная после клика по
   * строке ленты (≠ `lastMoveKey` — это про last-move highlight доски).
   */
  const [flashedKey, setFlashedKey] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** KS-2707. ref'ы карточек по `gameKey` для scrollIntoView. */
  const cardRefsRef = useRef<Record<string, HTMLElement | null>>({});

  // KS-2708: один shared WASM Stockfish + FIFO очередь анализа.
  const { evals: evalsByKey, enqueue: enqueueEval } = useBroadcastEvalQueue();

  // Initial load: broadcast meta + rounds + games
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;

    setLoading(true);
    Promise.all([
      broadcastApi.get<LichessBroadcastMeta>(`/${tournamentId}`),
      broadcastApi.get<{ data: LichessRoundInfo[] }>(`/${tournamentId}/rounds`),
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
    ])
      .then(([meta, roundsRes, gamesRes]) => {
        if (cancelled) return;
        setBroadcast(meta);
        setRounds(Array.isArray(roundsRes?.data) ? roundsRes.data : []);
        setGames(sortGamesByWhite(Array.isArray(gamesRes?.data) ? gamesRes.data : []));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, roundId, t]);

  // KS-2701: live-обновления через WebSocket. До тикета — REST polling
  // 15s. Backend публикует `broadcast:sync` при каждом изменении
  // раунда (включая обновления `whiteClockMs`/etc по KS-2699). Здесь
  // подписываемся, ловим snapshot, проигрываем звук и обновляем `games`.
  // REST остаётся:
  //   - initial-fetch (выше) — нам нужны данные ДО connect'а сокета;
  //   - fallback-polling ниже — только когда `connected=false`.
  const prevGamesRef = useRef<LichessGame[]>([]);

  // Ключ партии для сравнения «эта ли получила ход последней».
  // Имена игроков стабильны между WS и REST, в отличие от `id` который
  // в WS-payload иногда отсутствует.
  const gameKey = (g: LichessGame): string =>
    `${g.whitePlayer ?? ''}|${g.blackPlayer ?? ''}`;

  const applyFreshGames = useCallback(
    (rawFresh: LichessGame[], shouldPlaySound: boolean) => {
      // KS-2710: WS broadcast:sync шлёт игры с полем `fen`, REST API
      // даёт `currentFen`. Нормализуем shape ДО любой обработки —
      // иначе после первого WS-sync пропадают clocks (KS-2700),
      // last-move highlight (KS-2705) и eval-bar (KS-2708), потому
      // что они ожидают `currentFen`.
      const fresh: LichessGame[] = rawFresh.map((g) => {
        if (g.currentFen) return g;
        const fenAlt = (g as unknown as { fen?: string }).fen;
        return fenAlt ? { ...g, currentFen: fenAlt } : g;
      });
      const prev = prevGamesRef.current;
      // KS-2702: ищем партию(-ии) в которых увеличилась PGN-длина
      // относительно prev — это и есть «получили новый ход в этом
      // апдейте». Берём ПЕРВУЮ найденную для звука и подсветки. Если
      // prev пуст (initial-sync) — пропускаем оба эффекта, чтобы при
      // заходе не было ложного звука и подсветка стартовала чистой.
      let advancedKey: string | null = null;
      let advancedSan: string | null = null;
      if (prev.length > 0) {
        for (const g of fresh) {
          const k = gameKey(g);
          const prevGame = prev.find((p) => gameKey(p) === k);
          const prevPgnLen = prevGame?.pgn?.length ?? 0;
          const curPgnLen = g.pgn?.length ?? 0;
          if (curPgnLen > prevPgnLen && g.pgn) {
            advancedKey = k;
            advancedSan = computeLastMoveSan(g.pgn);
            break;
          }
        }
      }
      // KS-2704: диагностика звука. Логируем полное состояние,
      // которое предшествует вызову playSound — чтобы по console-логу
      // пользователя можно было точно увидеть, дошли ли мы до WS-
      // обработчика, есть ли advancedSan, не выкошен ли звук флагом
      // shouldPlaySound. Логи будут удалены вместе с финальным фиксом.
      // eslint-disable-next-line no-console
      console.log(
        `[broadcast-sound] applyFreshGames advancedSan=${advancedSan ?? 'null'} shouldPlaySound=${shouldPlaySound} prev.length=${prev.length}`,
      );
      if (shouldPlaySound && advancedSan) {
        const sinceMove = Date.now() - lastSoundAtRef.current;
        if (sinceMove < 1500) {
          // eslint-disable-next-line no-console
          console.log(
            `[broadcast-sound] sync sound suppressed (handleMove already played ${sinceMove}ms ago)`,
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[broadcast-sound] calling playSound for san=${advancedSan}`,
          );
          playSound(soundEventFromSan(advancedSan));
          lastSoundAtRef.current = Date.now();
        }
      }
      // На diff'е ставим key партии, у которой PGN вырос.
      // На initial-sync (prev пуст) — выбираем партию по самому свежему
      // clockUpdatedAt (fallback: самая длинная PGN). На тихих апдейтах
      // оставляем предыдущее значение.
      if (advancedKey !== null) {
        setLastMoveKey(advancedKey);
      } else if (prev.length === 0) {
        let latestKey: string | null = null;
        let latestTs = -Infinity;
        for (const g of fresh) {
          const ts = g.clockUpdatedAt
            ? new Date(g.clockUpdatedAt).getTime()
            : NaN;
          if (Number.isFinite(ts) && ts > latestTs) {
            latestTs = ts;
            latestKey = gameKey(g);
          }
        }
        if (latestKey === null) {
          let maxLen = -1;
          for (const g of fresh) {
            const len = g.pgn?.length ?? 0;
            if (len > maxLen) {
              maxLen = len;
              latestKey = gameKey(g);
            }
          }
        }
        setLastMoveKey(latestKey);
      }
      // KS-2705: пересчитываем lastMoveUci для каждой партии по PGN'у
      // — это даёт точный from→to ровно одной фигуры, даже если diff
      // FEN'ов выглядит как два разных хода.
      const uciNext: Record<string, string> = {};
      for (const g of fresh) {
        const u = computeLastMoveUci(g.pgn ?? '');
        if (u) uciNext[gameKey(g)] = u;
      }
      setLastMoveUciMap(uciNext);

      // KS-2708: при initial-sync ставим в очередь оценку текущей
      // позиции каждой live-партии. На последующих syncn'ах добавляем
      // только те, где PGN вырос (учитывает diff PGN-длин выше).
      // Завершённые партии (result !== '*') пропускаем.
      const isInitial = prev.length === 0;
      const newFeedItems: BroadcastFeedItem[] = [];
      for (const g of fresh) {
        if (g.result && g.result !== '*') continue;
        const fenForEval = g.currentFen;
        if (!fenForEval) continue;
        const prevG = prev.find((p) => gameKey(p) === gameKey(g));
        const grew =
          (prevG?.pgn?.length ?? 0) < (g.pgn?.length ?? 0);
        if (isInitial) {
          enqueueEval(gameKey(g), fenForEval);
          // На initial-sync кладём last move каждой live-партии
          // в feed (источник: PGN.history.at(-1)). Это устраняет
          // задержку 30-60 сек до первого нового sync'а — пользователь
          // сразу видит активность раунда.
          const last = extractLastMoveFromPgn(g.pgn ?? '');
          if (last) {
            newFeedItems.push({
              gameKey: gameKey(g),
              whitePlayer: g.whitePlayer ?? '?',
              blackPlayer: g.blackPlayer ?? '?',
              side: last.side,
              moveNumber: last.moveNumber,
              notation: last.san,
              ts: g.clockUpdatedAt
                ? new Date(g.clockUpdatedAt).getTime()
                : Date.now() - 60_000, // initial-batch — не «сейчас»
            });
          }
        } else if (grew) {
          enqueueEval(gameKey(g), fenForEval);
          const last = extractLastMoveFromPgn(g.pgn ?? '');
          if (last) {
            newFeedItems.push({
              gameKey: gameKey(g),
              whitePlayer: g.whitePlayer ?? '?',
              blackPlayer: g.blackPlayer ?? '?',
              side: last.side,
              moveNumber: last.moveNumber,
              notation: last.san,
              ts: Date.now(),
            });
          }
        }
      }
      if (newFeedItems.length > 0) {
        // Сортируем по ts (новые сверху). Для initial-batch это будет
        // порядок свежести clockUpdatedAt.
        newFeedItems.sort((a, b) => b.ts - a.ts);
        setLiveFeed((prevFeed) => {
          // dedup: отфильтровываем те newFeedItems, чей (gameKey,
          // moveNumber, side) уже есть в первых 10 строках ленты —
          // защита от дубля «move уже добавил, sync пытается ещё раз».
          const recentKeys = new Set(
            prevFeed.slice(0, 10).map(
              (i) => `${i.gameKey}|${i.moveNumber}|${i.side}`,
            ),
          );
          const filtered = newFeedItems.filter(
            (i) =>
              !recentKeys.has(`${i.gameKey}|${i.moveNumber}|${i.side}`),
          );
          if (filtered.length === 0) return prevFeed;
          return [...filtered, ...prevFeed].slice(0, 50);
        });
      }

      const fingerprint = gamesFingerprint(fresh);
      const prevFingerprint = gamesFingerprint(prev);
      if (prev.length === 0 || fingerprint !== prevFingerprint) {
        setGames(sortGamesByWhite(fresh));
      }
      prevGamesRef.current = fresh;
    },
    [playSound, enqueueEval],
  );

  const handleSync = useCallback(
    (payload: { games: LichessGame[] }) => {
      applyFreshGames(payload.games ?? [], true);
    },
    [applyFreshGames],
  );

  // KS-2702: `broadcast:move` — короткий апдейт, прилетает раньше
  // следующего `sync`. Поднимаем highlight на этой партии немедленно
  // и патчим её `currentFen` для перерисовки доски без ожидания PGN.
  // Звук тут НЕ играем — следующий sync обязательно догонит с обновлёнными
  // PGN/clocks (KS-2701) и проиграет звук там, иначе будет дубль.
  // Защита от дубля звука: при `broadcast:move` играем сразу, при
  // последующем `broadcast:sync` (если он прилетит с обновлённым PGN)
  // diff увидит рост → попытается сыграть второй раз. Запоминаем
  // момент последнего звука и в applyFreshGames пропускаем sound-call
  // если прошло меньше 1500мс.
  const lastSoundAtRef = useRef<number>(0);

  const handleMove = useCallback(
    (payload: {
      gameIndex: number;
      uci: string;
      fen: string;
      whitePlayer?: string | null;
      blackPlayer?: string | null;
    }) => {
      let pre: { fen: string | null; whitePlayer: string; blackPlayer: string } | null = null;
      setGames((prev) => {
        if (prev.length === 0) return prev;
        const idx = prev.findIndex(
          (g) =>
            (payload.whitePlayer && payload.whitePlayer === g.whitePlayer) ||
            (payload.blackPlayer && payload.blackPlayer === g.blackPlayer),
        );
        const target = idx >= 0 ? idx : payload.gameIndex;
        if (target < 0 || target >= prev.length) return prev;
        const next = prev.slice();
        const g = next[target];
        // KS-2707: сохраняем pre-FEN партии — он нужен для конвертации
        // payload.uci → SAN внутри ленты.
        pre = {
          fen: g.currentFen ?? null,
          whitePlayer: g.whitePlayer ?? '',
          blackPlayer: g.blackPlayer ?? '',
        };
        next[target] = { ...g, currentFen: payload.fen };
        const k = gameKey(g);
        // KS-2705: сохраняем точный UCI хода, чтобы подсветка в карточке
        // рисовалась по нему, а не по diff FEN'ов.
        Promise.resolve().then(() => {
          setLastMoveKey(k);
          if (payload.uci) {
            setLastMoveUciMap((prev2) => ({ ...prev2, [k]: payload.uci }));
          }
        });
        return next;
      });
      // KS-2708: новый ход → enqueue анализа (replace-by-key).
      if (pre && (pre as { fen: string | null }).fen) {
        enqueueEval(
          `${(pre as { whitePlayer: string; blackPlayer: string }).whitePlayer}|${(pre as { whitePlayer: string; blackPlayer: string }).blackPlayer}`,
          payload.fen,
        );
      }
      // Играем звук сразу — даже если sync не догонит с PGN, юзер
      // услышит ход. soundEventFromSan нам недоступен (нет san), берём
      // обычный 'move'. Capture/check тут не различаем — backend в move
      // payload san не отдаёт.
      playSound('move');
      lastSoundAtRef.current = Date.now();

      // Добавляем в ленту прямо здесь — sync может прийти с
      // задержкой 30+ сек. KS-2712: робастная конверсия UCI→SAN
      // через `uciToFeedSan` (3 попытки). Если все провалились —
      // печатаем UCI и считаем moveNumber/side из postFen (после
      // payload.fen применён — side инвертирован, moveNumber возможно
      // вырос).
      if (pre && payload.uci) {
        const preCast = pre as {
          fen: string | null;
          whitePlayer: string;
          blackPlayer: string;
        };
        const conv = uciToFeedSan(
          preCast.fen,
          payload.fen,
          payload.uci,
        );
        let san = payload.uci;
        let side: 'white' | 'black' = 'white';
        let moveNumber = 1;
        if (conv) {
          san = conv.san;
          side = conv.side;
          moveNumber = conv.moveNumber;
        } else if (payload.fen) {
          // Все три попытки провалились — пытаемся хотя бы вытащить
          // moveNumber/side из postFEN (side инвертируем обратно).
          const parts = payload.fen.split(' ');
          const postSide: 'white' | 'black' =
            parts[1] === 'b' ? 'black' : 'white';
          side = postSide === 'white' ? 'black' : 'white';
          const postFullmove = parseInt(parts[5] ?? '1', 10) || 1;
          moveNumber =
            side === 'black' ? postFullmove - 1 : postFullmove;
        }
        const item: BroadcastFeedItem = {
          gameKey: `${preCast.whitePlayer}|${preCast.blackPlayer}`,
          whitePlayer:
            preCast.whitePlayer || (payload.whitePlayer ?? '?'),
          blackPlayer:
            preCast.blackPlayer || (payload.blackPlayer ?? '?'),
          side,
          moveNumber,
          notation: san,
          ts: Date.now(),
        };
        setLiveFeed((prevFeed) => {
          // dedup: если такая же запись уже на верху ленты (move
          // продублировался следующим sync'ом или повторился), не
          // добавляем повторно.
          const top = prevFeed[0];
          if (
            top &&
            top.gameKey === item.gameKey &&
            top.moveNumber === item.moveNumber &&
            top.side === item.side
          ) {
            return prevFeed;
          }
          return [item, ...prevFeed].slice(0, 50);
        });
      }
    },
    [playSound, enqueueEval],
  );

  const { connected } = useBroadcastSocket({
    roundId: roundId ?? null,
    onSync: handleSync,
    onMove: handleMove,
  });

  // KS-2707: scroll + flash highlight при клике по строке ленты.
  const handleFeedClick = useCallback((gKey: string) => {
    const node = cardRefsRef.current[gKey];
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setFlashedKey(gKey);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashedKey(null), 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // KS-2701: REST-polling fallback. Запускается только если WS НЕ
  // подключён (или ещё не подключился). Период 30с — без WS обновления
  // раунда нечастые (партия классическая, ходы раз в минуту), 15→30с
  // снижает нагрузку без потери UX.
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    if (connected) return;

    let cancelled = false;
    let isFirstFetch = true;

    const fetchGames = () => {
      broadcastApi
        .get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`)
        .then((res) => {
          if (cancelled) return;
          const fresh = Array.isArray(res?.data) ? res.data : [];
          // На первом fetch'е (после disconnect/initial) звук не играем
          // — это «догоняющая» синхронизация, а не новый ход.
          applyFreshGames(fresh, !isFirstFetch);
          isFirstFetch = false;
        })
        .catch(() => {});
    };

    const intervalId = setInterval(fetchGames, 30_000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [tournamentId, roundId, connected, applyFreshGames]);

  const currentRound = rounds.find((r) => r.id === roundId);

  const handleGameClick = (game: LichessGame) => {
    if (!game.pgn) return;
    // KS-2448: для live-партий (текущий тур ongoing, результат ещё не
    // определён) уходим на live-страницу с подпиской на обновления, а не
    // в Мастерскую (она замораживала позицию). Для завершённых партий
    // прежнее поведение — `openAnalysisFromPgn` → `/analysis/<id>`.
    const isLive =
      currentRound?.status === 'ongoing' && (!game.result || game.result === '*');
    if (isLive) {
      navigate(`/broadcasts/${tournamentId}/${roundId}/${game.id}/live`);
      return;
    }
    void openAnalysisFromPgn(navigate, {
      pgn: game.pgn,
      title: `${game.whitePlayer} vs ${game.blackPlayer}`,
      state: {
        breadcrumbRootTitle: broadcast?.title ?? '',
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
        breadcrumbSection: currentRound?.name,
        breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
      },
    });
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast) {
    return <div className="error">{error || t('broadcasts.error', 'Failed to load broadcast')}</div>;
  }

  return (
    <div className="broadcast-round-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {broadcast.title}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{currentRound?.name ?? ''}</span>
      </nav>

      {/* KS-2703: явный CTA для разблокировки звука. AudioContext'у
          в новой вкладке нужен user-gesture для запуска (autoplay-policy);
          без видимой кнопки юзер не догадывается, что нужно тыкнуть на
          страницу. Баннер уходит когда `unlocked=true` (Chrome перевёл
          ctx в `running` — звук теперь играет). */}
      {!soundUnlocked && (
        <button
          type="button"
          className="broadcast-sound-unlock"
          onClick={unlockSounds}
          data-testid="broadcast-sound-unlock"
        >
          {t('broadcastRound.enableSound', '🔔 Enable move sound')}
        </button>
      )}

      {/* Round tabs */}
      <div className="broadcast-rounds-row">
        {rounds.map((r) => (
          <Link
            key={r.id}
            to={`/broadcasts/${tournamentId}/${r.id}`}
            className={`broadcast-round-btn${r.id === roundId ? ' broadcast-round-btn--active' : ''}`}
          >
            {r.name}
          </Link>
        ))}
      </div>

      {games.length === 0 ? (
        <div className="broadcasts-empty">{t('broadcastRound.noGames', 'No games in this round')}</div>
      ) : (
        // KS-2707: layout двух-колоночный: сетка партий слева, лента
        // ходов справа. На mobile feed уезжает в accordion внизу.
        <div className="broadcast-games-section broadcast-games-section--with-feed">
          <div className="broadcast-boards-grid">
            {games.map((game) => {
              const k = gameKey(game);
              return (
                <div
                  key={game.id}
                  ref={(el) => {
                    cardRefsRef.current[k] = el;
                  }}
                  className={`broadcast-board-card-wrap${flashedKey === k ? ' broadcast-board-card-wrap--flash' : ''}`}
                >
                  <BroadcastBoardCard
                    game={game}
                    onGameClick={handleGameClick}
                    showLastMoveHighlight={
                      lastMoveKey !== null && k === lastMoveKey
                    }
                    lastMoveUci={lastMoveUciMap[k] ?? null}
                    evalSnap={evalsByKey[k] ?? null}
                  />
                </div>
              );
            })}
          </div>
          <BroadcastLiveFeed items={liveFeed} onItemClick={handleFeedClick} />
        </div>
      )}
    </div>
  );
}
