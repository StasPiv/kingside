import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

type FeedbackType = 'bug' | 'suggestion' | 'question';

interface FeedbackModalProps {
  onClose: () => void;
}

export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<FeedbackType>('suggestion');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setSending(true);
    setError('');
    try {
      await api.post('/api/feedback', {
        type,
        message: message.trim(),
        email: email.trim() || undefined,
        page: window.location.pathname,
        userAgent: navigator.userAgent,
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('feedback.error', 'Failed to send'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content feedback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('feedback.title', 'Feedback')}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        {sent ? (
          <div className="feedback-success">
            <p>{t('feedback.thanks', 'Thank you! We received your message.')}</p>
            <button className="feedback-done-btn" onClick={onClose}>OK</button>
          </div>
        ) : (
          <div className="feedback-form">
            <div className="feedback-field">
              <label>{t('feedback.type', 'Type')}</label>
              <div className="feedback-type-btns">
                {(['bug', 'suggestion', 'question'] as FeedbackType[]).map((tp) => (
                  <button
                    key={tp}
                    className={`feedback-type-btn${type === tp ? ' active' : ''}`}
                    onClick={() => setType(tp)}
                  >
                    {tp === 'bug' ? '🐛' : tp === 'suggestion' ? '💡' : '❓'}
                    {' '}
                    {t(`feedback.type_${tp}`, tp)}
                  </button>
                ))}
              </div>
            </div>

            <div className="feedback-field">
              <label>{t('feedback.email', 'Email (optional)')}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('feedback.emailPlaceholder', 'your@email.com')}
              />
            </div>

            <div className="feedback-field">
              <label>{t('feedback.message', 'Message')}</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('feedback.messagePlaceholder', 'Describe your issue or suggestion...')}
                rows={5}
              />
            </div>

            {error && <div className="feedback-error">{error}</div>}

            <button
              className="feedback-submit-btn"
              onClick={handleSubmit}
              disabled={!message.trim() || sending}
            >
              {sending ? t('common.loading') : t('feedback.send', 'Send')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
