import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { FeedbackModal } from '../components/FeedbackModal';

type FeedbackPost = {
  id: string;
  title: string | null;
  type: string;
  status: string;
  message: string;
  voteCount: number;
  upCount: number;
  downCount: number;
  voted: 'up' | 'down' | null;
  commentCount: number;
  user?: { username: string } | null;
  createdAt: string;
};

const TYPE_ICONS: Record<string, string> = { bug: '\uD83D\uDC1B', suggestion: '\uD83D\uDCA1', question: '\u2753' };
const STATUS_COLORS: Record<string, string> = { open: '#3b82f6', planned: '#f59e0b', 'in-progress': '#8b5cf6', done: '#4ade80', declined: '#64748b' };
const PAGE_SIZE = 20;

export function FeedbackBoardPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [posts, setPosts] = useState<FeedbackPost[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), sort });
      if (type) params.set('type', type);
      if (status) params.set('status', status);
      const data = await api.get<{ data: FeedbackPost[]; total: number }>(`/api/feedback?${params}`);
      setPosts(data.data ?? []);
      setTotal(data.total ?? 0);
    } catch { setPosts([]); }
    setLoading(false);
  }, [page, type, status, sort]);

  useEffect(() => { fetchPosts(); }, [fetchPosts]);

  const handleVote = async (id: string, direction: 'up' | 'down') => {
    try {
      const res = await api.post<{ voteCount: number; upCount: number; downCount: number; voted: 'up' | 'down' | null }>(`/api/feedback/${id}/vote`, { direction });
      setPosts((prev) => prev.map((p) => p.id === id ? { ...p, voteCount: res.voteCount, upCount: res.upCount, downCount: res.downCount, voted: res.voted } : p));
    } catch { /* ignore */ }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="fb-board-page">
      <div className="fb-board-header">
        <h1>{t('feedbackBoard.title', 'Feedback & Ideas')}</h1>
        {user && <button className="fb-new-btn" onClick={() => setShowModal(true)}>+ {t('feedbackBoard.newPost', 'New Post')}</button>}
      </div>

      <div className="fb-filters">
        <select value={type} onChange={(e) => { setType(e.target.value); setPage(0); }}>
          <option value="">{t('feedbackBoard.allTypes', 'All types')}</option>
          <option value="bug">{TYPE_ICONS.bug} {t('feedback.type_bug', 'Bug')}</option>
          <option value="suggestion">{TYPE_ICONS.suggestion} {t('feedback.type_suggestion', 'Suggestion')}</option>
          <option value="question">{TYPE_ICONS.question} {t('feedback.type_question', 'Question')}</option>
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">{t('feedbackBoard.allStatuses', 'All statuses')}</option>
          <option value="open">{t('feedbackBoard.statusOpen', 'Open')}</option>
          <option value="planned">{t('feedbackBoard.statusPlanned', 'Planned')}</option>
          <option value="in-progress">{t('feedbackBoard.statusInProgress', 'In Progress')}</option>
          <option value="done">{t('feedbackBoard.statusDone', 'Done')}</option>
          <option value="declined">{t('feedbackBoard.statusDeclined', 'Declined')}</option>
        </select>
        <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }}>
          <option value="newest">{t('feedbackBoard.sortNewest', 'Newest')}</option>
          <option value="popular">{t('feedbackBoard.sortPopular', 'Most voted')}</option>
        </select>
      </div>

      {loading ? (
        <p className="fb-loading">{t('common.loading')}</p>
      ) : posts.length === 0 ? (
        <p className="fb-empty">{t('feedbackBoard.empty', 'No posts yet. Be the first!')}</p>
      ) : (
        <div className="fb-list">
          {posts.map((post) => (
            <div key={post.id} className="fb-post-card">
              <div className="fb-vote-group">
                <button className={`fb-vote-btn${post.voted === 'up' ? ' voted' : ''}`} onClick={() => handleVote(post.id, 'up')} disabled={!user}>
                  <span className="fb-vote-arrow">&#9650;</span>
                  <span className="fb-vote-count fb-vote-count--up">+{post.upCount ?? 0}</span>
                </button>
                <button className={`fb-vote-btn fb-vote-btn--down${post.voted === 'down' ? ' voted-down' : ''}`} onClick={() => handleVote(post.id, 'down')} disabled={!user}>
                  <span className="fb-vote-arrow">&#9660;</span>
                  <span className="fb-vote-count fb-vote-count--down">-{post.downCount ?? 0}</span>
                </button>
              </div>
              <div className="fb-post-body">
                <Link to={`/feedback/${post.id}`} className="fb-post-title">
                  <span className="fb-post-type">{TYPE_ICONS[post.type] || ''}</span>
                  {post.title || post.message.slice(0, 60)}
                </Link>
                <div className="fb-post-meta">
                  <span className="fb-post-status" style={{ background: STATUS_COLORS[post.status] || '#64748b' }}>{post.status}</span>
                  <span>{post.user?.username || t('feedbackBoard.anonymous', 'Anonymous')}</span>
                  <span>{new Date(post.createdAt).toLocaleDateString()}</span>
                  <span>{post.commentCount} {t('feedbackBoard.comments', 'comments')}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="puzzle-pagination">
          <button disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>{t('puzzleBrowser.prev', 'Prev')}</button>
          <span className="puzzle-pagination__info">{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>{t('puzzleBrowser.next', 'Next')}</button>
        </div>
      )}

      {showModal && <FeedbackModal onClose={() => { setShowModal(false); fetchPosts(); }} />}
    </div>
  );
}
