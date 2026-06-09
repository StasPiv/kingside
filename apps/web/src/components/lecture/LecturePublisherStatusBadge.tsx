import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';
import {
  AudioPublisherLockError,
  useLectureAudioPublisher,
} from '../../hooks/useLectureAudioPublisher';
import { useLectureAudioPeerConnections } from '../../hooks/useLectureAudioPeerConnections';

/**
 * KS-3863. Компактный индикатор записи лекции для тренера, без больших
 * кнопок «Включить микрофон» / «Закрыть» — те живут в общем потоке
 * «Начать лекцию» / «Закрыть лекцию» родительской страницы.
 *
 * Управление через проп `active`:
 *  - При `active === true` хук `useLectureAudioPublisher` запускает
 *    запись один раз (если ещё не запущена) — общая кнопка «Начать
 *    лекцию» в `AnalysisPage` одновременно стартует и трансляцию, и
 *    запись голоса.
 *  - При переходе `active: true → false` вызывается `finalize()` —
 *    последний чанк дописывается, шлётся `POST /lectures/:id/end`.
 *  - Подключает `useLectureAudioPeerConnections` к тому же сокету,
 *    зрители получают audio-track автоматически.
 *  - В UI — пульсирующая красная точка + строка «Запись · N слушают»
 *    и значок предупреждения при ошибках. Без отдельных кнопок.
 */

export interface LecturePublisherStatusBadgeProps {
  lectureId: string;
  socket: Socket;
  /** `true` — запись должна идти, `false` — должна быть финализирована. */
  active: boolean;
  /** clockSkew из ответа POST /start (KS-3834). По умолчанию 0. */
  clockSkewMs?: number;
  /** Момент начала записи событий. Опционально. */
  recordingStartedAtClient?: string | null;
  /** Колбэк после успешного finalize (после POST /end). */
  onFinalized?: () => void;
  /** Дополнительный класс. */
  className?: string;
}

export function LecturePublisherStatusBadge({
  lectureId,
  socket,
  active,
  clockSkewMs = 0,
  recordingStartedAtClient = null,
  onFinalized,
  className,
}: LecturePublisherStatusBadgeProps) {
  const { t } = useTranslation();
  const publisher = useLectureAudioPublisher({
    lectureId,
    clockSkewMs,
    recordingStartedAtClient,
    socket,
  });
  const { peerCount } = useLectureAudioPeerConnections({
    lectureId,
    audioTrack: publisher.audioTrack,
    socket,
  });

  const prevActiveRef = useRef(false);
  const [startError, setStartError] = useState<Error | null>(null);

  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;

    if (!prev && active) {
      // false → true: запускаем запись.
      setStartError(null);
      publisher.start().catch((e) => {
        setStartError(e instanceof Error ? e : new Error(String(e)));
      });
      return;
    }
    if (prev && !active) {
      // true → false: финализируем.
      publisher
        .finalize()
        .then(() => {
          onFinalized?.();
        })
        .catch(() => {
          // ошибки финализации логируются в publisher.error
        });
    }
    // Намеренно не зависим от publisher — у него хук-стейбильный API,
    // повторные вызовы start/finalize не нужны на каждом ре-рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const error = startError ?? publisher.error;
  const isLockError = error instanceof AudioPublisherLockError;
  const isPermissionError =
    !!error &&
    (error.name === 'NotAllowedError' || /permission/i.test(error.message));

  const showRecording = publisher.isRecording;
  const showError = !!error && !showRecording;

  if (!showRecording && !showError) return null;

  return (
    <div
      className={['lecture-publisher-status-badge', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="lecture-publisher-status-badge"
      data-recording={showRecording ? 'true' : 'false'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
      }}
    >
      {showRecording && (
        <>
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#d32f2f',
              animation:
                'lecture-publisher-status-badge-blink 1s ease-in-out infinite',
            }}
          />
          <style>{`
            @keyframes lecture-publisher-status-badge-blink {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.35; }
            }
          `}</style>
          <span
            data-testid="lecture-publisher-status-badge-text"
            style={{ color: '#8a1f1f' }}
          >
            {t(
              'lecturePublisher.compactRecording',
              'Запись · {{count}} слушают',
              { count: peerCount },
            )}
          </span>
          {publisher.chunksFailed > 0 && (
            <span
              data-testid="lecture-publisher-status-badge-failed"
              style={{ color: '#b26a00' }}
              title={t(
                'lecturePublisher.failedHint',
                'Аудио не загрузилось на сервер',
              )}
            >
              ⚠
            </span>
          )}
        </>
      )}
      {showError && (
        <span
          data-testid="lecture-publisher-status-badge-error"
          role="alert"
          style={{ color: '#8a1f1f' }}
        >
          {isLockError
            ? t(
                'lecturePublisher.compactLockError',
                'Лекция уже ведётся в другой вкладке. Закройте эту или продолжите там.',
              )
            : isPermissionError
            ? t(
                'lecturePublisher.compactPermissionError',
                'Нет доступа к микрофону',
              )
            : t(
                'lecturePublisher.compactGenericError',
                'Запись не запущена',
              )}
        </span>
      )}
    </div>
  );
}
