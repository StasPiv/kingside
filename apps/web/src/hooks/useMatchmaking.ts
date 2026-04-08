import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { matchmakingSocket } from '../socket';
import { useLazySocket } from './useLazySocket';
import { useServerBusy } from './useServerBusy';
import { MatchmakingEvents } from '@kingside/shared';
import type { TimeControlCategory } from './useTimeControl';

export type RatingFilterMode = 'none' | 'relative' | 'absolute';

type SearchPayload = {
  timeInitial: number;
  increment: number;
  activeTab: TimeControlCategory | 'custom';
};

export function useMatchmaking() {
  useLazySocket(matchmakingSocket);
  const serverBusy = useServerBusy(matchmakingSocket);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searching, setSearching] = useState(false);
  const [ratingFilterMode, setRatingFilterMode] = useState<RatingFilterMode>('none');
  const [ratingMin, setRatingMin] = useState(800);
  const [ratingMax, setRatingMax] = useState(2200);
  const [ratingMinus, setRatingMinus] = useState(200);
  const [ratingPlus, setRatingPlus] = useState(200);

  useEffect(() => {
    const onMatchFound = (data: { gameId: string; color: 'white' | 'black' }) => {
      setSearching(false);
      navigate(`/game/${data.gameId}`, { state: { color: data.color } });
    };

    matchmakingSocket.on(MatchmakingEvents.FOUND, onMatchFound);
    return () => {
      matchmakingSocket.off(MatchmakingEvents.FOUND, onMatchFound);
      if (searching) {
        matchmakingSocket.emit(MatchmakingEvents.LEAVE);
      }
    };
  }, [navigate, searching]);

  const handleSearch = ({ timeInitial, increment, activeTab }: SearchPayload) => {
    if (searching) {
      matchmakingSocket.emit(MatchmakingEvents.LEAVE);
      setSearching(false);
    } else {
      const payload: Record<string, unknown> = { timeInitial, increment };
      if (ratingFilterMode === 'absolute') {
        payload.ratingFilter = { minRating: ratingMin, maxRating: ratingMax };
      } else if (ratingFilterMode === 'relative' && user) {
        const ratingKey = `rating${
          activeTab !== 'custom'
            ? activeTab.charAt(0).toUpperCase() + activeTab.slice(1)
            : 'Blitz'
        }` as keyof typeof user;
        const myRating = Number(user[ratingKey]) || 1500;
        payload.ratingFilter = {
          minRating: myRating - ratingMinus,
          maxRating: myRating + ratingPlus,
        };
      }
      matchmakingSocket.emit(MatchmakingEvents.JOIN, payload);
      setSearching(true);
    }
  };

  return {
    serverBusy,
    searching,
    ratingFilterMode,
    setRatingFilterMode,
    ratingMin,
    setRatingMin,
    ratingMax,
    setRatingMax,
    ratingMinus,
    setRatingMinus,
    ratingPlus,
    setRatingPlus,
    handleSearch,
  };
}
