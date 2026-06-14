/**
 * KS-4124 / ADR-128 §6 — модалка «Войдите, чтобы продолжить».
 *
 * Презентационный компонент: открытие/закрытие управляется снаружи
 * (RequireAuthProvider в context/RequireAuthContext.tsx). Сама модалка
 * только рисует UI и зовёт `onClose`/`onLogin`/`onRegister`.
 *
 * Закрывается по Esc (глобальный keydown) и клику по overlay.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface LoginRequiredModalProps {
  /**
   * Описание действия (i18n-ключ или сразу текст), которое требует
   * авторизации. Например: «Чтобы написать игроку, нужно войти в
   * Kingside». Если ключ передан через i18n — резолвится здесь же.
   */
  description: string;
  onClose: () => void;
  onLogin: () => void;
  onRegister: () => void;
}

export function LoginRequiredModal({
  description,
  onClose,
  onLogin,
  onRegister,
}: LoginRequiredModalProps) {
  const { t } = useTranslation();

  // KS-4124: Esc закрывает модалку (соответствует UX обычных
  // dialog'ов в проекте — CreateTournamentModal, FeedbackModal и т.п.).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="modal-overlay login-required-overlay"
      data-testid="login-required-modal"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal-content login-required-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-required-title"
      >
        <div className="modal-header">
          <h2 id="login-required-title">
            {t('auth.loginRequired.title', 'Sign in to continue')}
          </h2>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            type="button"
          >
            &times;
          </button>
        </div>

        <p className="login-required-modal__description">{description}</p>

        <div className="login-required-modal__actions">
          <button
            type="button"
            className="login-required-modal__btn login-required-modal__btn--primary"
            data-testid="login-required-login-btn"
            onClick={onLogin}
            autoFocus
          >
            {t('auth.loginRequired.loginBtn', 'Sign in')}
          </button>
          <button
            type="button"
            className="login-required-modal__btn login-required-modal__btn--secondary"
            data-testid="login-required-register-btn"
            onClick={onRegister}
          >
            {t('auth.loginRequired.registerBtn', 'Create account')}
          </button>
          <button
            type="button"
            className="login-required-modal__btn login-required-modal__btn--ghost"
            data-testid="login-required-cancel-btn"
            onClick={onClose}
          >
            {t('auth.loginRequired.cancelBtn', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
