import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { AuthTokenResponse } from '@kingside/shared';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

declare global {
  interface Window {
    TelegramLoginWidget: {
      dataOnauth: (user: TelegramUser) => void;
    };
  }
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

  // Register global Telegram popup callback
  useEffect(() => {
    window.TelegramLoginWidget = {
      dataOnauth: (user: TelegramUser) => {
        setTelegramData(user);
      },
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).TelegramLoginWidget;
    };
  }, []);

  // Handle Telegram auth data when popup callback fires
  useEffect(() => {
    if (!telegramData) return;
    setTelegramLoading(true);
    api
      .post<AuthTokenResponse>('/api/auth/telegram', telegramData)
      .then(({ accessToken, refreshToken }) => {
        loginWithTokens(accessToken, refreshToken);
        navigate('/lobby', { replace: true });
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
    const returnTo = window.location.href;
    const authUrl =
      `https://oauth.telegram.org/auth` +
      `?bot_id=${TELEGRAM_BOT_ID}` +
      `&origin=${encodeURIComponent(origin)}` +
      `&return_to=${encodeURIComponent(returnTo)}` +
      `&embed=1` +
      `&request_access=write`;
    window.open(authUrl, 'tgLogin', 'width=550,height=470,resizable=yes,scrollbars=yes');
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
