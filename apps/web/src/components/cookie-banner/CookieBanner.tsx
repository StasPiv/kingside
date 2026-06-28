import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api';
import {
  readAnalyticsConsentCookie,
  readGuestConsentLocal,
  setGuestConsentLocal,
  writeFrontAnalyticsConsentCookie,
} from '../../lib/events';
import { getUserConsent } from './consentTypes';

const API_BASE =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';

type GuestDeleteState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'loading' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * KS-4698 / ADR-147 §6.2. Cookie-banner с чекбоксом «Аналитика для
 * персональных подсказок».
 *
 * Видимость:
 *  - **Авторизованный** — показываем, пока `user.analyticsConsent`
 *    не выставлен (`null|undefined`). После выбора (true/false) —
 *    скрываем; следующий показ — только при сбросе через Settings.
 *  - **Гость** — показываем, пока cookie `analytics_consent` не
 *    выставлен (`!== '1'`) и пользователь не дисмиссил баннер. После
 *    accept/decline backend (`POST /guest/consent`) сам ставит/чистит
 *    подписанные cookies (HMAC-подпись только на сервере, KS-4700).
 *
 * Дополнительно для гостя — кнопка «Удалить мои данные»
 * (`DELETE /guest/analytics-data`, ADR-147 §6.3) с подтверждением.
 * Backend сам clear'ит cookies через `Max-Age=0` после успеха.
 */
export function CookieBanner(): ReactElement | null {
  const { t } = useTranslation();
  const { user, loading, refreshUser } = useAuth();
  const userConsent = useMemo(() => getUserConsent(user), [user]);

  const [hiddenForGuest, setHiddenForGuest] = useState<boolean>(() =>
    readGuestDismissed(),
  );
  // bump инкрементируется после сетевых запросов, которые меняют cookies —
  // это триггерит пересчёт `guestConsentGiven` (cookie не наблюдается
  // подпиской, читаем заново).
  const [bump, setBump] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guestDelete, setGuestDelete] = useState<GuestDeleteState>({ kind: 'idle' });
  // KS-4722. Безусловный признак «гость нажал accept в этой сессии».
  // Не зависит от cookie (которая может не записаться в iOS Safari
  // ITP / WebView quirks) и от localStorage (private mode → quota).
  // Гарантирует, что баннер скроется сразу после 200 OK от
  // POST /guest/consent. Storage остаётся источником на mount/reload.
  const [acceptedThisSession, setAcceptedThisSession] = useState(false);

  // KS-4715/KS-4722. Источники признака consent:
  //   1) React state `acceptedThisSession` — синхронно после 200 OK;
  //   2) cookie `analytics_consent=1` — на следующем mount/reload;
  //   3) localStorage-флаг — fallback для случая «cookie не доехала».
  // Достаточно одного истинного.
  const guestConsentGiven = useMemo(
    () =>
      acceptedThisSession
      || readAnalyticsConsentCookie()
      || readGuestConsentLocal(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bump, acceptedThisSession],
  );

  // KS-4722. Для авторизованного — тот же страховочный state, чтобы
  // баннер скрылся сразу после PATCH /me/consent, не дожидаясь
  // refreshUser/обновления контекста.
  const [userChoiceMadeThisSession, setUserChoiceMadeThisSession] = useState(false);

  const onUserChoice = useCallback(
    async (next: boolean) => {
      if (!user) return;
      setSubmitting(true);
      setError(null);
      try {
        await api.patch('/me/consent', { analytics: next });
        setUserChoiceMadeThisSession(true);
        await refreshUser();
        // KS-4718: оповестим EventsBootstrap/HintHost, чтобы
        // tracking/pull стартовал сразу, без reload.
        dispatchConsentChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [user, refreshUser],
  );

  const onGuestChoice = useCallback(async (analytics: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/guest/consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analytics }),
      });
      if (!res.ok) {
        // KS-4722: показываем код, чтобы QA/юзер сразу видели причину
        // (раньше было generic «try again»). Console-лог — для
        // прод-DevTools диагностики (CORS-preflight, 5xx и т.п.).
        const text = await res.text().catch(() => '');
        const detail = text ? `${res.status} ${text.slice(0, 80)}` : `HTTP ${res.status}`;
        console.error('[CookieBanner] /guest/consent failed', detail);
        setError(detail);
        return;
      }
      // KS-4715: явно фиксируем согласие в localStorage. До фикса
      // backend (Domain=.kingside.site) только этот источник
      // увидит фронт; после фикса остаётся fallback'ом.
      // Decline → cookie очищен на бэке + локальный флаг сбрасываем
      // и ставим dismissed, чтобы баннер не вылезал снова.
      if (analytics) {
        setGuestConsentLocal(true);
        // KS-4722: дублируем cookie от фронта (Domain=.kingside.site).
        // Backend Set-Cookie может не дойти (HttpOnly/ITP/WebView/CDN
        // strip), localStorage может быть недоступен (private mode).
        // Этот cookie — третий независимый источник для readAnalytics-
        // ConsentCookie() на следующем mount/reload.
        writeFrontAnalyticsConsentCookie(true);
        // React state — для текущего рендера, чтобы баннер скрылся
        // сразу же, без ожидания пересчёта useMemo.
        setAcceptedThisSession(true);
      } else {
        setGuestConsentLocal(false);
        writeFrontAnalyticsConsentCookie(false);
        setAcceptedThisSession(false);
        setGuestDismissed();
        setHiddenForGuest(true);
      }
      setBump((b) => b + 1);
      // KS-4718: оповещаем EventsBootstrap и HintHost — без события
      // они узнают о новом consent только после reload, и pull-loop
      // / page_view не стартуют.
      dispatchConsentChanged();
    } catch (err) {
      // KS-4722: типичная причина — CORS-preflight reject; в Network
      // виден только OPTIONS без POST. Console.error помогает увидеть
      // конкретный TypeError ("Failed to fetch" / "NetworkError").
      console.error('[CookieBanner] /guest/consent network error', err);
      setError(err instanceof Error ? err.message : 'network');
    } finally {
      setSubmitting(false);
    }
  }, []);

  const onGuestDismiss = useCallback(() => {
    setGuestDismissed();
    setHiddenForGuest(true);
  }, []);

  const onAskGuestDelete = useCallback(() => {
    setGuestDelete({ kind: 'confirm' });
  }, []);

  const onCancelGuestDelete = useCallback(() => {
    setGuestDelete({ kind: 'idle' });
  }, []);

  const onConfirmGuestDelete = useCallback(async () => {
    setGuestDelete({ kind: 'loading' });
    try {
      const res = await fetch(`${API_BASE}/guest/analytics-data`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        setGuestDelete({
          kind: 'error',
          message: `HTTP ${res.status}`,
        });
        return;
      }
      // Backend сам ставит Max-Age=0 на consent-cookies → следующий
      // bump перерасчёт скроет accept-вариант. Доп. ставим dismissed,
      // чтобы баннер не «возродился» сразу после удаления.
      // KS-4715: чистим и localStorage-флаг — иначе после reload
      // баннер останется скрытым, хотя данных уже нет.
      // KS-4722: и front-cookie тоже.
      setGuestConsentLocal(false);
      writeFrontAnalyticsConsentCookie(false);
      setAcceptedThisSession(false);
      setGuestDismissed();
      setGuestDelete({ kind: 'done' });
      setBump((b) => b + 1);
      setHiddenForGuest(true);
      // KS-4718: consent отозван — пусть EventsBootstrap/HintHost
      // остановят pull/tracking немедленно.
      dispatchConsentChanged();
    } catch (err) {
      setGuestDelete({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network',
      });
    }
  }, []);

  useEffect(() => {
    // При логауте — снова разрешаем показ гостевой части.
    if (!user) return;
    setHiddenForGuest(false);
  }, [user]);

  if (loading) return null;

  // Авторизованный с принятым решением (true/false) — баннер скрыт.
  // KS-4722: либо контекст уже знает userConsent, либо PATCH прошёл
  // успешно в этой сессии (страховка на случай долгого refreshUser).
  if (user && (userConsent !== null || userChoiceMadeThisSession)) return null;
  // Гость уже дал согласие через cookie — баннер скрыт.
  if (!user && guestConsentGiven) return null;
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
          "We'd like to collect anonymous usage events (page views, game and puzzle starts, idle time) to personalise contextual hints. Your games, moves, chat messages, ratings and account data are stored as part of the platform itself — independently of this choice.",
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
            {t('cookieBanner.accept', 'Enable hints analytics')}
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
              {' '}
              <small className="cookie-banner__error-detail">({error})</small>
            </span>
          )}
        </div>
      ) : (
        <div className="cookie-banner__controls">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void onGuestChoice(true)}
            data-testid="cookie-banner-guest-accept"
          >
            {t('cookieBanner.accept', 'Enable hints analytics')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void onGuestChoice(false)}
            data-testid="cookie-banner-guest-decline"
          >
            {t('cookieBanner.decline', 'Decline')}
          </button>
          <button
            type="button"
            className="cookie-banner__link"
            onClick={onAskGuestDelete}
            data-testid="cookie-banner-guest-delete"
          >
            {t('cookieBanner.guestDelete', 'Delete my analytics data')}
          </button>
          <button
            type="button"
            className="cookie-banner__link"
            onClick={onGuestDismiss}
            data-testid="cookie-banner-guest-dismiss"
          >
            {t('cookieBanner.guestDismiss', 'Not now')}
          </button>
          {error && (
            <span className="cookie-banner__error" data-testid="cookie-banner-error">
              {t('cookieBanner.error', 'Could not save your choice — try again.')}
            </span>
          )}

          {guestDelete.kind === 'confirm' && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cookie-banner-guest-delete-title"
              className="cookie-banner__confirm"
              data-testid="cookie-banner-guest-delete-confirm"
            >
              <h3 id="cookie-banner-guest-delete-title">
                {t(
                  'cookieBanner.guestDeleteConfirmTitle',
                  'Delete analytics data?',
                )}
              </h3>
              <p>
                {t(
                  'cookieBanner.guestDeleteConfirmBody',
                  'Removes only analytics events and consent cookies for this guest session. Your games and account data are not affected.',
                )}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => void onConfirmGuestDelete()}
                  data-testid="cookie-banner-guest-delete-yes"
                >
                  {t('cookieBanner.guestDeleteConfirmYes', 'Yes, delete')}
                </button>
                <button
                  type="button"
                  onClick={onCancelGuestDelete}
                  data-testid="cookie-banner-guest-delete-no"
                >
                  {t('cookieBanner.guestDeleteConfirmNo', 'Cancel')}
                </button>
              </div>
            </div>
          )}
          {guestDelete.kind === 'loading' && (
            <p data-testid="cookie-banner-guest-delete-loading">
              {t('cookieBanner.guestDeleteLoading', 'Deleting…')}
            </p>
          )}
          {guestDelete.kind === 'error' && (
            <p
              className="cookie-banner__error"
              data-testid="cookie-banner-guest-delete-error"
            >
              {t('cookieBanner.guestDeleteError', 'Delete failed: {{message}}', {
                message: guestDelete.message,
              })}
            </p>
          )}
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

/**
 * KS-4718. Сигнал «consent изменился» — слушают `EventsBootstrap` и
 * `HintHost`, чтобы перенастроить tracking/pull без reload.
 */
function dispatchConsentChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('kingside:consent-changed'));
  } catch {
    /* старые браузеры — пропускаем */
  }
}

// Экспорт для других модулей (Settings → Privacy переиспользует тот же
// helper, когда нужно понять, выставлен ли guest-консент в cookie).
export { readAnalyticsConsentCookie };
