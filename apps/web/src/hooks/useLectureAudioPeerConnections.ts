import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type {
  WebRTCAnswerEvent,
  WebRTCIceEvent,
  WebRTCPeerJoinedEvent,
  WebRTCPeerLeftEvent,
} from '@kingside/shared';

/**
 * KS-3842 / ADR-116 §2.1, §2.2. Хук тренера-публикатора аудио лекции.
 *
 * Тренер держит по одному `RTCPeerConnection` на каждого зрителя
 * (mesh-топология, без SFU). Для каждого нового подписчика создаётся
 * peer, в него добавляется единственный audio-track из getUserMedia,
 * генерируется SDP-offer и пересылается зрителю через namespace
 * `/live-analysis` (см. KS-3836: gateway-сигналинг).
 *
 * Поведение:
 *  - `webrtc:peer-joined` (forward от gateway, в payload `fromSocketId`):
 *    создаём `RTCPeerConnection` с двумя STUN'ами (Google + Cloudflare),
 *    `addTrack(audioTrack)`, `createOffer()` → `setLocalDescription`,
 *    `emit('webrtc:offer', { lectureId, toSocketId, sdp })`.
 *  - `webrtc:answer` от того же peer: `setRemoteDescription(sdp)`.
 *  - `webrtc:ice` от того же peer: `pc.addIceCandidate(candidate)`.
 *  - `pc.onicecandidate`: каждый локальный кандидат уходит этому peer'у
 *    через `emit('webrtc:ice', …)`.
 *  - `webrtc:peer-left` или сам ушёл из peer-list (disconnect): `pc.close()`,
 *    запись удаляется из Map.
 *  - Локальный лимит 15 одновременных peer'ов (фиксирован ADR-116 §2.2,
 *    дублирует серверный capacity). При превышении новый peer
 *    игнорируется с `console.warn` — gateway сам отправит зрителю
 *    `webrtc:capacity-exceeded`, фронту-тренеру дополнительная реакция
 *    не нужна.
 *
 * Возвращает:
 *  - `peerCount` — текущее число peer-соединений в Map (для бейджа
 *    «N слушателей»);
 *  - `connectedPeers` — список socketId, у которых
 *    `iceConnectionState === 'connected'` (для отображения «N в эфире»).
 *
 * Хук «спит», пока не пришли все три аргумента (`lectureId`,
 * `audioTrack`, `socket`). При смене любого из них старые соединения
 * закрываются.
 */

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const MAX_PEERS = 15;

export interface UseLectureAudioPeerConnectionsArgs {
  /** ID лекции. `null`/`undefined` — хук «спит». */
  lectureId: string | null | undefined;
  /**
   * Audio-track из `getUserMedia({ audio: true })`. Один и тот же track
   * добавляется во все peer-соединения. `null`/`undefined` — хук «спит»
   * (пока тренер не дал разрешение на микрофон).
   */
  audioTrack: MediaStreamTrack | null | undefined;
  /**
   * Уже подключённый socket к namespace `/live-analysis`. Обычно —
   * глобальный `liveAnalysisSocket` из `apps/web/src/socket.ts`.
   */
  socket: Socket | null | undefined;
}

export interface UseLectureAudioPeerConnectionsState {
  /** Текущее число peer-connection'ов в Map (создано, но может быть ещё не connected). */
  peerCount: number;
  /**
   * socketId'ы тех peer'ов, у которых
   * `iceConnectionState === 'connected' | 'completed'`. Источник для
   * UI «N в эфире».
   */
  connectedPeers: string[];
}

export function useLectureAudioPeerConnections({
  lectureId,
  audioTrack,
  socket,
}: UseLectureAudioPeerConnectionsArgs): UseLectureAudioPeerConnectionsState {
  // Map хранится в ref'е: peer-connection'ы — мутабельные внешние ресурсы,
  // включение их в стейт привело бы к ненужным ре-рендерам. Производные
  // данные (peerCount, connectedPeers) — в state, обновляются точечно.
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [peerCount, setPeerCount] = useState(0);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);

  // Текущие значения lectureId / audioTrack / socket нужны внутри
  // listener'ов; кладём в ref, чтобы не пересоздавать подписки на
  // каждый рендер из-за смены замыкания.
  const lectureIdRef = useRef(lectureId);
  const audioTrackRef = useRef(audioTrack);
  const socketRef = useRef(socket);
  useEffect(() => {
    lectureIdRef.current = lectureId;
  }, [lectureId]);
  useEffect(() => {
    audioTrackRef.current = audioTrack;
  }, [audioTrack]);
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  const refreshConnected = useCallback(() => {
    const list: string[] = [];
    peersRef.current.forEach((pc, peerId) => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') list.push(peerId);
    });
    setConnectedPeers(list);
  }, []);

  const closePeer = useCallback(
    (peerSocketId: string) => {
      const pc = peersRef.current.get(peerSocketId);
      if (!pc) return;
      try {
        pc.close();
      } catch {
        /* peer уже закрыт — игнорируем */
      }
      peersRef.current.delete(peerSocketId);
      setPeerCount(peersRef.current.size);
      refreshConnected();
    },
    [refreshConnected],
  );

  useEffect(() => {
    if (!lectureId || !audioTrack || !socket) {
      // «Спим» — закрываем всё, что было.
      peersRef.current.forEach((pc) => {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      });
      peersRef.current.clear();
      setPeerCount(0);
      setConnectedPeers([]);
      return;
    }

    const handlePeerJoined = (payload: WebRTCPeerJoinedEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const peerSocketId = payload.fromSocketId;
      if (!peerSocketId) return;
      // Идемпотентность: если по какой-то причине gateway переотправил
      // peer-joined для уже известного socketId — не дублируем pc.
      if (peersRef.current.has(peerSocketId)) return;
      if (peersRef.current.size >= MAX_PEERS) {
        // Серверный capacity 15 (см. ADR-116 §2.2) уже отсёк
        // зрителя; этот лимит — страховка на случай рассинхрона.
        console.warn(
          '[useLectureAudioPeerConnections] локальный лимит 15 peer-connection пройден, peer-joined игнорируется',
          { peerSocketId, lectureId: lectureIdRef.current },
        );
        return;
      }

      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      peersRef.current.set(peerSocketId, pc);
      setPeerCount(peersRef.current.size);

      try {
        // KS-3881: addTrack обязательно с MediaStream вторым
        // аргументом. Без него в SDP-offer нет `a=msid`, и у зрителя
        // `pc.ontrack(ev)` приходит с `ev.streams[]` пустым — Chrome
        // тогда не привязывает трек к `<audio>` корректно и звука нет.
        // Создаём отдельный stream на каждый peer; track можно
        // безопасно держать в нескольких MediaStream одновременно.
        const peerStream = new MediaStream([audioTrack]);
        pc.addTrack(audioTrack, peerStream);
      } catch (err) {
        // addTrack может бросить, если track уже остановлен. Закрываем
        // pc, чтобы не висеть в полу-инициализированном состоянии.
        console.warn('[useLectureAudioPeerConnections] addTrack failed', err);
        closePeer(peerSocketId);
        return;
      }

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const s = socketRef.current;
        const lid = lectureIdRef.current;
        if (!s || !lid) return;
        const evt: WebRTCIceEvent = {
          lectureId: lid,
          toSocketId: peerSocketId,
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
        const st = pc.iceConnectionState;
        if (st === 'failed' || st === 'closed' || st === 'disconnected') {
          // Не закрываем сразу на 'disconnected' — браузер может сам
          // вернуться в 'connected' через ICE-restart. Но на 'failed'/
          // 'closed' гарантированно мёртвый peer.
          if (st !== 'disconnected') {
            closePeer(peerSocketId);
            return;
          }
        }
        refreshConnected();
      };

      // Запускаем offer/answer-цикл асинхронно — обработчик события
      // sync, await — fire-and-forget.
      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const s = socketRef.current;
          const lid = lectureIdRef.current;
          if (!s || !lid) return;
          if (!offer.sdp) return;
          s.emit('webrtc:offer', {
            lectureId: lid,
            toSocketId: peerSocketId,
            sdp: offer.sdp,
          });
        } catch (err) {
          console.warn('[useLectureAudioPeerConnections] createOffer failed', err);
          closePeer(peerSocketId);
        }
      })();
    };

    const handleAnswer = (payload: WebRTCAnswerEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const peerSocketId = payload.fromSocketId;
      if (!peerSocketId) return;
      const pc = peersRef.current.get(peerSocketId);
      if (!pc) return;
      pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp }).catch((err) => {
        console.warn(
          '[useLectureAudioPeerConnections] setRemoteDescription(answer) failed',
          err,
        );
        closePeer(peerSocketId);
      });
    };

    const handleIce = (payload: WebRTCIceEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const peerSocketId = payload.fromSocketId;
      if (!peerSocketId) return;
      const pc = peersRef.current.get(peerSocketId);
      if (!pc) return;
      // Сохраняем те же поля, что прислал сервер; неустановленный
      // sdpMid/sdpMLineIndex для some браузеров — валидный кейс.
      pc.addIceCandidate({
        candidate: payload.candidate.candidate,
        sdpMid: payload.candidate.sdpMid ?? undefined,
        sdpMLineIndex: payload.candidate.sdpMLineIndex ?? undefined,
        usernameFragment: payload.candidate.usernameFragment ?? undefined,
      }).catch((err) => {
        console.warn('[useLectureAudioPeerConnections] addIceCandidate failed', err);
      });
    };

    const handlePeerLeft = (payload: WebRTCPeerLeftEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      const peerSocketId = payload.fromSocketId;
      if (!peerSocketId) return;
      closePeer(peerSocketId);
    };

    socket.on('webrtc:peer-joined', handlePeerJoined);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice', handleIce);
    socket.on('webrtc:peer-left', handlePeerLeft);

    const peers = peersRef.current;
    return () => {
      socket.off('webrtc:peer-joined', handlePeerJoined);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice', handleIce);
      socket.off('webrtc:peer-left', handlePeerLeft);
      peers.forEach((pc) => {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      });
      peers.clear();
      setPeerCount(0);
      setConnectedPeers([]);
    };
  }, [lectureId, audioTrack, socket, closePeer, refreshConnected]);

  return { peerCount, connectedPeers };
}
