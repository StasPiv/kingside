import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

type PuzzleRushStatus = 'idle' | 'playing' | 'finished';

type RushPuzzle = {
  id: string;
  fen: string;
  moves: string;
  rating: number;
};

type RushSession = {
  id: string;
  solved: number;
  failed: number;
  timeLimitSec: number;
  startedAt: string;
  finishedAt: string | null;
};

type RushHighScore = {
  solved: number;
  date: string;
};

const TIME_LIMITS = [3 * 60, 5 * 60, 10 * 60];
const MAX_FAILURES = 3;

export function PuzzleRushPage() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [status, setStatus] = useState<PuzzleRushStatus>('idle');
  const [timeLimit, setTimeLimit] = useState(5 * 60);
  const [timeLeft, setTimeLeft] = useState(5 * 60);
  const [solved, setSolved] = useState(0);
  const [failed, setFailed] = useState(0);
  const [currentPuzzle, setCurrentPuzzle] = useState<RushPuzzle | null>(null);
  const [moveIndex, setMoveIndex] = useState(0);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [highScores, setHighScores] = useState<RushHighScore[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadHighScores = useCallback(async () => {
    try {
      const data = await api.get<RushHighScore[]>('/api/puzzles/rush/highscores');
      setHighScores(data);
    } catch {
      // API may not be available yet
    }
  }, []);

  useEffect(() => {
    loadHighScores();
  }, [loadHighScores]);

  useEffect(() => {
    if (status === 'playing' && timeLeft > 0) {
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            setStatus('finished');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [status, timeLeft > 0]);

  const fetchNextPuzzle = useCallback(async () => {
    try {
      const puzzle = await api.get<RushPuzzle>('/api/puzzles/rush/next');
      setCurrentPuzzle(puzzle);
      setMoveIndex(0);
      setSelectedSquare(null);
      setFeedback(null);
    } catch {
      setError(t('puzzleRush.errorLoading'));
    }
  }, [t]);

  const handleStart = async () => {
    setError(null);
    try {
      const session = await api.post<RushSession>('/api/puzzles/rush/start', {
        timeLimitSec: timeLimit,
      });
      setSessionId(session.id);
      setSolved(0);
      setFailed(0);
      setTimeLeft(timeLimit);
      setStatus('playing');
      await fetchNextPuzzle();
    } catch {
      setError(t('puzzleRush.errorStarting'));
    }
  };

  const endSession = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setStatus('finished');
    if (sessionId) {
      try {
        await api.post(`/api/puzzles/rush/${sessionId}/finish`, {});
        await loadHighScores();
      } catch {
        // ignore
      }
    }
  }, [sessionId, loadHighScores]);

  const handleMove = async (from: string, to: string) => {
    if (!currentPuzzle || status !== 'playing') return;

    const moves = currentPuzzle.moves.split(' ');
    const expectedMove = moves[moveIndex];

    if (!expectedMove) return;

    const userMove = `${from}${to}`;

    if (userMove === expectedMove) {
      setFeedback('correct');
      const nextIndex = moveIndex + 1;

      if (nextIndex >= moves.length) {
        const newSolved = solved + 1;
        setSolved(newSolved);
        try {
          await api.post(`/api/puzzles/rush/${sessionId}/attempt`, {
            puzzleId: currentPuzzle.id,
            solved: true,
          });
        } catch {
          // ignore
        }
        setTimeout(() => fetchNextPuzzle(), 500);
      } else {
        setMoveIndex(nextIndex);
        setSelectedSquare(null);
      }
    } else {
      setFeedback('wrong');
      const newFailed = failed + 1;
      setFailed(newFailed);
      try {
        await api.post(`/api/puzzles/rush/${sessionId}/attempt`, {
          puzzleId: currentPuzzle.id,
          solved: false,
        });
      } catch {
        // ignore
      }
      if (newFailed >= MAX_FAILURES) {
        setTimeout(() => endSession(), 500);
      } else {
        setTimeout(() => fetchNextPuzzle(), 500);
      }
    }
  };

  const handleSquareClick = (square: string) => {
    if (status !== 'playing') return;
    if (selectedSquare) {
      handleMove(selectedSquare, square);
      setSelectedSquare(null);
    } else {
      setSelectedSquare(square);
    }
  };

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handlePlayAgain = () => {
    setStatus('idle');
    setCurrentPuzzle(null);
    setSessionId(null);
    setFeedback(null);
    setError(null);
  };

  return (
    <div className="puzzle-rush-page">
      <h1>{t('puzzleRush.title')}</h1>

      {status === 'idle' && (
        <div className="puzzle-rush-setup">
          <p className="puzzle-rush-description">{t('puzzleRush.description')}</p>

          <div className="puzzle-rush-time-select">
            <h3>{t('puzzleRush.selectTime')}</h3>
            <div className="time-controls">
              {TIME_LIMITS.map((limit) => (
                <button
                  key={limit}
                  className={`tc-btn ${timeLimit === limit ? 'active' : ''}`}
                  onClick={() => setTimeLimit(limit)}
                >
                  {formatTime(limit)}
                </button>
              ))}
            </div>
          </div>

          {highScores.length > 0 && (
            <div className="puzzle-rush-highscores">
              <h3>{t('puzzleRush.highScores')}</h3>
              <div className="highscore-list">
                {highScores.map((hs, i) => (
                  <div key={i} className="highscore-item">
                    <span className="highscore-rank">#{i + 1}</span>
                    <span className="highscore-solved">{hs.solved}</span>
                    <span className="highscore-date">{new Date(hs.date).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="play-btn" onClick={handleStart}>
            {t('puzzleRush.start')}
          </button>

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {status === 'playing' && (
        <div className="puzzle-rush-game">
          <div className="puzzle-rush-header">
            <div className="puzzle-rush-timer">
              <span className={`rush-time ${timeLeft <= 30 ? 'rush-time-low' : ''}`}>
                {formatTime(timeLeft)}
              </span>
            </div>
            <div className="puzzle-rush-score">
              <span className="rush-solved">{solved}</span>
              <span className="rush-separator">/</span>
              <span className="rush-failed">
                {failed}/{MAX_FAILURES}
              </span>
            </div>
          </div>

          {currentPuzzle && (
            <div className="puzzle-rush-board">
              <div className="puzzle-info">
                <span className="puzzle-rating">
                  {t('puzzleRush.rating', { rating: currentPuzzle.rating })}
                </span>
              </div>
              <div
                className="board-container puzzle-board-placeholder"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = Math.floor(((e.clientX - rect.left) / rect.width) * 8);
                  const y = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
                  const file = String.fromCharCode(97 + x);
                  const rank = String(8 - y);
                  handleSquareClick(`${file}${rank}`);
                }}
              >
                <div className="puzzle-fen-display">{currentPuzzle.fen}</div>
              </div>
              {feedback && (
                <div className={`puzzle-feedback ${feedback}`}>
                  {feedback === 'correct'
                    ? t('puzzleRush.correct')
                    : t('puzzleRush.wrong')}
                </div>
              )}
            </div>
          )}

          {error && <p className="error">{error}</p>}
        </div>
      )}

      {status === 'finished' && (
        <div className="puzzle-rush-result">
          <h2>{t('puzzleRush.finished')}</h2>
          <div className="rush-final-score">
            <div className="rush-score-big">{solved}</div>
            <div className="rush-score-label">{t('puzzleRush.puzzlesSolved')}</div>
          </div>
          <div className="rush-stats">
            <div className="rush-stat">
              <span className="rush-stat-value">{failed}</span>
              <span className="rush-stat-label">{t('puzzleRush.mistakes')}</span>
            </div>
            <div className="rush-stat">
              <span className="rush-stat-value">{formatTime(timeLimit - timeLeft)}</span>
              <span className="rush-stat-label">{t('puzzleRush.timeUsed')}</span>
            </div>
          </div>
          <button className="play-btn" onClick={handlePlayAgain}>
            {t('puzzleRush.playAgain')}
          </button>
        </div>
      )}
    </div>
  );
}
