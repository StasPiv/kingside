/**
 * KS-4144 / ADR-128 §4. Локальная игра гостя против бота — без
 * сервера и WebSocket'а. Бот = Stockfish 18 WASM (`useBotEngine`).
 *
 * Сценарий:
 *   /play (гость, клик "Play Bot")  →  navigate('/play/local-bot', {
 *     state: { level, color, tc }
 *   })
 *
 * Здесь:
 *   - chess.js хранит позицию;
 *   - игрок ходит кликом по своей фигуре + по клетке цели;
 *   - бот отвечает через `useBotEngine.getBotMove(fen)`;
 *   - финал → экран с результатом, кнопки «New game» и «Back to /play».
 *
 * Что НЕ делаем (по KS-4144):
 *   - часы / time control (отдельный тикет если понадобится);
 *   - рейтинг, статистика, сохранение партии;
 *   - PATCH /games/:id/moves, POST /games/bot — ни одного сетевого
 *     запроса к game-сервису.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { useTranslation } from 'react-i18next';

import { MemoChessboard } from '../components/MemoChessboard';
import { useBoardTheme } from '../hooks/useBoardTheme';
import { useBotEngine } from '../hooks/useBotEngine';
import { sendClientLog } from '../utils/clientLogger';

type PieceColor = 'white' | 'black' | 'random';

interface LocationState {
  level?: number;
  color?: PieceColor;
}

function resolveColor(c: PieceColor | undefined): 'white' | 'black' {
  if (c === 'white' || c === 'black') return c;
  return Math.random() < 0.5 ? 'white' : 'black';
}

type GameStatus = 'playing' | 'finished';
type GameResult = 'win' | 'loss' | 'draw';

export function LocalBotGamePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { customPieces } = useBoardTheme();
  const state = (location.state ?? {}) as LocationState;

  const [playerColor] = useState<'white' | 'black'>(() => resolveColor(state.color));
  const [botLevel] = useState<number>(() => {
    const n = typeof state.level === 'number' ? state.level : 3;
    return Math.max(1, Math.min(10, n));
  });
  // chess.js инстанс храним в state — обновляем заново при сбросе.
  const [game, setGame] = useState<Chess>(() => new Chess());
  const [fen, setFen] = useState<string>(() => game.fen());
  const [status, setStatus] = useState<GameStatus>('playing');
  const [result, setResult] = useState<GameResult | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [botThinking, setBotThinking] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [resetSeq, setResetSeq] = useState(0);

  // useBotEngine принимает gameId только для логов; для локальной
  // партии используем стабильный «local-<seq>», чтобы worker
  // пересоздавался при каждой новой партии.
  const localGameId = `local-${resetSeq}`;
  const { getBotMove } = useBotEngine(localGameId, botLevel, status === 'playing');

  const opponentColor = playerColor === 'white' ? 'black' : 'white';
  const turnColor = game.turn() === 'w' ? 'white' : 'black';
  const isPlayerTurn = turnColor === playerColor && status === 'playing';

  const finalize = useCallback(
    (g: Chess) => {
      let r: GameResult = 'draw';
      if (g.isCheckmate()) {
        // Mate победитель — тот, чей ход уже не наступит. game.turn() —
        // у кого ход сейчас (тот, кто стал жертвой мата).
        const loser = g.turn() === 'w' ? 'white' : 'black';
        r = loser === playerColor ? 'loss' : 'win';
      } else if (
        g.isStalemate() ||
        g.isThreefoldRepetition() ||
        g.isInsufficientMaterial() ||
        g.isDraw()
      ) {
        r = 'draw';
      }
      setStatus('finished');
      setResult(r);
    },
    [playerColor],
  );

  // Бот-ход: триггерится, когда ход не наш и игра идёт.
  useEffect(() => {
    if (status !== 'playing') return;
    if (turnColor === playerColor) return;
    let cancelled = false;
    setBotThinking(true);
    (async () => {
      try {
        const uci = await getBotMove(game.fen());
        if (cancelled) return;
        const from = uci.slice(0, 2) as Square;
        const to = uci.slice(2, 4) as Square;
        const promotion = uci.length >= 5 ? uci[4] : undefined;
        const next = new Chess(game.fen());
        const move = next.move({ from, to, promotion });
        if (!move) {
          sendClientLog('error', `[local-bot] illegal uci from engine: ${uci}`);
          return;
        }
        setGame(next);
        setFen(next.fen());
        if (next.isGameOver()) finalize(next);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          sendClientLog('error', `[local-bot] engine error: ${msg}`);
          setBotError(msg);
        }
      } finally {
        if (!cancelled) setBotThinking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // turnColor отслеживается через fen — при смене fen этот эффект
    // снова сравнит чей ход.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, status, playerColor]);

  const tryMove = useCallback(
    (from: Square, to: Square) => {
      if (!isPlayerTurn) return false;
      const next = new Chess(game.fen());
      const piece = next.get(from);
      const targetRank = to[1];
      const isPromotion =
        piece?.type === 'p' &&
        ((piece.color === 'w' && targetRank === '8') ||
          (piece.color === 'b' && targetRank === '1'));
      const move = next.move({
        from,
        to,
        ...(isPromotion ? { promotion: 'q' } : {}),
      });
      if (!move) return false;
      setGame(next);
      setFen(next.fen());
      setSelected(null);
      if (next.isGameOver()) finalize(next);
      return true;
    },
    [game, isPlayerTurn, finalize],
  );

  const onSquareClick = useCallback(
    ({ square }: { square: string }) => {
      if (!isPlayerTurn) return;
      const sq = square as Square;
      if (selected) {
        if (sq === selected) {
          setSelected(null);
          return;
        }
        const moved = tryMove(selected, sq);
        if (moved) return;
        // не легально — попробуем выбрать новую фигуру.
        const piece = game.get(sq);
        if (piece && piece.color === (playerColor === 'white' ? 'w' : 'b')) {
          setSelected(sq);
        } else {
          setSelected(null);
        }
      } else {
        const piece = game.get(sq);
        if (piece && piece.color === (playerColor === 'white' ? 'w' : 'b')) {
          setSelected(sq);
        }
      }
    },
    [selected, tryMove, isPlayerTurn, game, playerColor],
  );

  const startNewGame = useCallback(() => {
    const fresh = new Chess();
    setGame(fresh);
    setFen(fresh.fen());
    setStatus('playing');
    setResult(null);
    setSelected(null);
    setBotError(null);
    setResetSeq((s) => s + 1);
  }, []);

  const squareStyles = useMemo(() => {
    if (!selected) return undefined;
    const styles: Record<string, React.CSSProperties> = {};
    styles[selected] = { backgroundColor: 'rgba(124, 131, 255, 0.45)' };
    const moves = game.moves({ square: selected, verbose: true });
    for (const m of moves) {
      styles[m.to] = { backgroundColor: 'rgba(124, 131, 255, 0.25)' };
    }
    return styles;
  }, [selected, game]);

  const boardOptions = useMemo(
    () => ({
      position: fen,
      boardOrientation: playerColor,
      allowDragging: false,
      animationDurationInMs: 150,
      ...(customPieces && { pieces: customPieces }),
      squareStyles,
      onSquareClick,
    }),
    [fen, playerColor, customPieces, squareStyles, onSquareClick],
  );

  return (
    <div className="game-page" data-testid="local-bot-game">
      <Link to="/play" className="back-nav-link">
        ← {t('game.backToLobby', 'Back to lobby')}
      </Link>
      <div className="game-board-area">
        <div className="player-info opponent-info">
          <span className={`color-indicator ${opponentColor}`} />
          <span className="player-name">
            {t('lobby.bot', 'Bot')} (Lv. {botLevel})
          </span>
        </div>
        <div className="board-container" style={{ maxWidth: 560 }}>
          <MemoChessboard options={boardOptions} />
        </div>
        <div className="player-info self-info">
          <span className={`color-indicator ${playerColor}`} />
          <span className="player-name">{t('game.you', 'You')}</span>
        </div>

        {botError && (
          <div
            className="local-bot-error"
            data-testid="local-bot-error"
            style={{ marginTop: 12, color: '#ef4444' }}
            role="alert"
          >
            {t('game.botEngineError', 'Bot engine could not start: {{msg}}', {
              msg: botError,
            })}
          </div>
        )}
        <div
          className="local-bot-status"
          data-testid="local-bot-status"
          style={{ marginTop: 12 }}
        >
          {status === 'playing' ? (
            isPlayerTurn ? (
              <span data-testid="local-bot-status-you">
                {t('game.yourMove', 'Your move')}
              </span>
            ) : (
              <span data-testid="local-bot-status-bot">
                {botThinking
                  ? t('game.botThinking', 'Bot is thinking…')
                  : t('game.botMove', "Bot's move")}
              </span>
            )
          ) : (
            <span data-testid="local-bot-status-final">
              {result === 'win'
                ? t('game.youWon', 'You won')
                : result === 'loss'
                  ? t('game.youLost', 'You lost')
                  : t('game.draw', 'Draw')}
            </span>
          )}
        </div>

        {status === 'finished' && (
          <div
            className="local-bot-actions"
            data-testid="local-bot-actions"
            style={{ marginTop: 12, display: 'flex', gap: 8 }}
          >
            <button
              type="button"
              className="play-btn"
              data-testid="local-bot-new-game"
              onClick={startNewGame}
            >
              {t('game.newGame', 'New game')}
            </button>
            <button
              type="button"
              className="play-btn"
              data-testid="local-bot-to-play"
              onClick={() => navigate('/play')}
            >
              {t('game.backToLobby', 'Back to lobby')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
