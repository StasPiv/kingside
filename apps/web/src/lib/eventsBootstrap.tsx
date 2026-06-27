import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  configureEvents,
  isAnalyticsConsentGiven,
  teardownEvents,
} from './events';
import type { UserWithConsent } from '../components/cookie-banner/consentTypes';

/**
 * KS-4684/KS-4698 / ADR-147 §2.2. Инициализирует events-клиент после
 * первого рендера и обновляет конфиг при смене пользователя / токена /
 * consent. Без этого `track()` остаётся полным no-op (по дизайну
 * KS-4684).
 *
 * Гейт `isConsented`:
 *  - user → `user.analyticsConsent === true`;
 *  - guest → cookie `analytics_consent=1` (выставляет backend
 *    `POST /guest/consent`, KS-4700).
 *
 * Источник токена: `localStorage['token']` — тот же, что использует
 * `api.ts` (минуем cycle через AuthContext, который перерисовывается
 * при refresh).
 */
export function EventsBootstrap(): null {
  const { user, token } = useAuth();

  useEffect(() => {
    configureEvents({
      isConsented: () =>
        isAnalyticsConsentGiven(user as UserWithConsent | null),
      getAuthToken: () => token,
    });
    // teardown между перенастройками не нужен — configureEvents
    // идемпотентен по unload-listener'ам и таймеру.
    return () => {
      // Только при полном unmount (тесты/HMR) сбрасываем модуль.
      teardownEvents();
    };
    // user объект может пересоздаваться — реагируем на стабильные поля.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, (user as UserWithConsent | null)?.analyticsConsent, token]);

  return null;
}
