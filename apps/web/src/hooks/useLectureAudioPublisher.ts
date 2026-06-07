import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';

/**
 * KS-3841 / ADR-116 §5.2, §2.4. Хук тренера: запись микрофона +
 * чанковая загрузка в S3 через backend (модуль `lecture-audio`,
 * KS-3830).
 *
 * Поток:
 *  1. `start()` запрашивает микрофон через `getUserMedia({ audio: …
 *     echoCancellation/noiseSuppression/autoGainControl })`.
 *  2. `new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus',
 *     audioBitsPerSecond: 32000 })`. 32 kbps моно — компромисс между
 *     качеством голоса и размером (≈ 4 КБ/сек).
 *  3. `recorder.start(30_000)` — `ondataavailable` срабатывает каждые
 *     30 секунд с очередным `Blob` чанка.
 *  4. На каждый чанк (seq = 0, 1, 2, …):
 *     - `POST /lectures/:id/audio/chunk-url { seq, sizeBytes }`
 *       → `{ uploadUrl, chunkKey }` (presigned PUT, TTL 5 мин).
 *     - `PUT uploadUrl` с заголовком `x-amz-tagging: kind=chunk`
 *       (без этого S3 отвергнет подпись — заголовок входит в
 *       signedHeaders, см. KS-3827 / lifecycle 24 часа). Body = blob.
 *     - Из ответа PUT'а достаём `ETag` (с кавычками — оставляем как
 *       есть, backend сам нормализует).
 *     - `POST /lectures/:id/audio/chunk-ack { seq, etag, sizeBytes,
 *       clientCreatedAt }`. Backend идемпотентно UPSERT'нет
 *       `LectureAudioChunk` по `(lectureId, seq)`.
 *  5. Очередь параллелизма: максимум 2 одновременных upload'а. Это
 *     ограничивает сетевой пик при 30-секундном такте и не мешает
 *     быстрому догону, если один чанк завис.
 *
 * `recorderStartedAtClient` — момент `recorder.start()` в виде
 * ISO-8601, скорректированный на `clockSkewMs` (см. KS-3834 / ADR-116
 * §2.5: `serverNow - Date.now()` в ответе `POST /lectures/:id/start`).
 *
 * KS-3845 (singleton-lock): на `start()` хук проверяет
 * `localStorage['kingside:audio-publisher-lock']`. Если там lock
 * другого устройства, обновлённый ≤30 секунд назад — `start()` бросает
 * `AudioPublisherLockError` без обращения к микрофону. Свой lock
 * обновляется каждые 10 секунд через `setInterval`; на `stop()` lock
 * стирается. Это страховка против двух одновременных публикаций с
 * одного аккаунта (две вкладки, второе устройство).
 *
 * KS-3846 (финализация): отдельный метод `finalize()` дожидается
 * опустошения очереди upload'ов и шлёт `POST /lectures/:id/end` с
 * `{ offsetMs, chunkCount, recorderStartedAtClient, recorderEndedAtClient }`.
 * На `window.beforeunload` хук сам шлёт тот же payload через
 * `navigator.sendBeacon(...)` — best-effort, последний чанк может
 * не успеть, cron-finalizer (KS-A05') добьёт.
 *
 * KS-3851 (privacy-disclaimer для зрителя): если в `args.socket`
 * передан подключённый socket (`/live-analysis`), хук на `start()`
 * шлёт `lecture:recording-started { lectureId }`, на `stop()` —
 * `lecture:recording-stopped { lectureId }`. Зритель показывает
 * значок «🔴 запись» (см. `LectureRecordingBadge`).
 *
 * Хук — fire-and-forget по сети: HTTP-ошибки логируются в
 * `chunksFailed` (увеличивается на 1), запись продолжается; повторных
 * попыток нет.
 */

const RECORDER_MIME = 'audio/webm;codecs=opus';
const RECORDER_BITRATE = 32_000;
// Короткий интервал (5 сек) выбран ради устойчивости коротких лекций
// (10–20 сек): хотя бы один полный чанк успеет уйти в S3, не полагаясь
// на финальный кусочек от `recorder.stop()`. Сетевой пик невелик —
// 32 kbps ≈ 20 КБ за чанк.
const CHUNK_DURATION_MS = 5_000;
const MAX_PARALLEL_UPLOADS = 2;
const X_AMZ_TAGGING = 'kind=chunk';

/** KS-3845: ключ в localStorage и параметры singleton-lock. */
const LOCK_STORAGE_KEY = 'kingside:audio-publisher-lock';
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/**
 * KS-3845: ошибка singleton-lock. UI отличает её от прочих по
 * `error.name === 'AudioPublisherLockError'` и показывает текст
 * «Запись уже идёт с другого устройства» вместо generic-сообщения.
 */
export class AudioPublisherLockError extends Error {
  constructor(message = 'Запись уже идёт с другого устройства') {
    super(message);
    this.name = 'AudioPublisherLockError';
  }
}

interface AudioPublisherLockPayload {
  lectureId: string;
  deviceId: string;
  lastHeartbeat: number;
}

function readLock(): AudioPublisherLockPayload | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AudioPublisherLockPayload>;
    if (
      typeof parsed?.lectureId !== 'string' ||
      typeof parsed?.deviceId !== 'string' ||
      typeof parsed?.lastHeartbeat !== 'number'
    ) {
      return null;
    }
    return parsed as AudioPublisherLockPayload;
  } catch {
    return null;
  }
}

function writeLock(lock: AudioPublisherLockPayload): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(lock));
  } catch {
    /* quota / private mode — игнорируем */
  }
}

function clearLock(deviceId: string): void {
  if (typeof localStorage === 'undefined') return;
  const current = readLock();
  // Стираем lock только если он наш — иначе перетрём чужой свежий.
  if (!current || current.deviceId === deviceId) {
    try {
      localStorage.removeItem(LOCK_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

function generateDeviceId(): string {
  // crypto.randomUUID() — современный браузер; fallback на Math.random
  // для совсем старых.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface UseLectureAudioPublisherArgs {
  /** ID лекции (требуется на `start()`). `null`/`undefined` — `start()` бросит. */
  lectureId: string | null | undefined;
  /**
   * KS-3834: `serverNow - Date.now()` на момент ответа `POST
   * /lectures/:id/start`. Используется, чтобы привести клиентский
   * `Date.now()` к серверной шкале при формировании
   * `recorderStartedAtClient` и `recorderEndedAtClient`.
   */
  clockSkewMs?: number;
  /**
   * ISO-8601 момент начала записи событий (`LectureRecording.startedAt`,
   * также скорректированный clockSkew). Если передан, хук вычисляет
   * `offsetMs = recorderStart - recordingStart`.
   */
  recordingStartedAtClient?: string | null;
  /**
   * KS-3851: socket к `/live-analysis` для рассылки disclaimer-событий
   * `lecture:recording-started` / `lecture:recording-stopped`. Если
   * не передан — события не шлются, остальной флоу работает.
   */
  socket?: Socket | null;
}

export interface UseLectureAudioPublisherState {
  /** Стартует запись и upload-цикл. Бросает при отсутствии lectureId, getUserMedia или MediaRecorder. */
  start: () => Promise<void>;
  /** Останавливает запись. Безопасен повторный вызов. */
  stop: () => Promise<void>;
  /**
   * KS-3846: останавливает запись (если активна), дожидается
   * опустошения очереди upload'ов и шлёт `POST /lectures/:id/end`
   * с финализирующим payload. Если запись не велась — `POST /end`
   * не шлётся, возвращается `null`.
   */
  finalize: () => Promise<unknown>;
  /** `true` если recorder в состоянии 'recording'. */
  isRecording: boolean;
  /** Кол-во чанков, для которых полностью прошёл цикл presign → PUT → ack. */
  chunksSent: number;
  /** Кол-во чанков, на которых хоть один шаг свалился. */
  chunksFailed: number;
  /** Момент `recorder.start()` в серверной шкале, ISO-8601. `null` до старта. */
  recorderStartedAtClient: string | null;
  /** Момент `recorder.stop()` в серверной шкале, ISO-8601. `null` до stop. */
  recorderEndedAtClient: string | null;
  /**
   * Смещение начала аудио относительно начала `LectureRecording`, мс.
   * `null` если `recordingStartedAtClient` не передан.
   */
  offsetMs: number | null;
  /** Последняя ошибка `start()` / `getUserMedia` / MediaRecorder / lock. */
  error: Error | null;
  /**
   * KS-3843: audio-track активного `MediaStream`'а. `null` пока запись
   * не идёт. Используется `useLectureAudioPeerConnections` для
   * публикации голоса зрителям через WebRTC. Один и тот же track
   * безопасно использовать в нескольких peer-connection одновременно.
   */
  audioTrack: MediaStreamTrack | null;
}

interface ChunkUploadResponse {
  uploadUrl: string;
  chunkKey: string;
}

interface FinalizeRequest {
  offsetMs: number | null;
  chunkCount: number;
  recorderStartedAtClient: string | null;
  recorderEndedAtClient: string | null;
}

export function useLectureAudioPublisher({
  lectureId,
  clockSkewMs = 0,
  recordingStartedAtClient = null,
  socket = null,
}: UseLectureAudioPublisherArgs): UseLectureAudioPublisherState {
  const [isRecording, setIsRecording] = useState(false);
  const [chunksSent, setChunksSent] = useState(0);
  const [chunksFailed, setChunksFailed] = useState(0);
  const [recorderStartedAtClient, setRecorderStartedAtClient] = useState<
    string | null
  >(null);
  const [recorderEndedAtClient, setRecorderEndedAtClient] = useState<
    string | null
  >(null);
  const [offsetMs, setOffsetMs] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [audioTrack, setAudioTrack] = useState<MediaStreamTrack | null>(null);

  // Ссылка на mutable ресурсы записи: stream/recorder живут вне React-
  // состояния, иначе их остановка через стейт может опоздать.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const seqRef = useRef(0);

  // Семафор параллельности (≤ MAX_PARALLEL_UPLOADS одновременных
  // upload'ов).
  const inFlightRef = useRef(0);
  const waitersRef = useRef<Array<() => void>>([]);
  // KS-3846: уведомление о полном опустошении очереди — finalize()
  // ждёт `chunksSent + chunksFailed === seqRef.current`.
  const queueDrainListenersRef = useRef<Array<() => void>>([]);

  // KS-3845: уникальный deviceId на жизнь хука. Используется в lock-
  // записи и проверке «свой ли это lock».
  const deviceIdRef = useRef<string>('');
  if (!deviceIdRef.current) deviceIdRef.current = generateDeviceId();
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Свежие props в замыканиях.
  const lectureIdRef = useRef(lectureId);
  useEffect(() => {
    lectureIdRef.current = lectureId;
  }, [lectureId]);
  const clockSkewRef = useRef(clockSkewMs);
  useEffect(() => {
    clockSkewRef.current = clockSkewMs;
  }, [clockSkewMs]);
  const recordingStartedAtRef = useRef(recordingStartedAtClient);
  useEffect(() => {
    recordingStartedAtRef.current = recordingStartedAtClient;
  }, [recordingStartedAtClient]);
  const socketRef = useRef(socket);
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  // ─── Семафор очереди ────────────────────────────────────────────────
  const acquireSlot = useCallback((): Promise<void> => {
    if (inFlightRef.current < MAX_PARALLEL_UPLOADS) {
      inFlightRef.current += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waitersRef.current.push(() => {
        inFlightRef.current += 1;
        resolve();
      });
    });
  }, []);

  const releaseSlot = useCallback(() => {
    inFlightRef.current -= 1;
    const next = waitersRef.current.shift();
    if (next) next();
    // KS-3846: если очередь пуста и больше никто не ждёт — уведомляем
    // подписчиков (finalize).
    if (inFlightRef.current === 0 && waitersRef.current.length === 0) {
      const listeners = queueDrainListenersRef.current.slice();
      queueDrainListenersRef.current = [];
      listeners.forEach((fn) => fn());
    }
  }, []);

  const waitForQueueDrain = useCallback((): Promise<void> => {
    if (inFlightRef.current === 0 && waitersRef.current.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queueDrainListenersRef.current.push(resolve);
    });
  }, []);

  // ─── Upload одного чанка ────────────────────────────────────────────
  const uploadChunk = useCallback(
    async (seq: number, blob: Blob) => {
      const lid = lectureIdRef.current;
      if (!lid) {
        setChunksFailed((n) => n + 1);
        return;
      }
      const clientCreatedAt = new Date(
        Date.now() + clockSkewRef.current,
      ).toISOString();
      await acquireSlot();
      try {
        const presign = await api.post<ChunkUploadResponse>(
          `/lectures/${encodeURIComponent(lid)}/audio/chunk-url`,
          { seq, sizeBytes: blob.size },
        );
        const putRes = await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: {
            'x-amz-tagging': X_AMZ_TAGGING,
            'Content-Type': RECORDER_MIME,
          },
          body: blob,
        });
        if (!putRes.ok) {
          throw new Error(
            `S3 PUT failed: ${putRes.status} ${putRes.statusText}`,
          );
        }
        const etag = putRes.headers.get('ETag') ?? putRes.headers.get('etag');
        if (!etag) {
          throw new Error('S3 PUT response missing ETag header');
        }
        await api.post(
          `/lectures/${encodeURIComponent(lid)}/audio/chunk-ack`,
          {
            seq,
            etag,
            sizeBytes: blob.size,
            clientCreatedAt,
          },
        );
        setChunksSent((n) => n + 1);
      } catch (err) {
        console.warn(
          '[useLectureAudioPublisher] chunk upload failed',
          { seq, error: err },
        );
        setChunksFailed((n) => n + 1);
      } finally {
        releaseSlot();
      }
    },
    [acquireSlot, releaseSlot],
  );

  // ─── KS-3845: singleton-lock ────────────────────────────────────────
  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
    }
    heartbeatTimerRef.current = setInterval(() => {
      const lid = lectureIdRef.current;
      if (!lid) return;
      writeLock({
        lectureId: lid,
        deviceId: deviceIdRef.current,
        lastHeartbeat: Date.now(),
      });
    }, LOCK_HEARTBEAT_MS);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  // ─── Teardown ───────────────────────────────────────────────────────
  const teardown = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
    }
    streamRef.current = null;
    recorderRef.current = null;
    setIsRecording(false);
    setAudioTrack(null);
    stopHeartbeat();
    clearLock(deviceIdRef.current);
  }, [stopHeartbeat]);

  // ─── start ──────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (recorderRef.current) return;
    setError(null);
    setChunksSent(0);
    setChunksFailed(0);
    setRecorderEndedAtClient(null);
    seqRef.current = 0;
    inFlightRef.current = 0;
    waitersRef.current = [];
    queueDrainListenersRef.current = [];

    const lid = lectureIdRef.current;
    if (!lid) {
      const err = new Error(
        'useLectureAudioPublisher.start: lectureId is required',
      );
      setError(err);
      throw err;
    }

    // KS-3845: проверка lock. Если есть свежий чужой lock — выходим.
    const existing = readLock();
    if (
      existing &&
      existing.deviceId !== deviceIdRef.current &&
      Date.now() - existing.lastHeartbeat < LOCK_STALE_MS
    ) {
      const lockErr = new AudioPublisherLockError();
      setError(lockErr);
      throw lockErr;
    }
    // Свой / устаревший / отсутствующий — пишем свой lock.
    writeLock({
      lectureId: lid,
      deviceId: deviceIdRef.current,
      lastHeartbeat: Date.now(),
    });

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const err = new Error(
        'getUserMedia is not available (insecure context or unsupported browser)',
      );
      setError(err);
      clearLock(deviceIdRef.current);
      throw err;
    }
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
      const err = new Error(
        'MediaRecorder is not supported in this browser',
      );
      setError(err);
      clearLock(deviceIdRef.current);
      throw err;
    }
    if (!window.MediaRecorder.isTypeSupported(RECORDER_MIME)) {
      const err = new Error(
        `MediaRecorder does not support ${RECORDER_MIME} in this browser`,
      );
      setError(err);
      clearLock(deviceIdRef.current);
      throw err;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      clearLock(deviceIdRef.current);
      throw err;
    }
    streamRef.current = stream;
    // KS-3843: первый audio-track из stream'а — публикуем его в
    // peer-connections (`useLectureAudioPeerConnections`). У микрофона
    // ровно один track, остальное — defensive.
    const tracks = stream.getAudioTracks();
    setAudioTrack(tracks[0] ?? null);

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: RECORDER_MIME,
        audioBitsPerSecond: RECORDER_BITRATE,
      });
    } catch (e) {
      teardown();
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      const blob = ev.data;
      if (!blob || blob.size === 0) return;
      const seq = seqRef.current;
      seqRef.current = seq + 1;
      void uploadChunk(seq, blob);
    };
    recorder.onerror = (ev: Event) => {
      const detail =
        ev instanceof ErrorEvent && ev.error instanceof Error
          ? ev.error
          : new Error('MediaRecorder error');
      console.warn('[useLectureAudioPublisher] recorder error', detail);
      setError(detail);
      teardown();
    };
    recorder.onstop = () => {
      setIsRecording(false);
    };

    const beforeMs = Date.now();
    recorder.start(CHUNK_DURATION_MS);
    const afterMs = Date.now();
    const midMs = Math.round((beforeMs + afterMs) / 2);
    const startedClient = new Date(midMs + clockSkewRef.current).toISOString();
    setRecorderStartedAtClient(startedClient);
    setIsRecording(true);
    startHeartbeat();

    const recStart = recordingStartedAtRef.current;
    if (recStart) {
      const recStartMs = Date.parse(recStart);
      const recorderStartMs = Date.parse(startedClient);
      if (Number.isFinite(recStartMs) && Number.isFinite(recorderStartMs)) {
        setOffsetMs(recorderStartMs - recStartMs);
      } else {
        setOffsetMs(null);
      }
    } else {
      setOffsetMs(null);
    }

    // KS-3851: уведомляем зрителей через WS.
    const s = socketRef.current;
    if (s) {
      try {
        s.emit('lecture:recording-started', { lectureId: lid });
      } catch {
        /* socket мог упасть — не критично */
      }
    }
  }, [startHeartbeat, teardown, uploadChunk]);

  // ─── stop ───────────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    const endedClient = new Date(
      Date.now() + clockSkewRef.current,
    ).toISOString();

    // KS-3851: рассылка ДО teardown, пока socketRef ещё валиден.
    const s = socketRef.current;
    const lid = lectureIdRef.current;
    if (s && lid) {
      try {
        s.emit('lecture:recording-stopped', { lectureId: lid });
      } catch {
        /* ignore */
      }
    }

    if (!recorder) {
      teardown();
      return;
    }
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    setRecorderEndedAtClient(endedClient);
    teardown();
  }, [teardown]);

  // ─── KS-3846: finalize ──────────────────────────────────────────────
  const finalize = useCallback(async () => {
    const lid = lectureIdRef.current;
    if (!lid) return null;
    // Если запись была — останавливаем (это даст последний chunk).
    const wasRecording = Boolean(recorderRef.current);
    if (wasRecording) {
      await stop();
    }
    if (!wasRecording && seqRef.current === 0) {
      // Хук вообще не использовался — нечего финализировать.
      return null;
    }
    // Ждём, пока все начатые upload-задачи завершатся.
    await waitForQueueDrain();

    const payload: FinalizeRequest = {
      offsetMs,
      chunkCount: seqRef.current,
      recorderStartedAtClient,
      recorderEndedAtClient:
        recorderEndedAtClient ??
        new Date(Date.now() + clockSkewRef.current).toISOString(),
    };
    try {
      const resp = await api.post(
        `/lectures/${encodeURIComponent(lid)}/end`,
        payload,
      );
      return resp;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn('[useLectureAudioPublisher] finalize failed', err);
      setError(err);
      return null;
    }
  }, [
    offsetMs,
    recorderEndedAtClient,
    recorderStartedAtClient,
    stop,
    waitForQueueDrain,
  ]);

  // ─── KS-3846: beforeunload + sendBeacon ─────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      // Шлём только если recorder реально стартовал (иначе finalize
      // на бэке упадёт на чужой лекции).
      const lid = lectureIdRef.current;
      const startedAt = recorderStartedAtClient;
      if (!lid || !startedAt) return;
      // recorder.stop() даёт шанс последнему chunk'у уйти в upload —
      // но в beforeunload браузер уже свернёт fetch'и. Это лучшая
      // попытка, основной флаш делает cron-finalizer (KS-A05').
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      const endedAt = new Date(
        Date.now() + clockSkewRef.current,
      ).toISOString();
      const payload: FinalizeRequest = {
        offsetMs,
        chunkCount: seqRef.current,
        recorderStartedAtClient: startedAt,
        recorderEndedAtClient: endedAt,
      };
      // KS-3851: финальный disclaimer на unload.
      const s = socketRef.current;
      if (s) {
        try {
          s.emit('lecture:recording-stopped', { lectureId: lid });
        } catch {
          /* ignore */
        }
      }
      // sendBeacon берёт абсолютный URL — используем тот же API_URL,
      // что в `api.ts`.
      const API_URL =
        import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
      const url = `${API_URL}/lectures/${encodeURIComponent(lid)}/end`;
      const blob = new Blob([JSON.stringify(payload)], {
        type: 'application/json',
      });
      try {
        navigator.sendBeacon?.(url, blob);
      } catch {
        /* ignore — last-resort fallback ничего не даст */
      }
      // KS-3845: отдаём lock, чтобы тренер мог сразу перезапустить
      // на другой вкладке/устройстве.
      clearLock(deviceIdRef.current);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [offsetMs, recorderStartedAtClient]);

  // На unmount останавливаем запись и стираем lock.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        });
      }
      streamRef.current = null;
      recorderRef.current = null;
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      clearLock(deviceIdRef.current);
    };
  }, []);

  return {
    start,
    stop,
    finalize,
    isRecording,
    chunksSent,
    chunksFailed,
    recorderStartedAtClient,
    recorderEndedAtClient,
    offsetMs,
    error,
    audioTrack,
  };
}
