import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

type Comment = { id: string; message: string; user?: { username: string } | null; createdAt: string };
type FeedbackDetail = {
  id: string; title: string | null; type: string; status: string; message: string;
  votes: number; voted: boolean; email?: string;
  user?: { username: string } | null; createdAt: string;
  comments: Comment[];
};

const TYPE_ICONS: Record<string, string> = { bug: '\uD83D\uDC1B', suggestion: '\uD83D\uDCA1', question: '\u2753' };
const STATUS_COLORS: Record<string, string> = { open: '#3b82f6', planned: '#f59e0b', 'in-progress': '#8b5cf6', done: '#4ade80', declined: '#64748b' };

export function FeedbackDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [post, setPost] = useState<FeedbackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);

  const fetchPost = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api.get<FeedbackDetail>(`/api/feedback/${id}`);
      setPost(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchPost(); }, [fetchPost]);

  const handleVote = async () => {
    if (!post || !user) return;
    try {
      const res = await api.post<{ votes: number; voted: boolean }>(`/api/feedback/${post.id}/vote`, {});
      setPost((p) => p ? { ...p, votes: res.votes, voted: res.voted } : p);
    } catch { /* ignore */ }
  };

  const handleComment = async () => {
    if (!post || !commentText.trim() || sending) return;
    setSending(true);
    try {
      await api.post(`/api/feedback/${post.id}/comments`, { message: commentText.trim() });
      setCommentText('');
      fetchPost();
    } catch { /* ignore */ }
    setSending(false);
  };

  if (loading) return <div className="fb-detail-page"><p>{t('common.loading')}</p></div>;
  if (!post) return <div className="fb-detail-page"><p>Not found</p></div>;

  return (
    <div className="fb-detail-page">
      <Link to="/feedback" className="back-nav-link">&larr; {t('feedbackBoard.title', 'Feedback')}</Link>

      <div className="fb-detail-card">
        <div className="fb-detail-header">
          <button className={`fb-vote-btn fb-vote-btn--lg${post.voted ? ' voted' : ''}`} onClick={handleVote} disabled={!user}>
            <span className="fb-vote-arrow">&#9650;</span>
            <span className="fb-vote-count">{post.votes}</span>
          </button>
          <div>
            <h1 className="fb-detail-title">
              <span>{TYPE_ICONS[post.type] || ''}</span> {post.title || post.message.slice(0, 80)}
            </h1>
            <div className="fb-detail-meta">
              <span className="fb-post-status" style={{ background: STATUS_COLORS[post.status] || '#64748b' }}>{post.status}</span>
              <span>{post.user?.username || t('feedbackBoard.anonymous', 'Anonymous')}</span>
              <span>{new Date(post.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
        <div className="fb-detail-message">{post.message}</div>
      </div>

      <div className="fb-comments-section">
        <h2>{t('feedbackBoard.comments', 'Comments')} ({post.comments.length})</h2>
        {post.comments.map((c) => (
          <div key={c.id} className="fb-comment">
            <div className="fb-comment-meta">
              <strong>{c.user?.username || t('feedbackBoard.anonymous', 'Anonymous')}</strong>
              <span>{new Date(c.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="fb-comment-body">{c.message}</div>
          </div>
        ))}

        {user && (
          <div className="fb-comment-form">
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={t('feedbackBoard.addComment', 'Add a comment...')}
              rows={3}
            />
            <button onClick={handleComment} disabled={!commentText.trim() || sending}>
              {sending ? t('common.loading') : t('feedback.send', 'Send')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
