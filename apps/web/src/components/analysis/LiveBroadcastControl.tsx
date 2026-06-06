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

/**
 * KS-3764 / ADR-112 §4. Контекст анализа, в котором рендерится кнопка.
 *  - `analysis` — обычная страница анализа (свой или ad-hoc):
 *      • если `analysisId` есть → flow «Транслировать»;
 *      • если `analysisId === null` → flow «Сохранить и транслировать»:
 *        сначала autosave создаёт запись в БД, потом запускается
 *        трансляция с уже валидным id (ADR-112: трансляция привязана
 *        к конкретному `Analysis`).
 *  - `review` (`/game/:id/review`) и `puzzle` — анализ чужой партии /
 *    пазла. Трансляция не имеет смысла без отдельного «своего» анализа.
 *    Кнопка disabled + тултип-подсказка «Сохраните в мастерскую».
 */
export type LiveBroadcastKind = 'analysis' | 'review' | 'puzzle';

export interface LiveBroadcastControlProps {
  isLive: boolean;
  isStarting: boolean;
  viewerCount: number;
  /** Полная ссылка `https://kingside.site/live/<slug>`. */
  publicUrl: string | null;
  /** Сервер-ошибка (для inline-тоста). */
  errorMessage: string | null;
  /** KS-3764 / ADR-112: контекст анализа, см. `LiveBroadcastKind`. */
  kind: LiveBroadcastKind;
  /**
   * KS-3764 / ADR-112: ID сохранённого анализа. Если `null` для
   * `kind='analysis'` — это ad-hoc-сессия без записи в БД; кнопка
   * превратится в «Сохранить и транслировать».
   */
  analysisId: string | null;
  /** Обычный «Транслировать» — когда `kind='analysis'` и есть `analysisId`. */
  onStart: () => void;
  /**
   * KS-3764: ad-hoc «Сохранить и транслировать». Родитель должен:
   *  1) вызвать autosave (POST /analyses), дождаться entry.id,
   *  2) вызвать `start(entry.id)` хука.
   * Если флоу не передан (компонент рендерится без `analysisId`) — для
   * безопасности кнопка disabled (но это не штатный сценарий — родитель
   * обязан либо иметь analysisId, либо передать onSaveAndStart).
   */
  onSaveAndStart?: () => void;
  onStop: () => void;
}

export function LiveBroadcastControl({
  isLive,
  isStarting,
  viewerCount,
  publicUrl,
  errorMessage,
  kind,
  analysisId,
  onStart,
  onSaveAndStart,
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
        // KS-3764 / ADR-112 §4: kind-aware кнопка.
        // 1) review/puzzle — disabled + тултип «Сохраните в мастерскую».
        // 2) analysis без analysisId — «Сохранить и транслировать».
        // 3) analysis с analysisId — обычный «Транслировать».
        kind !== 'analysis' ? (
          <button
            type="button"
            className="analysis-live-broadcast__start analysis-live-broadcast__start--disabled"
            data-testid="analysis-live-start-disabled"
            disabled
            title={t(
              'liveAnalysis.unavailableTooltip',
              'Save to your workshop to start broadcasting',
            )}
            aria-label={t(
              'liveAnalysis.unavailableTooltip',
              'Save to your workshop to start broadcasting',
            )}
          >
            {t('liveAnalysis.start', 'Broadcast')}
          </button>
        ) : !analysisId ? (
          <button
            type="button"
            className="analysis-live-broadcast__start"
            data-testid="analysis-live-save-and-start"
            onClick={onSaveAndStart}
            disabled={isStarting || !onSaveAndStart}
            title={t(
              'liveAnalysis.saveAndStartTooltip',
              'Saves the analysis to your workshop, then starts the broadcast',
            )}
          >
            {isStarting
              ? t('liveAnalysis.starting', 'Starting…')
              : t('liveAnalysis.saveAndStart', 'Save and broadcast')}
          </button>
        ) : (
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
        )
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
