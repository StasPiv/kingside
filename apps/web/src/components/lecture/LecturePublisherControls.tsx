import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';
import {
  AudioPublisherLockError,
  useLectureAudioPublisher,
} from '../../hooks/useLectureAudioPublisher';
import { useLectureAudioPeerConnections } from '../../hooks/useLectureAudioPeerConnections';
import { LectureSettingsModal } from './LectureSettingsModal';
import { LectureAnalysisSwitcher } from './LectureAnalysisSwitcher';

/**
 * KS-3843 / ADR-116 §7.3. UI live-комнаты тренера: кнопка «Включить
 * микрофон и запись», индикатор записи, счётчик подключённых
 * зрителей по голосу.
 *
 * Связывает два хука:
 *  - `useLectureAudioPublisher` (KS-3841 / KS-3845 / KS-3846 / KS-3851):
 *    запись микрофона, чанковая загрузка, singleton-lock, финализация.
 *  - `useLectureAudioPeerConnections` (KS-3842): N RTCPeerConnection
 *    на зрителей, рассылка audio-track через WebRTC.
 *
 * Поведение:
 *  - Пока запись не идёт — кнопка «🎙 Включить микрофон и запись».
 *    Клик → `publisher.start()`. После успеха автоматически
 *    подключаются peer-connections (хук видит `audioTrack` и начинает
 *    слушать `webrtc:peer-joined`).
 *  - Во время записи — кнопка «■ Остановить запись», индикатор
 *    «Запись идёт, чанков отправлено: N» с анимированной красной
 *    точкой, счётчик «Слушают по голосу: M / 15».
 *  - Ошибки:
 *    - `AudioPublisherLockError` (KS-3845): модал «Запись уже идёт
 *      с другого устройства».
 *    - `NotAllowedError` (permission denied): модал с инструкцией
 *      разрешить микрофон в настройках браузера.
 *    - `NotFoundError` / `device unplugged`: модал «Микрофон не
 *      найден, подключите устройство».
 *    - Прочие: модал с текстом ошибки.
 *  - KS-3846: «Закрыть лекцию» → `publisher.finalize()` → ждёт
 *    выгрузки последнего чанка → `POST /lectures/:id/end` с
 *    `{ offsetMs, chunkCount, recorderStartedAtClient,
 *    recorderEndedAtClient }`. Колбэк `onClosed` зовётся после
 *    успешного finalize (родитель решает, куда редиректить).
 *  - `beforeunload` — sendBeacon реализован прямо в хуке (KS-3846),
 *    дополнительная регистрация не нужна.
 *
 * Все socket-события (`webrtc:*` для KS-3842, `lecture:recording-*`
 * для KS-3851) идут через переданный `socket` (обычно
 * `liveAnalysisSocket`).
 */

export interface LecturePublisherControlsProps {
  /** ID лекции. */
  lectureId: string;
  /**
   * Socket к namespace `/live-analysis`. Используется для WebRTC-
   * сигналинга и `lecture:recording-*` событий.
   */
  socket: Socket;
  /** KS-3834: `serverNow - Date.now()` из ответа `POST /start`. */
  clockSkewMs?: number;
  /** ISO-8601 момент начала записи событий (для расчёта `offsetMs`). */
  recordingStartedAtClient?: string | null;
  /**
   * Колбэк после успешной финализации (`publisher.finalize()`).
   * Родитель показывает следующий экран / делает navigate.
   */
  onClosed?: () => void;
  /** Доп. класс. */
  className?: string;
  /**
   * KS-4628 / ADR-142 §2.9. Slug активной трансляции лекции — нужен
   * для popover'а «Переключить окно анализа» (REST `POST
   * /live-analyses/:slug/switch-analysis`). Если не передан, switcher
   * не рендерится — у компонента остаётся прежнее аудио/доступ-поведение.
   */
  liveSlug?: string | null;
  /**
   * KS-4628 / ADR-142 §2.4. UUID активного `Analysis` для подсветки
   * текущего пункта в picker'е. Источник — `LiveAnalysisSyncSnapshot.activeAnalysisId`.
   */
  activeAnalysisId?: string | null;
  /**
   * KS-4628 / ADR-142 §2.4. Заголовок активного окна — для текста
   * «Сейчас в эфире: <title>» в шапке popover'а.
   */
  activeAnalysisTitle?: string | null;
}

/**
 * KS-4633: Возвращает i18n-ключи (а не локализованные строки) — собственно
 * перевод делается на месте через `t()`. Раньше функция возвращала
 * хардкод-русский, из-за чего EN-юзеры видели русский даже при
 * en-локали.
 */
function describeErrorKeys(err: Error): {
  titleKey: string;
  bodyKey: string;
  bodyFallback?: string;
} {
  if (err instanceof AudioPublisherLockError) {
    return {
      titleKey: 'lecturePublisher.error.lockTitle',
      bodyKey: 'lecturePublisher.error.lockBody',
    };
  }
  if (err.name === 'NotAllowedError' || /permission/i.test(err.message)) {
    return {
      titleKey: 'lecturePublisher.error.permissionTitle',
      bodyKey: 'lecturePublisher.error.permissionBody',
    };
  }
  if (
    err.name === 'NotFoundError' ||
    /no.*device|device.*not.*found|unplugged/i.test(err.message)
  ) {
    return {
      titleKey: 'lecturePublisher.error.notFoundTitle',
      bodyKey: 'lecturePublisher.error.notFoundBody',
    };
  }
  return {
    titleKey: 'lecturePublisher.error.genericTitle',
    bodyKey: 'lecturePublisher.error.genericBody',
    // err.message — техническая строка, остаётся как есть (используется
    // как override, если есть).
    bodyFallback: err.message || undefined,
  };
}

export function LecturePublisherControls({
  lectureId,
  socket,
  clockSkewMs = 0,
  recordingStartedAtClient = null,
  onClosed,
  className,
  liveSlug = null,
  activeAnalysisId = null,
  activeAnalysisTitle = null,
}: LecturePublisherControlsProps) {
  const { t } = useTranslation();

  const publisher = useLectureAudioPublisher({
    lectureId,
    clockSkewMs,
    recordingStartedAtClient,
    socket,
  });

  // KS-3842: peer-connections используют `audioTrack` из `publisher`
  // (один и тот же track безопасно живёт в нескольких pc одновременно).
  // Пока запись не началась, `audioTrack === null` — хук peer-connections
  // «спит», pc не создаются.
  const { peerCount } = useLectureAudioPeerConnections({
    lectureId,
    audioTrack: publisher.audioTrack,
    socket,
  });

  const [pendingAction, setPendingAction] = useState<
    'starting' | 'stopping' | 'closing' | null
  >(null);
  const [localError, setLocalError] = useState<Error | null>(null);
  // KS-3976 / ADR-119 C07. Открыто ли быстрое окно управления
  // доступом. Открывает `LectureSettingsModal` сразу на вкладке
  // `access` — тренер может за один клик добавить пользователя в
  // allowlist прямо из live-комнаты, не выходя из записи.
  const [accessModalOpen, setAccessModalOpen] = useState(false);

  // KS-3844 / ADR-116 §2.4.1. Safari < 14.5 не поддерживает
  // MediaRecorder (или поддерживает без opus). Проверка делается один
  // раз на маунте — если запись невозможна, открываем модал
  // предупреждения и держим кнопку микрофона disabled. Live-передача
  // голоса через WebRTC — отдельный сценарий (в этом компоненте не
  // поддерживается, см. описание задачи: «Live идёт без записи» —
  // запускается через другой механизм/компонент).
  const recordingSupported = useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.MediaRecorder === 'undefined') return false;
    try {
      return window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus');
    } catch {
      return false;
    }
  }, []);
  const [showUnsupportedModal, setShowUnsupportedModal] = useState(
    !recordingSupported,
  );

  // Объединяем ошибки публикатора и локальные UI-ошибки.
  const visibleError = localError ?? publisher.error;
  const errorInfo = useMemo(() => {
    if (!visibleError) return null;
    const keys = describeErrorKeys(visibleError);
    return {
      title: t(keys.titleKey),
      body: t(keys.bodyKey, keys.bodyFallback ?? ''),
    };
  }, [visibleError, t]);

  // На размонтирование/смену лекции — закрываем модал ошибки, чтобы
  // он не висел на следующем экране.
  useEffect(() => {
    setLocalError(null);
  }, [lectureId]);

  const handleStart = useCallback(async () => {
    setLocalError(null);
    setPendingAction('starting');
    try {
      await publisher.start();
    } catch (e) {
      setLocalError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setPendingAction(null);
    }
  }, [publisher]);

  const handleStop = useCallback(async () => {
    setPendingAction('stopping');
    try {
      await publisher.stop();
    } finally {
      setPendingAction(null);
    }
  }, [publisher]);

  const handleClose = useCallback(async () => {
    setPendingAction('closing');
    try {
      await publisher.finalize();
      onClosed?.();
    } catch (e) {
      setLocalError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setPendingAction(null);
    }
  }, [publisher, onClosed]);

  return (
    <div
      className={['lecture-publisher-controls', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="lecture-publisher-controls"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        border: '1px solid #ddd',
        borderRadius: 8,
        background: '#fafafa',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        {!publisher.isRecording ? (
          <button
            type="button"
            onClick={handleStart}
            disabled={pendingAction === 'starting' || !recordingSupported}
            title={
              !recordingSupported
                ? t(
                    'lecturePublisher.recorderUnsupportedHint',
                    'Your browser does not support audio recording',
                  )
                : undefined
            }
            data-testid="lecture-publisher-start"
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: 'none',
              background: '#1976d2',
              color: '#fff',
              fontSize: 15,
              cursor: pendingAction === 'starting' ? 'wait' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span aria-hidden="true">🎙</span>
            {pendingAction === 'starting'
              ? t('lecturePublisher.starting', 'Starting…')
              : t(
                  'lecturePublisher.start',
                  'Start microphone and recording',
                )}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            disabled={pendingAction === 'stopping'}
            data-testid="lecture-publisher-stop"
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #d32f2f',
              background: '#fff',
              color: '#d32f2f',
              fontSize: 15,
              cursor: pendingAction === 'stopping' ? 'wait' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span aria-hidden="true">■</span>
            {pendingAction === 'stopping'
              ? t('lecturePublisher.stopping', 'Stopping…')
              : t('lecturePublisher.stop', 'Stop recording')}
          </button>
        )}

        {publisher.isRecording && (
          <div
            data-testid="lecture-publisher-recording-indicator"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              color: '#8a1f1f',
              fontSize: 14,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#d32f2f',
                animation:
                  'lecture-publisher-blink 1s ease-in-out infinite',
              }}
            />
            <style>{`
              @keyframes lecture-publisher-blink {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.35; }
              }
            `}</style>
            <span data-testid="lecture-publisher-chunks-count">
              {t(
                'lecturePublisher.recording',
                'Recording, chunks sent: {{count}}',
                { count: publisher.chunksSent },
              )}
            </span>
            {publisher.chunksFailed > 0 && (
              <span
                data-testid="lecture-publisher-chunks-failed"
                style={{ color: '#b26a00', marginLeft: 6 }}
              >
                {t(
                  'lecturePublisher.failed',
                  'failed: {{count}}',
                  { count: publisher.chunksFailed },
                )}
              </span>
            )}
          </div>
        )}

        <div
          data-testid="lecture-publisher-peer-count"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: '#555',
            fontSize: 14,
            marginLeft: 'auto',
          }}
        >
          <span aria-hidden="true">👂</span>
          {t(
            'lecturePublisher.peerCount',
            'Listeners on voice: {{count}} / 15',
            { count: peerCount },
          )}
        </div>

        {/* KS-3976 / ADR-119 C07. Кнопка «Доступ» — быстрый
            короткий путь к управлению allowlist'ом из live-комнаты,
            не открывая ⋮-меню AnalysisActionsMenu. Открывает
            `LectureSettingsModal` сразу на вкладке `access`. */}
        <button
          type="button"
          onClick={() => setAccessModalOpen(true)}
          data-testid="lecture-publisher-access"
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #1976d2',
            background: '#fff',
            color: '#1976d2',
            fontSize: 13,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span aria-hidden="true">🔒</span>
          {t('lecturePublisher.access', 'Access')}
        </button>

        {/* KS-4628 / ADR-142 §2.9. Popover «Переключить окно анализа».
            Рендерится только когда есть `liveSlug` (т.е. трансляция
            активна). На lectures без `slug` блок отсутствует — старое
            UI без switcher'а сохраняется как fallback. */}
        {liveSlug && (
          <LectureAnalysisSwitcher
            slug={liveSlug}
            activeAnalysisId={activeAnalysisId}
            activeTitle={activeAnalysisTitle}
          />
        )}
      </div>

      {publisher.isRecording && (
        <button
          type="button"
          onClick={handleClose}
          disabled={pendingAction === 'closing'}
          data-testid="lecture-publisher-close"
          style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #999',
            background: '#fff',
            color: '#333',
            fontSize: 13,
            cursor: pendingAction === 'closing' ? 'wait' : 'pointer',
          }}
        >
          {pendingAction === 'closing'
            ? t('lecturePublisher.closing', 'Finalizing…')
            : t('lecturePublisher.close', 'Close lecture')}
        </button>
      )}

      {showUnsupportedModal && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="lecture-publisher-unsupported-title"
          data-testid="lecture-publisher-unsupported-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowUnsupportedModal(false);
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 10,
              padding: 20,
              maxWidth: 480,
              boxShadow: '0 12px 32px rgba(0,0,0,0.2)',
            }}
          >
            <h3
              id="lecture-publisher-unsupported-title"
              style={{ margin: '0 0 8px 0', fontSize: 18 }}
            >
              {t(
                'lecturePublisher.unsupportedTitle',
                'Audio recording is not available in this browser',
              )}
            </h3>
            <p style={{ margin: '0 0 16px 0', color: '#444', fontSize: 14 }}>
              {t(
                'lecturePublisher.unsupportedBody',
                'Your browser does not support audio recording. Update Chrome, Firefox or Safari to the latest version, otherwise the lecture will run without recording.',
              )}
            </p>
            <button
              type="button"
              onClick={() => setShowUnsupportedModal(false)}
              data-testid="lecture-publisher-unsupported-dismiss"
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                border: 'none',
                background: '#1976d2',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {t(
                'lecturePublisher.unsupportedContinue',
                'Continue without recording',
              )}
            </button>
          </div>
        </div>
      )}

      {accessModalOpen && (
        <LectureSettingsModal
          lectureId={lectureId}
          initialTab="access"
          onClose={() => setAccessModalOpen(false)}
        />
      )}

      {errorInfo && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="lecture-publisher-error-title"
          data-testid="lecture-publisher-error-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setLocalError(null);
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 10,
              padding: 20,
              maxWidth: 420,
              boxShadow: '0 12px 32px rgba(0,0,0,0.2)',
            }}
          >
            <h3
              id="lecture-publisher-error-title"
              style={{ margin: '0 0 8px 0', fontSize: 18 }}
            >
              {errorInfo.title}
            </h3>
            <p style={{ margin: '0 0 16px 0', color: '#444', fontSize: 14 }}>
              {errorInfo.body}
            </p>
            <button
              type="button"
              onClick={() => setLocalError(null)}
              data-testid="lecture-publisher-error-dismiss"
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                border: 'none',
                background: '#1976d2',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {t('common.ok', 'OK')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
