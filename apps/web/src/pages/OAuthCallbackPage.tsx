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

    if (error || !accessToken || !refreshToken) {
      navigate('/login', {
        replace: true,
        state: { oauthError: t('auth.oauth.error') },
      });
      return;
    }

    loginWithTokens(accessToken, refreshToken);
    setInitialized(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialized || loading) return;
    if (user) {
      navigate('/lobby', { replace: true });
    } else {
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
