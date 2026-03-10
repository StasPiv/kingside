import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const location = useLocation();
  const returnUrl = (location.state as { returnUrl?: string })?.returnUrl || '/lobby';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate(returnUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.login.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>{t('auth.login.title')}</h1>
        {error && <div className="error">{error}</div>}
        <input
          type="text"
          placeholder={t('auth.login.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={t('auth.login.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? t('auth.login.submitting') : t('auth.login.submit')}
        </button>
        <p>
          {t('auth.login.noAccount')} <Link to="/register">{t('auth.login.registerLink')}</Link>
        </p>
      </form>
    </div>
  );
}
