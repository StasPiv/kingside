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

  // KS-4608. Id последней успешно отправленной попытки по текущему
  // пазлу. Сохраняется в `handleSubmit` и переиспользуется в
  // `handleOpenWorkshop`, чтобы повторный клик «Открыть в мастерской»
  // на экране результата не отправлял attempt второй раз и сразу
  // обращался к `POST /analyses/from-tactic-attempt`.
  const lastAttemptIdRef = useRef<string | null>(null);

  const handleSubmit = useCallback(
    async (data: TacticPuzzleRunnerSubmit) => {
      if (!puzzle) return;
      // Гостям не отправляем attempt (JWT обязателен на backend).
      if (!user) return;
      try {
        const submitted = await tacticPuzzleApi.submitAttempt(puzzle.id, {
          lineHalfMoves: data.lineHalfMoves,
          userMoves: data.userMoves,
          stopReason: data.stopReason,
          timeMs: data.timeMs,
          wdlStart: data.wdlStart,
          wdlEnd: data.wdlEnd,
        });
        // KS-4608: запоминаем attemptId — нужен для
        // `POST /analyses/from-tactic-attempt`.
        lastAttemptIdRef.current = submitted.attemptId;
      } catch (e) {
        console.warn('SolveTacticPuzzlePage: submitAttempt failed', e);
      }
    },
    [puzzle, user],
  );

  // KS-4606. Кнопка «Дальше».
  //
  // Жалоба: «по клику ничего не происходит». Корневых причин может быть
  // две:
  //   (а) backend `/next` возвращает 204 (нет задач в рейтинг-окне) —
  //       раньше при этом фронт уводил в `/critical-moment`, что
  //       пользователь воспринимал как «возврат вместо следующей»;
  //   (б) backend возвращает ТУ ЖЕ задачу (рейтинг-окно вернуло
  //       текущий id) — `navigate` на тот же URL react-router не
  //       инициирует re-mount, визуально «ничего не произошло».
  //
  // На обоих случаях редиректим в каталог с фильтром `solved=false`
  // («Не решал») — пользователь сразу видит список оставшихся для
  // решения. Это лучше, чем застрять на той же позиции или попасть в
  // полный каталог «Все».
  const handleNext = useCallback(async () => {
    const fallbackToUnsolved = () => navigate('/critical-moment?solved=false');
    try {
      const next = await tacticPuzzleApi.pickNext();
      if (!next || next.id === puzzle?.id) {
        fallbackToUnsolved();
        return;
      }
      navigate(`/critical-moment/${next.id}`);
    } catch {
      fallbackToUnsolved();
    }
  }, [navigate, puzzle?.id]);

  const handleBack = useCallback(() => {
    navigate('/critical-moment');
  }, [navigate]);

  /**
   * KS-4347 → KS-4350 → KS-4353 → KS-4492 → KS-4608. «Открыть в мастерской».
   *
   * KS-4608. Серверный метод `POST /analyses/from-tactic-attempt
   * { attemptId }` (KS-4607) сам собирает PGN из связки
   * `tactic_puzzle_attempts → tactic_puzzles` и переиспользует dedup
   * `analyses.create`. Это убирает `buildTacticPuzzlePgn` из фронта и
   * исключает рассинхрон формата PGN с тем, что считает каноничным
   * backend.
   *
   * Поток для авторизованного пользователя:
   *   1. Если уже есть `attemptId` от предыдущего `submitAttempt`
   *      (раннер вызывал `onSubmit` при завершении/сдаче) — сразу
   *      шлём `POST /analyses/from-tactic-attempt`.
   *   2. Иначе — сначала `submitAttempt` (получаем `attemptId`), затем
   *      `POST /analyses/from-tactic-attempt`. Это покрывает клик «Открыть
   *      в мастерской» во время решения: раннер вызовом `onOpenWorkshop`
   *      переводит компонент в `lose`, фронт отправляет attempt c
   *      `stopReason='aborted'`.
   *
   * Гость не может ни сохранить анализ, ни отправить attempt — для него
   * fallback `/analysis?fen=` (нотация в мастерской начнётся с «1.»,
   * но это лучше, чем заблокированная кнопка).
   *
   * `lastAttemptIdRef` хранит id последнего успешного `submitAttempt`
   * по текущему пазлу (см. объявление выше у `handleSubmit`).
   * Сбрасывается при смене `puzzle.id`.
   */
  const handleOpenWorkshop = useCallback(
    async (data: TacticPuzzleRunnerSubmit) => {
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

      if (!user) {
        redirect(fallbackUrl);
        return;
      }

      try {
        // Если attempt ещё не отправлен по этому пазлу — отправляем сейчас
        // через общий handleSubmit (он пишет id в ref). Если уже был
        // отправлен (раннер вызывал onSubmit при завершении/сдаче) —
        // переиспользуем сохранённый id.
        if (!lastAttemptIdRef.current) {
          await handleSubmit(data);
        }
        const attemptId = lastAttemptIdRef.current;
        if (!attemptId) {
          // submitAttempt не получил id (например, сеть упала) —
          // мастерскую открываем без привязки к попытке.
          redirect(fallbackUrl);
          return;
        }

        const created = await api.post<{ id: string }>(
          '/analyses/from-tactic-attempt',
          { attemptId },
        );
        redirect(`/analysis/${created.id}`);
      } catch (e) {
        console.warn(
          'SolveTacticPuzzlePage: from-tactic-attempt failed, fallback to ?fen=',
          e,
        );
        redirect(fallbackUrl);
      }
    },
    [puzzle, user, handleSubmit],
  );

  // Сбрасываем `attemptId` при смене пазла — новая задача = нет
  // привязанной попытки.
  useEffect(() => {
    lastAttemptIdRef.current = null;
  }, [puzzle?.id]);

  // KS-4608. Wrapper для `onSubmit` раннера — просто проксирует в
  // `handleSubmit` (который сам сохраняет `attemptId` в ref).
  // Раньше тут стоял флаг «уже отправили», но он стал избыточен:
  // `handleSubmit` идемпотентен на уровне сети (повторный POST по тому
  // же пазлу backend дедупит), а `handleOpenWorkshop` использует ref
  // как кэш `attemptId`.
  const handleSubmitWrapper = handleSubmit;

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
