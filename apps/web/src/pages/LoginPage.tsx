import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export function LoginPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const oauthError = (location.state as { oauthError?: string } | null)?.oauthError;
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);

  useEffect(() => {
    if (loadingProvider) {
      window.location.href = `${API_URL}/auth/${loadingProvider}`;
    }
  }, [loadingProvider]);

  const handleOAuth = (provider: string) => {
    setLoadingProvider(provider);
  };

  const isLoading = loadingProvider !== null;

  return (
    <div className="auth-page">
      <div className="auth-form">
        <h1>{t('auth.login.title')}</h1>
        {oauthError && <div className="error">{oauthError}</div>}
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
            className="oauth-button oauth-button--chesscom"
            onClick={() => handleOAuth('chessdotcom')}
            disabled={isLoading}
          >
            {loadingProvider === 'chessdotcom' ? (
              <><span className="oauth-spinner" aria-hidden="true" />{t('auth.oauth.connecting')}</>
            ) : t('auth.oauth.chesscom')}
          </button>
        </div>
      </div>
    </div>
  );
}
