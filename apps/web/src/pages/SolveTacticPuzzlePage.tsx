/**
 * KS-4343 → KS-4346 → KS-4347 / ADR-135 §2.5. Страница решения одного
 * пазла раздела «Точность». Маршрут `/tactic-puzzles/:id`.
 *
 * Логика:
 *   1. Если есть `:id` — загружаем пазл через `/tactic-puzzles/:id`.
 *   2. Иначе — `/tactic-puzzles/next` (авто-подбор, JWT).
 *   3. Передаём в `TacticPuzzleRunner`. На submit отправляем attempt,
 *      затем загружаем следующий пазл (auto-pick).
 *
 * KS-4347. По образцу `/precision/:id` (PuzzlePage + PuzzleSourceGame):
 *   - хлебные крошки «Главная / Точность / Задача #...»;
 *   - чип «Сложность %» над доской (`puzzle.difficulty * 100`);
 *   - блок «Из партии» под доской с именами/ELO/событием/датой/результатом
 *     и ссылкой «Открыть в архиве» (адаптер `sourceHeaders` →
 *     `PuzzleSourceGameDto`, чтобы переиспользовать готовый компонент);
 *   - кнопка «Открыть в мастерской» рядом с «Сдаться» — отправляет
 *     попытку как `aborted` и переходит на `/analysis?fen=...`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  PuzzleSourceGame as PuzzleSourceGameDto,
  TacticPuzzleResponse,
} from '@kingside/shared';
import { useAuth } from '../context/AuthContext';
import { PageSeo } from '../components/seo/PageSeo';
import {
  TacticPuzzleRunner,
  type TacticPuzzleRunnerSubmit,
} from '../components/puzzle/TacticPuzzleRunner';
import { PuzzleSourceGame } from '../components/puzzle/PuzzleSourceGame';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';

/**
 * KS-4347. Адаптер `TacticPuzzleResponse.sourceHeaders` (PGN-headers) →
 * `PuzzleSourceGameDto`. Поля PGN-headers могут отсутствовать, формат
 * `Result` уже PGN-стандартный (`1-0` / `0-1` / `1/2-1/2`). ELO в шапку
 * не пишем — у `PuzzleSourceGameDto` нет поля, а добавление ломает
 * единый стиль с `/precision`; ELO видно на каталоге.
 */
function buildSourceGame(
  puzzle: TacticPuzzleResponse,
): PuzzleSourceGameDto | undefined {
  const h = puzzle.sourceHeaders;
  if (!h && !puzzle.sourceGameId) return undefined;
  return {
    white: h?.White ?? undefined,
    black: h?.Black ?? undefined,
    event: h?.Event ?? undefined,
    date: h?.Date ?? undefined,
    result: h?.Result ?? undefined,
    archiveGameId: puzzle.sourceGameId ?? undefined,
  };
}

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

  /**
   * KS-4347. «Открыть в мастерской». Шаги:
   *   1) Отправляем attempt с `stopReason='aborted'` (как «Сдаться»).
   *   2) Переходим на `/analysis?fen=<puzzle.fen>` — в мастерской
   *      откроется ровно стартовая позиция пазла.
   * Submit не блокирует переход: если упал — логируем, пользователь
   * всё равно попадает в мастерскую.
   */
  const handleOpenWorkshop = useCallback(
    async (data: TacticPuzzleRunnerSubmit) => {
      if (!puzzle) return;
      if (user) {
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
          console.warn('SolveTacticPuzzlePage: workshop submit failed', e);
        }
      }
      navigate(`/analysis?fen=${encodeURIComponent(puzzle.fen)}`);
    },
    [puzzle, user, navigate],
  );

  const puzzleShortId = puzzle ? puzzle.id.slice(0, 8) : '';

  return (
    <div
      className="puzzle-page tactic-puzzle-solve"
      data-testid="tactic-puzzle-solve"
      data-state={loading ? 'loading' : error ? 'error' : 'ready'}
    >
      <PageSeo ns="tacticPuzzle.solve" path="/tactic-puzzles" />
      {/* KS-4347: хлебные крошки «Главная / Точность / Задача #...»
          по образцу /precision (`PuzzlePage.renderHeader`). Используем
          существующие CSS-классы `.puzzle-breadcrumbs*` — единый стиль. */}
      <nav
        className="puzzle-breadcrumbs"
        data-testid="tactic-puzzle-breadcrumbs"
        aria-label={t('breadcrumbs.label', 'Breadcrumbs')}
      >
        <Link to="/" className="puzzle-breadcrumbs__link">
          {t('breadcrumbs.home', 'Home')}
        </Link>
        <span className="puzzle-breadcrumbs__sep" aria-hidden="true">
          /
        </span>
        <Link
          to="/tactic-puzzles"
          className="puzzle-breadcrumbs__link"
          data-testid="tactic-puzzle-breadcrumbs-section"
        >
          {t('tacticPuzzle.title', 'Tactics')}
        </Link>
        {puzzleShortId && (
          <>
            <span className="puzzle-breadcrumbs__sep" aria-hidden="true">
              /
            </span>
            <span
              className="puzzle-breadcrumbs__current"
              data-testid="tactic-puzzle-breadcrumbs-current"
            >
              {t('breadcrumbs.puzzleN', 'Puzzle #{{id}}', {
                id: puzzleShortId,
              })}
            </span>
          </>
        )}
      </nav>

      {loading && (
        <p
          className="tactic-puzzle-solve__loading"
          data-testid="tactic-puzzle-solve-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}
      {error && !loading && (
        <div
          className="tactic-puzzle-solve__error"
          data-testid="tactic-puzzle-solve-error"
        >
          <p>{error}</p>
          <div className="tactic-puzzle-solve__error-actions">
            <button
              type="button"
              className="play-btn play-btn--secondary play-btn--compact"
              onClick={handleBack}
            >
              {t('common.back', 'Back')}
            </button>
            <button
              type="button"
              className="play-btn play-btn--compact"
              onClick={() => void loadPuzzle()}
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      )}
      {puzzle && (
        <>
          {/* KS-4347: чип сложности над доской — единый стиль с
              `.puzzle-difficulty` на /precision. Считаем процент сами,
              т.к. контракт `TacticPuzzleResponse.difficulty` уже в
              `[0..1]` и не имеет `maiaMetricVersion` (это другая
              алгоритм-семья). */}
          <div
            className="puzzle-stats puzzle-stats--play-vs-engine"
            data-testid="tactic-puzzle-stats"
          >
            <span
              className="puzzle-difficulty"
              data-testid="tactic-puzzle-difficulty"
              data-percent={Math.round(puzzle.difficulty * 100)}
            >
              {t('puzzle.difficulty', 'Сложность')}{' '}
              <span
                className="puzzle-difficulty__value"
                data-testid="tactic-puzzle-difficulty-value"
              >
                {Math.round(puzzle.difficulty * 100)}%
              </span>
            </span>
          </div>
          <TacticPuzzleRunner
            key={puzzle.id}
            puzzle={puzzle}
            onSubmit={handleSubmit}
            onNext={handleNext}
            onBack={handleBack}
            onOpenWorkshop={handleOpenWorkshop}
          />
          {/* KS-4347: блок «Из партии» — переиспользуем готовый
              `PuzzleSourceGame` из /precision. Адаптер
              `buildSourceGame` приводит `sourceHeaders` (PGN) +
              `sourceGameId` к `PuzzleSourceGameDto`. */}
          <PuzzleSourceGame source={buildSourceGame(puzzle)} />
        </>
      )}
    </div>
  );
}
