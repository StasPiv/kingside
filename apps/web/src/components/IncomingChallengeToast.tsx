import { useTranslation } from 'react-i18next';
import type { IncomingChallenge } from '../hooks/useChallenge';

type Props = {
  challenge: IncomingChallenge;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
};

export function IncomingChallengeToast({ challenge, onAccept, onDecline }: Props) {
  const { t } = useTranslation();
  const mins = Math.floor(challenge.timeInitial / 60);
  const inc = challenge.increment;

  return (
    <div className="challenge-toast">
      <div className="challenge-toast__info">
        <strong>{challenge.from.username}</strong> ({challenge.from.rating})
        <span className="challenge-toast__tc">{mins}+{inc}</span>
      </div>
      <div className="challenge-toast__text">
        {t('challenge.incoming', 'challenges you to a game!')}
      </div>
      <div className="challenge-toast__actions">
        <button className="challenge-toast__accept" onClick={() => onAccept(challenge.challengeId)}>
          {t('challenge.accept', 'Accept')}
        </button>
        <button className="challenge-toast__decline" onClick={() => onDecline(challenge.challengeId)}>
          {t('challenge.decline', 'Decline')}
        </button>
      </div>
    </div>
  );
}
