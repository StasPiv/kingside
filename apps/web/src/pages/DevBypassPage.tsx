import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import type { AuthTokenResponse } from '@kingside/shared';

interface DevBypassPageProps {
  secret: string;
}

export function DevBypassPage({ secret }: DevBypassPageProps) {
  const navigate = useNavigate();
  const { loginWithTokens } = useAuth();
  const { t } = useTranslation();
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    api
      .post<AuthTokenResponse>('/api/auth/dev-bypass', { secret })
      .then(({ accessToken, refreshToken }) => {
        loginWithTokens(accessToken, refreshToken);
        navigate('/lobby', { replace: true });
      })
      .catch(() => {
        navigate('/login', {
          replace: true,
          state: { oauthError: 'Dev bypass failed' },
        });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="auth-page">
      <div className="auth-form">
        <p>{t('common.loading')}</p>
      </div>
    </div>
  );
}
