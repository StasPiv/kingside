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
import { SeoHelmet } from '../components/seo/SeoHelmet';
import {
  TacticPuzzleRunner,
  type TacticPuzzleRunnerSubmit,
} from '../components/puzzle/TacticPuzzleRunner';
import { PuzzleSourceGame } from '../components/puzzle/PuzzleSourceGame';
import { tacticPuzzleApi } from '../api/api-tactic-puzzle';
import { api } from '../api';

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
   * KS-4347 → KS-4350. «Открыть в мастерской».
   *
   * Шаги:
   *   1) Сразу синхронно открываем пустую новую вкладку (`window.open`
   *      в обработчике клика — single user-gesture, иначе блокировщик
   *      всплывающих окон может задержать вкладку).
   *   2) Параллельно отправляем `attempt` с `stopReason='aborted'`.
   *   3) Если есть `sourceGameId` — `POST /analyses { archiveGameId }`,
   *      backend (KS-3261/3263) сам подгрузит PGN и дедуплицирует
   *      по `archiveGameId`. После — подменяем URL новой вкладки на
   *      `/analysis/<created.id>`.
   *   4) Если `sourceGameId` нет (legacy) — fallback: открываем
   *      `/analysis?fen=<puzzle.fen>` в той же новой вкладке.
   *   5) Если открытие новой вкладки заблокировано (pop-up blocker
   *      или гость без права на POST `/analyses`) — навигация в той же
   *      вкладке как окончательный fallback.
   *
   * На странице пазла раннер выставил `state='lose'` — пользователь
   * видит экран результата с «сдался», возврат сюда после возврата из
   * мастерской показывает уже закрытую попытку.
   */
  const handleOpenWorkshop = useCallback(
    async (data: TacticPuzzleRunnerSubmit) => {
      if (!puzzle) return;
      // Открываем пустую вкладку синхронно — обязательное условие
      // user-gesture для большинства pop-up политик. Без `noopener`,
      // чтобы получить ссылку и потом подменить URL.
      const tab: Window | null = window.open('about:blank', '_blank');
      const fallbackUrl = `/analysis?fen=${encodeURIComponent(puzzle.fen)}`;
      // attempt + POST /analyses идут параллельно — submit от backend
      // нужен сам по себе (журнал ошибок), а ссылка на анализ не зависит
      // от его исхода.
      const submitPromise = user
        ? tacticPuzzleApi
            .submitAttempt(puzzle.id, {
              lineHalfMoves: data.lineHalfMoves,
              userMoves: data.userMoves,
              stopReason: data.stopReason,
              timeMs: data.timeMs,
              wdlStart: data.wdlStart,
              wdlEnd: data.wdlEnd,
            })
            .catch((e) => {
              console.warn(
                'SolveTacticPuzzlePage: workshop submit failed',
                e,
              );
            })
        : Promise.resolve();

      let targetUrl = fallbackUrl;
      if (user && puzzle.sourceGameId) {
        try {
          const title = puzzle.sourceHeaders
            ? `${puzzle.sourceHeaders.White ?? '?'} vs ${
                puzzle.sourceHeaders.Black ?? '?'
              }`
            : 'Tactic puzzle';
          const created = await api.post<{ id: string }>(`/analyses`, {
            title,
            category: 'analysis',
            archiveGameId: puzzle.sourceGameId,
          });
          targetUrl = `/analysis/${created.id}`;
        } catch (e) {
          console.warn(
            'SolveTacticPuzzlePage: POST /analyses failed, fallback to fen',
            e,
          );
        }
      }
      // Подменяем URL в открытой вкладке. Если открытие было
      // заблокировано — fallback на навигацию в той же вкладке.
      if (tab && !tab.closed) {
        tab.location.href = targetUrl;
      } else {
        window.location.href = targetUrl;
      }
      await submitPromise;
    },
    [puzzle, user],
  );

  const puzzleShortId = puzzle ? puzzle.id.slice(0, 8) : '';

  /**
   * KS-4351. SEO-теги собираем динамически по `puzzle`. Если у пазла
   * есть имена белых/чёрных в `sourceHeaders` — шаблон с фамилиями
   * («Kuzubov,Y − Kasimdzhanov,R — задача …»); иначе — запасной с
   * коротким идентификатором.
   */
  const hasPlayers = Boolean(
    puzzle?.sourceHeaders?.White || puzzle?.sourceHeaders?.Black,
  );
  const seoVars = puzzle
    ? {
        playersTitle: `${puzzle.sourceHeaders?.White ?? '?'} − ${
          puzzle.sourceHeaders?.Black ?? '?'
        }`,
        eventSuffix: puzzle.sourceHeaders?.Event
          ? ` (${puzzle.sourceHeaders.Event}${
              puzzle.sourceHeaders?.Date
                ? `, ${puzzle.sourceHeaders.Date}`
                : ''
            })`
          : '',
        difficulty: Math.round(puzzle.difficulty * 100),
        shortId: puzzleShortId,
      }
    : {};
  const seoTitleKey = hasPlayers
    ? 'seo.tacticPuzzles.detail.title'
    : 'seo.tacticPuzzles.detail.titleNoPlayers';
  const seoDescriptionKey = hasPlayers
    ? 'seo.tacticPuzzles.detail.description'
    : 'seo.tacticPuzzles.detail.descriptionNoPlayers';
  const seoCanonical = puzzle
    ? `https://kingside.site/tactic-puzzles/${puzzle.id}`
    : 'https://kingside.site/tactic-puzzles';

  return (
    <div
      className="puzzle-page tactic-puzzle-solve"
      data-testid="tactic-puzzle-solve"
      data-state={loading ? 'loading' : error ? 'error' : 'ready'}
    >
      {/* KS-4351. На странице решения title/description зависят от
          данных пазла (имена игроков, сложность). Используем SeoHelmet
          напрямую — PageSeo рассчитан на статический ns без выбора
          между двумя шаблонами «с игроками / без». Пока пазл грузится,
          оставляем статический SEO раздела. */}
      {puzzle ? (
        <SeoHelmet
          title={t(seoTitleKey, seoVars)}
          description={t(seoDescriptionKey, seoVars)}
          canonical={seoCanonical}
          ogType="article"
        />
      ) : (
        <PageSeo ns="tacticPuzzles.list" path="/tactic-puzzles" />
      )}
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
