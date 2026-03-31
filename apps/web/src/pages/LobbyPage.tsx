import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { HelpButton } from '../components/HelpButton';

type WorkshopGame = {
  id: string;
  playerColor: 'white' | 'black';
  playerResult: 'win' | 'loss' | 'draw';
  opponent: { username: string };
  result: string;
  timeControl: string;
  createdAt: string;
};

type PuzzleRushStats = {
  best3: number;
  best5: number;
  totalSessions: number;
};

type ModalId = 'puzzles' | 'rush' | 'workshop' | 'broadcasts' | 'players' | 'liveGames' | null;

export function LobbyPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [rushStats, setRushStats] = useState<PuzzleRushStats | null>(null);
  const [widgetsLoading, setWidgetsLoading] = useState(true);

  const [workshopGames, setWorkshopGames] = useState<WorkshopGame[]>([]);
  const [workshopGamesLoading, setWorkshopGamesLoading] = useState(false);
  const pgnInputRef = useRef<HTMLInputElement>(null);

  const [activeModal, setActiveModal] = useState<ModalId>(null);

  useEffect(() => {
    if (!user) {
      setWidgetsLoading(false);
      return;
    }
    api.get<PuzzleRushStats>(`/api/users/${user.id}/puzzle-rush-stats`)
      .catch(() => null)
      .then((rush) => {
        setRushStats(rush);
      }).finally(() => setWidgetsLoading(false));
  }, [user]);

  const loadWorkshopGames = useCallback(async () => {
    if (!user) return;
    setWorkshopGamesLoading(true);
    try {
      const data = await api.get<{ data: WorkshopGame[] }>(`/api/users/${user.id}/games?take=5`);
      setWorkshopGames(data.data);
    } catch {
      setWorkshopGames([]);
    } finally {
      setWorkshopGamesLoading(false);
    }
  }, [user]);

  const handlePgnFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const pgn = ev.target?.result as string;
      if (pgn) {
        navigate('/analysis', { state: { pgn } });
        closeModal();
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const closeModal = () => setActiveModal(null);

  const openModal = (id: NonNullable<ModalId>) => {
    setActiveModal(id);
    if (id === 'workshop') {
      loadWorkshopGames();
    }
  };

  const rushModalContent = (
    <div className="lobby-panel">
      <h2 className="lobby-panel__title">⚡ {t('lobby.teasers.rush.title')}</h2>
      {widgetsLoading ? (
        <p className="lobby-widget__loading">{t('common.loading')}</p>
      ) : rushStats && (rushStats.best3 > 0 || rushStats.best5 > 0) ? (
        <div className="lobby-widget__content">
          <p className="lobby-widget__stat">
            {t('lobby.myRecord')} 3 {t('lobby.min')}: {rushStats.best3}
          </p>
          <p className="lobby-widget__stat">
            {t('lobby.myRecord')} 5 {t('lobby.min')}: {rushStats.best5}
          </p>
        </div>
      ) : null}
      <p className="lobby-modal__desc">{t('lobby.teasers.rush.modalDesc')}</p>
      <div className="lobby-widget__actions">
        <Link to="/puzzle-rush" className="lobby-widget__btn" onClick={closeModal}>
          {t('lobby.play')} →
        </Link>
        <Link to="/puzzle-rush/leaderboard" className="lobby-widget__btn lobby-widget__btn--secondary" onClick={closeModal}>
          {t('lobby.leaderboard')} →
        </Link>
      </div>
    </div>
  );

  const workshopModalContent = (
    <div className="lobby-panel">
      <h2 className="lobby-panel__title">&#9812; {t('lobby.teasers.workshop.title')}</h2>

      <div className="workshop-section">
        <button
          className="play-btn"
          onClick={() => { navigate('/analysis'); closeModal(); }}
        >
          {t('lobby.workshop.newGame')}
        </button>
      </div>

      <div className="workshop-section">
        <p className="workshop-section__label">{t('lobby.workshop.uploadPgn')}</p>
        <input
          ref={pgnInputRef}
          type="file"
          accept=".pgn"
          style={{ display: 'none' }}
          onChange={handlePgnFileChange}
        />
        <button
          className="lobby-widget__btn lobby-widget__btn--secondary"
          onClick={() => pgnInputRef.current?.click()}
        >
          {t('lobby.workshop.uploadPgnBtn')}
        </button>
      </div>

      <div className="workshop-section">
        <p className="workshop-section__label">{t('lobby.workshop.recentGames')}</p>
        {workshopGamesLoading ? (
          <p className="lobby-widget__loading">{t('common.loading')}</p>
        ) : workshopGames.length > 0 ? (
          <ul className="workshop-games-list">
            {workshopGames.map((g) => (
              <li key={g.id} className="workshop-game-item">
                <Link
                  to={`/game/${g.id}/review`}
                  className="workshop-game-link"
                  onClick={closeModal}
                >
                  <span className={`workshop-game-result workshop-game-result--${g.playerResult}`}>
                    {g.playerResult === 'win' ? '▲' : g.playerResult === 'loss' ? '▼' : '='}
                  </span>
                  <span className="workshop-game-opponent">vs {g.opponent.username}</span>
                  <span className="workshop-game-tc">{g.timeControl}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="lobby-widget__loading">{t('lobby.workshop.noGames')}</p>
        )}
      </div>

      <div className="workshop-section">
        <p className="workshop-section__label">{t('lobby.workshop.tournaments')}</p>
        <p className="workshop-section__stub">{t('lobby.workshop.tournamentsComingSoon')}</p>
      </div>

      <div className="lobby-widget__actions">
        <Link to="/workshop" className="lobby-widget__btn" onClick={closeModal}>
          {t('lobby.workshop.openWorkshop')} →
        </Link>
      </div>
    </div>
  );

  const teasers = [
    {
      id: 'puzzles' as const,
      icon: '🧩',
      titleKey: 'lobby.teasers.puzzles.title',
      descKey: 'lobby.teasers.puzzles.description',
      ctaKey: 'lobby.teasers.puzzles.cta',
      to: '/puzzles',
    },
    {
      id: 'rush' as const,
      icon: '⚡',
      titleKey: 'lobby.teasers.rush.title',
      descKey: 'lobby.teasers.rush.description',
      ctaKey: 'lobby.teasers.rush.cta',
    },
    {
      id: 'workshop' as const,
      icon: '♟',
      titleKey: 'lobby.teasers.workshop.title',
      descKey: 'lobby.teasers.workshop.description',
      ctaKey: 'lobby.teasers.workshop.cta',
      to: '/workshop',
    },
    {
      id: 'broadcasts' as const,
      icon: '📡',
      titleKey: 'lobby.teasers.broadcasts.title',
      descKey: 'lobby.teasers.broadcasts.description',
      ctaKey: 'lobby.teasers.broadcasts.cta',
      to: '/broadcasts',
    },
    {
      id: 'players' as const,
      icon: '👥',
      titleKey: 'lobby.teasers.players.title',
      descKey: 'lobby.teasers.players.description',
      ctaKey: 'lobby.teasers.players.cta',
      to: '/players',
    },
    {
      id: 'liveGames' as const,
      icon: '👁',
      titleKey: 'lobby.teasers.liveGames.title',
      descKey: 'lobby.teasers.liveGames.description',
      ctaKey: 'lobby.teasers.liveGames.cta',
      to: '/games/live',
    },
  ] as Array<{ id: NonNullable<ModalId>; icon: string; titleKey: string; descKey: string; ctaKey: string; to?: string }>;

  const modalContentMap: Record<NonNullable<ModalId>, React.ReactNode> = {
    rush: rushModalContent,
    workshop: workshopModalContent,
    puzzles: null,
    broadcasts: null,
    players: null,
    liveGames: null,
  };

  return (
    <div className="lobby-page">
      <h1>{t('lobby.title')}<HelpButton section="play" /></h1>
      {user && (
        <p className="user-info">
          {user.username}
        </p>
      )}

      <div className="lobby-teasers">
        {teasers.map((teaser) => (
          <div key={teaser.id} className="lobby-teaser">
            <div className="lobby-teaser__image">{teaser.icon}</div>
            <h2 className="lobby-teaser__title">{t(teaser.titleKey)}</h2>
            <p className="lobby-teaser__desc">{t(teaser.descKey)}</p>
            <button
              className="lobby-teaser__btn"
              onClick={() => teaser.to ? navigate(teaser.to) : openModal(teaser.id)}
            >
              {t(teaser.ctaKey)}
            </button>
          </div>
        ))}
      </div>

      {activeModal && (
        <div className="lobby-modal-overlay" onClick={closeModal}>
          <div className="lobby-modal" onClick={(e) => e.stopPropagation()}>
            <button className="lobby-modal__close" onClick={closeModal} aria-label="Close">
              ×
            </button>
            {modalContentMap[activeModal]}
          </div>
        </div>
      )}
    </div>
  );
}
