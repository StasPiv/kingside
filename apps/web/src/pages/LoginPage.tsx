import { useState, useEffect, useRef } from 'react';
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
    onTelegramAuth: (user: TelegramUser) => void;
  }
}

const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME ?? 'kingside1_bot';

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
  const telegramRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loadingProvider) {
      window.location.href = `/api/auth/${loadingProvider}`;
    }
  }, [loadingProvider]);

  // Register global Telegram widget callback
  useEffect(() => {
    window.onTelegramAuth = (user: TelegramUser) => {
      setTelegramData(user);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).onTelegramAuth;
    };
  }, []);

  // Inject Telegram Login Widget script
  useEffect(() => {
    const container = telegramRef.current;
    if (!container) return;
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', TELEGRAM_BOT_USERNAME);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-onauth', 'onTelegramAuth');
    script.setAttribute('data-request-access', 'write');
    script.async = true;
    container.appendChild(script);
    return () => {
      container.innerHTML = '';
    };
  }, []);

  // Handle Telegram auth data when widget callback fires
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
          {telegramLoading ? (
            <div className="oauth-button oauth-button--telegram">
              <span className="oauth-spinner" aria-hidden="true" />
              {t('auth.oauth.connecting')}
            </div>
          ) : (
            <div ref={telegramRef} className="telegram-widget-container" />
          )}
        </div>
      </div>
    </div>
  );
}
