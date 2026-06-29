import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  configureEvents,
  isAnalyticsConsentGiven,
  teardownEvents,
} from './events';
import type { UserWithConsent } from '../components/cookie-banner/consentTypes';
import { usePageViewTracking } from '../hooks/usePageViewTracking';
import { useIdleTracking } from '../hooks/useIdleTracking';
import { useGuestLandingTracking } from '../hooks/useGuestLandingTracking';

/**
 * KS-4684/KS-4698/KS-4718 / ADR-147 §2.2. Инициализирует events-клиент
 * после первого рендера, реконфигурирует при смене user/token/consent
 * и активирует tracking-хуки (page_view / session_idle /
 * guest_landing_viewed). Без этого `track()` остаётся no-op, а POST
 * /events никогда не уходит.
 *
 * Гейт `isConsented` (см. `isAnalyticsConsentGiven`):
 *  - user → `user.analyticsConsent === true`;
 *  - guest → cookie `analytics_consent=1` или localStorage-флаг
 *    (KS-4715 fallback на случай Domain=api.kingside.site).
 *
 * Реактивность к consent: слушаем custom-event
 * `kingside:consent-changed` — диспатчится из `CookieBanner` после
 * accept/decline/delete. Это триггерит reconfigure без reload.
 */
export function EventsBootstrap(): null {
  const { user, token } = useAuth();
  // bump переинициализирует configureEvents при изменении consent
  // (cookie/localStorage не наблюдаются подпиской).
  const [consentBump, setConsentBump] = useState(0);

  // Подписка на смену consent.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = () => setConsentBump((b) => b + 1);
    window.addEventListener('kingside:consent-changed', onChange);
    // storage event срабатывает в других вкладках того же origin —
    // удобно для случая, когда пользователь сменил consent в другой
    // вкладке.
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('kingside:consent-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  useEffect(() => {
    configureEvents({
      isConsented: () =>
        isAnalyticsConsentGiven(user as UserWithConsent | null),
      getAuthToken: () => token,
    });
    return () => {
      // Snimaem listeners/timer. KS-4787: buffer сохраняется по умолчанию,
      // чтобы StrictMode mount→unmount→remount не терял page_view.
      teardownEvents();
    };
    // user объект может пересоздаваться — реагируем на стабильные поля.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user?.id,
    (user as UserWithConsent | null)?.analyticsConsent,
    token,
    consentBump,
  ]);

  // KS-4787: считаем events-клиент готовым, когда consent дан. До этого
  // `track()` всё равно no-op'ает — но `usePageViewTracking` без гейта
  // считал бы pathname «отправленным» и больше не повторил бы попытку,
  // даже когда consent появится после auth.me. consentBump участвует в
  // зависимостях, чтобы реактивно реагировать на cookie/localStorage,
  // которые сами по себе не наблюдаемы подпиской.
  const eventsReady = useMemo(
    () => isAnalyticsConsentGiven(user as UserWithConsent | null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, (user as UserWithConsent | null)?.analyticsConsent, consentBump],
  );

  // Tracking-хуки сами не зависят от consent — он проверяется внутри
  // `track()` в lib/events.ts. Без consent хуки безопасно no-op'ят.
  usePageViewTracking(eventsReady);
  useIdleTracking();
  useGuestLandingTracking({ disabled: Boolean(user) });

  return null;
}
