/**
 * KS-4343 → KS-4346 → KS-4347 / ADR-135 §2.5. Страница решения одного
 * пазла раздела «Точность». Маршрут `/critical-moment/:id`.
 *
 * Логика:
 *   1. Если есть `:id` — загружаем пазл через `/critical-moment/:id`.
 *   2. Иначе — `/critical-moment/next` (авто-подбор, JWT).
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
import { useCallback, useEffect, useRef, useState } from 'react';
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
// KS-4492. PGN-сборка по образцу Precision: открываем мастерскую через
// `/analyses` + `/analysis/<id>`, чтобы AnalysisPage парсил корректные
// `[SetUp][FEN]`-теги и нумерацию ходов от позиции-источника.
import { buildTacticPuzzlePgn } from '../utils/buildTacticPuzzlePgn';
import { TacticPuzzlesSubNav } from '../components/tactic-puzzles/TacticPuzzlesSubNav';

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
        navigate(`/critical-moment/${next.id}`);
      } else {
        navigate('/critical-moment');
      }
    } catch {
      navigate('/critical-moment');
    }
  }, [navigate]);

  const handleBack = useCallback(() => {
    navigate('/critical-moment');
  }, [navigate]);

  /**
   * KS-4347 → KS-4350 → KS-4353 → KS-4492. «Открыть в мастерской».
   *
   * KS-4492. Для авторизованного — сохраняем PGN-снимок задачи через
   * `POST /analyses` и открываем `/analysis/<id>`. То же, что делает
   * Precision (см. PrecisionAttemptPage). Раньше передавали только
   * `?fen=` — у мастерской терялись теги партии-источника и нумерация
   * ходов начиналась с «1.», что пользователь воспринимал как сбитую
   * нотацию. PGN включает `[SetUp][FEN]` + `Source*`-теги +
   * пользовательские ходы (если успел сделать).
   *
   * Для гостя (нельзя POST'нуть `/analyses`) — fallback на старый
   * путь `?fen=`. Гостю всё равно нельзя сохранить анализ; разница
   * с нотацией для него менее заметна (нет окружения «карточки
   * партии в мастерской», в которое ложатся теги).
   *
   * attempt-логика прежняя:
   *   - если попытка ещё не отправлена (раннер передал данные на клик
   *     по кнопке во время решения), параллельно шлём `attempt`
   *     с `stopReason='aborted'`;
   *   - если уже отправлена — `submittedAttemptRef` пропускает повтор.
   */
  const submittedAttemptRef = useRef<string | null>(null);
  const handleOpenWorkshop = useCallback(
    (data: TacticPuzzleRunnerSubmit) => {
      if (!puzzle) return;

      // KS-4492. Открываем вкладку СИНХРОННО (требование pop-up
      // политик) на about:blank, а потом переадресуем — либо на
      // /analysis/<id> после POST, либо на fallback /analysis?fen=
      // если POST упал/гость.
      const tab = window.open('about:blank', '_blank');
      const fallbackUrl = `/analysis?fen=${encodeURIComponent(puzzle.fen)}`;

      const redirect = (url: string) => {
        if (tab) {
          try {
            tab.location.href = url;
          } catch {
            // Если новая вкладка изолирована (rare), отдадим в текущей.
            window.location.href = url;
          }
        } else {
          window.location.href = url;
        }
      };

      if (user) {
        const shortId = puzzle.id.slice(0, 8);
        const pgn = buildTacticPuzzlePgn({
          initialFen: puzzle.fen,
          userMovesUci: data.userMoves,
          headers: puzzle.sourceHeaders,
        });
        const title = t('tacticPuzzle.workshopTitle', 'Critical Moment #{{id}}', {
          id: shortId,
          defaultValue: 'Critical Moment #{{id}}',
        });
        api
          .post<{ id: string }>(
            '/analyses',
            { pgn, title, category: 'analysis' },
          )
          .then((created) => {
            redirect(`/analysis/${created.id}`);
          })
          .catch((e) => {
            console.warn(
              'SolveTacticPuzzlePage: POST /analyses failed, fallback to ?fen=',
              e,
            );
            redirect(fallbackUrl);
          });
      } else {
        redirect(fallbackUrl);
      }

      // attempt отправляем только если ещё не отправляли для этого пазла.
      if (
        user &&
        submittedAttemptRef.current !== puzzle.id
      ) {
        submittedAttemptRef.current = puzzle.id;
        tacticPuzzleApi
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
          });
      }
    },
    [puzzle, user, t],
  );

  // Сбрасываем «уже отправили» при смене пазла.
  useEffect(() => {
    submittedAttemptRef.current = null;
  }, [puzzle?.id]);

  // Зеркальная пометка «attempt уже отправлен» — раннер ставит её
  // при обычном `onSubmit`, чтобы повторный клик «Открыть в мастерской»
  // на экране результата не отправил attempt второй раз.
  const handleSubmitWrapper = useCallback(
    async (data: TacticPuzzleRunnerSubmit) => {
      if (!puzzle) return;
      submittedAttemptRef.current = puzzle.id;
      await handleSubmit(data);
    },
    [puzzle, handleSubmit],
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
    ? `https://kingside.site/critical-moment/${puzzle.id}`
    : 'https://kingside.site/critical-moment';

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
        <PageSeo ns="tacticPuzzles.list" path="/critical-moment" />
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
          to="/critical-moment"
          className="puzzle-breadcrumbs__link"
          data-testid="tactic-puzzle-breadcrumbs-section"
        >
          {t('tacticPuzzle.title', 'Critical Moment')}
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
      <TacticPuzzlesSubNav />

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
            onSubmit={handleSubmitWrapper}
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
