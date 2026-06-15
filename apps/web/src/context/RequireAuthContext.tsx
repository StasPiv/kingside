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
 *
 * KS-4131 / ADR-128 §6.9. Подписка на window-event
 * `kingside:guest-401` (диспатчит `api.ts` когда гость получил 401 от
 * backend'а). Классифицирует запрос:
 *   - read (GET/HEAD) → toast «не удалось загрузить»;
 *   - write+PF (whitelist `/nav-stats/increment`, `/feedback`) → toast
 *     «не удалось выполнить, попробуйте позже»;
 *   - write остальное (PR/PV) → открывает `<LoginRequiredModal>`
 *     с generic-описанием и returnUrl = текущий URL.
 * Глобального редиректа на /login провайдер не делает — это работа
 * AuthContext (session-expired у авторизованного с проваленным refresh).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

interface ToastState {
  id: number;
  message: string;
}

/**
 * KS-4131 / ADR-128 §6.9. Эндпоинты записи, которые по контракту
 * должны быть public (PF): backend KS-4130 должен отдавать 204, а не
 * 401. До раскатки backend'а — terappy для гостя выглядит как «не
 * получилось», не как «нужно войти», чтобы не вводить в заблуждение
 * UI-модалкой о логине там, где логин не требуется по дизайну.
 *
 * Whitelist short — расширяется по факту обнаружения 401 на PF-write.
 */
const WRITE_PF_PATTERNS: readonly RegExp[] = [
  /^\/user\/nav-stats\/(increment|top)/,
  /^\/feedback(\/|$)/,
];

/**
 * KS-4131 / ADR-128 §6.9. Эндпоинты «личного» (PV) — гостю их 401
 * означает, что без авторизации действие невозможно. Это grep по
 * актуальным private-маршрутам frontend'а; новые PV-эндпоинты
 * сводятся к одному из паттернов ниже.
 *
 * Не используется напрямую (на текущем этапе любая POST вне
 * WRITE_PF_PATTERNS трактуется как «нужен логин» → модалка), но
 * оставлен в коде как явный реестр для будущего различения
 * UI-формулировок PR vs PV.
 */
export const PV_PATTERNS: readonly RegExp[] = [
  /^\/messages(\/|$)/,
  /^\/friends(\/|$)/,
  /^\/profile(\/|$)/,
  /^\/settings(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/my\//,
  /^\/users\/blocked(\/|$)/,
];

function isWriteMethod(method: string): boolean {
  return (
    method === 'POST' ||
    method === 'PUT' ||
    method === 'PATCH' ||
    method === 'DELETE'
  );
}

function isWritePfPath(path: string): boolean {
  const clean = path.split('?')[0];
  return WRITE_PF_PATTERNS.some((re) => re.test(clean));
}

const TOAST_AUTO_DISMISS_MS = 5000;

export function RequireAuthProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  // Растущий счётчик для уникальности toast'а — каждое новое сообщение
  // отменяет предыдущий setTimeout, чтобы старый dismiss не убил новый.
  const toastSeqRef = useRef(0);

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

  const showToast = useCallback((message: string) => {
    toastSeqRef.current += 1;
    const id = toastSeqRef.current;
    setToast({ id, message });
    setTimeout(() => {
      setToast((prev) => (prev && prev.id === id ? null : prev));
    }, TOAST_AUTO_DISMISS_MS);
  }, []);

  // KS-4131. Подписка на guest-401-событие из api.ts.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ path: string; method: string }>)
        .detail;
      if (!detail) return;
      // Лог для расследования: куда уходит «гостевой» 401. Заменит
      // Sentry-event на этапе пока проектного wrapper'а нет — попадает
      // в browser console и в наш ClientLogger (initClientLogger).
      // eslint-disable-next-line no-console
      console.warn(
        `[api:guest-401] ${detail.method} ${detail.path} — guest hit auth-required endpoint`,
      );
      const write = isWriteMethod(detail.method);
      if (!write) {
        // Read (GET/HEAD) — для гостя backend ещё не открыл этот
        // endpoint или он PV. UI не должен ломаться, страница уже
        // отрисована (или отрисуется без данных). Показываем toast.
        showToast(
          t(
            'auth.loginRequired.toastLoadFailed',
            'Could not load. Please try again later.',
          ),
        );
        return;
      }
      if (isWritePfPath(detail.path)) {
        // Write PF — баг backend'а (должен быть 204). Не зовём логин,
        // показываем generic-toast.
        showToast(
          t(
            'auth.loginRequired.toastActionFailed',
            'Action could not be completed. Please try again later.',
          ),
        );
        return;
      }
      // Write PR/PV — авторизация требуется, открываем модалку.
      const returnUrl = `${window.location.pathname}${window.location.search}`;
      setModal({
        description: t(
          'auth.loginRequired.descriptionDefault',
          'Sign in to your Kingside account to continue.',
        ),
        returnUrl,
      });
    };
    window.addEventListener('kingside:guest-401', handler);
    return () => window.removeEventListener('kingside:guest-401', handler);
  }, [showToast, t]);

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
      {toast && (
        <div
          className="api-notice-toast"
          data-testid="api-notice-toast"
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
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
