import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { BroadcastGameSummary } from '@kingside/shared';

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
}: BroadcastBoardCardProps) {
  const isClickable = clickable ?? Boolean(game.pgn);
  const fen = resolveFen(game.currentFen, game.pgn ?? '');
  const lastMove = computeLastMove(game.pgn ?? '');
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
      </div>
      <div className="broadcast-board-wrap">
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
      <div className="broadcast-board-players">
        <span className="broadcast-player broadcast-player--white">
          &#9817; {game.whitePlayer ?? '—'}
        </span>
        {whiteScore && (
          <span className="broadcast-player-result">{whiteScore}</span>
        )}
      </div>
    </div>
  );
}
