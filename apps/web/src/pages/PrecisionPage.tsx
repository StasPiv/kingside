import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { api } from '../api';

/**
 * KS-2484 (ADR-044) — список play-vs-engine пазлов.
 *
 * Backend API (rev:113, KS-2472) принимает фильтр
 * `solutionMode=play-vs-engine` и возвращает массив пазлов с полем
 * `playVsEngine: { blunderMove, wdlAfterBlunder, winThreshold,
 * failThreshold, halfMovesN }`. На текущий момент таких пазлов в
 * генерации мало (~единицы) — фоновое заполнение KS-2466 ещё идёт.
 *
 * Минимальный UI: карточки с мини-доской (FEN-превью), темой,
 * рейтингом, кликом на `/puzzle/:id`. Если пазлов нет — плейсхолдер.
 *
 * # DOM
 *
 *   <div class="play-vs-engine-puzzles" data-testid="play-vs-engine-puzzles"
 *        data-state="loading|ready|empty|error">
 *     <h1>…</h1>
 *     <p class="play-vs-engine-puzzles__intro">…</p>
 *     <div class="play-vs-engine-puzzles__list">
 *       <article data-testid="play-vs-engine-card" data-puzzle-id="…" />
 *       …
 *     </div>
 *   </div>
 */

interface PlayVsEnginePuzzleDto {
  id: string;
  fen: string;
  rating: number;
  themes: string[];
  source: string;
  solutionMode: 'play-vs-engine';
  playVsEngine?: {
    blunderMove?: string;
    wdlAfterBlunder?: number;
    winThreshold?: number;
    failThreshold?: number;
    halfMovesN?: number;
  };
}

const LIMIT = 20;

/** Сторона на ходу из FEN — для ориентации мини-доски (нижняя сторона). */
function sideFromFen(fen: string): 'white' | 'black' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'black' : 'white';
}

// KS-2542 (ADR-048): компонент переименован `PlayVsEnginePuzzlesPage`
// → `PrecisionPage` после переезда на роут `/precision`. Внутренние
// CSS-классы и testid'ы пока сохраняем — они не часть API.
export function PrecisionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [puzzles, setPuzzles] = useState<PlayVsEnginePuzzleDto[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>(
    'loading',
  );

  const fetchPuzzles = useCallback(async () => {
    setState('loading');
    try {
      const data = await api.get<PlayVsEnginePuzzleDto[]>(
        `/puzzles?solutionMode=play-vs-engine&limit=${LIMIT}`,
      );
      const list = Array.isArray(data) ? data : [];
      setPuzzles(list);
      setState(list.length === 0 ? 'empty' : 'ready');
    } catch {
      setPuzzles([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void fetchPuzzles();
  }, [fetchPuzzles]);

  return (
    <div
      className="play-vs-engine-puzzles"
      data-testid="play-vs-engine-puzzles"
      data-state={state}
    >
      <header className="play-vs-engine-puzzles__header">
        <h1>{t('puzzles.playVsEngine.title', 'Play vs Engine puzzles')}</h1>
        <p className="play-vs-engine-puzzles__intro">
          {t(
            'puzzles.playVsEngine.intro',
            'Practice positions where a Stockfish-strong engine punishes mistakes. Find the precise sequence and outplay the machine.',
          )}
        </p>
        <div className="play-vs-engine-puzzles__nav">
          <Link to="/puzzles" className="play-vs-engine-puzzles__back-link">
            ← {t('puzzles.playVsEngine.backToAll', 'All puzzles')}
          </Link>
        </div>
      </header>

      {state === 'loading' && (
        <p
          className="play-vs-engine-puzzles__status"
          data-testid="play-vs-engine-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {state === 'error' && (
        <div
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
          data-testid="play-vs-engine-error"
        >
          <p>{t('puzzles.playVsEngine.loadError', 'Could not load puzzles.')}</p>
          <button type="button" onClick={() => void fetchPuzzles()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {state === 'empty' && (
        <p
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--empty"
          data-testid="play-vs-engine-empty"
        >
          {t(
            'puzzles.playVsEngine.empty',
            'No play-vs-engine puzzles yet — the generator is still filling the bank. Check back soon.',
          )}
        </p>
      )}

      {state === 'ready' && (
        <div className="play-vs-engine-puzzles__list">
          {puzzles.map((p) => {
            const orientation = sideFromFen(p.fen);
            const onClick = () =>
              navigate(`/puzzle/${p.id}?source=play-vs-engine`);
            return (
              <article
                key={p.id}
                className="play-vs-engine-card"
                data-testid="play-vs-engine-card"
                data-puzzle-id={p.id}
              >
                <button
                  type="button"
                  className="play-vs-engine-card__board-btn"
                  onClick={onClick}
                  aria-label={t('puzzles.playVsEngine.openPuzzle', 'Open puzzle')}
                >
                  <Chessboard
                    options={{
                      position: p.fen,
                      boardOrientation: orientation,
                      animationDurationInMs: 0,
                      allowDragging: false,
                      showNotation: false,
                    }}
                  />
                </button>
                <div className="play-vs-engine-card__body">
                  <div className="play-vs-engine-card__title">
                    {t('puzzles.playVsEngine.cardTitle', '#{{id}}', {
                      id: p.id.slice(0, 8),
                    })}
                  </div>
                  <div className="play-vs-engine-card__themes">
                    {p.themes.slice(0, 3).map((theme) => (
                      <span
                        key={theme}
                        className="play-vs-engine-card__theme-tag"
                        data-testid="play-vs-engine-card-theme"
                      >
                        {t(`puzzleBrowser.themes.${theme}`, theme)}
                      </span>
                    ))}
                  </div>
                  <div className="play-vs-engine-card__meta">
                    <span
                      className="play-vs-engine-card__rating"
                      data-testid="play-vs-engine-card-rating"
                    >
                      {t('puzzleBrowser.yourRating', 'Puzzle rating: {{rating}}', {
                        rating: p.rating,
                      })}
                    </span>
                    <span
                      className="play-vs-engine-card__side"
                      data-side={orientation}
                    >
                      {orientation === 'white'
                        ? t('drills.side.whiteToMove', 'White to move')
                        : t('drills.side.blackToMove', 'Black to move')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="play-vs-engine-card__solve-btn"
                    data-testid="play-vs-engine-card-solve"
                    onClick={onClick}
                  >
                    {t('puzzleBrowser.solve', 'Solve')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
