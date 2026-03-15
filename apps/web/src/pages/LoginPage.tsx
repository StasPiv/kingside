import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function LoginPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const oauthError = (location.state as { oauthError?: string } | null)?.oauthError;

  const handleOAuth = (provider: string) => {
    window.location.href = `/api/auth/${provider}`;
  };

  return (
    <div className="auth-page">
      <div className="auth-form">
        <h1>{t('auth.login.title')}</h1>
        {oauthError && <div className="error">{oauthError}</div>}
        <div className="oauth-buttons">
          <button className="oauth-button oauth-button--google" onClick={() => handleOAuth('google')}>
            {t('auth.oauth.google')}
          </button>
          <button className="oauth-button oauth-button--facebook" onClick={() => handleOAuth('facebook')}>
            {t('auth.oauth.facebook')}
          </button>
          <button className="oauth-button oauth-button--chesscom" onClick={() => handleOAuth('chess-com')}>
            {t('auth.oauth.chesscom')}
          </button>
        </div>
      </div>
    </div>
  );
}
