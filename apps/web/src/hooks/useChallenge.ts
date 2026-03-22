import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { messagesSocket } from '../socket';
import {
  ChallengeEvents,
  type WsChallengeSendPayload,
  type WsChallengeReceivedPayload,
  type WsChallengeStartedPayload,
} from '@kingside/shared';

export type ChallengeState = 'idle' | 'sending' | 'waiting' | 'received';

export type IncomingChallenge = WsChallengeReceivedPayload;

export function useChallenge() {
  const navigate = useNavigate();
  const [state, setState] = useState<ChallengeState>('idle');
  const [incoming, setIncoming] = useState<IncomingChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const challengeIdRef = useRef<string | null>(null);

  useEffect(() => {
    const onReceived = (data: WsChallengeReceivedPayload) => {
      setIncoming(data);
      setState('received');
    };

    const onStarted = (data: WsChallengeStartedPayload) => {
      setState('idle');
      setIncoming(null);
      challengeIdRef.current = null;
      navigate(`/game/${data.gameId}`);
    };

    const onError = (data: { message: string }) => {
      setError(data.message);
      setState('idle');
      challengeIdRef.current = null;
    };

    const onDeclined = () => {
      setState('idle');
      challengeIdRef.current = null;
    };

    messagesSocket.on(ChallengeEvents.RECEIVED, onReceived);
    messagesSocket.on(ChallengeEvents.STARTED, onStarted);
    messagesSocket.on(ChallengeEvents.ERROR, onError);
    messagesSocket.on(ChallengeEvents.DECLINE, onDeclined);

    return () => {
      messagesSocket.off(ChallengeEvents.RECEIVED, onReceived);
      messagesSocket.off(ChallengeEvents.STARTED, onStarted);
      messagesSocket.off(ChallengeEvents.ERROR, onError);
      messagesSocket.off(ChallengeEvents.DECLINE, onDeclined);
    };
  }, [navigate]);

  const sendChallenge = useCallback((payload: WsChallengeSendPayload) => {
    setError(null);
    setState('waiting');
    messagesSocket.emit(ChallengeEvents.SEND, payload);
  }, []);

  const acceptChallenge = useCallback((challengeId: string) => {
    messagesSocket.emit(ChallengeEvents.ACCEPT, { challengeId });
    setState('idle');
    setIncoming(null);
  }, []);

  const declineChallenge = useCallback((challengeId: string) => {
    messagesSocket.emit(ChallengeEvents.DECLINE, { challengeId });
    setState('idle');
    setIncoming(null);
  }, []);

  const cancel = useCallback(() => {
    setState('idle');
    setError(null);
  }, []);

  return {
    state,
    incoming,
    error,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    cancel,
  };
}
