import { useCallback, useEffect, useRef, useState } from 'react';
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
 * Это даёт серверу единое «когда тренер реально начал запись» для
 * синхронизации аудио с потоком событий (`audio.t = recording.t +
 * offsetMs`). Если `recordingStartedAtClient` передан (момент начала
 * `LectureRecording`), хук вычисляет `offsetMs = recorderStart -
 * recordingStart` (может быть отрицательным, если микрофон стартовал
 * до первого recorded-event'а).
 *
 * `stop()`:
 *  - `recorder.stop()` → последний `ondataavailable` с финальным
 *    кусочком, который уходит на upload по той же очереди.
 *  - Все треки `stream.getTracks()` останавливаются (чтобы погасить
 *    индикатор записи у браузера/ОС).
 *  - Хук НЕ вызывает `POST /lectures/:id/end` — это делает UI
 *    компонент (KS-C04'/KS-3846), решающий ещё нужно ли финализировать
 *    запись.
 *
 * Хук — fire-and-forget по сети: HTTP-ошибки логируются в
 * `chunksFailed` (увеличивается на 1), запись продолжается; повторных
 * попыток нет. Финальный шаг finalize/end на бэке делает sanity-check
 * фактических vs ожидаемых чанков (KS-3846), там и решается, что
 * считать «успешно записано».
 */

const RECORDER_MIME = 'audio/webm;codecs=opus';
const RECORDER_BITRATE = 32_000;
const CHUNK_DURATION_MS = 30_000;
const MAX_PARALLEL_UPLOADS = 2;
const X_AMZ_TAGGING = 'kind=chunk';

export interface UseLectureAudioPublisherArgs {
  /** ID лекции (требуется на `start()`). `null`/`undefined` — `start()` бросит. */
  lectureId: string | null | undefined;
  /**
   * KS-3834: `serverNow - Date.now()` на момент ответа `POST
   * /lectures/:id/start`. Используется, чтобы привести клиентский
   * `Date.now()` к серверной шкале при формировании
   * `recorderStartedAtClient`. По умолчанию 0 (без коррекции).
   */
  clockSkewMs?: number;
  /**
   * ISO-8601 момент начала записи событий (`LectureRecording.startedAt`,
   * также скорректированный clockSkew). Если передан, хук вычисляет
   * `offsetMs = recorderStart - recordingStart`. Без него `offsetMs`
   * возвращается как `null` — финализация на бэке (KS-3846) сама
   * посчитает корректный offset.
   */
  recordingStartedAtClient?: string | null;
}

export interface UseLectureAudioPublisherState {
  /** Стартует запись и upload-цикл. Бросает при отсутствии lectureId, getUserMedia или MediaRecorder. */
  start: () => Promise<void>;
  /** Останавливает запись. Безопасен повторный вызов. */
  stop: () => Promise<void>;
  /** `true` если recorder в состоянии 'recording'. */
  isRecording: boolean;
  /** Кол-во чанков, для которых полностью прошёл цикл presign → PUT → ack. */
  chunksSent: number;
  /** Кол-во чанков, на которых хоть один шаг свалился. */
  chunksFailed: number;
  /** Момент `recorder.start()` в серверной шкале, ISO-8601. `null` до старта. */
  recorderStartedAtClient: string | null;
  /**
   * Смещение начала аудио относительно начала `LectureRecording`, мс.
   * `null` если `recordingStartedAtClient` не передан.
   */
  offsetMs: number | null;
  /** Последняя ошибка `start()` / `getUserMedia` / MediaRecorder. */
  error: Error | null;
}

interface ChunkUploadResponse {
  uploadUrl: string;
  chunkKey: string;
}

export function useLectureAudioPublisher({
  lectureId,
  clockSkewMs = 0,
  recordingStartedAtClient = null,
}: UseLectureAudioPublisherArgs): UseLectureAudioPublisherState {
  const [isRecording, setIsRecording] = useState(false);
  const [chunksSent, setChunksSent] = useState(0);
  const [chunksFailed, setChunksFailed] = useState(0);
  const [recorderStartedAtClient, setRecorderStartedAtClient] = useState<
    string | null
  >(null);
  const [offsetMs, setOffsetMs] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Ссылка на mutable ресурсы записи: stream/recorder живут вне React-
  // состояния, иначе их остановка через стейт может опоздать.
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const seqRef = useRef(0);

  // Семафор параллельности (≤ MAX_PARALLEL_UPLOADS одновременных
  // upload'ов). Каждый чанк ждёт свободный слот, запускается, по
  // завершении дёргает голову очереди ожидания.
  const inFlightRef = useRef(0);
  const waitersRef = useRef<Array<() => void>>([]);

  // Свежий lectureId для замыканий `ondataavailable` — иначе recorder,
  // созданный в start(), будет помнить старый id даже если родитель
  // успел поменять lectureId.
  const lectureIdRef = useRef(lectureId);
  useEffect(() => {
    lectureIdRef.current = lectureId;
  }, [lectureId]);
  const clockSkewRef = useRef(clockSkewMs);
  useEffect(() => {
    clockSkewRef.current = clockSkewMs;
  }, [clockSkewMs]);

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
  }, []);

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
        // PUT в S3 — отдельный fetch, не через `api` (там JWT и
        // baseUrl нам не нужны). Заголовок `x-amz-tagging: kind=chunk`
        // обязателен: backend подписал URL включая этот заголовок
        // в signedHeaders (см. KS-3827, S3 Lifecycle 24ч).
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
        // Логируем, увеличиваем счётчик неудач. Повторных попыток в
        // рамках этого хука нет — финализация на бэке (KS-3846)
        // увидит дыру по seq и решит, что делать.
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
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return; // уже идёт
    setError(null);
    setChunksSent(0);
    setChunksFailed(0);
    seqRef.current = 0;
    inFlightRef.current = 0;
    waitersRef.current = [];

    const lid = lectureIdRef.current;
    if (!lid) {
      const err = new Error(
        'useLectureAudioPublisher.start: lectureId is required',
      );
      setError(err);
      throw err;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const err = new Error(
        'getUserMedia is not available (insecure context or unsupported browser)',
      );
      setError(err);
      throw err;
    }
    if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
      const err = new Error(
        'MediaRecorder is not supported in this browser',
      );
      setError(err);
      throw err;
    }
    if (!window.MediaRecorder.isTypeSupported(RECORDER_MIME)) {
      const err = new Error(
        `MediaRecorder does not support ${RECORDER_MIME} in this browser`,
      );
      setError(err);
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
      throw err;
    }
    streamRef.current = stream;

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
      // Очередь сама ограничит параллелизм; fire-and-forget — мы не
      // блокируем recorder, иначе следующий 30-секундный чанк
      // придёт уже с задержкой.
      void uploadChunk(seq, blob);
    };
    recorder.onerror = (ev: Event) => {
      // KS-3841: фатальная ошибка recorder'а — отдаём пользователю
      // как `error`, останавливаем запись. UI сам решит, что делать
      // (KS-C04'/KS-3843).
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

    // KS-3834: момент `recorder.start()` приведённый к серверной
    // шкале. Делаем замер сразу до и после старта — берём середину,
    // чтобы скомпенсировать микро-задержку самого вызова.
    const beforeMs = Date.now();
    recorder.start(CHUNK_DURATION_MS);
    const afterMs = Date.now();
    const midMs = Math.round((beforeMs + afterMs) / 2);
    const startedClient = new Date(midMs + clockSkewRef.current).toISOString();
    setRecorderStartedAtClient(startedClient);
    setIsRecording(true);

    // offsetMs = recorderStart - recordingStart. Может быть < 0, если
    // recorder стартовал раньше, чем сервер увидел `POST /start`.
    if (recordingStartedAtClient) {
      const recStartMs = Date.parse(recordingStartedAtClient);
      const recorderStartMs = Date.parse(startedClient);
      if (Number.isFinite(recStartMs) && Number.isFinite(recorderStartMs)) {
        setOffsetMs(recorderStartMs - recStartMs);
      } else {
        setOffsetMs(null);
      }
    } else {
      setOffsetMs(null);
    }
  }, [recordingStartedAtClient, teardown, uploadChunk]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      teardown();
      return;
    }
    if (recorder.state !== 'inactive') {
      try {
        // Последний `ondataavailable` придёт синхронно из stop() — он
        // запушит финальный чанк в очередь uploadChunk. Сам upload
        // продолжится в фоне.
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    teardown();
  }, [teardown]);

  // На unmount останавливаем запись, чтобы не оставить «висящий»
  // микрофон у браузера/ОС.
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
    };
  }, []);

  return {
    start,
    stop,
    isRecording,
    chunksSent,
    chunksFailed,
    recorderStartedAtClient,
    offsetMs,
    error,
  };
}
