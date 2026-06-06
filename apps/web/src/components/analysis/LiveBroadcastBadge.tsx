import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * KS-3755 / ADR-112. Компактный индикатор активной трансляции для
 * AnalysisPage. Заменяет `LiveBroadcastControl`, который ранее
 * рендерился под заголовком и занимал много места (кнопки + индикатор +
 * счётчик). Теперь управление трансляцией (старт/стоп/копирование
 * ссылки) живёт в `AnalysisActionsMenu` под доской, а статус наружу
 * показывает этот лёгкий бейдж.
 *
 * Поведение:
 *  - Виден только при `isLive=true`. Иначе компонент возвращает `null`
 *    (помимо тоста ошибки, если он есть).
 *  - На переходе `publicUrl null → string` (т.е. трансляция стартовала)
 *    автоматически копирует ссылку в буфер и показывает тост — оставлено
 *    для совместимости с UX из KS-3736 acceptance.
 *  - Тост ошибки (если `errorMessage` не пустой) отображается под
 *    бейджем.
 */
export interface LiveBroadcastBadgeProps {
  isLive: boolean;
  viewerCount: number;
  publicUrl: string | null;
  errorMessage: string | null;
}

export function LiveBroadcastBadge({
  isLive,
  viewerCount,
  publicUrl,
  errorMessage,
}: LiveBroadcastBadgeProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // KS-3736 acceptance carry-over: при создании трансляции ссылка
  // копируется автоматически и показывается тост «Ссылка скопирована».
  // Триггерим только на переход publicUrl null → string, чтобы при
  // REST-восстановлении (publicUrl уже строка с первого рендера)
  // тост не появлялся.
  const prevPublicUrlRef = useRef(publicUrl);
  useEffect(() => {
    const prev = prevPublicUrlRef.current;
    prevPublicUrlRef.current = publicUrl;
    if (!prev && publicUrl) {
      void (async () => {
        try {
          await navigator.clipboard.writeText(publicUrl);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2500);
        } catch {
          /* clipboard может быть закрыт permissions — игнорируем */
        }
      })();
    }
  }, [publicUrl]);

  if (!isLive && !errorMessage) return null;

  return (
    <div
      className="analysis-live-badge"
      data-testid="analysis-live-badge"
      // Inline-стили — без отдельного CSS-файла, чтобы не блокировать
      // задачу на верстальщике. Координатор/верстальщик при желании
      // перенесут на класс с дизайн-токенами.
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 4,
        margin: '8px 0',
      }}
    >
      {isLive && (
        <span
          className="analysis-live-badge__status"
          role="status"
          aria-live="polite"
          data-testid="analysis-live-badge-status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            borderRadius: 12,
            background: 'rgba(229, 57, 53, 0.10)',
            color: '#c62828',
            fontSize: 13,
            border: '1px solid rgba(229, 57, 53, 0.35)',
            width: 'fit-content',
          }}
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
          <span data-testid="analysis-live-badge-viewers">
            · {viewerCount} {t('liveAnalysis.viewersShort', 'viewers')}
          </span>
        </span>
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
