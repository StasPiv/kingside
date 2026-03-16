import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

type CheckResponse = { available: boolean };

type Props = {
  onSuccess: () => void;
};

export function UsernameSetupModal({ onSuccess }: Props) {
  const { t } = useTranslation();
  const { loginWithTokens } = useAuth();
  const [username, setUsername] = useState('');
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkUsername = useCallback(async (value: string) => {
    setChecking(true);
    setAvailable(null);
    try {
      const res = await api.get<CheckResponse>(
        `/api/users/check-username?username=${encodeURIComponent(value)}`,
      );
      setAvailable(res.available);
    } catch {
      setAvailable(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setAvailable(null);
    setSaveError(null);

    if (!USERNAME_RE.test(username)) {
      setChecking(false);
      return;
    }

    setChecking(true);
    debounceRef.current = setTimeout(() => {
      checkUsername(username);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [username, checkUsername]);

  const isValid = USERNAME_RE.test(username);
  const canSave = isValid && available === true && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.post<{ accessToken?: string; refreshToken?: string }>(
        '/api/users/set-username',
        { username },
      );
      if (res && res.accessToken && res.refreshToken) {
        loginWithTokens(res.accessToken, res.refreshToken);
      }
      onSuccess();
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err as { status: number }).status === 409
      ) {
        setAvailable(false);
        setSaveError(t('auth.usernameSetup.errorConflict'));
      } else {
        setSaveError(t('auth.usernameSetup.errorNetwork'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave();
  };

  const getStatusText = () => {
    if (!username || !isValid) return null;
    if (checking) return t('auth.usernameSetup.checking');
    if (available === true) return t('auth.usernameSetup.available');
    if (available === false) return t('auth.usernameSetup.taken');
    return null;
  };

  const statusText = getStatusText();

  return (
    <div className="username-setup-overlay">
      <div className="username-setup-modal">
        <h2 className="username-setup-modal__title">{t('auth.usernameSetup.title')}</h2>

        <div className="username-setup-modal__field">
          <label className="username-setup-modal__label" htmlFor="username-setup-input">
            {t('auth.usernameSetup.label')}
          </label>
          <input
            id="username-setup-input"
            className="username-setup-modal__input"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('auth.usernameSetup.placeholder')}
            autoComplete="off"
            autoFocus
            maxLength={20}
          />
          {statusText && (
            <span
              className={`username-setup-modal__status ${
                available === true
                  ? 'username-setup-modal__status--available'
                  : available === false
                    ? 'username-setup-modal__status--taken'
                    : ''
              }`}
            >
              {statusText}
            </span>
          )}
          {username && !isValid && (
            <span className="username-setup-modal__status username-setup-modal__status--taken">
              {t('auth.usernameSetup.errorInvalid')}
            </span>
          )}
        </div>

        {saveError && (
          <p className="username-setup-modal__error">{saveError}</p>
        )}

        <button
          className="username-setup-modal__save-btn"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? t('auth.usernameSetup.saving') : t('auth.usernameSetup.save')}
        </button>
      </div>
    </div>
  );
}
