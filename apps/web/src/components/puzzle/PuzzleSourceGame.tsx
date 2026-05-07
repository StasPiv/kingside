import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { PuzzleSourceGame as PuzzleSourceGameDto } from '@kingside/shared';

/**
 * KS-2488 (ADR-044 follow-up). Блок «Из партии: …» под доской пазла.
 *
 * Backend (KS-2487 / api rev:114) кладёт в `puzzle.sourceGame` всё, что
 * знает о партии-источнике: headers (white/black/event/date/result),
 * `archiveGameId` (UUID `archive_games.id` для глубокой ссылки в архив)
 * и/или `pgnUrl` (для Lichess-пазлов — внешний `gameUrl`). Любое поле
 * может отсутствовать; компонент рендерит ровно то, что есть.
 *
 * Если `sourceGame` совсем пустой / undefined — компонент возвращает
 * `null`, чтобы не оставить пустой `<div>` под доской.
 *
 * # Контракт DOM
 *
 *   <section class="puzzle-source-game" data-testid="puzzle-source-game">
 *     <header class="puzzle-source-game__header">From game</header>
 *     <p class="puzzle-source-game__headers"
 *        data-testid="puzzle-source-game-headers">
 *        White vs Black, Event, 2024.05.12, 1-0
 *     </p>
 *     <div class="puzzle-source-game__links">
 *       <Link to="/archive/games/<id>" data-testid="puzzle-source-game-archive-link" />
 *       <a href="<pgnUrl>" target=_blank data-testid="puzzle-source-game-pgn-link" />
 *     </div>
 *   </section>
 */
export interface PuzzleSourceGameProps {
  source?: PuzzleSourceGameDto;
}

/** Есть ли в объекте хоть одно непустое поле — иначе блок не рендерим. */
function hasAnyField(s: PuzzleSourceGameDto | undefined): s is PuzzleSourceGameDto {
  if (!s) return false;
  return Boolean(
    s.white ||
      s.black ||
      s.event ||
      s.date ||
      s.result ||
      s.archiveGameId ||
      s.pgnUrl,
  );
}

export function PuzzleSourceGame({ source }: PuzzleSourceGameProps) {
  const { t } = useTranslation();
  if (!hasAnyField(source)) return null;

  // Headers: «White vs Black», «Event», «date», «result». Объединяем
  // только непустые поля через «, ».
  const headersParts: string[] = [];
  if (source.white && source.black) {
    headersParts.push(`${source.white} − ${source.black}`);
  } else if (source.white) {
    headersParts.push(source.white);
  } else if (source.black) {
    headersParts.push(source.black);
  }
  if (source.event) headersParts.push(source.event);
  if (source.date) headersParts.push(source.date);
  if (source.result) headersParts.push(source.result);
  const headersText = headersParts.join(', ');

  return (
    <section
      className="puzzle-source-game"
      data-testid="puzzle-source-game"
    >
      <header className="puzzle-source-game__header">
        {t('puzzle.sourceGame.fromGame', 'From game')}
      </header>
      {headersText && (
        <p
          className="puzzle-source-game__headers"
          data-testid="puzzle-source-game-headers"
        >
          {headersText}
        </p>
      )}
      {(source.archiveGameId || source.pgnUrl) && (
        <div className="puzzle-source-game__links">
          {source.archiveGameId && (
            <Link
              to={`/archive/games/${source.archiveGameId}`}
              className="puzzle-source-game__link"
              data-testid="puzzle-source-game-archive-link"
            >
              {t('puzzle.sourceGame.openInArchive', 'Open in archive')}
            </Link>
          )}
          {source.pgnUrl && (
            <a
              href={source.pgnUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="puzzle-source-game__link puzzle-source-game__link--external"
              data-testid="puzzle-source-game-pgn-link"
            >
              {t('puzzle.sourceGame.openOnLichess', 'Open on Lichess')}
            </a>
          )}
        </div>
      )}
    </section>
  );
}
