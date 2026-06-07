import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type {
  WebRTCIceEvent,
  WebRTCOfferEvent,
  WebRTCPeerJoinedEvent,
  WebRTCPeerLeftEvent,
} from '@kingside/shared';

/**
 * KS-3847 / ADR-116 §5.2. Хук зрителя live-лекции: принимает audio-track
 * тренера через WebRTC и публикует его в `<audio>`-элемент.
 *
 * Зеркалит логику `useLectureAudioPeerConnections` (KS-3842) со стороны
 * подписчика — у зрителя есть ровно одно peer-соединение, с публикатором.
 *
 * Поведение:
 *  - На mount: `socket.emit('webrtc:peer-joined', { lectureId })` —
 *    регистрируется в peer-list лекции (gateway хранит
 *    `Map<lectureId, Set<socketId>>`, см. KS-3836). После регистрации
 *    gateway форвардит публикатору такое же событие с `fromSocketId =
 *    socketId зрителя`, тренер создаёт под зрителя свой
 *    `RTCPeerConnection` и шлёт offer.
 *  - На `webrtc:offer` от тренера (`fromSocketId`):
 *    `new RTCPeerConnection({ iceServers: STUN_SERVERS })`,
 *    `setRemoteDescription(sdp)` → `createAnswer` →
 *    `setLocalDescription` → `emit('webrtc:answer', { lectureId,
 *    toSocketId: fromSocketId, sdp })`. `ontrack` прокидывает входящий
 *    `MediaStream` в `audioRef.current.srcObject`.
 *  - На `webrtc:ice` от тренера: `addIceCandidate(candidate)`.
 *  - На локальный `pc.onicecandidate`: `emit('webrtc:ice', { lectureId,
 *    toSocketId: publisherSocketId, candidate })`.
 *  - На unmount / смену `lectureId` / смену `socket`: `pc.close()`,
 *    `emit('webrtc:peer-left', { lectureId })`. Сам socket не
 *    disconnect-аем — он глобальный.
 *
 * Воспроизведение звука: `audioRef` нужно прокинуть в `<audio ref={…} />`.
 * Автоплей `.play()` вызывается после установки `srcObject`; в браузерах,
 * блокирующих autoplay без user-interaction (Safari, Chrome без gesture),
 * `play()` reject-нется — потребитель должен показать кнопку «Включить
 * голос», по клику на которой вызвать `audioRef.current?.play()`.
 *
 * Возвращает:
 *  - `audioRef` — ref на `<audio>`. Хук сам выставит `srcObject` при
 *    приходе `ontrack`.
 *  - `connectionState` — текущий `iceConnectionState` peer'а (`null`
 *    пока offer от тренера ещё не пришёл).
 *  - `isConnected` — `true` если `iceConnectionState === 'connected' ||
 *    'completed'`. Удобный флаг для UI (бейдж «голос в эфире»).
 */

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface UseLectureAudioSubscriberArgs {
  /** ID лекции. `null`/`undefined` — хук «спит». */
  lectureId: string | null | undefined;
  /**
   * Уже подключённый socket к namespace `/live-analysis`. Обычно —
   * глобальный `liveAnalysisSocket` из `apps/web/src/socket.ts`.
   */
  socket: Socket | null | undefined;
}

export interface UseLectureAudioSubscriberState {
  /**
   * Ref на `<audio>`-элемент. Хук установит `srcObject` при приходе
   * `ontrack`. Потребитель: `<audio ref={audioRef} autoPlay playsInline />`.
   */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /**
   * Текущий `iceConnectionState` peer-соединения с тренером. `null`
   * — peer ещё не создан (offer не пришёл).
   */
  connectionState: RTCIceConnectionState | null;
  /** `true` если `connectionState === 'connected' || 'completed'`. */
  isConnected: boolean;
}

export function useLectureAudioSubscriber({
  lectureId,
  socket,
}: UseLectureAudioSubscriberArgs): UseLectureAudioSubscriberState {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Единственное peer-соединение с тренером — храним в ref'е (мутабельный
  // ресурс, ре-рендер на каждое изменение не нужен).
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // socketId тренера, от которого пришёл offer. Нужен, чтобы
  // отправлять answer/ice обратно.
  const publisherSocketIdRef = useRef<string | null>(null);

  const [connectionState, setConnectionState] =
    useState<RTCIceConnectionState | null>(null);

  const lectureIdRef = useRef(lectureId);
  const socketRef = useRef(socket);
  useEffect(() => {
    lectureIdRef.current = lectureId;
  }, [lectureId]);
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    if (!lectureId || !socket) {
      // «Спим»: чистим всё.
      const pc = pcRef.current;
      if (pc) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      }
      pcRef.current = null;
      publisherSocketIdRef.current = null;
      setConnectionState(null);
      return;
    }

    const closePeer = () => {
      const pc = pcRef.current;
      if (pc) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      }
      pcRef.current = null;
      publisherSocketIdRef.current = null;
      setConnectionState(null);
      const el = audioRef.current;
      if (el) {
        el.srcObject = null;
      }
    };

    const handleOffer = (payload: WebRTCOfferEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const fromSocketId = payload.fromSocketId;
      if (!fromSocketId) return;
      // Re-offer от того же тренера (ICE-restart) — закрываем старый pc.
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {
          /* ignore */
        }
        pcRef.current = null;
      }

      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      pcRef.current = pc;
      publisherSocketIdRef.current = fromSocketId;

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const s = socketRef.current;
        const lid = lectureIdRef.current;
        const publisherId = publisherSocketIdRef.current;
        if (!s || !lid || !publisherId) return;
        const evt: WebRTCIceEvent = {
          lectureId: lid,
          toSocketId: publisherId,
          candidate: {
            candidate: ev.candidate.candidate,
            sdpMid: ev.candidate.sdpMid ?? null,
            sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
            usernameFragment: ev.candidate.usernameFragment ?? null,
          },
        };
        s.emit('webrtc:ice', evt);
      };

      pc.oniceconnectionstatechange = () => {
        setConnectionState(pc.iceConnectionState);
        if (
          pc.iceConnectionState === 'failed' ||
          pc.iceConnectionState === 'closed'
        ) {
          // Peer мёртв — обнуляем srcObject, чтобы аудиоэлемент не
          // держал отвалившийся MediaStream.
          const el = audioRef.current;
          if (el) el.srcObject = null;
        }
      };

      pc.ontrack = (ev) => {
        // Берём первый stream — у нас единственный audio-track.
        const stream = ev.streams[0] ?? new MediaStream([ev.track]);
        const el = audioRef.current;
        if (el) {
          el.srcObject = stream;
          // play() может reject-нуться из-за autoplay-policy браузера
          // (Safari, Chrome без user-gesture). Это нормально: UI
          // показывает кнопку «Включить голос», по клику дёргает play().
          el.play().catch(() => {
            /* autoplay blocked — UI обработает по клику */
          });
        }
      };

      (async () => {
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const s = socketRef.current;
          const lid = lectureIdRef.current;
          if (!s || !lid || !answer.sdp) return;
          s.emit('webrtc:answer', {
            lectureId: lid,
            toSocketId: fromSocketId,
            sdp: answer.sdp,
          });
        } catch (err) {
          console.warn('[useLectureAudioSubscriber] answer flow failed', err);
          closePeer();
        }
      })();
    };

    const handleIce = (payload: WebRTCIceEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const fromSocketId = payload.fromSocketId;
      if (!fromSocketId) return;
      // Принимаем ICE только от того тренера, с кем уже идёт обмен.
      if (
        publisherSocketIdRef.current &&
        publisherSocketIdRef.current !== fromSocketId
      ) {
        return;
      }
      const pc = pcRef.current;
      if (!pc) return;
      pc.addIceCandidate({
        candidate: payload.candidate.candidate,
        sdpMid: payload.candidate.sdpMid ?? undefined,
        sdpMLineIndex: payload.candidate.sdpMLineIndex ?? undefined,
        usernameFragment: payload.candidate.usernameFragment ?? undefined,
      }).catch((err) => {
        console.warn('[useLectureAudioSubscriber] addIceCandidate failed', err);
      });
    };

    const handlePeerLeft = (payload: WebRTCPeerLeftEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      // Если ушёл тренер — закрываем peer.
      if (
        publisherSocketIdRef.current &&
        payload.fromSocketId === publisherSocketIdRef.current
      ) {
        closePeer();
      }
    };

    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:ice', handleIce);
    socket.on('webrtc:peer-left', handlePeerLeft);

    // Регистрируемся в peer-list. Сервер сам форвардит peer-joined
    // публикатору с нашим socketId, и тренер пришлёт offer.
    const joinEvt: WebRTCPeerJoinedEvent = { lectureId };
    socket.emit('webrtc:peer-joined', joinEvt);

    return () => {
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:ice', handleIce);
      socket.off('webrtc:peer-left', handlePeerLeft);
      try {
        const leaveEvt: WebRTCPeerLeftEvent = { lectureId };
        socket.emit('webrtc:peer-left', leaveEvt);
      } catch {
        /* socket мог упасть — игнорируем */
      }
      closePeer();
    };
  }, [lectureId, socket]);

  const isConnected =
    connectionState === 'connected' || connectionState === 'completed';

  return { audioRef, connectionState, isConnected };
}
