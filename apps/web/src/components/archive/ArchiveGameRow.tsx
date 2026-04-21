import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { ArchiveGamesByPositionItem } from '@kingside/shared';

interface ArchiveGameRowProps {
  item: ArchiveGamesByPositionItem;
  /** FEN of the queried position (used for UCI→SAN of the next move). */
  positionFen: string;
  onClick: (item: ArchiveGamesByPositionItem) => void;
}

const RESULT_CLASS: Record<string, string> = {
  '1-0': 'archive-game-row__result--white',
  '0-1': 'archive-game-row__result--black',
  '1/2-1/2': 'archive-game-row__result--draw',
  '*': 'archive-game-row__result--unknown',
};

function formatDate(date: string | null): string {
  if (!date) return '—';
  // Accept ISO or raw PGN date ("YYYY.MM.DD"). Trim to year for compact display.
  const m = /^(\d{4})/.exec(date);
  return m ? m[1] : date;
}

function moveNumberFromPly(ply: number): string {
  // Ply is 1-based count of half-moves already played before the queried position.
  // We want the full-move number of the next move (at `ply + 1`).
  const nextPly = ply + 1;
  const moveNo = Math.ceil(nextPly / 2);
  const isWhiteMove = nextPly % 2 === 1;
  return isWhiteMove ? `${moveNo}.` : `${moveNo}...`;
}

function uciToSan(positionFen: string, uci: string | null): string | null {
  if (!uci) return null;
  try {
    const chess = new Chess(positionFen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4) : undefined;
    const move = chess.move({ from, to, promotion });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

/**
 * Single row in the games-by-position list.
 *
 * Clicking the row notifies the parent (which fetches the PGN via
 * archive-service `/games/:id` and navigates to /analysis).
 */
export function ArchiveGameRow({ item, positionFen, onClick }: ArchiveGameRowProps) {
  const { t } = useTranslation();

  const nextMoveSan = useMemo(
    () => uciToSan(positionFen, item.nextMoveUci),
    [positionFen, item.nextMoveUci],
  );

  const resultText = item.result ?? '*';
  const resultClass = RESULT_CLASS[resultText] ?? RESULT_CLASS['*'];

  return (
    <button
      type="button"
      className="archive-game-row"
      onClick={() => onClick(item)}
      data-testid={`archive-game-row-${item.id}`}
    >
      <span className={`archive-game-row__result ${resultClass}`}>{resultText}</span>

      <span className="archive-game-row__players">
        <span className="archive-game-row__player">
          {item.white.name ?? '—'}
          {item.white.elo != null && (
            <span className="archive-game-row__elo"> ({item.white.elo})</span>
          )}
        </span>
        <span className="archive-game-row__vs"> — </span>
        <span className="archive-game-row__player">
          {item.black.name ?? '—'}
          {item.black.elo != null && (
            <span className="archive-game-row__elo"> ({item.black.elo})</span>
          )}
        </span>
      </span>

      {item.eco && <span className="archive-game-row__eco">{item.eco}</span>}

      <span className="archive-game-row__date">{formatDate(item.date)}</span>

      {item.event && (
        <span className="archive-game-row__event" title={item.event}>
          {item.event}
        </span>
      )}

      <span className="archive-game-row__reached">
        {t('archive.games.reachedAt', {
          defaultValue: 'reached at move {{move}}',
          move: moveNumberFromPly(item.reachedAtPly),
        })}
      </span>

      {nextMoveSan && (
        <span className="archive-game-row__next-move" data-testid="archive-game-row-next-move">
          {t('archive.games.nextMove', { defaultValue: 'next: {{san}}', san: nextMoveSan })}
        </span>
      )}
    </button>
  );
}
