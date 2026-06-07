import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type {
  WebRTCCapacityExceededEvent,
  WebRTCIceEvent,
  WebRTCOfferEvent,
  WebRTCPeerJoinedEvent,
  WebRTCPeerLeftEvent,
} from '@kingside/shared';
import { api } from '../api';

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
 * KS-3850 / ADR-116 §2.1, §2.2. Обработка переполнения лекции:
 *  - На `webrtc:capacity-exceeded` от gateway (лекция уже набрала 15
 *    подписчиков): `connectionState` переходит в `'capacity-exceeded'`,
 *    peer-connection НЕ создаётся, повторных попыток нет. UI показывает
 *    badge «Лекция заполнена, голос недоступен. Подключитесь позже».
 *    Доска (соседний WS-канал) при этом продолжает работать — хук влияет
 *    только на голос.
 *
 * KS-3849 / ADR-116 §2.3, §6.2. Обработка проблем NAT:
 *  - Через 10 секунд после `webrtc:peer-joined` хук проверяет
 *    `iceConnectionState`. Если за это время `pc` не успел дойти до
 *    `connected`/`completed` или ушёл в `failed` — `connectionState`
 *    переходит в `'ice-failed-timeout'`, отправляется метрика
 *    `POST /lecture-audio/peer-failed` (одноразово), UI показывает
 *    «Не удалось установить голосовое соединение». Повторных попыток
 *    нет — пользователь решает, перезагрузить ли страницу или сменить
 *    устройство.
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
 *  - `connectionState` — текущее состояние голосового соединения:
 *    `RTCIceConnectionState` (если peer создан) либо синтетические
 *    `'capacity-exceeded'` (KS-3850), `'ice-failed-timeout'` (KS-3849),
 *    либо `null` пока ничего не известно.
 *  - `isConnected` — `true` если `iceConnectionState === 'connected' ||
 *    'completed'`. Удобный флаг для UI (бейдж «голос в эфире»).
 */

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * KS-3849 / ADR-116 §2.3. 10 секунд — крайний срок установления
 * соединения. По истечении считаем, что NAT/firewall не пробивается без
 * TURN, и сообщаем метрику.
 */
const ICE_TIMEOUT_MS = 10_000;

/**
 * KS-3850: синтетическое состояние «лекция набрала capacity 15». Не
 * входит в `RTCIceConnectionState`.
 *
 * KS-3849: синтетическое состояние «10 секунд после peer-joined прошли,
 * а соединение так и не установилось».
 */
export type LectureAudioConnectionState =
  | RTCIceConnectionState
  | 'capacity-exceeded'
  | 'ice-failed-timeout';

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
   * Текущее состояние голосового соединения. `null` — peer ещё не
   * создан (offer не пришёл). См. `LectureAudioConnectionState`.
   */
  connectionState: LectureAudioConnectionState | null;
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
    useState<LectureAudioConnectionState | null>(null);

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

    // KS-3850: если gateway отказал в peer-list, не открываем peer
    // вовсе. KS-3849: если 10 сек прошли без connected — метрика
    // peer-failed. Оба пути идут через этот флаг: один раз — больше
    // ничего не делаем.
    let peerFailedReported = false;
    let iceTimer: ReturnType<typeof setTimeout> | null = null;
    let capacityRefused = false;

    const reportPeerFailed = (
      reason: 'ice_failed' | 'ice_timeout',
      iceState: string,
    ) => {
      if (peerFailedReported) return;
      peerFailedReported = true;
      // Fire-and-forget. Ошибки сети глотаем — пользователь уже видит
      // UI «не удалось установить соединение», вторая ошибка ему не
      // помогает.
      api
        .post('/lecture-audio/peer-failed', {
          lectureId,
          reason,
          role: 'subscriber',
          iceConnectionState: iceState,
        })
        .catch((err) => {
          console.warn(
            '[useLectureAudioSubscriber] peer-failed POST failed',
            err,
          );
        });
    };

    const clearIceTimer = () => {
      if (iceTimer) {
        clearTimeout(iceTimer);
        iceTimer = null;
      }
    };

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
      // Не затираем 'capacity-exceeded' / 'ice-failed-timeout' —
      // эти состояния «терминальные», UI должен их показывать дальше.
      setConnectionState((prev) =>
        prev === 'capacity-exceeded' || prev === 'ice-failed-timeout'
          ? prev
          : null,
      );
      const el = audioRef.current;
      if (el) {
        el.srcObject = null;
      }
    };

    const handleOffer = (payload: WebRTCOfferEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      // KS-3850: если gateway уже сообщил, что лекция заполнена,
      // отрицаем любые внезапные offer'ы (форвард мог быть в полёте).
      if (capacityRefused) return;
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
          pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed'
        ) {
          // KS-3849: дошли до connected раньше 10 сек — снимаем таймер.
          clearIceTimer();
        }
        if (pc.iceConnectionState === 'failed') {
          // KS-3849: failed → метрика peer-failed + UI «не удалось».
          clearIceTimer();
          reportPeerFailed('ice_failed', pc.iceConnectionState);
          setConnectionState('ice-failed-timeout');
        }
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

    const handleCapacityExceeded = (payload: WebRTCCapacityExceededEvent) => {
      if (payload?.lectureId !== lectureIdRef.current) return;
      // KS-3850: peer-list уже набрал 15 подписчиков, gateway нас не
      // зарегистрировал. Не открываем peer, помечаем терминальное
      // состояние; таймер ICE отменяем, чтобы не сработала ложная
      // peer-failed метрика на пустом месте.
      capacityRefused = true;
      clearIceTimer();
      setConnectionState('capacity-exceeded');
      // На всякий случай закрываем уже созданный peer (если успел).
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {
          /* ignore */
        }
        pcRef.current = null;
        publisherSocketIdRef.current = null;
      }
    };

    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:ice', handleIce);
    socket.on('webrtc:peer-left', handlePeerLeft);
    socket.on('webrtc:capacity-exceeded', handleCapacityExceeded);

    // Регистрируемся в peer-list. Сервер сам форвардит peer-joined
    // публикатору с нашим socketId, и тренер пришлёт offer.
    const joinEvt: WebRTCPeerJoinedEvent = { lectureId };
    socket.emit('webrtc:peer-joined', joinEvt);

    // KS-3849: запускаем 10-секундный таймер. Если до этого момента
    // peer не успел дойти до connected/completed (включая случай,
    // когда offer вообще не пришёл, например при проблемах NAT у
    // тренера), считаем соединение неудавшимся и шлём метрику. UI
    // получит state 'ice-failed-timeout'.
    iceTimer = setTimeout(() => {
      iceTimer = null;
      // Capacity-exceeded — нормальный отказ сервера, не считаем за
      // peer-failed. Если уже connected — таймер был очищен раньше.
      if (capacityRefused || peerFailedReported) return;
      const pc = pcRef.current;
      const state: string = pc?.iceConnectionState ?? 'no_offer';
      if (state === 'connected' || state === 'completed') return;
      reportPeerFailed('ice_timeout', state);
      setConnectionState('ice-failed-timeout');
      // Закрываем pc — повторных попыток нет (см. ADR-116 §2.3).
      if (pc) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
        pcRef.current = null;
        publisherSocketIdRef.current = null;
      }
      const el = audioRef.current;
      if (el) el.srcObject = null;
    }, ICE_TIMEOUT_MS);

    return () => {
      clearIceTimer();
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:ice', handleIce);
      socket.off('webrtc:peer-left', handlePeerLeft);
      socket.off('webrtc:capacity-exceeded', handleCapacityExceeded);
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
