import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { BroadcastGameSummary } from '@kingside/shared';
import {
  formatBroadcastClock,
  useBroadcastClock,
} from '../../hooks/useBroadcastClock';
import type { EvalSnapshot } from '../../hooks/useBroadcastEvalQueue';
import { BroadcastEvalBar } from './BroadcastEvalBar';

/**
 * Карточка партии трансляции с мини-доской.
 *
 * Используется на `BroadcastRoundPage` и внутри `<PlayoffBracket>` (KS-1825
 * v2), чтобы у пары в сетке плей-офф раскрывался тот же визуал, что и на
 * странице тура — живая позиция + подсветка последнего хода + результат.
 *
 * Компонент не тянет поллинг/логику обновления — он чисто презентационный.
 * Данные о партии передаются пропом `game`, родитель отвечает за свежесть.
 */

interface BroadcastBoardCardProps {
  game: BroadcastGameSummary;
  onGameClick?: (game: BroadcastGameSummary) => void;
  /**
   * Можно ли кликать по карточке. По умолчанию — только если есть pgn.
   * Страница тура делает клик = переход в /analysis, песочница может
   * передавать всегда-true для демо.
   */
  clickable?: boolean;
  /**
   * KS-2702. Подсветка last-move клеток. До тикета highlight рисовался
   * на каждой мини-доске, что захламляло страницу и не давало понять,
   * где случился свежий ход. Теперь родитель (`BroadcastRoundPage`)
   * передаёт `true` только в одну партию — ту, которая последней
   * получила ход среди всех в раунде. Default `false` — обратная
   * совместимость для остальных потребителей (PlayoffBracket etc.).
   */
  showLastMoveHighlight?: boolean;
  /**
   * KS-2705. Точный last-move из backend (`broadcast:move.uci`) или
   * из последнего верифицированного PGN-history. Формат `e2e4`. Если
   * передан — подсветка рисуется по нему (одна фигура, одна пара
   * клеток). Если не передан и `showLastMoveHighlight=true`, то
   * fallback на PGN-history; diff FEN'ов больше не используется,
   * чтобы не подсвечивать «два разных хода» при пропуске snapshot'а.
   */
  lastMoveUci?: string | null;
  /**
   * KS-2708. Снимок оценки от shared eval-queue. Если undefined —
   * анализ ещё не выполнен; bar рисует серый плейсхолдер.
   */
  evalSnap?: EvalSnapshot | null;
}

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

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

function computeFen(pgn: string): string {
  if (!pgn) return INITIAL_FEN;
  const chess = new Chess();
  return loadPgnSafe(chess, pgn) ? chess.fen() : INITIAL_FEN;
}

/**
 * `currentFen` из API предпочтительнее (актуальнее), но если он всё ещё
 * стартовый, а в PGN уже есть ходы — берём вычисленный FEN из PGN.
 * Экспортируется для тестов.
 */
export function resolveFen(
  currentFen: string | null | undefined,
  pgn: string,
): string {
  if (currentFen && currentFen !== INITIAL_FEN) return currentFen;
  const computed = computeFen(pgn);
  if (computed === INITIAL_FEN && currentFen) return currentFen;
  return computed;
}

/**
 * KS-2705: парсим last-move в порядке надёжности:
 *   1. `uci` (e2e4) — самый надёжный, приходит явно от backend.
 *   2. PGN history последнего хода — `chess.history({verbose:true})`.
 * Diff FEN'ов больше НЕ используется: при пропуске snapshot'а он мог
 * вернуть две клетки от двух разных ходов разных игроков (см. жалобу).
 */
function squaresFromUci(
  uci: string | null | undefined,
): { from: string; to: string } | null {
  if (!uci || uci.length < 4) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return null;
  return { from, to };
}

function computeLastMove(pgn: string): { from: string; to: string } | null {
  if (!pgn) return null;
  const chess = new Chess();
  if (!loadPgnSafe(chess, pgn)) return null;
  try {
    const hist = chess.history({ verbose: true });
    if (hist.length === 0) return null;
    const last = hist[hist.length - 1];
    return { from: last.from, to: last.to };
  } catch {
    return null;
  }
}

function resultToScore(
  result: string | null | undefined,
  side: 'white' | 'black',
): string | null {
  if (!result || result === '*') return null;
  const r = result.replace(/½/g, '1/2');
  if (r === '1-0') return side === 'white' ? '1' : '0';
  if (r === '0-1') return side === 'white' ? '0' : '1';
  if (r === '1/2-1/2') return '½';
  return null;
}

export function BroadcastBoardCard({
  game,
  onGameClick,
  clickable,
  showLastMoveHighlight = false,
  lastMoveUci,
  evalSnap,
}: BroadcastBoardCardProps) {
  const isClickable = clickable ?? Boolean(game.pgn);
  const fen = resolveFen(game.currentFen, game.pgn ?? '');
  // KS-2702 → KS-2705: highlight рисуем только если родитель разрешил.
  // Источник прямого хода: сначала `lastMoveUci` (от backend
  // `broadcast:move.uci`), fallback — последний ход PGN-истории.
  const lastMove = showLastMoveHighlight
    ? squaresFromUci(lastMoveUci) ?? computeLastMove(game.pgn ?? '')
    : null;
  const squareStyles: Record<string, React.CSSProperties> = {};
  if (lastMove) {
    const hl = { backgroundColor: 'rgba(255, 255, 0, 0.4)' };
    squareStyles[lastMove.from] = hl;
    squareStyles[lastMove.to] = hl;
  }

  const handleClick = () => {
    if (!isClickable || !onGameClick) return;
    onGameClick(game);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (!isClickable || !onGameClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onGameClick(game);
    }
  };

  const whiteScore = resultToScore(game.result, 'white');
  const blackScore = resultToScore(game.result, 'black');

  // KS-2706. Таймеры обоих игроков. Side-to-move берём из текущего FEN.
  // `useBroadcastClock` сам вернёт `hasClocks=false` если у партии нет
  // полей KS-2699 — тогда pill не рендерим (без placeholder'ов).
  const isBlackTurn = fen.split(' ')[1] === 'b';
  const isFinished = Boolean(game.result && game.result !== '*');
  const clock = useBroadcastClock({
    whiteClockMs: game.whiteClockMs ?? null,
    blackClockMs: game.blackClockMs ?? null,
    clockUpdatedAt: game.clockUpdatedAt ?? null,
    isBlackTurn,
    isFinished,
  });
  const whiteClockText = formatBroadcastClock(clock.whiteRemainingMs);
  const blackClockText = formatBroadcastClock(clock.blackRemainingMs);

  return (
    <div
      className={`broadcast-board-card${isClickable ? ' broadcast-board-card--clickable' : ''}`}
      aria-label={`${game.whitePlayer ?? ''} vs ${game.blackPlayer ?? ''}`}
      onClick={handleClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={handleKey}
      data-testid={`broadcast-board-card-${game.id}`}
    >
      <div className="broadcast-board-players">
        <span className="broadcast-player broadcast-player--black">
          &#9823; {game.blackPlayer ?? '—'}
        </span>
        {blackScore && (
          <span className="broadcast-player-result">{blackScore}</span>
        )}
        {clock.hasClocks && blackClockText !== null && (
          <span
            className={`broadcast-card-clock${isBlackTurn && !isFinished ? ' broadcast-card-clock--active' : ''}`}
            data-testid="broadcast-card-clock-black"
          >
            {blackClockText}
          </span>
        )}
      </div>
      <div className="broadcast-board-wrap">
        {/* KS-2708: eval-bar слева от мини-доски. Если родитель не
            передал evalSnap — bar рисует серый плейсхолдер. На
            завершившейся партии передаём `finalResult`. */}
        <BroadcastEvalBar
          evalSnap={evalSnap ?? null}
          finalResult={
            isFinished && (game.result === '1-0' || game.result === '0-1' || game.result === '1/2-1/2')
              ? (game.result as '1-0' | '0-1' | '1/2-1/2')
              : null
          }
        />
        <div className="broadcast-board-wrap__board">
          <Chessboard
            options={{
              position: fen,
              allowDragging: false,
              showNotation: false,
              animationDurationInMs: 0,
              squareStyles,
            }}
          />
        </div>
      </div>
      <div className="broadcast-board-players">
        <span className="broadcast-player broadcast-player--white">
          &#9817; {game.whitePlayer ?? '—'}
        </span>
        {whiteScore && (
          <span className="broadcast-player-result">{whiteScore}</span>
        )}
        {clock.hasClocks && whiteClockText !== null && (
          <span
            className={`broadcast-card-clock${!isBlackTurn && !isFinished ? ' broadcast-card-clock--active' : ''}`}
            data-testid="broadcast-card-clock-white"
          >
            {whiteClockText}
          </span>
        )}
      </div>
    </div>
  );
}
