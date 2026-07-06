import type { BroadcastGameSummary } from '@kingside/shared';

interface PairingCardProps {
  game: BroadcastGameSummary;
  /**
   * Обработчик клика по паре. Родитель обычно передаёт функцию,
   * ведущую на страницу партии — даже если `pgn=null`, страница
   * покажет доску в стартовой позиции с плашкой ожидания.
   */
  onClick?: (game: BroadcastGameSummary) => void;
}

/**
 * KS-4848 / ADR-158 §2.4.1: карточка пары трансляции — компактное
 * представление партии до её начала. Игроки + рейтинги, клик ведёт
 * к странице партии, если у неё есть `id`.
 */
export function PairingCard({ game, onClick }: PairingCardProps) {
  const isClickable = Boolean(onClick) && Boolean(game.id);
  const formatPlayer = (
    name: string | null,
    elo: number | null | undefined,
  ): string => {
    if (!name) return '—';
    return elo ? `${name} (${elo})` : name;
  };

  const handleClick = () => {
    if (!isClickable || !onClick) return;
    onClick(game);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (!isClickable || !onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick(game);
    }
  };

  return (
    <div
      className={`broadcast-pairing-card${isClickable ? ' broadcast-pairing-card--clickable' : ''}`}
      onClick={handleClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={handleKey}
      data-testid={`broadcast-pairing-card-${game.id}`}
    >
      <span className="broadcast-pairing-card__player broadcast-pairing-card__player--white">
        <span className="broadcast-pairing-card__icon">&#9817;</span>
        {formatPlayer(game.whitePlayer, game.whiteElo)}
      </span>
      <span className="broadcast-pairing-card__vs">—</span>
      <span className="broadcast-pairing-card__player broadcast-pairing-card__player--black">
        <span className="broadcast-pairing-card__icon">&#9823;</span>
        {formatPlayer(game.blackPlayer, game.blackElo)}
      </span>
    </div>
  );
}
