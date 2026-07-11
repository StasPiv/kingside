import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
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
import { RoundCountdown } from '../components/broadcast/RoundCountdown';
import { PairingCard } from '../components/broadcast/PairingCard';
import {
  sortGamesByWhite,
  sortGamesByLastMove,
  gamesFingerprint,
} from '../utils/broadcastGameSort';
import { useBroadcastSocket } from '../hooks/useBroadcastSocket';
import { useBroadcastEvalQueue } from '../hooks/useBroadcastEvalQueue';
import { useLichessPgnStream } from '../hooks/useLichessPgnStream';
// KS-3261: batch-проверка «В мастерской» через POST /analyses/check.
import { checkAnalyses } from '../api/checkAnalyses';
import { useAuth } from '../context/AuthContext';
import { SeoHelmet } from '../components/seo/SeoHelmet';
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

/** Strip clock/eval comments that may cause chess.js loadPgn to fail */
function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

/**
 * KS-4856 / ADR-159 §3.2 п.2 + KS-4861: merge клиентского snapshot'а из
 * direct-stream с серверным.
 *
 *  - Серверный список — авторитет по составу партий и bracket-полям
 *    (`id` UUID из БД, `bracketStage`, `bracketPairId`, `matchScore`).
 *  - Клиентский snapshot — авторитет по свежести: fen, clocks, pgn,
 *    result, lastMoveAt.
 *  - Партии из stream, которых нет в server (ещё не занесены при
 *    переходе pending → ongoing) — добавляем как есть.
 *
 * KS-4861: fallback-матч по паре игроков `(whitePlayer, blackPlayer)`
 * — если у серверной записи `lichessGameId=null` (партии до KS-3229),
 * либо WS-payload `broadcast:sync` пришёл без `lichessGameId`, либо
 * server и client получили id по разным путям
 * (`GameURL` vs `Site` vs `round:X.Y`) — stream и server всё равно
 * сматчатся по одному и тому же поединку. До KS-4861 из-за одиночного
 * матча по `lichessGameId` тот же поединок попадал в extras → пользователь
 * видел две карточки одной партии на странице ongoing раунда.
 */
export function mergeStreamedGames(
  serverGames: readonly BroadcastGameSummary[],
  streamedGames: readonly BroadcastGameSummary[],
): BroadcastGameSummary[] {
  const norm = (s: string | null | undefined) =>
    (s ?? '').trim().toLowerCase();
  const pairKey = (
    w: string | null | undefined,
    b: string | null | undefined,
  ) => {
    const wk = norm(w);
    const bk = norm(b);
    if (!wk || !bk) return null;
    return `pair:${wk}|${bk}`;
  };

  const merged = new Map<string, BroadcastGameSummary>();
  const serverOrder: string[] = [];
  const idIndex = new Map<string, string>(); // lichessGameId → merged-key
  const pairIndex = new Map<string, string>(); // pair-key → merged-key

  for (const s of serverGames) {
    const key = s.lichessGameId ?? `srv:${s.id || Math.random().toString(36).slice(2)}`;
    merged.set(key, s);
    serverOrder.push(key);
    if (s.lichessGameId) idIndex.set(s.lichessGameId, key);
    const pk = pairKey(s.whitePlayer, s.blackPlayer);
    if (pk) pairIndex.set(pk, key);
  }

  const extraStreamKeys: string[] = [];
  for (const c of streamedGames) {
    // Ищем совпадение сначала по идентификатору партии Lichess,
    // потом — по паре игроков (KS-4861 fallback).
    const lookupKey =
      (c.lichessGameId && idIndex.get(c.lichessGameId)) ||
      pairIndex.get(pairKey(c.whitePlayer, c.blackPlayer) ?? '__none__');
    if (lookupKey) {
      const srv = merged.get(lookupKey);
      if (!srv) continue;
      merged.set(lookupKey, {
        ...srv,
        // KS-4861: если у server-записи `lichessGameId=null`, а stream
        // его знает — сохраняем в merged, чтобы последующие round-trip'ы
        // WS/REST уже находили её по id и не создавали дубль.
        lichessGameId: srv.lichessGameId ?? c.lichessGameId ?? null,
        whiteElo: srv.whiteElo ?? c.whiteElo ?? null,
        blackElo: srv.blackElo ?? c.blackElo ?? null,
        pgn: c.pgn ?? srv.pgn,
        currentFen: c.currentFen ?? srv.currentFen,
        result:
          c.result && c.result !== '*'
            ? c.result
            : (srv.result ?? c.result ?? null),
        whiteClockMs: c.whiteClockMs ?? srv.whiteClockMs ?? null,
        blackClockMs: c.blackClockMs ?? srv.blackClockMs ?? null,
        clockUpdatedAt: c.clockUpdatedAt ?? srv.clockUpdatedAt ?? null,
        lastMoveAt: c.lastMoveAt ?? srv.lastMoveAt ?? null,
      });
      continue;
    }
    // Партия из stream без совпадения в server — добавляем как есть,
    // регистрируя в обоих индексах, чтобы следующий tick того же stream'а
    // не породил ещё одну копию.
    const extraKey = c.lichessGameId ?? `stream:${extraStreamKeys.length}`;
    merged.set(extraKey, c);
    extraStreamKeys.push(extraKey);
    if (c.lichessGameId) idIndex.set(c.lichessGameId, extraKey);
    const pk = pairKey(c.whitePlayer, c.blackPlayer);
    if (pk) pairIndex.set(pk, extraKey);
  }

  const out: BroadcastGameSummary[] = [];
  for (const k of serverOrder) {
    const g = merged.get(k);
    if (g) out.push(g);
  }
  for (const k of extraStreamKeys) {
    const g = merged.get(k);
    if (g) out.push(g);
  }
  return out;
}

/** Финальный результат партии (учитывает юникодную «½-½»). */
function isFinalResult(result: string | null | undefined): boolean {
  if (!result) return false;
  const r = result.replace(/½/g, '1/2');
  return r === '1-0' || r === '0-1' || r === '1/2-1/2';
}

/**
 * KS-4889. Защита локального состояния от отката устаревшим снимком.
 *
 * После ADR-159 (клиентская трансляция; backend 8d3920ce удалил
 * runStream) сервер НЕ обновляет партии ongoing-раунда — его снимок
 * заморожен на момент импорта. При этом REST-опрос (30 с) и WS-sync
 * продолжают вызывать `applyFreshGames` этим замороженным снимком и
 * затирали живые данные клиентского потока:
 *  - партия завершилась (стрим принёс `result='1/2-1/2'`) → через ≤30 с
 *    REST возвращал `result='*'` — результат исчезал из карточки;
 *  - `lastMoveAt` стрим не знает (в PGN Lichess нет wall-clock хода),
 *    а серверный заморожен → подпись «N минут назад» никогда не
 *    обновлялась, хотя позиция росла.
 *
 * Правила (сравнение по паре игроков, как в `mergeStreamedGames`):
 *  - fresh с более коротким PGN — отстал: сохраняем прежние
 *    pgn/fen/clocks;
 *  - финальный результат не откатываем к '*'/null;
 *  - PGN вырос (новый ход) — `lastMoveAt = nowIso`, если fresh не
 *    принёс значение новее прежнего;
 *  - без нового хода `lastMoveAt` не даунгрейдим к более старому/null.
 */
export function guardStaleSnapshot(
  prev: readonly BroadcastGameSummary[],
  fresh: readonly BroadcastGameSummary[],
  nowIso: string,
): BroadcastGameSummary[] {
  if (prev.length === 0) return [...fresh];
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  const keyOf = (g: BroadcastGameSummary) =>
    `${norm(g.whitePlayer)}|${norm(g.blackPlayer)}`;
  const prevByKey = new Map<string, BroadcastGameSummary>();
  for (const p of prev) prevByKey.set(keyOf(p), p);

  return fresh.map((g) => {
    const prevG = prevByKey.get(keyOf(g));
    if (!prevG) return g;
    let out = g;

    const prevLen = prevG.pgn?.length ?? 0;
    if ((out.pgn?.length ?? 0) < prevLen) {
      out = {
        ...out,
        pgn: prevG.pgn,
        currentFen: prevG.currentFen,
        whiteClockMs: prevG.whiteClockMs ?? out.whiteClockMs ?? null,
        blackClockMs: prevG.blackClockMs ?? out.blackClockMs ?? null,
        clockUpdatedAt: prevG.clockUpdatedAt ?? out.clockUpdatedAt ?? null,
      };
    }

    if (isFinalResult(prevG.result) && !isFinalResult(out.result)) {
      out = { ...out, result: prevG.result };
    }

    const prevTs = prevG.lastMoveAt ? Date.parse(prevG.lastMoveAt) : NaN;
    const curTs = out.lastMoveAt ? Date.parse(out.lastMoveAt) : NaN;
    const grew = (out.pgn?.length ?? 0) > prevLen;
    if (grew) {
      const freshIsNewer =
        Number.isFinite(curTs) && (!Number.isFinite(prevTs) || curTs > prevTs);
      if (!freshIsNewer) out = { ...out, lastMoveAt: nowIso };
    } else if (
      Number.isFinite(prevTs) &&
      (!Number.isFinite(curTs) || prevTs > curTs)
    ) {
      out = { ...out, lastMoveAt: prevG.lastMoveAt };
    }
    return out;
  });
}

// Lichess types.
// NB: shared `BroadcastGameSummary` точнее шейпит bracket-поля (KS-1813);
// используем его, чтобы `PlayoffBracket` получил корректный тип.
type LichessGame = BroadcastGameSummary;

/** KS-4893: localStorage-ключ выбранного режима сортировки досок. */
const SORT_MODE_STORAGE_KEY = 'broadcast.boardsSortMode';


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

  // KS-4893: режим сортировки досок. 'default' — текущий порядок
  // (по фамилии белых, как и раньше), 'lastMove' — самые свежие ходы
  // первыми (живой lastMoveAt из KS-4889). Выбор переживает
  // перезагрузку через localStorage.
  const [sortMode, setSortMode] = useState<'default' | 'lastMove'>(() => {
    try {
      return window.localStorage.getItem(SORT_MODE_STORAGE_KEY) === 'lastMove'
        ? 'lastMove'
        : 'default';
    } catch {
      return 'default';
    }
  });
  const changeSortMode = useCallback((next: 'default' | 'lastMove') => {
    setSortMode(next);
    try {
      window.localStorage.setItem(SORT_MODE_STORAGE_KEY, next);
    } catch {
      /* privacy mode и т. п. */
    }
  }, []);
  // Сортировку по последнему ходу применяем на рендере: state `games`
  // всегда хранится в порядке по умолчанию, поэтому переключение назад
  // мгновенно возвращает исходный порядок. `games` обновляется на
  // каждом значимом снимке (fingerprint учитывает pgn/clockUpdatedAt),
  // так что порядок живёт вместе с новыми ходами.
  const displayGames = useMemo(
    () => (sortMode === 'lastMove' ? sortGamesByLastMove(games) : games),
    [sortMode, games],
  );
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

  // KS-2708: один shared WASM Stockfish + FIFO очередь анализа.
  const { evals: evalsByKey, enqueue: enqueueEval } = useBroadcastEvalQueue();

  // KS-3261: map lichessGameId → есть ли у пользователя analysis.
  // Заполняется
  // через batch POST /analyses/check после загрузки списка партий раунда.
  // Бейдж «В мастерской» виден только авторизованным; гостям не дёргаем.
  const { user } = useAuth();
  const [inWorkshopMap, setInWorkshopMap] = useState<Record<string, boolean>>(
    () => ({}),
  );
  useEffect(() => {
    if (!user) return;
    const lichessIds = games
      .map((g) => (g as { lichessGameId?: string }).lichessGameId)
      .filter((v): v is string => Boolean(v));
    if (lichessIds.length === 0) return;
    let cancelled = false;
    void checkAnalyses({ lichessGameIds: lichessIds }).then((res) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const id of lichessIds) {
        next[id] = Boolean(res.lichess?.[id]);
      }
      setInWorkshopMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [user, games]);

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
      const normalized: LichessGame[] = rawFresh.map((g) => {
        if (g.currentFen) return g;
        const fenAlt = (g as unknown as { fen?: string }).fen;
        return fenAlt ? { ...g, currentFen: fenAlt } : g;
      });
      const prev = prevGamesRef.current;
      // KS-4889: REST-опрос и WS-sync после ADR-159 приносят замороженный
      // серверный снимок — не даём ему откатить result/pgn/fen живого
      // клиентского потока; здесь же проставляется lastMoveAt при росте
      // PGN (стрим wall-clock хода не знает, сервер его не обновляет).
      const fresh = guardStaleSnapshot(prev, normalized, new Date().toISOString());
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
      if (shouldPlaySound && advancedSan) {
        const sinceMove = Date.now() - lastSoundAtRef.current;
        // KS-2704: ≥1500мс защита от двойного воспроизведения, когда и
        // sync-апдейт, и broadcast:move прилетают почти одновременно.
        if (sinceMove >= 1500) {
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
      for (const g of fresh) {
        if (g.result && g.result !== '*') continue;
        const fenForEval = g.currentFen;
        if (!fenForEval) continue;
        const prevG = prev.find((p) => gameKey(p) === gameKey(g));
        const grew =
          (prevG?.pgn?.length ?? 0) < (g.pgn?.length ?? 0);
        if (isInitial || grew) {
          enqueueEval(gameKey(g), fenForEval);
        }
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
    },
    [playSound, enqueueEval],
  );

  const { connected } = useBroadcastSocket({
    roundId: roundId ?? null,
    onSync: handleSync,
    onMove: handleMove,
  });

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

  // KS-4856 / ADR-159 §2.2 + §3.2: клиентский direct-stream к Lichess.
  // Хук сам проверяет фиче-флаг `VITE_BROADCAST_DIRECT_STREAM_ENABLED`;
  // при выключенном флаге возвращает status='idle' и никаких запросов
  // не делает — старый путь через WS работает как прежде.
  const lichessRoundId = currentRound?.lichessRoundId ?? null;
  const streamActive = currentRound?.status === 'ongoing';
  const stream = useLichessPgnStream({
    lichessRoundId,
    enabled: streamActive,
  });

  // Merge клиентского snapshot'а с локальным state. По ADR-159 §3.2 п.2:
  // клиент приоритетен для fen/clocks/lastMoveAt/pgn/result; серверные
  // bracket-поля (id/bracketStage/bracketPairId/matchScore) сохраняются.
  useEffect(() => {
    if (!stream.games) return;
    const merged = mergeStreamedGames(prevGamesRef.current, stream.games);
    applyFreshGames(merged, true);
    // Реагируем на новый snapshot; applyFreshGames обновляет ref сам.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.games]);

  // Индикатор состояния канала: streaming/fallback/offline. WS-подключение
  // остаётся всегда — если direct-stream упал в fallback и WS открыт,
  // помечаем «замедленно»; если и WS отключён — «оффлайн».
  const channelIndicator: 'streaming' | 'slow' | 'offline' | 'hidden' =
    !streamActive
      ? 'hidden'
      : stream.status === 'streaming'
        ? 'streaming'
        : stream.status === 'fallback' && !connected
          ? 'offline'
          : stream.status === 'fallback'
            ? 'slow'
            : !connected
              ? 'offline'
              : 'hidden';

  const handleGameClick = (game: LichessGame) => {
    if (!game.pgn) return;
    // KS-2774: backend `:9754d58b` теперь шлёт `id` в REST и WS payload.
    // Если поле всё-таки пустое (нет lichessGameId / partial sync) —
    // не строим URL `/broadcasts/.../undefined/live`, игнорируем клик.
    if (!game.id) return;
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
      // KS-3261: lichessGameId для dedup. Backend (1b18d16f) при повторном
      // открытии той же партии вернёт existing analysis-id, не создаст дубль.
      lichessGameId:
        (game as { lichessGameId?: string }).lichessGameId ?? undefined,
      state: {
        breadcrumbRootTitle: broadcast?.title ?? '',
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
        breadcrumbSection: currentRound?.name,
        breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
      },
      // KS-3333: передаём t для локализации alert при ошибке POST.
      t,
    });
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast) {
    return <div className="error">{error || t('broadcasts.error', 'Failed to load broadcast')}</div>;
  }

  // KS-4183 / ADR-128 §7.6.1.2 B3. Description зависит от наличия
  // партий: если игр в туре нет (часто перед стартом) — используем
  // `descriptionNoGames`. JSON-LD type=SportsEvent (раунд как часть
  // турнира).
  const seoRoundName = currentRound?.name ?? '';
  const seoTitle = t('seo.broadcasts.round.title', {
    tournament: broadcast.title,
    round: seoRoundName,
  });
  const seoDescription = games.length > 0
    ? t('seo.broadcasts.round.description', {
        tournament: broadcast.title,
        round: seoRoundName,
        gamesCount: games.length,
      })
    : t('seo.broadcasts.round.descriptionNoGames', {
        tournament: broadcast.title,
        round: seoRoundName,
      });
  const seoCanonical = `https://kingside.site/broadcasts/${tournamentId}/${roundId}`;
  const seoJsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${broadcast.title} — ${seoRoundName}`,
    description: seoDescription,
    url: seoCanonical,
    // KS-4213 / ADR-128 §7.6.1.2 B3: раунд — часть турнира; URL
    // турнира кладём явно, чтобы боты могли подняться по иерархии.
    superEvent: {
      '@type': 'SportsEvent',
      name: broadcast.title,
      url: `https://kingside.site/broadcasts/${tournamentId}`,
    },
  };

  return (
    <div className="broadcast-round-page">
      <SeoHelmet
        title={seoTitle}
        description={seoDescription}
        canonical={seoCanonical}
        ogType="event"
        ogImage="/og/broadcast.png"
        jsonLd={seoJsonLd}
      />
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {broadcast.title}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{currentRound?.name ?? ''}</span>
      </nav>

      {/* KS-4856 / ADR-159 §2.4: индикатор состояния канала обновлений.
          streaming → без плашки (норма). slow → «Обновления замедлены».
          offline → «Нет связи с сервером трансляций». */}
      {channelIndicator === 'slow' && (
        <div
          className="broadcast-channel-indicator broadcast-channel-indicator--slow"
          data-testid="broadcast-channel-indicator"
          data-channel-state="slow"
        >
          {t(
            'broadcastRound.slowMode',
            'Live stream unavailable, updates arrive with a delay',
          )}
        </div>
      )}
      {channelIndicator === 'offline' && (
        <div
          className="broadcast-channel-indicator broadcast-channel-indicator--offline"
          data-testid="broadcast-channel-indicator"
          data-channel-state="offline"
        >
          {t(
            'broadcastRound.offline',
            'No connection to the broadcast server',
          )}
        </div>
      )}

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

      {/* Round tabs.
          KS-2802: на mobile (<= 768px) кнопки скрываются CSS-ом, вместо
          них показывается компактный нативный `<select>`. На desktop
          поведение прежнее (плоская сетка кнопок) — регрессий KS-2790
          (активная подсветка через .broadcast-round-btn--active) нет.
          Оба варианта в DOM одновременно — переключаются media-query'ем,
          не JS-ом: проще, без зависимости от window.matchMedia и
          мерцания на ресайзе. */}
      <div
        className="broadcast-rounds-row"
        data-testid="broadcast-rounds-row-desktop"
      >
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
      <div
        className="broadcast-rounds-select"
        data-testid="broadcast-rounds-select"
      >
        <label
          className="broadcast-rounds-select__label"
          htmlFor="broadcast-rounds-select-input"
        >
          {t('broadcastRound.selectorLabel', 'Round')}
        </label>
        <select
          id="broadcast-rounds-select-input"
          className="broadcast-rounds-select__input"
          value={roundId ?? ''}
          data-testid="broadcast-rounds-select-input"
          onChange={(e) => {
            const next = e.target.value;
            if (next && next !== roundId) {
              navigate(`/broadcasts/${tournamentId}/${next}`);
            }
          }}
          aria-label={t('broadcastRound.selectorLabel', 'Round')}
        >
          {rounds.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      {/* KS-4893: переключатель сортировки досок. */}
      <div
        className="broadcast-sort-toggle"
        role="group"
        aria-label={t('broadcastRound.sort.label', 'Board order')}
        data-testid="broadcast-sort-toggle"
      >
        <span className="broadcast-sort-toggle__label">
          {t('broadcastRound.sort.label', 'Board order')}:
        </span>
        <button
          type="button"
          className={`broadcast-sort-toggle__btn${sortMode === 'default' ? ' broadcast-sort-toggle__btn--active' : ''}`}
          aria-pressed={sortMode === 'default'}
          data-testid="broadcast-sort-default"
          onClick={() => changeSortMode('default')}
        >
          {t('broadcastRound.sort.default', 'Default')}
        </button>
        <button
          type="button"
          className={`broadcast-sort-toggle__btn${sortMode === 'lastMove' ? ' broadcast-sort-toggle__btn--active' : ''}`}
          aria-pressed={sortMode === 'lastMove'}
          data-testid="broadcast-sort-last-move"
          onClick={() => changeSortMode('lastMove')}
        >
          {t('broadcastRound.sort.lastMove', 'Recent move first')}
        </button>
      </div>

      {renderRoundBody({
        status: currentRound?.status ?? '',
        startsAt: currentRound?.startsAt ?? null,
        games: displayGames,
        gameKey,
        lastMoveKey,
        lastMoveUciMap,
        evalsByKey,
        inWorkshopMap,
        handleGameClick,
        t,
      })}
    </div>
  );
}

/**
 * KS-4848 / ADR-158 §2.4: рендер тела страницы раунда с учётом
 * трёх новых состояний:
 *  - A: `status='pending'` — countdown + пары (или заглушка «Пары
 *    ещё не объявлены»).
 *  - B: `status='ongoing' AND games.length===0` — «Раунд начался,
 *    ожидаем первые ходы…» + spinner.
 *  - C: `status='ongoing' AND games.length>0` — обычная сетка досок.
 *    В карточке партии с `pgn=null AND result=null` плашка «Партия
 *    скоро начнётся» (см. `BroadcastBoardCard`).
 *
 * Legacy-fallback: `status='finished'` (или иное значение) — тот же
 * сеточный рендер, что и раньше; пустой список даёт «No games…».
 */
function renderRoundBody({
  status,
  startsAt,
  games,
  gameKey,
  lastMoveKey,
  lastMoveUciMap,
  evalsByKey,
  inWorkshopMap,
  handleGameClick,
  t,
}: {
  status: string;
  startsAt: string | null;
  games: BroadcastGameSummary[];
  gameKey: (g: BroadcastGameSummary) => string;
  lastMoveKey: string | null;
  lastMoveUciMap: Record<string, string>;
  evalsByKey: Record<string, import('../hooks/useBroadcastEvalQueue').EvalSnapshot>;
  inWorkshopMap: Record<string, boolean>;
  handleGameClick: (g: BroadcastGameSummary) => void;
  t: import('i18next').TFunction;
}) {
  // ─── Ветка A: раунд не начался. ─────────────────────────────────
  if (status === 'pending') {
    return (
      <div
        className="broadcast-pending-section"
        data-testid="broadcast-pending-section"
      >
        <div className="broadcast-pending-header">
          <span
            className="broadcast-pending-badge"
            data-testid="broadcast-pending-badge"
          >
            {t('broadcastRound.pending.upcomingBadge', 'Upcoming')}
          </span>
          <RoundCountdown startsAt={startsAt} />
        </div>
        {games.length === 0 ? (
          <div
            className="broadcasts-empty broadcast-pending-empty"
            data-testid="broadcast-pending-empty"
          >
            {t(
              'broadcastRound.pending.pairingsNotAnnounced',
              'Pairings not announced yet',
            )}
          </div>
        ) : (
          <div
            className="broadcast-pairings-grid"
            data-testid="broadcast-pairings-grid"
          >
            {games.map((game) => (
              <PairingCard
                key={
                  game.id ||
                  game.lichessGameId ||
                  `${game.whitePlayer ?? '?'}|${game.blackPlayer ?? '?'}`
                }
                game={game}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Ветка B: раунд начался, но пары/ходы ещё не пришли. ─────────
  if (status === 'ongoing' && games.length === 0) {
    return (
      <div
        className="broadcast-awaiting-first-moves"
        data-testid="broadcast-awaiting-first-moves"
      >
        <span className="broadcast-awaiting-first-moves__spinner" aria-hidden />
        <span className="broadcast-awaiting-first-moves__text">
          {t(
            'broadcastRound.ongoing.awaitingFirstMoves',
            'Round has started, waiting for the first moves…',
          )}
        </span>
      </div>
    );
  }

  // ─── Ветка C и legacy: сетка досок. ─────────────────────────────
  if (games.length === 0) {
    return (
      <div className="broadcasts-empty">
        {t('broadcastRound.noGames', 'No games in this round')}
      </div>
    );
  }
  return (
    <div className="broadcast-games-section">
      <div className="broadcast-boards-grid">
        {games.map((game) => {
          const k = gameKey(game);
          const lichessId = (game as { lichessGameId?: string }).lichessGameId;
          // KS-4861: карточки из direct-stream, ещё не сматченные с
          // серверным snapshot'ом, имеют `game.id=''` (см.
          // `parseLichessBroadcastPgn`). Используем lichessGameId или
          // пару игроков как fallback-ключ, чтобы React не ругался на
          // дублирующиеся пустые ключи и не переиспользовал состояние.
          const reactKey =
            game.id ||
            game.lichessGameId ||
            `${game.whitePlayer ?? '?'}|${game.blackPlayer ?? '?'}`;
          return (
            <BroadcastBoardCard
              key={reactKey}
              game={game}
              onGameClick={handleGameClick}
              showLastMoveHighlight={lastMoveKey !== null && k === lastMoveKey}
              lastMoveUci={lastMoveUciMap[k] ?? null}
              evalSnap={evalsByKey[k] ?? null}
              inWorkshop={
                lichessId ? Boolean(inWorkshopMap[lichessId]) : false
              }
            />
          );
        })}
      </div>
    </div>
  );
}
