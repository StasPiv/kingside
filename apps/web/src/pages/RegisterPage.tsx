import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(t('auth.register.passwordMismatch'));
      return;
    }

    setLoading(true);
    try {
      await register(username, email, password);
      navigate('/lobby');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.register.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>{t('auth.register.title')}</h1>
        {error && <div className="error">{error}</div>}
        <input
          type="text"
          placeholder={t('auth.register.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          maxLength={20}
          pattern="^[a-zA-Z0-9_]+$"
        />
        <input
          type="email"
          placeholder={t('auth.register.email')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={t('auth.register.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <input
          type="password"
          placeholder={t('auth.register.confirmPassword')}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? t('auth.register.submitting') : t('auth.register.submit')}
        </button>
        <p>
          {t('auth.register.hasAccount')} <Link to="/login">{t('auth.register.loginLink')}</Link>
        </p>
      </form>
    </div>
  );
}
