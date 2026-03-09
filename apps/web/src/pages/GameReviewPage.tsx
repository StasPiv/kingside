import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { MemoChessboard } from '../components/MemoChessboard';
import { useStablePosition } from '../hooks/useStablePosition';
import { useContainerWidth } from '../hooks/useContainerWidth';
import { INITIAL_FEN } from '@kingside/shared';
import { api } from '../api';

type GameData = {
  id: string;
  white: { id: string; username: string };
  black: { id: string; username: string };
  result: string;
  timeControl: string;
  status: string;
};

type MoveData = {
  san: string;
  uci: string;
  fen: string;
};

export function GameReviewPage() {
  const { id: gameId } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [gameData, setGameData] = useState<GameData | null>(null);
  const [moves, setMoves] = useState<MoveData[]>([]);
  const [currentMoveIndex, setCurrentMoveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const boardWidth = useContainerWidth(boardContainerRef);
  const movesEndRef = useRef<HTMLDivElement>(null);

  const game = useMemo(() => new Chess(), []);

  useEffect(() => {
    if (!gameId) return;

    const fetchData = async () => {
      try {
        const [gData, mData] = await Promise.all([
          api.get<GameData>(`/api/games/${gameId}`),
          api.get<MoveData[]>(`/api/games/${gameId}/moves`),
        ]);
        setGameData(gData);
        setMoves(mData);
        setCurrentMoveIndex(mData.length - 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('review.loadError'));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [gameId, t]);

  const currentFen = useMemo(() => {
    if (currentMoveIndex < 0) return INITIAL_FEN;
    return moves[currentMoveIndex]?.fen ?? INITIAL_FEN;
  }, [currentMoveIndex, moves]);

  useEffect(() => {
    game.load(currentFen);
  }, [currentFen, game]);

  const goToStart = useCallback(() => setCurrentMoveIndex(-1), []);
  const goToEnd = useCallback(() => setCurrentMoveIndex(moves.length - 1), [moves.length]);
  const goBack = useCallback(() => setCurrentMoveIndex((i) => Math.max(-1, i - 1)), []);
  const goForward = useCallback(() => setCurrentMoveIndex((i) => Math.min(moves.length - 1, i + 1)), [moves.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToStart();
      } else if (e.key === 'End') {
        e.preventDefault();
        goToEnd();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goBack, goForward, goToStart, goToEnd]);

  useEffect(() => {
    const activeMove = document.querySelector('.review-move.active');
    if (activeMove) {
      activeMove.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentMoveIndex]);

  const stablePosition = useStablePosition(currentFen);

  const boardStyle = useMemo(
    () => (boardWidth > 0 ? { width: boardWidth, height: boardWidth } : undefined),
    [boardWidth],
  );

  const boardOptions = useMemo(
    () => ({
      position: stablePosition,
      boardOrientation: 'white' as const,
      animationDurationInMs: 200,
      allowDragging: false,
      ...(boardStyle && { boardStyle }),
    }),
    [stablePosition, boardStyle],
  );

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  if (!gameData) return null;

  const resultText = gameData.result === 'draw'
    ? t('game.draw')
    : gameData.result === 'white_wins'
      ? t('game.whiteWins')
      : t('game.blackWins');

  return (
    <div className="game-page">
      <div className="game-board-area">
        <div className="player-info opponent-info">
          <span className="color-indicator black" />
          <span className="player-name">{gameData.black.username}</span>
        </div>
        <div className="board-container" ref={boardContainerRef}>
          <MemoChessboard options={boardOptions} />
        </div>
        <div className="player-info player-info-self">
          <span className="color-indicator white" />
          <span className="player-name">{gameData.white.username}</span>
        </div>
      </div>

      <div className="game-sidebar">
        <div className="game-result">
          <h3>{t('game.finished')}</h3>
          <p>{resultText}</p>
          <span className="game-tc">{gameData.timeControl}</span>
        </div>

        <div className="move-list">
          <h3>{t('game.moves')}</h3>
          <div className="review-moves">
            {moves.map((move, i) =>
              i % 2 === 0 ? (
                <div key={i} className="move-pair">
                  <span className="move-number">{Math.floor(i / 2) + 1}.</span>
                  <span
                    className={`review-move${currentMoveIndex === i ? ' active' : ''}`}
                    onClick={() => setCurrentMoveIndex(i)}
                  >
                    {move.san}
                  </span>
                  {moves[i + 1] && (
                    <span
                      className={`review-move${currentMoveIndex === i + 1 ? ' active' : ''}`}
                      onClick={() => setCurrentMoveIndex(i + 1)}
                    >
                      {moves[i + 1].san}
                    </span>
                  )}
                </div>
              ) : null,
            )}
            <div ref={movesEndRef} />
          </div>
        </div>

        <div className="review-controls">
          <button onClick={goToStart} disabled={currentMoveIndex < 0} title={t('review.toStart')}>
            &#x23EE;
          </button>
          <button onClick={goBack} disabled={currentMoveIndex < 0} title={t('review.back')}>
            &#x25C0;
          </button>
          <button onClick={goForward} disabled={currentMoveIndex >= moves.length - 1} title={t('review.forward')}>
            &#x25B6;
          </button>
          <button onClick={goToEnd} disabled={currentMoveIndex >= moves.length - 1} title={t('review.toEnd')}>
            &#x23ED;
          </button>
        </div>

        <Link to="/profile" className="review-back-link">{t('review.backToProfile')}</Link>
      </div>
    </div>
  );
}
