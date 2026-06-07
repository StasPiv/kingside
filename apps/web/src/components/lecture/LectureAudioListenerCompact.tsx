import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';
import { useLectureAudioSubscriber } from '../../hooks/useLectureAudioSubscriber';

/**
 * KS-3863 (доработка KS-3848). Компактный вариант
 * `LectureAudioListener`: одна круглая кнопка-иконка «🔊/🔇» в шапке
 * страницы. Регулятор громкости и статус — в маленьком всплывающем
 * окошке по клику на иконку. Большой блок (как в `LectureAudioListener`)
 * захламлял шапку, поэтому в `AnalysisPage` и `LiveAnalysisViewerPage`
 * используется этот компактный вариант.
 *
 * Состояния:
 *  - До первого клика: иконка «🔊», по клику — `audio.muted=false +
 *    play()`. Это user-gesture, разблокирующий звук под autoplay-policy.
 *  - После клика: иконка «🔇» (текущая громкость > 0) или «🔇» с
 *    зачёркнутой полосой при mute. По клику открывается popover с
 *    регулятором громкости, mute-кнопкой и текстом статуса.
 *  - `capacity-exceeded` (KS-3850): иконка приглушённая, при наведении
 *    подсказка «Лекция заполнена».
 *  - `ice-failed-timeout` (KS-3849): иконка с красной точкой, подсказка
 *    «Не удалось установить голосовое соединение».
 */

export interface LectureAudioListenerCompactProps {
  lectureId: string;
  socket: Socket;
  className?: string;
}

export function LectureAudioListenerCompact({
  lectureId,
  socket,
  className,
}: LectureAudioListenerCompactProps) {
  const { t } = useTranslation();
  const { audioRef, connectionState, isConnected } = useLectureAudioSubscriber({
    lectureId,
    socket,
  });

  const [unlocked, setUnlocked] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // KS-3880: «прогревающий» AudioContext, созданный синхронно в
  // обработчике клика. WebRTC под капотом тоже создаёт AudioContext
  // на каждый входящий аудио-трек; если до этого момента в
  // документе не было ни одного `resume`-нутого в жесте AudioContext,
  // браузер блокирует все WebRTC-потоки с сообщением «AudioContext
  // was not allowed to start» и звука нет, даже если `<audio>.play()`
  // уже разрешён. Один раз создаём свой, держим в ref, чтобы
  // повторные клики его переиспользовали.
  const warmupCtxRef = useRef<AudioContext | null>(null);

  // Синхронизация state ↔ <audio>.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = muted;
    el.volume = volume;
  }, [audioRef, muted, volume]);

  // KS-3880: закрытие «прогревающего» AudioContext при unmount —
  // освобождаем аппаратные ресурсы аудио-вывода.
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

  // Закрытие popover при клике вне компонента.
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  const handleIconClick = useCallback(() => {
    const el = audioRef.current;
    if (!unlocked) {
      // KS-3880: всё ниже выполняется СИНХРОННО внутри обработчика
      // клика — никаких await. Браузер разрешает аудио-вывод только
      // если AudioContext был resume-нут / `<audio>.play()` вызван в
      // том же тике, что и user gesture.
      try {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (Ctor && !warmupCtxRef.current) {
          const ctx = new Ctor();
          warmupCtxRef.current = ctx;
          // resume — на случай если контекст создался suspended.
          // Игнорируем промис: вызов уже зачтён как «в жесте».
          if (typeof ctx.resume === 'function') void ctx.resume();
          // Короткий тишинный осциллятор окончательно «разогревает»
          // вывод — на iOS Safari без этого следующие WebRTC-потоки
          // всё равно блокировались.
          try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0;
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.01);
          } catch {
            /* отдельные браузеры не поддерживают всю цепочку — не критично */
          }
        } else if (
          warmupCtxRef.current &&
          warmupCtxRef.current.state === 'suspended'
        ) {
          void warmupCtxRef.current.resume();
        }
      } catch {
        /* AudioContext недоступен — без прогрева, но это не должно мешать */
      }
      if (el) {
        el.muted = false;
        el.play().catch(() => {
          /* track ещё не пришёл — UI всё равно перешёл в «звук включён» */
        });
      }
      setMuted(false);
      setUnlocked(true);
      return;
    }
    // Уже разблокирован — открываем/закрываем popover.
    setPopoverOpen((p) => !p);
  }, [audioRef, unlocked]);

  const handleToggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const isCapacityExceeded = connectionState === 'capacity-exceeded';
  const isFailed = connectionState === 'ice-failed-timeout';
  const hasIssue = isCapacityExceeded || isFailed;

  const title = isCapacityExceeded
    ? t(
        'lectureAudio.capacityExceededShort',
        'Лекция заполнена, голос недоступен',
      )
    : isFailed
    ? t(
        'lectureAudio.iceFailedShort',
        'Не удалось установить голосовое соединение',
      )
    : !unlocked
    ? t('lectureAudio.unlock', 'Включить голос тренера')
    : muted
    ? t('lectureAudio.unmuteTitle', 'Включить звук')
    : t('lectureAudio.muteTitle', 'Выключить звук');

  return (
    <div
      ref={wrapperRef}
      className={['lecture-audio-listener-compact', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="lecture-audio-listener-compact"
      data-connection-state={connectionState ?? 'idle'}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <audio
        ref={audioRef}
        autoPlay
        muted
        playsInline
        data-testid="lecture-audio-listener-compact-audio"
      />
      <button
        type="button"
        onClick={handleIconClick}
        disabled={isCapacityExceeded}
        title={title}
        aria-label={title}
        data-testid="lecture-audio-listener-compact-icon"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1px solid #ccc',
          background: hasIssue ? '#fff' : unlocked ? '#1976d2' : '#fff',
          color: hasIssue ? '#8a1f1f' : unlocked ? '#fff' : '#333',
          cursor: isCapacityExceeded ? 'not-allowed' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          position: 'relative',
          opacity: isCapacityExceeded ? 0.6 : 1,
        }}
      >
        {/* KS-3882: разные значки для состояний. До первого клика и
            при выключенном звуке — «🔇» (заглушённый), после клика и
            при наличии потока — «🔊». Пока WebRTC ещё не подключён —
            «⏳» (ожидание потока от тренера). */}
        <span aria-hidden="true">
          {!unlocked || muted
            ? '🔇'
            : isConnected
              ? '🔊'
              : '⏳'}
        </span>
        {hasIssue && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#d32f2f',
              border: '1px solid #fff',
            }}
          />
        )}
      </button>

      {popoverOpen && unlocked && !hasIssue && (
        <div
          data-testid="lecture-audio-listener-compact-popover"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 200,
            minWidth: 200,
            padding: '10px 12px',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 8,
            boxShadow: '0 6px 18px rgba(0,0,0,0.12)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={handleToggleMute}
              data-testid="lecture-audio-listener-compact-mute"
              aria-pressed={muted}
              title={
                muted
                  ? t('lectureAudio.unmuteTitle', 'Включить звук')
                  : t('lectureAudio.muteTitle', 'Выключить звук')
              }
              style={{
                padding: '4px 8px',
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
              data-testid="lecture-audio-listener-compact-volume"
              aria-label={t('lectureAudio.volumeLabel', 'Громкость')}
              /* KS-3882: фиксируем размер ползунка. Без явной ширины
                 в некоторых браузерах (Safari iOS) `<input type=range>`
                 переходит в `-webkit-appearance: slider-vertical` и
                 растягивается вертикально. */
              style={{
                width: 140,
                height: 18,
                margin: 0,
                appearance: 'auto',
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: '#555' }}>
            {isConnected
              ? t('lectureAudio.statusLive', 'Голос в эфире')
              : t('lectureAudio.statusWaiting', 'Ожидание тренера…')}
          </div>
        </div>
      )}
    </div>
  );
}
