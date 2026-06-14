import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { matchmakingSocket } from '../socket';
import { useLazySocket } from './useLazySocket';
import { useServerBusy } from './useServerBusy';
import { MatchmakingEvents } from '@kingside/shared';
import type { WsMatchmakingNoOpponentsPayload } from '@kingside/shared';
import type { TimeControlCategory } from './useTimeControl';

export type RatingFilterMode = 'none' | 'relative' | 'absolute';

type SearchPayload = {
  timeInitial: number;
  increment: number;
  activeTab: TimeControlCategory | 'custom';
};

type LastSearch = SearchPayload & { payload: Record<string, unknown> };

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
  // KS-2185: блок «No opponents online» — не null если бэкенд прислал событие
  // MatchmakingEvents.NO_OPPONENTS. Сервер уже сделал LEAVE — клиент не шлёт LEAVE.
  const [noOpponents, setNoOpponents] = useState<WsMatchmakingNoOpponentsPayload | null>(null);

  // Запоминаем последний JOIN, чтобы кнопка «Попробовать снова» отправила ровно тот же запрос.
  const lastSearchRef = useRef<LastSearch | null>(null);

  useEffect(() => {
    const onMatchFound = (data: { gameId: string; color: 'white' | 'black' }) => {
      setSearching(false);
      setNoOpponents(null);
      navigate(`/game/${data.gameId}`, { state: { color: data.color } });
    };

    const onNoOpponents = (payload: WsMatchmakingNoOpponentsPayload) => {
      // Сервер автоматически делает LEAVE — мы только обновляем UI-состояние.
      setSearching(false);
      setNoOpponents(payload);
    };

    matchmakingSocket.on(MatchmakingEvents.FOUND, onMatchFound);
    matchmakingSocket.on(MatchmakingEvents.NO_OPPONENTS, onNoOpponents);
    return () => {
      matchmakingSocket.off(MatchmakingEvents.FOUND, onMatchFound);
      matchmakingSocket.off(MatchmakingEvents.NO_OPPONENTS, onNoOpponents);
      if (searching) {
        matchmakingSocket.emit(MatchmakingEvents.LEAVE);
      }
    };
  }, [navigate, searching]);

  const buildPayload = useCallback(
    ({ timeInitial, increment, activeTab }: SearchPayload): Record<string, unknown> => {
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
      return payload;
    },
    [ratingFilterMode, ratingMin, ratingMax, ratingMinus, ratingPlus, user],
  );

  const handleSearch = (search: SearchPayload) => {
    if (searching) {
      matchmakingSocket.emit(MatchmakingEvents.LEAVE);
      setSearching(false);
      return;
    }
    const payload = buildPayload(search);
    lastSearchRef.current = { ...search, payload };
    setNoOpponents(null);
    matchmakingSocket.emit(MatchmakingEvents.JOIN, payload);
    setSearching(true);
  };

  // KS-2185: повторный JOIN с теми же параметрами после блока «No opponents online».
  const retryAfterNoOpponents = useCallback(() => {
    const last = lastSearchRef.current;
    if (!last) return;
    setNoOpponents(null);
    matchmakingSocket.emit(MatchmakingEvents.JOIN, last.payload);
    setSearching(true);
  }, []);

  // KS-2185: «Выбрать другой контроль» — закрыть блок, остаться на экране выбора TC.
  const dismissNoOpponents = useCallback(() => {
    setNoOpponents(null);
  }, []);

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
    noOpponents,
    retryAfterNoOpponents,
    dismissNoOpponents,
  };
}
