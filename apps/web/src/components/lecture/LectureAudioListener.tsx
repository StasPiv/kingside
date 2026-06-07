import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';
import { useLectureAudioSubscriber } from '../../hooks/useLectureAudioSubscriber';

/**
 * KS-3848 / ADR-116 §5.2. UI зрителя для голоса тренера.
 *
 * Современные браузеры блокируют autoplay со звуком без user-gesture
 * (Safari всегда, Chrome без предыдущего взаимодействия пользователя).
 * Поэтому `<audio>` рендерится с `muted` и `autoPlay`, а первое
 * включение звука — только по явному клику пользователя.
 *
 * Состояния UI:
 *  - Нет звука (peer создаётся, не подключился): подсказка «Тренер ещё
 *    не подключился к голосу».
 *  - Звук есть, не «включён»: большая кнопка «🔊 Включить голос
 *    тренера». По клику — `audio.muted=false`, `audio.play()`.
 *  - Звук включён: регулятор громкости + кнопка mute.
 *  - `connectionState === 'capacity-exceeded'` (KS-3850): badge
 *    «Лекция заполнена, голос недоступен».
 *  - `connectionState === 'ice-failed-timeout'` (KS-3849): badge
 *    «Не удалось установить голосовое соединение».
 *
 * Доска зрителя (отдельный WS-канал, не зависит от голоса) продолжает
 * работать независимо от состояния этого компонента — он рендерит
 * только аудиоплеер и статус.
 */

export interface LectureAudioListenerProps {
  /** ID лекции, на которую подписываемся. */
  lectureId: string;
  /** Socket к namespace `/live-analysis` (обычно `liveAnalysisSocket`). */
  socket: Socket;
  /** Дополнительный класс на корневой контейнер. */
  className?: string;
}

export function LectureAudioListener({
  lectureId,
  socket,
  className,
}: LectureAudioListenerProps) {
  const { t } = useTranslation();
  const { audioRef, connectionState, isConnected } = useLectureAudioSubscriber({
    lectureId,
    socket,
  });

  // Пользователь нажал «Включить голос». До клика `muted=true`, после —
  // показываем регулятор громкости и кнопку mute. Сам факт «было ли
  // когда-либо снято mute» влияет на то, какой UI показывать, поэтому
  // флаг в отдельном state'е (не вычисляется из `audio.muted`, который
  // может вернуться в true по кнопке mute).
  const [unlocked, setUnlocked] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  // KS-3880: «прогревающий» AudioContext, см. подробный комментарий
  // в LectureAudioListenerCompact. Нужен, чтобы WebRTC под капотом
  // не блокировался autoplay-policy на следующих треках.
  const warmupCtxRef = useRef<AudioContext | null>(null);

  // Синхронизируем `audio.muted` / `audio.volume` со state'ом, чтобы
  // первый рендер с `<audio muted>` корректно работал, и чтобы
  // регулятор громкости менял реальную громкость элемента.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = muted;
    el.volume = volume;
  }, [audioRef, muted, volume]);

  // KS-3880: освобождаем AudioContext при unmount.
  useEffect(() => {
    return () => {
      const ctx = warmupCtxRef.current;
      if (ctx && typeof ctx.close === 'function') {
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
      }
      warmupCtxRef.current = null;
    };
  }, []);

  const handleUnlock = useCallback(() => {
    // KS-3880: синхронно прогреваем AudioContext до любых обращений к
    // `<audio>` — это разблокирует WebRTC-выход на удалённых треках.
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor && !warmupCtxRef.current) {
        const ctx = new Ctor();
        warmupCtxRef.current = ctx;
        if (typeof ctx.resume === 'function') void ctx.resume();
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain).connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.01);
        } catch {
          /* отдельные браузеры не поддерживают всю цепочку */
        }
      } else if (
        warmupCtxRef.current &&
        warmupCtxRef.current.state === 'suspended'
      ) {
        void warmupCtxRef.current.resume();
      }
    } catch {
      /* AudioContext недоступен — без прогрева */
    }
    const el = audioRef.current;
    if (!el) return;
    el.muted = false;
    setMuted(false);
    setUnlocked(true);
    // play() возвращает Promise — может reject-нуться если track ещё
    // не пришёл; UI всё равно перейдёт в «звук включён», а следующая
    // попытка случится автоматически на `ontrack` в хуке.
    el.play().catch(() => {
      /* пока тренер не подключён — нормально, играть нечего */
    });
  }, [audioRef]);

  const handleToggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const isCapacityExceeded = connectionState === 'capacity-exceeded';
  const isFailed = connectionState === 'ice-failed-timeout';

  return (
    <div
      className={['lecture-audio-listener', className].filter(Boolean).join(' ')}
      data-testid="lecture-audio-listener"
      data-connection-state={connectionState ?? 'idle'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '8px 12px',
        border: '1px solid #ddd',
        borderRadius: 8,
        background: '#fafafa',
      }}
    >
      {/* Сам аудиоэлемент. muted по умолчанию, чтобы autoplay-policy
          браузера не блокировал поток до клика. playsInline нужен для
          iOS, иначе Safari может попытаться открыть native-плеер. */}
      <audio
        ref={audioRef}
        autoPlay
        muted
        playsInline
        data-testid="lecture-audio-listener-audio"
      />

      {isCapacityExceeded && (
        <div
          role="status"
          data-testid="lecture-audio-listener-capacity-badge"
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            background: '#fff3e0',
            border: '1px solid #ffb74d',
            color: '#7a4f00',
            fontSize: 14,
          }}
        >
          {t(
            'lectureAudio.capacityExceeded',
            'Лекция заполнена, голос недоступен. Подключитесь позже.',
          )}
        </div>
      )}

      {isFailed && (
        <div
          role="alert"
          data-testid="lecture-audio-listener-failed-badge"
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            background: '#fdecea',
            border: '1px solid #ef9a9a',
            color: '#8a1f1f',
            fontSize: 14,
          }}
        >
          {t(
            'lectureAudio.iceFailed',
            'Не удалось установить голосовое соединение. Проверьте сеть или попробуйте другое устройство. Доска работает без звука.',
          )}
        </div>
      )}

      {!isCapacityExceeded && !isFailed && !unlocked && (
        <button
          type="button"
          onClick={handleUnlock}
          data-testid="lecture-audio-listener-unlock"
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            border: 'none',
            background: '#1976d2',
            color: '#fff',
            fontSize: 16,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span aria-hidden="true">🔊</span>
          {t('lectureAudio.unlock', 'Включить голос тренера')}
        </button>
      )}

      {!isCapacityExceeded && !isFailed && unlocked && (
        <div
          data-testid="lecture-audio-listener-controls"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={handleToggleMute}
            data-testid="lecture-audio-listener-mute"
            aria-pressed={muted}
            title={
              muted
                ? t('lectureAudio.unmuteTitle', 'Включить звук')
                : t('lectureAudio.muteTitle', 'Выключить звук')
            }
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid #ccc',
              background: muted ? '#eee' : '#fff',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true">{muted ? '🔇' : '🔊'}</span>
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            data-testid="lecture-audio-listener-volume"
            aria-label={t('lectureAudio.volumeLabel', 'Громкость')}
            style={{ flex: '1 1 120px', maxWidth: 240 }}
          />
          <span
            data-testid="lecture-audio-listener-status"
            style={{ fontSize: 13, color: '#555' }}
          >
            {isConnected
              ? t('lectureAudio.statusLive', 'Голос в эфире')
              : t('lectureAudio.statusWaiting', 'Ожидание тренера…')}
          </span>
        </div>
      )}

      {!isCapacityExceeded && !isFailed && !unlocked && !isConnected && (
        <div
          data-testid="lecture-audio-listener-waiting"
          style={{ fontSize: 13, color: '#555' }}
        >
          {t(
            'lectureAudio.publisherNotJoined',
            'Тренер ещё не подключился к голосу.',
          )}
        </div>
      )}
    </div>
  );
}
