import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * KS-3736 / ADR-110. UI-блок управления трансляцией анализа на
 * `AnalysisPage`: одна кнопка-переключатель + индикатор статуса
 * («В эфире» с красной точкой + счётчик зрителей) + inline-сообщение
 * о копировании ссылки.
 *
 * Презентационный компонент — вся state-логика живёт в
 * `useAnalysisLiveBroadcast`. Видимость («только авторизованному»)
 * контролируется родителем через условный рендер: компонент сам не
 * знает про auth-контекст.
 *
 * Доступность: индикатор `role="status"` + `aria-live="polite"`, чтобы
 * скринридер сообщал об изменении числа зрителей не агрессивно.
 */

export interface LiveBroadcastControlProps {
  isLive: boolean;
  isStarting: boolean;
  viewerCount: number;
  /** Полная ссылка `https://kingside.site/live/<slug>`. */
  publicUrl: string | null;
  /** Сервер-ошибка (для inline-тоста). */
  errorMessage: string | null;
  onStart: () => void;
  onStop: () => void;
}

export function LiveBroadcastControl({
  isLive,
  isStarting,
  viewerCount,
  publicUrl,
  errorMessage,
  onStart,
  onStop,
}: LiveBroadcastControlProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copyUrl = useCallback(async () => {
    if (!publicUrl) return;
    try {
      // Современный clipboard API доступен только в secure context
      // (https / localhost). Для http-prod-зеркала фолбэк не нужен —
      // прод полностью на https. В тестовых http-сборках кнопка просто
      // тихо ничего не сделает.
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard может быть закрыт permissions — игнорируем */
    }
  }, [publicUrl]);

  // KS-3736 acceptance: «при создании трансляции ссылка копируется».
  // Триггерим auto-copy только когда publicUrl сменился с `null` на
  // строку — это значит юзер именно сейчас нажал «Транслировать», а не
  // получил готовую трансляцию после reload (там publicUrl приходит уже
  // строкой при первом рендере, ref-сравнение это отсечёт).
  const prevPublicUrlRef = useRef(publicUrl);
  useEffect(() => {
    const prev = prevPublicUrlRef.current;
    prevPublicUrlRef.current = publicUrl;
    if (!prev && publicUrl) {
      void copyUrl();
    }
  }, [publicUrl, copyUrl]);

  return (
    <div
      className="analysis-live-broadcast"
      data-testid="analysis-live-broadcast"
    >
      {!isLive ? (
        <button
          type="button"
          className="analysis-live-broadcast__start"
          data-testid="analysis-live-start"
          onClick={onStart}
          disabled={isStarting}
          title={t('liveAnalysis.start', 'Start live broadcast')}
        >
          {isStarting
            ? t('liveAnalysis.starting', 'Starting…')
            : t('liveAnalysis.start', 'Broadcast')}
        </button>
      ) : (
        <div
          className="analysis-live-broadcast__active"
          data-testid="analysis-live-active"
        >
          <span
            className="analysis-live-broadcast__status"
            role="status"
            aria-live="polite"
            // Inline-стиль для красной точки: без отдельного CSS-файла,
            // чтобы не блокировать задачу на layout-агенте. Координатор
            // / layout позже могут переехать на класс с дизайн-токенами.
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#e53935',
                display: 'inline-block',
              }}
            />
            <strong>{t('liveAnalysis.onAir', 'On air')}</strong>
            <span
              className="analysis-live-broadcast__viewers"
              data-testid="analysis-live-viewers"
              aria-label={t('liveAnalysis.viewers', 'Viewers')}
            >
              · {viewerCount}{' '}
              {t('liveAnalysis.viewersShort', 'viewers')}
            </span>
          </span>
          {publicUrl && (
            <button
              type="button"
              className="analysis-live-broadcast__copy"
              data-testid="analysis-live-copy"
              onClick={copyUrl}
              title={t('liveAnalysis.copyLink', 'Copy viewer link')}
            >
              {t('liveAnalysis.copyLink', 'Copy link')}
            </button>
          )}
          <button
            type="button"
            className="analysis-live-broadcast__stop"
            data-testid="analysis-live-stop"
            onClick={onStop}
            title={t('liveAnalysis.stop', 'Stop broadcast')}
          >
            {t('liveAnalysis.stop', 'Stop')}
          </button>
        </div>
      )}
      {copied && (
        <span
          className="analysis-existing-toast"
          role="status"
          aria-live="polite"
          data-testid="analysis-live-link-copied"
        >
          {t('liveAnalysis.linkCopied', 'Link copied')}
        </span>
      )}
      {errorMessage && (
        <span
          className="analysis-existing-toast"
          role="status"
          aria-live="polite"
          data-testid="analysis-live-error"
        >
          {errorMessage}
        </span>
      )}
    </div>
  );
}
