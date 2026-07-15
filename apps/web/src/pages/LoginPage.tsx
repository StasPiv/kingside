import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { PageSeo } from '../components/seo/PageSeo';
import { redirectToTelegramOAuth } from '../utils/telegramOAuth';
import {
  consumeAuthReturnUrl,
  setAuthReturnUrl,
} from '../utils/authReturnUrl';
import { markLoginStart } from '../utils/registrationAttribution';
import type { TelegramAuthResponse } from '@kingside/shared';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// KS-2200: на проде фронтенд — SPA на S3/CloudFront, путь `/auth/google`
// не проксируется к API. Нужен абсолютный URL к API-серверу,
// аналогично тому, как это сделано в MainLayout.tsx.
const API_URL = import.meta.env.VITE_API_URL ?? '';

export function LoginPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { loginWithTokens } = useAuth();
  const oauthErrorFromState = (location.state as { oauthError?: string } | null)?.oauthError;
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [error, setError] = useState<string | null>(oauthErrorFromState ?? null);
  const [telegramData, setTelegramData] = useState<TelegramUser | null>(null);

  // KS-2110: если на /login пришли через ProtectedRoute, returnUrl
  // уже в sessionStorage. На случай прямого `/login?returnUrl=` или
  // `state.returnUrl` (внутри SPA) — закрепляем то же значение там же,
  // чтобы OAuth-callback его прочитал.
  useEffect(() => {
    const stateReturnUrl = (location.state as { returnUrl?: string } | null)
      ?.returnUrl;
    if (stateReturnUrl) {
      setAuthReturnUrl(stateReturnUrl);
    }
  }, [location.state]);

  useEffect(() => {
    if (loadingProvider) {
      // KS-2200: используем абсолютный URL к API (VITE_API_URL), чтобы
      // переход работал на проде, где фронтенд и API — разные домены.
      window.location.href = `${API_URL}/auth/${loadingProvider}`;
    }
  }, [loadingProvider]);

  // Handle tgAuthResult redirect from Telegram OAuth (COOP: same-origin blocks popup opener access)
  // Telegram OAuth sends tgAuthResult as URL fragment (#tgAuthResult=...), not query string
  useEffect(() => {
    const hash = location.hash.slice(1); // remove leading '#'
    const params = new URLSearchParams(hash);
    const tgAuthResult = params.get('tgAuthResult');
    if (!tgAuthResult) return;
    // Clean up URL immediately
    window.history.replaceState({}, '', location.pathname);
    try {
      const user = JSON.parse(atob(tgAuthResult)) as TelegramUser;
      setTelegramData(user);
    } catch {
      setError(t('auth.oauth.error'));
    }
  }, [t, location.hash, location.pathname]);

  // Handle Telegram auth data — send to backend
  useEffect(() => {
    if (!telegramData) return;
    setTelegramLoading(true);
    api
      .post<TelegramAuthResponse>('/auth/telegram', telegramData)
      .then(({ accessToken, refreshToken, requiresUsernameSetup: needsSetup, isNewUser }) => {
        setTelegramData(null);
        if (needsSetup) {
          // Redirect to OAuthCallbackPage which handles pending users correctly.
          // LoginPage is wrapped in GuestRoute which unmounts it when loading=true,
          // so any local state (requiresUsernameSetup) would be lost. OAuthCallbackPage
          // is not wrapped in GuestRoute and survives the loading cycle.
          // KS-4970: пробрасываем isNewUser (у Telegram он есть в ответе),
          // чтобы OAuthCallbackPage отправил событие регистрации после
          // успешного username-setup именно для нового аккаунта.
          const newUserFlag = isNewUser ? '&isNewUser=true' : '';
          navigate(
            `/oauth/callback?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}&requiresUsernameSetup=true${newUserFlag}`,
            { replace: true },
          );
        } else {
          loginWithTokens(accessToken, refreshToken);
          // KS-2110: возвращаем пользователя туда, откуда его кинуло
          // на /login (sessionStorage, см. `setAuthReturnUrl`).
          // Без этого после Telegram-логина из /lessons его всегда
          // отправляло на /, и он терял контекст.
          const target = consumeAuthReturnUrl() ?? '/';
          navigate(target, { replace: true });
        }
      })
      .catch(() => {
        setError(t('auth.oauth.error'));
        setTelegramLoading(false);
        setTelegramData(null);
      });
  }, [telegramData, loginWithTokens, navigate, t]);

  const handleOAuth = (provider: string) => {
    // KS-4970: фиксируем провайдера и страницу входа до редиректа на OAuth.
    markLoginStart(provider);
    setLoadingProvider(provider);
  };

  const handleTelegramLogin = () => {
    markLoginStart('telegram');
    redirectToTelegramOAuth();
  };

  const isLoading = loadingProvider !== null || telegramLoading;

  return (
    <div className="auth-page">
      <PageSeo ns="login" path="/login" />
      <div className="auth-form">
        <h1>{t('auth.login.title')}</h1>
        {error && <div className="error">{error}</div>}
        <div className="oauth-buttons">
          <button
            className="oauth-button oauth-button--google"
            onClick={() => handleOAuth('google')}
            disabled={isLoading}
          >
            {loadingProvider === 'google' ? (
              <><span className="oauth-spinner" aria-hidden="true" />{t('auth.oauth.connecting')}</>
            ) : t('auth.oauth.google')}
          </button>
          <button
            className="oauth-button oauth-button--facebook"
            onClick={() => handleOAuth('facebook')}
            disabled={isLoading}
          >
            {loadingProvider === 'facebook' ? (
              <><span className="oauth-spinner" aria-hidden="true" />{t('auth.oauth.connecting')}</>
            ) : t('auth.oauth.facebook')}
          </button>
          <button
            className="oauth-button oauth-button--telegram"
            onClick={handleTelegramLogin}
            disabled={isLoading}
          >
            {telegramLoading ? (
              <><span className="oauth-spinner" aria-hidden="true" />{t('auth.oauth.connecting')}</>
            ) : t('auth.oauth.telegram')}
          </button>
        </div>
      </div>
    </div>
  );
}
