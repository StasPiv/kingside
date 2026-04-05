export type GameMetaInfo = {
  white: { username: string; rating?: number | null };
  black: { username: string; rating?: number | null };
  opening?: string;
  result?: string;
  event?: string;
  date?: string;
  ratingChange?: {
    whiteRatingBefore: number;
    whiteRatingAfter: number;
    blackRatingBefore: number;
    blackRatingAfter: number;
  };
};

type Props = {
  info: GameMetaInfo;
};

function RatingDiff({ before, after }: { before: number; after: number }) {
  const diff = after - before;
  const cls = diff > 0 ? 'positive' : diff < 0 ? 'negative' : '';
  return (
    <span className={`rating-diff ${cls}`}>
      ({diff > 0 ? '+' : ''}{diff})
    </span>
  );
}

export function GameMetaBar({ info }: Props) {
  return (
    <div className="game-meta-bar">
      {/* Mobile: single compact line */}
      <div className="game-meta-bar__mobile">
        <span className="game-meta-bar__dot game-meta-bar__dot--white" />
        <span className="game-meta-bar__name">{info.white.username}</span>
        {info.white.rating != null && (
          <span className="game-meta-bar__rating">{info.white.rating}</span>
        )}
        {info.ratingChange && (
          <RatingDiff before={info.ratingChange.whiteRatingBefore} after={info.ratingChange.whiteRatingAfter} />
        )}
        {info.result && <span className="game-meta-bar__result">{info.result}</span>}
        <span className="game-meta-bar__dot game-meta-bar__dot--black" />
        <span className="game-meta-bar__name">{info.black.username}</span>
        {info.black.rating != null && (
          <span className="game-meta-bar__rating">{info.black.rating}</span>
        )}
        {info.ratingChange && (
          <RatingDiff before={info.ratingChange.blackRatingBefore} after={info.ratingChange.blackRatingAfter} />
        )}
      </div>

      {/* Desktop: multi-line in sidebar */}
      <div className="game-meta-bar__desktop">
        <div className="game-meta-bar__players">
          <div className="game-meta-bar__player">
            <span className="game-meta-bar__dot game-meta-bar__dot--white" />
            <span className="game-meta-bar__name">{info.white.username}</span>
            {info.white.rating != null && (
              <span className="game-meta-bar__rating">{info.white.rating}</span>
            )}
            {info.ratingChange && (
              <RatingDiff before={info.ratingChange.whiteRatingBefore} after={info.ratingChange.whiteRatingAfter} />
            )}
          </div>
          {info.result && <span className="game-meta-bar__result-badge">{info.result}</span>}
          <div className="game-meta-bar__player">
            <span className="game-meta-bar__dot game-meta-bar__dot--black" />
            <span className="game-meta-bar__name">{info.black.username}</span>
            {info.black.rating != null && (
              <span className="game-meta-bar__rating">{info.black.rating}</span>
            )}
            {info.ratingChange && (
              <RatingDiff before={info.ratingChange.blackRatingBefore} after={info.ratingChange.blackRatingAfter} />
            )}
          </div>
        </div>
        {info.opening && (
          <div className="game-meta-bar__opening">{info.opening}</div>
        )}
        {(info.event || info.date) && (
          <div className="game-meta-bar__meta">
            {info.event && <span>{info.event}</span>}
            {info.event && info.date && <span> — </span>}
            {info.date && <span>{info.date}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
