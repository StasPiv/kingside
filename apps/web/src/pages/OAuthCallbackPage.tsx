import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';

export function OAuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loginWithTokens, user, loading } = useAuth();
  const { t } = useTranslation();
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const accessToken = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');
    const error = searchParams.get('error');

    console.log('[OAuthCallback] init effect', {
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      accessTokenPreview: accessToken ? accessToken.slice(0, 20) + '...' : null,
      error,
      fullUrl: window.location.href,
    });

    if (error || !accessToken || !refreshToken) {
      console.log('[OAuthCallback] missing tokens or error, redirecting to /login', { error, hasAccessToken: !!accessToken, hasRefreshToken: !!refreshToken });
      navigate('/login', {
        replace: true,
        state: { oauthError: t('auth.oauth.error') },
      });
      return;
    }

    console.log('[OAuthCallback] calling loginWithTokens');
    loginWithTokens(accessToken, refreshToken);
    setInitialized(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    console.log('[OAuthCallback] nav effect', { initialized, loading, hasUser: !!user });
    if (!initialized || loading) return;
    if (user) {
      console.log('[OAuthCallback] user found, navigating to /lobby', { userId: user.id, username: user.username });
      navigate('/lobby', { replace: true });
    } else {
      console.log('[OAuthCallback] no user after loading complete, navigating to /login');
      navigate('/login', {
        replace: true,
        state: { oauthError: t('auth.oauth.error') },
      });
    }
  }, [initialized, loading, user, navigate, t]);

  return (
    <div className="auth-page">
      <div className="auth-form">
        <p>{t('common.loading')}</p>
      </div>
    </div>
  );
}
