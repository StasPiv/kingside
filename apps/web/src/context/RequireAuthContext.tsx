/**
 * KS-4124 / ADR-128 §6 — провайдер и хук `useRequireAuth`.
 *
 * Единая точка входа для auth-gated действий. Гостю показываем
 * <LoginRequiredModal>; авторизованному — сразу выполняем callback.
 *
 * Использование:
 *   const requireAuth = useRequireAuth();
 *   <button onClick={() => requireAuth(() => doAction(), {
 *     description: t('player.loginToMessage'),
 *   })}>...</button>
 *
 * Для повторения действия после возврата с /login — отдельная задача
 * страницы (читает returnUrl/state и сам ре-вызывает действие). Здесь
 * этим не занимаемся: ADR-128 §6 явно оставляет это поведение на
 * усмотрение страницы, чтобы не плодить глобальную «очередь действий».
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import { LoginRequiredModal } from '../components/LoginRequiredModal';
import { setAuthReturnUrl } from '../utils/authReturnUrl';

interface RequireAuthOptions {
  /**
   * Текст описания действия в модалке («Чтобы написать игроку, нужно
   * войти…»). Если не передан — используем общий fallback из i18n.
   */
  description?: string;
  /**
   * Куда возвращать после логина. По умолчанию — текущий
   * pathname+search; обычно достаточно.
   */
  returnUrl?: string;
}

type RequireAuthFn = (
  action: () => void,
  options?: RequireAuthOptions,
) => void;

const RequireAuthContext = createContext<RequireAuthFn | null>(null);

interface ModalState {
  description: string;
  returnUrl: string;
}

export function RequireAuthProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [modal, setModal] = useState<ModalState | null>(null);

  const requireAuth = useCallback<RequireAuthFn>(
    (action, options) => {
      if (user) {
        action();
        return;
      }
      const returnUrl =
        options?.returnUrl ??
        `${window.location.pathname}${window.location.search}`;
      const description =
        options?.description ??
        t(
          'auth.loginRequired.descriptionDefault',
          'Sign in to your Kingside account to continue.',
        );
      setModal({ description, returnUrl });
    },
    [user, t],
  );

  const closeModal = useCallback(() => setModal(null), []);

  const goToLogin = useCallback(() => {
    if (!modal) return;
    // KS-2110-паттерн: сохраняем returnUrl в sessionStorage (на случай
    // OAuth-редиректа — `state` через react-router не переживает
    // полный browser-redirect) и дублируем через router state.
    setAuthReturnUrl(modal.returnUrl);
    setModal(null);
    navigate('/login', { state: { returnUrl: modal.returnUrl } });
  }, [modal, navigate]);

  const goToRegister = useCallback(() => {
    if (!modal) return;
    setAuthReturnUrl(modal.returnUrl);
    setModal(null);
    navigate('/register', { state: { returnUrl: modal.returnUrl } });
  }, [modal, navigate]);

  // useMemo для requireAuth-функции через стабильный ref (callback
  // зависит только от user/t — ок).
  const value = useMemo(() => requireAuth, [requireAuth]);

  return (
    <RequireAuthContext.Provider value={value}>
      {children}
      {modal && (
        <LoginRequiredModal
          description={modal.description}
          onClose={closeModal}
          onLogin={goToLogin}
          onRegister={goToRegister}
        />
      )}
    </RequireAuthContext.Provider>
  );
}

export function useRequireAuth(): RequireAuthFn {
  const ctx = useContext(RequireAuthContext);
  if (!ctx) {
    throw new Error(
      'useRequireAuth must be used within RequireAuthProvider',
    );
  }
  return ctx;
}
