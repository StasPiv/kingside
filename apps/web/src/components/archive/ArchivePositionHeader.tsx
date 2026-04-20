import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';

interface ArchivePositionHeaderProps {
  fen: string;
  totalApprox: number;
  eco?: string | null;
  opening?: string | null;
}

/**
 * Header for the /archive/games page:
 * - mini-board (react-chessboard) rendering the current FEN
 * - ECO + opening name (if available)
 * - FEN text
 * - approximate total games count
 *
 * Styling is delivered separately (KS-1614); only structural markup here.
 */
export function ArchivePositionHeader({
  fen,
  totalApprox,
  eco,
  opening,
}: ArchivePositionHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="archive-games-header" data-testid="archive-position-header">
      <div className="archive-games-header__board">
        <Chessboard
          options={{
            position: fen,
            allowDragging: false,
            showNotation: false,
            animationDurationInMs: 0,
          }}
        />
      </div>
      <div className="archive-games-header__info">
        {(eco || opening) && (
          <div className="archive-games-header__opening" data-testid="archive-position-opening">
            {eco && <span className="archive-games-header__eco">{eco}</span>}
            {opening && <span className="archive-games-header__opening-name">{opening}</span>}
          </div>
        )}
        <div className="archive-games-header__fen" data-testid="archive-position-fen">
          <span className="archive-games-header__fen-label">FEN:</span>
          <code>{fen}</code>
        </div>
        <div className="archive-games-header__total" data-testid="archive-position-total">
          {t('archive.games.totalApprox', {
            defaultValue: '~{{count}} games',
            count: totalApprox,
          })}
        </div>
      </div>
    </header>
  );
}
