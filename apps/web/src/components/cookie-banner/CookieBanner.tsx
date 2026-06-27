import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api';
import { readAnalyticsConsentCookie } from '../../lib/events';
import { getUserConsent } from './consentTypes';

/**
 * KS-4698 / ADR-147 §6.2. Cookie-banner с чекбоксом «Аналитика для
 * персональных подсказок».
 *
 * Видимость:
 *  - **Авторизованный** — показываем, пока `user.analyticsConsent`
 *    не выставлен (`null|undefined`). После выбора (true/false) —
 *    скрываем; следующий показ — только при сбросе через Settings.
 *  - **Гость** — guest-консент требует HMAC-подписи cookies со
 *    стороны backend (`POST /guest/consent`). Эндпоинт ещё не
 *    готов (отдельный backend-тикет, см. KS-4698 комментарий).
 *    Поэтому пока для гостя баннер только просматриваемый: показывает
 *    объяснение и кнопку «Войти» (CTA к /login). Чекбокс для гостя
 *    появится автоматически, когда `VITE_GUEST_CONSENT_ENABLED=true`.
 *
 * Гейт `events`-клиента из KS-4684 уже учитывает cookie
 * `analytics_consent`, поэтому даже если кто-то выставит куку руками,
 * без backend-подписи `GuestIdMiddleware` не выпишет `guest_id` —
 * события молча уйдут в 401, и клиент дропнет батч (4xx → дроп).
 */
export function CookieBanner(): ReactElement | null {
  const { t } = useTranslation();
  const { user, loading, refreshUser } = useAuth();
  const userConsent = useMemo(() => getUserConsent(user), [user]);
  const [hiddenForGuest, setHiddenForGuest] = useState<boolean>(() =>
    readGuestDismissed(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guestConsentEnabled =
    (import.meta.env?.VITE_GUEST_CONSENT_ENABLED as string | undefined) === 'true';

  const onUserChoice = useCallback(
    async (next: boolean) => {
      if (!user) return;
      setSubmitting(true);
      setError(null);
      try {
        await api.patch('/me/consent', { analytics: next });
        await refreshUser();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [user, refreshUser],
  );

  const onGuestDismiss = useCallback(() => {
    setGuestDismissed();
    setHiddenForGuest(true);
  }, []);

  useEffect(() => {
    // При логауте — снова разрешаем показ гостевой части.
    if (!user) return;
    setHiddenForGuest(false);
  }, [user]);

  if (loading) return null;

  // Авторизованный с принятым решением (true/false) — баннер скрыт.
  if (user && userConsent !== null) return null;
  // Гость, уже отклонивший баннер в этой сессии — скрыт.
  if (!user && hiddenForGuest) return null;

  return (
    <div
      className="cookie-banner"
      role="region"
      aria-label={t('cookieBanner.region', 'Privacy & analytics consent')}
      data-testid="cookie-banner"
    >
      <p className="cookie-banner__text">
        {t(
          'cookieBanner.intro',
          'We use a small amount of analytics to personalize hints and improve the site. No personal moves or messages are tracked — only high-level actions.',
        )}
      </p>

      {user ? (
        <div className="cookie-banner__controls">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void onUserChoice(true)}
            data-testid="cookie-banner-accept"
          >
            {t('cookieBanner.accept', 'Enable analytics')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void onUserChoice(false)}
            data-testid="cookie-banner-decline"
          >
            {t('cookieBanner.decline', 'Decline')}
          </button>
          {error && (
            <span className="cookie-banner__error" data-testid="cookie-banner-error">
              {t('cookieBanner.error', 'Could not save your choice — try again.')}
            </span>
          )}
        </div>
      ) : guestConsentEnabled ? (
        // Future-proof: ветка активируется feature-flag'ом, как только
        // backend завезёт POST /guest/consent.
        <div className="cookie-banner__controls">
          <button
            type="button"
            onClick={onGuestDismiss}
            data-testid="cookie-banner-guest-dismiss"
          >
            {t('cookieBanner.guestDismiss', 'Not now')}
          </button>
        </div>
      ) : (
        <div className="cookie-banner__controls">
          <p className="cookie-banner__guest-hint">
            {t(
              'cookieBanner.guestHint',
              'Sign in to choose your analytics preferences. As a guest, no events are recorded.',
            )}
          </p>
          <button
            type="button"
            onClick={onGuestDismiss}
            data-testid="cookie-banner-guest-dismiss"
          >
            {t('cookieBanner.guestDismiss', 'Got it')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

const GUEST_DISMISSED_KEY = 'cookieBanner.guestDismissedAt';

function readGuestDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(GUEST_DISMISSED_KEY);
    if (!raw) return false;
    // Скрываем гостевой баннер на 30 дней после первого dismiss.
    const dismissedAt = Number(raw);
    if (Number.isNaN(dismissedAt)) return false;
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    return Date.now() - dismissedAt < THIRTY_DAYS;
  } catch {
    return false;
  }
}

function setGuestDismissed(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GUEST_DISMISSED_KEY, String(Date.now()));
  } catch {
    /* private mode и т.п. */
  }
}

// Экспорт для других модулей (Settings → Privacy переиспользует тот же
// helper, когда нужно понять, выставлен ли guest-консент в cookie).
export { readAnalyticsConsentCookie };
