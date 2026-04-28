import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  ArchiveGameSummary,
  ArchiveGamesByPositionItem,
} from '@kingside/shared';

/**
 * KS-2068 (F2): универсальная строка партии в списке.
 *
 * Поддерживает два варианта данных:
 *  - by-position (`ArchiveGamesByPositionItem`) — строка в списке
 *    «партии с этой позицией»: дополнительно показывает «reached at
 *    move N» и следующий ход (SAN) от позиции;
 *  - metadata (`ArchiveGameSummary`) — строка в полном списке партий
 *    архива: только колонки white/black/result/event/date/ECO/[Open].
 *
 * Имена игроков ведут на `/archive/players/<slug>` (F3). Slug строится
 * из `name` клиентской нормализацией — на бэке slug может отличаться
 * (ADR-033 §4.4); после интеграции с B3/B4 нужно будет заменить
 * на серверный slug.
 */

type ArchiveAnyItem = ArchiveGamesByPositionItem | ArchiveGameSummary;

interface ArchiveGameRowProps {
  item: ArchiveAnyItem;
  /**
   * FEN of the queried position — используется только в by-position
   * режиме для UCI→SAN-конверсии следующего хода. В metadata-режиме
   * можно не передавать.
   */
  positionFen?: string;
  onClick: (item: ArchiveAnyItem) => void;
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
 * KS-2068: клиентский slug. На бэке (KS-2069/B3) появится явный
 * `slug` в `ArchivePlayerInfo`/`ArchiveGameSummary` — после этого
 * заменить на серверный.
 */
function slugifyPlayerName(name: string | null | undefined): string | null {
  if (!name) return null;
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : null;
}

function isByPositionItem(
  item: ArchiveAnyItem,
): item is ArchiveGamesByPositionItem {
  return 'reachedAtPly' in item;
}

/**
 * Single row in the archive games list.
 *
 * Сама строка — `<div role="button">`, не `<button>`, чтобы внутри
 * можно было разместить вложенные `<Link>` (HTML запрещает
 * интерактивные элементы внутри `<button>`). Клик по самой строке
 * вызывает `onClick`, клик по имени → переход на профиль через
 * react-router (event propagation останавливаем, чтобы не сработал
 * row-onClick).
 */
export function ArchiveGameRow({
  item,
  positionFen,
  onClick,
}: ArchiveGameRowProps) {
  const { t } = useTranslation();

  const isPositionItem = isByPositionItem(item);

  const nextMoveSan = useMemo(
    () =>
      isPositionItem && positionFen
        ? uciToSan(positionFen, item.nextMoveUci)
        : null,
    [isPositionItem, positionFen, item],
  );

  const resultText = item.result ?? '*';
  const resultClass = RESULT_CLASS[resultText] ?? RESULT_CLASS['*'];

  const whiteSlug = slugifyPlayerName(item.white.name);
  const blackSlug = slugifyPlayerName(item.black.name);

  const handleRowClick = () => onClick(item);
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(item);
    }
  };

  const stopRowEvent = (e: React.MouseEvent | React.KeyboardEvent) => {
    // KS-2068: клик по имени-Link не должен дёргать row-onClick.
    e.stopPropagation();
  };

  return (
    <div
      className="archive-game-row"
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      data-testid={`archive-game-row-${item.id}`}
    >
      <span className={`archive-game-row__result ${resultClass}`}>
        {resultText}
      </span>

      <span className="archive-game-row__players">
        <span className="archive-game-row__player">
          {whiteSlug ? (
            <Link
              to={`/archive/players/${whiteSlug}`}
              onClick={stopRowEvent}
              onKeyDown={stopRowEvent}
              data-testid={`archive-game-row-${item.id}-white-link`}
            >
              {item.white.name}
            </Link>
          ) : (
            item.white.name ?? '—'
          )}
          {item.white.elo != null && (
            <span className="archive-game-row__elo"> ({item.white.elo})</span>
          )}
        </span>
        <span className="archive-game-row__vs"> — </span>
        <span className="archive-game-row__player">
          {blackSlug ? (
            <Link
              to={`/archive/players/${blackSlug}`}
              onClick={stopRowEvent}
              onKeyDown={stopRowEvent}
              data-testid={`archive-game-row-${item.id}-black-link`}
            >
              {item.black.name}
            </Link>
          ) : (
            item.black.name ?? '—'
          )}
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

      {isPositionItem && (
        <span className="archive-game-row__reached">
          {t('archive.games.reachedAt', {
            defaultValue: 'reached at move {{move}}',
            move: moveNumberFromPly(item.reachedAtPly),
          })}
        </span>
      )}

      {nextMoveSan && (
        <span
          className="archive-game-row__next-move"
          data-testid="archive-game-row-next-move"
        >
          {t('archive.games.nextMove', {
            defaultValue: 'next: {{san}}',
            san: nextMoveSan,
          })}
        </span>
      )}
    </div>
  );
}
