/**
 * KS-4343 / ADR-135 §2.5. Страница solve одного пазла раздела «Точность»
 * на новой схеме `tactic_puzzles`. Маршрут `/tactic-puzzles/:id`.
 *
 * Логика:
 *   1. Если есть `:id` — загружаем пазл через `/tactic-puzzles/:id`.
 *   2. Иначе — `/tactic-puzzles/next` (авто-подбор, JWT).
 *   3. Передаём в `TacticPuzzleRunner`. На submit отправляем attempt,
 *      затем загружаем следующий пазл (auto-pick).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TacticPuzzleResponse } from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import {
  TacticPuzzleRunner,
  type TacticPuzzleRunnerSubmit,
} from '../components/puzzle/TacticPuzzleRunner';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

export function SolveTacticPuzzlePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [puzzle, setPuzzle] = useState<TacticPuzzleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPuzzle = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPuzzle(null);
    try {
      const next = id
        ? await tacticPuzzleApi.getById(id)
        : await tacticPuzzleApi.pickNext();
      if (!next) {
        setError(
          t(
            'tacticPuzzle.solveError.noPuzzle',
            'No puzzles available right now.',
          ),
        );
      } else {
        setPuzzle(next);
      }
    } catch {
      setError(
        t('tacticPuzzle.solveError.generic', 'Could not load puzzle.'),
      );
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void loadPuzzle();
  }, [loadPuzzle]);

  const handleSubmit = useCallback(
    async (data: TacticPuzzleRunnerSubmit) => {
      if (!puzzle) return;
      // Гостям не отправляем attempt (JWT обязателен на backend).
      if (!user) return;
      try {
        await tacticPuzzleApi.submitAttempt(puzzle.id, {
          lineHalfMoves: data.lineHalfMoves,
          userMoves: data.userMoves,
          stopReason: data.stopReason,
          timeMs: data.timeMs,
          wdlStart: data.wdlStart,
          wdlEnd: data.wdlEnd,
        });
      } catch (e) {
        console.warn('SolveTacticPuzzlePage: submitAttempt failed', e);
      }
    },
    [puzzle, user],
  );

  const handleNext = useCallback(async () => {
    try {
      const next = await tacticPuzzleApi.pickNext();
      if (next) {
        navigate(`/tactic-puzzles/${next.id}`);
      } else {
        navigate('/tactic-puzzles');
      }
    } catch {
      navigate('/tactic-puzzles');
    }
  }, [navigate]);

  const handleBack = useCallback(() => {
    navigate('/tactic-puzzles');
  }, [navigate]);

  return (
    <div
      className="tactic-puzzle-solve"
      data-testid="tactic-puzzle-solve"
      data-state={loading ? 'loading' : error ? 'error' : 'ready'}
    >
      <PageSeo ns="tacticPuzzle.solve" path="/tactic-puzzles" />
      {loading && (
        <p data-testid="tactic-puzzle-solve-loading">
          {t('common.loading', 'Loading…')}
        </p>
      )}
      {error && !loading && (
        <div
          className="tactic-puzzle-solve__error"
          data-testid="tactic-puzzle-solve-error"
        >
          <p>{error}</p>
          <button type="button" onClick={() => void loadPuzzle()}>
            {t('common.retry', 'Retry')}
          </button>
          <button type="button" onClick={handleBack}>
            {t('common.back', 'Back')}
          </button>
        </div>
      )}
      {puzzle && (
        <TacticPuzzleRunner
          key={puzzle.id}
          puzzle={puzzle}
          onSubmit={handleSubmit}
          onNext={handleNext}
          onBack={handleBack}
        />
      )}
    </div>
  );
}
