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
import { sortGamesByWhite, gamesFingerprint } from '../utils/broadcastGameSort';
import { useBroadcastSocket } from '../hooks/useBroadcastSocket';
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
   * KS-2702. ID партии, которая последней получила ход среди всех в
   * раунде. Используется чтобы отрисовать last-move-highlight ровно в
   * одной мини-доске. Обновляется в `applyFreshGames` по diff PGN-длин
   * между prev и fresh. На initial-sync (prev пуст) — не выставляем,
   * чтобы при заходе на страницу подсветки не было ни в одной партии
   * (по acceptance KS-2702 «Initial state без подсветки» — допустимо).
   */
  const [lastMoveGameId, setLastMoveGameId] = useState<string | null>(null);

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

  const applyFreshGames = useCallback(
    (fresh: LichessGame[], shouldPlaySound: boolean) => {
      const prev = prevGamesRef.current;
      // KS-2702: ищем партию(-ии) в которых увеличилась PGN-длина
      // относительно prev — это и есть «получили новый ход в этом
      // апдейте». Берём ПЕРВУЮ найденную для звука и подсветки. Если
      // prev пуст (initial-sync) — пропускаем оба эффекта, чтобы при
      // заходе не было ложного звука и подсветка стартовала чистой.
      let advancedGameId: string | null = null;
      let advancedSan: string | null = null;
      if (prev.length > 0) {
        for (const g of fresh) {
          const prevGame = prev.find((p) => p.id === g.id);
          const prevPgnLen = prevGame?.pgn?.length ?? 0;
          const curPgnLen = g.pgn?.length ?? 0;
          if (curPgnLen > prevPgnLen && g.pgn) {
            advancedGameId = g.id;
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
        // eslint-disable-next-line no-console
        console.log(
          `[broadcast-sound] calling playSound for san=${advancedSan}`,
        );
        playSound(soundEventFromSan(advancedSan));
      }
      // KS-2702 → KS-2705: highlight last-move только в одной партии.
      // На diff'е — ставим id партии, у которой PGN вырос.
      // На initial-sync (prev пуст) — вычисляем «самую свежую» партию
      // по `clockUpdatedAt` (KS-2699: он обновляется на каждом ходе)
      // или fallback по самой длинной PGN. Это обеспечивает что
      // пользователь сразу видит, где случился последний ход в раунде,
      // а не пустоту до следующего обновления.
      // На «тихих» апдейтах (advancedGameId === null, prev не пуст)
      // оставляем предыдущее значение — последний известный ход
      // продолжает гореть до следующего реального хода.
      if (advancedGameId !== null) {
        setLastMoveGameId(advancedGameId);
      } else if (prev.length === 0) {
        // Initial-sync: найти партию с самым свежим clockUpdatedAt.
        let latestId: string | null = null;
        let latestTs = -Infinity;
        for (const g of fresh) {
          const ts = g.clockUpdatedAt
            ? new Date(g.clockUpdatedAt).getTime()
            : NaN;
          if (Number.isFinite(ts) && ts > latestTs) {
            latestTs = ts;
            latestId = g.id;
          }
        }
        // Fallback: если ни у одной партии нет clockUpdatedAt —
        // берём ту, у которой самый длинный PGN (это эвристика
        // «больше всего сыграно ходов»; для одинаковой длины первая
        // встретившаяся выигрывает).
        if (latestId === null) {
          let maxLen = -1;
          for (const g of fresh) {
            const len = g.pgn?.length ?? 0;
            if (len > maxLen) {
              maxLen = len;
              latestId = g.id;
            }
          }
        }
        setLastMoveGameId(latestId);
      }
      const fingerprint = gamesFingerprint(fresh);
      const prevFingerprint = gamesFingerprint(prev);
      if (prev.length === 0 || fingerprint !== prevFingerprint) {
        setGames(sortGamesByWhite(fresh));
      }
      prevGamesRef.current = fresh;
    },
    [playSound],
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
  const handleMove = useCallback(
    (payload: {
      gameIndex: number;
      uci: string;
      fen: string;
      whitePlayer?: string | null;
      blackPlayer?: string | null;
    }) => {
      setGames((prev) => {
        if (prev.length === 0) return prev;
        // Идентификация: сначала по парам игроков (стабильно при любой
        // сортировке), fallback по `gameIndex` (порядок backend).
        const idx = prev.findIndex(
          (g) =>
            (payload.whitePlayer && payload.whitePlayer === g.whitePlayer) ||
            (payload.blackPlayer && payload.blackPlayer === g.blackPlayer),
        );
        const target = idx >= 0 ? idx : payload.gameIndex;
        if (target < 0 || target >= prev.length) return prev;
        const next = prev.slice();
        const g = next[target];
        next[target] = { ...g, currentFen: payload.fen };
        // Запоминаем ID для подсветки. setState внутри setState запрещён —
        // делаем через микротаску.
        Promise.resolve().then(() => setLastMoveGameId(g.id));
        return next;
      });
    },
    [],
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
        <div className="broadcast-games-section">
          <div className="broadcast-boards-grid">
            {games.map((game) => (
              <BroadcastBoardCard
                key={game.id}
                game={game}
                onGameClick={handleGameClick}
                showLastMoveHighlight={game.id === lastMoveGameId}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
