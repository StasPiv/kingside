import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';

/**
 * KS-3851 / ADR-116 §7.3. Privacy-disclaimer для зрителя live-лекции.
 *
 * Тренер на `recorder.start()` шлёт через `/live-analysis`-socket
 * событие `lecture:recording-started { lectureId }`; на
 * `recorder.stop()` (или unmount хука) — `lecture:recording-stopped
 * { lectureId }`. Этот компонент подписывается на оба события и
 * показывает значок «🔴 запись», когда запись идёт.
 *
 * GDPR-логика: зритель должен явно видеть, что лекция записывается.
 * Без серверной проверки невозможно гарантированно подтвердить факт
 * записи, поэтому значок управляется самим тренером — если он
 * выключил запись или ушёл со страницы, значок исчезает.
 *
 * Cross-room защита: события без поля `lectureId === props.lectureId`
 * игнорируются. Это нужно, потому что `liveAnalysisSocket` —
 * глобальный, и в редких сценариях может прилететь событие от
 * чужой лекции.
 */

export interface LectureRecordingBadgeProps {
  /** ID лекции, на которую подписываемся. */
  lectureId: string;
  /** Socket к namespace `/live-analysis` (обычно `liveAnalysisSocket`). */
  socket: Socket;
  /** Доп. класс. */
  className?: string;
}

interface RecordingEvent {
  lectureId: string;
}

export function LectureRecordingBadge({
  lectureId,
  socket,
  className,
}: LectureRecordingBadgeProps) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    const handleStarted = (payload: RecordingEvent) => {
      if (payload?.lectureId !== lectureId) return;
      setIsRecording(true);
    };
    const handleStopped = (payload: RecordingEvent) => {
      if (payload?.lectureId !== lectureId) return;
      setIsRecording(false);
    };
    socket.on('lecture:recording-started', handleStarted);
    socket.on('lecture:recording-stopped', handleStopped);
    return () => {
      socket.off('lecture:recording-started', handleStarted);
      socket.off('lecture:recording-stopped', handleStopped);
      setIsRecording(false);
    };
  }, [lectureId, socket]);

  if (!isRecording) return null;

  return (
    <div
      className={['lecture-recording-badge', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="lecture-recording-badge"
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: '#fdecea',
        border: '1px solid #ef9a9a',
        color: '#8a1f1f',
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <span
        aria-hidden="true"
        data-testid="lecture-recording-badge-dot"
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: '#d32f2f',
          animation: 'lecture-recording-blink 1s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes lecture-recording-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
      {t('lectureRecording.badge', 'Запись')}
    </div>
  );
}
