import { useEffect, useLayoutEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { UsernameSetupModal } from '../components/UsernameSetupModal';
import { consumeAuthReturnUrl } from '../utils/authReturnUrl';

export function OAuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loginWithTokens, refreshUser, user, loading } = useAuth();
  const { t } = useTranslation();
  const [initialized, setInitialized] = useState(false);
  const [requiresUsernameSetup, setRequiresUsernameSetup] = useState(false);

  // Eagerly persist OAuth tokens to localStorage during the layout phase,
  // before any useEffect (including AuthContext's token effect) can read it.
  // This prevents a race where AuthContext's parent useEffect fires before
  // this child's useEffect and sees an empty localStorage.
  useLayoutEffect(() => {
    const accessToken = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');
    const error = searchParams.get('error');
    if (!error && accessToken && refreshToken) {
      localStorage.setItem('token', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      console.log('[OAuthCallback] useLayoutEffect: tokens pre-saved to localStorage', {
        accessTokenPreview: accessToken.slice(0, 20) + '...',
      });
    }
    // KS-2034: запускаем один раз при mount — токены из URL сохраняем
    // ДО того как любой эффект-зависимость по `searchParams` сменится.
    // Включение `searchParams` в deps приведёт к повторной записи в
    // localStorage и потенциальной перезаписи только что обновлённого
    // refresh token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const accessToken = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');
    const error = searchParams.get('error');
    const needsSetup = searchParams.get('requiresUsernameSetup') === 'true';

    console.log('[OAuthCallback] init effect', {
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      accessTokenPreview: accessToken ? accessToken.slice(0, 20) + '...' : null,
      error,
      needsSetup,
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

    if (needsSetup) {
      setRequiresUsernameSetup(true);
    }

    console.log('[OAuthCallback] calling loginWithTokens');
    loginWithTokens(accessToken, refreshToken);
    setInitialized(true);
  // KS-2034: одноразовый init по содержимому URL. `loginWithTokens`,
  // `navigate`, `searchParams` стабильны в рамках mount — повторный
  // запуск только заново обработает уже использованный auth-callback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    console.log('[OAuthCallback] nav effect', { initialized, loading, hasUser: !!user, requiresUsernameSetup });
    if (!initialized || loading) return;
    // If username setup is required — wait for modal interaction, don't navigate
    if (requiresUsernameSetup) return;
    if (user) {
      // KS-2110: после OAuth-callback'а возвращаем пользователя на
      // сохранённый returnUrl (sessionStorage), чтобы прямой переход
      // на `/lessons` → `/login` → Google → callback → `/lessons`
      // действительно довёл его до запрошенной страницы.
      const target = consumeAuthReturnUrl() ?? '/';
      console.log('[OAuthCallback] user found, navigating to target', { userId: user.id, username: user.username, target });
      navigate(target, { replace: true });
    } else {
      console.log('[OAuthCallback] no user after loading complete, navigating to /login');
      navigate('/login', {
        replace: true,
        state: { oauthError: t('auth.oauth.error') },
      });
    }
  }, [initialized, loading, user, navigate, t, requiresUsernameSetup]);

  const handleUsernameSetupSuccess = async () => {
    await refreshUser();
    // KS-2110: после username-setup тоже возвращаем на returnUrl.
    const target = consumeAuthReturnUrl() ?? '/';
    navigate(target, { replace: true });
  };

  if (requiresUsernameSetup) {
    return (
      <div className="auth-page">
        <UsernameSetupModal
          onSuccess={handleUsernameSetupSuccess}
          accessToken={searchParams.get('accessToken') ?? undefined}
        />
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-form">
        <p>{t('common.loading')}</p>
      </div>
    </div>
  );
}
