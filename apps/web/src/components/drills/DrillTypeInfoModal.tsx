import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TacticDrillType } from '@kingside/shared';

/**
 * KS-2418 — универсальный модал с описанием drill-типа.
 *
 * Используется в двух режимах:
 *   - `variant='onboarding'` — короткое объяснение (2–3 предложения) при
 *     первом запуске drill-типа. Кнопка «Понятно» закрывает и помечает
 *     онбординг как просмотренный.
 *   - `variant='help'` — расширенное описание (название + одна фраза +
 *     зачем нужен + как отвечать). Открывается по кнопке «?» в runner'е.
 *
 * Закрытие: клик по overlay, Escape, кнопка закрытия. ESC и клик по
 * фону вызывают `onClose` с `'dismiss'`, кнопка-«Понятно» — с `'confirm'`.
 *
 * Aria/focus: фокусирует кнопку закрытия при открытии (один цикл,
 * примитивная focus trap'а — для drill-юзкейса достаточно).
 */
export type DrillTypeInfoModalVariant = 'onboarding' | 'help';

export interface DrillTypeInfoModalProps {
  drillType: TacticDrillType;
  variant: DrillTypeInfoModalVariant;
  onClose: (reason: 'dismiss' | 'confirm') => void;
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DrillTypeInfoModal({
  drillType,
  variant,
  onClose,
}: DrillTypeInfoModalProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const key = kebabToCamel(drillType);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose('dismiss');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isOnboarding = variant === 'onboarding';
  const title = isOnboarding
    ? t('drills.onboarding.title', "What's this drill?")
    : t(`drills.types.${key}`);

  return (
    <div
      className="drill-info-overlay"
      data-testid="drill-info-overlay"
      data-variant={variant}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose('dismiss');
      }}
    >
      <div
        className="drill-info-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drill-info-modal-title"
        data-testid="drill-info-modal"
        data-drill-type={drillType}
      >
        <header className="drill-info-modal__header">
          <h2 id="drill-info-modal-title" className="drill-info-modal__title">
            {title}
          </h2>
          {!isOnboarding && (
            <button
              type="button"
              className="drill-info-modal__close"
              data-testid="drill-info-modal-close"
              aria-label={t('drills.runner.closeHelp', 'Close')}
              onClick={() => onClose('dismiss')}
            >
              ×
            </button>
          )}
        </header>

        <div className="drill-info-modal__body">
          {isOnboarding ? (
            <>
              <p className="drill-info-modal__paragraph">
                {t(`drills.onboarding.body.${key}`)}
              </p>
              <p className="drill-info-modal__hint">
                {t(
                  'drills.onboarding.showAgainHint',
                  'You can reopen the description at any time via the «?» button on the board.',
                )}
              </p>
            </>
          ) : (
            <>
              <p className="drill-info-modal__paragraph drill-info-modal__paragraph--lead">
                {t(`drills.oneLiners.${key}`)}
              </p>
              <section className="drill-info-modal__section">
                <h3 className="drill-info-modal__subtitle">
                  {t('drills.about.whatItTrainsLabel', 'What it trains')}
                </h3>
                <p className="drill-info-modal__paragraph">
                  {t(`drills.whatItTrains.${key}`)}
                </p>
              </section>
              <section className="drill-info-modal__section">
                <h3 className="drill-info-modal__subtitle">
                  {t('drills.about.howToAnswerLabel', 'How to answer')}
                </h3>
                <p className="drill-info-modal__paragraph">
                  {t(`drills.howToAnswer.${key}`)}
                </p>
              </section>
            </>
          )}
        </div>

        <footer className="drill-info-modal__footer">
          <button
            ref={buttonRef}
            type="button"
            className="drill-info-modal__confirm"
            data-testid="drill-info-modal-confirm"
            onClick={() => onClose('confirm')}
          >
            {isOnboarding
              ? t('drills.onboarding.gotIt', 'Got it')
              : t('drills.runner.closeHelp', 'Close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
