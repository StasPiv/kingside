import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
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

// Numeric bot ID (part before colon in bot token) — safe to expose in frontend
const TELEGRAM_BOT_ID = import.meta.env.VITE_TELEGRAM_BOT_ID ?? '8447702776';

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

  useEffect(() => {
    if (loadingProvider) {
      window.location.href = `/api/auth/${loadingProvider}`;
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
      .post<TelegramAuthResponse>('/api/auth/telegram', telegramData)
      .then(({ accessToken, refreshToken, requiresUsernameSetup: needsSetup }) => {
        setTelegramData(null);
        if (needsSetup) {
          // Redirect to OAuthCallbackPage which handles pending users correctly.
          // LoginPage is wrapped in GuestRoute which unmounts it when loading=true,
          // so any local state (requiresUsernameSetup) would be lost. OAuthCallbackPage
          // is not wrapped in GuestRoute and survives the loading cycle.
          navigate(
            `/oauth/callback?accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}&requiresUsernameSetup=true`,
            { replace: true },
          );
        } else {
          loginWithTokens(accessToken, refreshToken);
          navigate('/', { replace: true });
        }
      })
      .catch(() => {
        setError(t('auth.oauth.error'));
        setTelegramLoading(false);
        setTelegramData(null);
      });
  }, [telegramData, loginWithTokens, navigate, t]);

  const handleOAuth = (provider: string) => {
    setLoadingProvider(provider);
  };

  const handleTelegramLogin = () => {
    const origin = window.location.origin;
    const returnTo = `${origin}/login`;
    // Use redirect (not popup): COOP: same-origin nullifies window.opener in cross-origin popups
    window.location.href =
      `https://oauth.telegram.org/auth` +
      `?bot_id=${TELEGRAM_BOT_ID}` +
      `&origin=${encodeURIComponent(origin)}` +
      `&return_to=${encodeURIComponent(returnTo)}`;
  };

  const isLoading = loadingProvider !== null || telegramLoading;

  return (
    <div className="auth-page">
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
