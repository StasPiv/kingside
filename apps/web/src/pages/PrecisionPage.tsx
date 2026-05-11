import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
// KS-2661: «Generate from PGN» переехала сюда из `PuzzleBrowserPage`.
// Логично держать её рядом с результатом — generated пазлы попадают
// именно в `/precision`.
import { PuzzleGeneratorModal } from '../components/PuzzleGeneratorModal';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import {
  useInfinitePuzzles,
  type BrowsePuzzleDto,
  type InfinitePuzzleFilters,
} from '../hooks/useInfinitePuzzles';
import { buildPrecisionPuzzleQuery } from '../utils/puzzleNav';
// KS-2746 / ADR-057 §3: общий sub-nav «Тренировка / Прогресс / История»
// сверху каждой precision-страницы. Подробные блоки статистики
// (PrecisionAttemptsList / PrecisionTrendsChart / PrecisionBreakdowns)
// переехали на /precision/stats (KS-2744) и /precision/history (KS-2745)
// — на главной их больше нет, чтобы сетка позиций была видна на первом
// экране без скролла.
import { PrecisionSubNav } from '../components/precision/PrecisionSubNav';

/**
 * KS-2484 (ADR-044) → KS-2578 → KS-2585/KS-2586 — список тренировки
 * точности.
 *
 * Эволюция:
 *  - KS-2484: legacy `/puzzles?solutionMode=play-vs-engine` фильтр.
 *  - KS-2578: переезд на унифицированный `/puzzles/browse?source=
 *    generated`. Pages cards = generated пазлы (forced-line +
 *    play-vs-engine), lichess живёт в `/puzzles`.
 *  - KS-2585: добавил draft/publish-flow в PuzzleGeneratorModal.
 *  - KS-2586: индивидуальный publish из карточки на `/precision?mine=
 *    true`. URL-параметры:
 *      - `mine=true` — только пазлы текущего юзера;
 *      - `visibility=draft|public|all` — фильтр по `is_public`.
 *
 * Backend: `KS-2560` (source-фильтр), `KS-2580` (per-puzzle
 * `PATCH /puzzles/:id { isPublic }`), `KS-2582` (visibility-фильтр в
 * `/puzzles/browse`).
 *
 * # DOM
 *
 *   <div class="play-vs-engine-puzzles" data-testid="play-vs-engine-puzzles"
 *        data-state="loading|ready|empty|error" data-mine="true|false"
 *        data-visibility="draft|public|all">
 *     <article data-testid="play-vs-engine-card" data-puzzle-id="…"
 *              data-public="true|false">
 *       …
 *       <span data-testid="precision-card-draft-badge" />     // если draft+owned
 *       <button data-testid="precision-card-publish" />        // если draft+owned
 *     </article>
 *     …
 *   </div>
 */

const LIMIT = 20;

function sideFromFen(fen: string): 'white' | 'black' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'black' : 'white';
}

/**
 * KS-2719 / ADR-056 §3.4 + §2.1. Контракт ответа `GET /precision/stats/me`.
 * Backend задача (KS-2718) ещё не выкатилась — до выкатки делаем
 * graceful fallback (404/4xx → null → placeholder «Сыграй первую попытку»).
 *
 * Все поля «average» — null когда attempts=0. `preservedCount` всегда
 * число (0 если пусто). `avgWdlLeakPerMove` хранится в долях (0..1),
 * на UI преобразуем в проценты. `avgHalfMovesUntilFirstMistake` — null
 * если ни в одной попытке не было ошибки (всё «лучшие» ходы).
 */
interface PrecisionStatsResponse {
  totalAttempts: number;
  preservedCount: number;
  avgAccuracyPercent: number | null;
  avgWdlLeakPerMove: number | null;
  avgHalfMovesUntilFirstMistake: number | null;
}

function isVisibility(v: string | null): v is 'draft' | 'public' | 'all' {
  return v === 'draft' || v === 'public' || v === 'all';
}

type ToastTone = 'success' | 'error' | 'info';
interface ToastState {
  id: number;
  message: string;
  tone: ToastTone;
}
const TOAST_AUTO_HIDE_MS = 3000;

export function PrecisionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const copyToClipboard = useCopyToClipboard();

  // KS-2586: URL-state read.
  const mineParam = searchParams.get('mine') === 'true';
  const visibilityParam = searchParams.get('visibility');
  const visibility: 'draft' | 'public' | 'all' | undefined = isVisibility(
    visibilityParam,
  )
    ? visibilityParam
    : undefined;
  // KS-2719 F3 / KS-2753 / KS-2754 follow-up: фильтр сетки PUZZLES.
  // ИНВЕРСИЯ ПО УМОЛЧАНИЮ: по дефолту скрываем удержанные позиции,
  // пользователь видит только новые задачи для тренировки. Чтобы
  // показать уже решённые — выставляет чекбокс «Показать решённые»,
  // в URL появляется `?showSolved=true`. Backend-фильтр прежний
  // (`hideSolved=true` → выкидывает удержанные позиции из выдачи).
  const showSolvedParam = searchParams.get('showSolved') === 'true';
  const hideSolved = !showSolvedParam;

  // KS-2586: миграция с raw `api.get` на `useInfinitePuzzles` —
  // нужен `patchLocally` для оптимистичного апдейта после publish'а.
  // Поведение page state'а сохраняем тем же набором значений.
  const filters = useMemo<InfinitePuzzleFilters>(
    () => ({
      source: 'generated',
      mine: mineParam ? true : undefined,
      visibility,
      hideSolved: hideSolved ? true : undefined,
      limit: LIMIT,
    }),
    [mineParam, visibility, hideSolved],
  );

  const {
    puzzles,
    loading,
    error,
    patchLocally,
    removeLocally,
  } = useInfinitePuzzles(filters);

  const [stats, setStats] = useState<PrecisionStatsResponse | null>(null);

  /** id пазла, который сейчас публикуется (для disable + spinner). */
  const [publishingId, setPublishingId] = useState<string | null>(null);
  /** id пазла, недавно опубликованного — для 2-сек «Published» badge. */
  const [recentlyPublishedId, setRecentlyPublishedId] = useState<string | null>(
    null,
  );
  // KS-2673: убрали `publishError`-state и inline-блок «Failed to
  // publish» — все ошибки идут через локализованный `showToast`.

  // KS-2663: per-card pending state для toggle visibility / delete.
  // Локальный «id, по которому идёт мутация» гарантирует disable
  // соответствующих кнопок и блокирует двойные клики.
  const [pendingActionId, setPendingActionId] = useState<{
    id: string;
    action: 'visibility' | 'delete';
  } | null>(null);

  // KS-2663: floating toast — образец взят из MyCoursesView (KS-2621).
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastIdRef = useRef(0);

  const showToast = useCallback((message: string, tone: ToastTone) => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToast({ id, message, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast((prev) => (prev && prev.id === id ? null : prev));
    }, TOAST_AUTO_HIDE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);
  // KS-2661: модалка генератора пазлов из PGN. Открывается из шапки,
  // closeflow без изменений — после генерации `useInfinitePuzzles`
  // сам перезагрузится при следующем открытии страницы / смене
  // фильтров (в текущем сеансе показ свежесгенерированных идёт через
  // отдельный success-screen внутри модалки → KS-2585/86).
  const [showGenerator, setShowGenerator] = useState(false);

  const handlePublish = useCallback(
    async (puzzleId: string) => {
      if (publishingId) return;
      setPublishingId(puzzleId);
      try {
        await api.patch(`/puzzles/${puzzleId}`, { isPublic: true });
        // Оптимистичный апдейт через hook'овский patchLocally —
        // карточка моментально перерисовывается без isPublic=false.
        patchLocally(puzzleId, { isPublic: true });
        setRecentlyPublishedId(puzzleId);
        // Через 2 секунды убираем «Published» индикатор.
        window.setTimeout(() => {
          setRecentlyPublishedId((prev) => (prev === puzzleId ? null : prev));
        }, 2000);
        // KS-2673: успешный publish — локализованный toast
        // (раньше показывался только Published-badge на 2с).
        showToast(
          t('precision.toasts.published', 'Puzzle published'),
          'success',
        );
      } catch {
        // KS-2673: ошибка через локализованный toast вместо inline-
        // строки с сырым `e.message`.
        showToast(
          t('precision.toasts.visibilityError', 'Failed to update visibility'),
          'error',
        );
      } finally {
        setPublishingId(null);
      }
    },
    [publishingId, patchLocally, showToast, t],
  );

  // KS-2663: per-card актйоны автора своих пазлов на вкладке «Мои».
  const handleCopyLink = useCallback(
    async (puzzle: BrowsePuzzleDto) => {
      const origin =
        typeof window !== 'undefined' ? window.location.origin : '';
      // Унифицированный URL solve (без `?source=precision`, чтобы
      // ссылка вне Kingside открыла обычный SolutionRunner для lichess
      // или PVE для generated по `solutionMode` — KS-2657).
      const url = `${origin}/puzzle/${puzzle.id}`;
      const ok = await copyToClipboard(url);
      if (!ok) {
        showToast(
          t('precision.toasts.linkCopyError', 'Failed to copy link'),
          'error',
        );
        return;
      }
      const message =
        puzzle.isPublic === false
          ? t(
              'precision.toasts.linkCopiedPrivate',
              'Link copied. Publish to share with others.',
            )
          : t('precision.toasts.linkCopied', 'Link copied');
      showToast(message, puzzle.isPublic === false ? 'info' : 'success');
    },
    [copyToClipboard, showToast, t],
  );

  const handleToggleVisibility = useCallback(
    async (puzzle: BrowsePuzzleDto) => {
      if (pendingActionId?.id === puzzle.id) return;
      setPendingActionId({ id: puzzle.id, action: 'visibility' });
      const next = puzzle.isPublic === false;
      try {
        await api.patch(`/puzzles/${puzzle.id}`, { isPublic: next });
        patchLocally(puzzle.id, { isPublic: next });
        showToast(
          next
            ? t('precision.toasts.published', 'Puzzle published')
            : t('precision.toasts.unpublished', 'Puzzle made private'),
          'success',
        );
      } catch {
        showToast(
          t(
            'precision.toasts.visibilityError',
            'Failed to update visibility',
          ),
          'error',
        );
      } finally {
        setPendingActionId((cur) =>
          cur && cur.id === puzzle.id ? null : cur,
        );
      }
    },
    [pendingActionId, patchLocally, showToast, t],
  );

  const handleDelete = useCallback(
    async (puzzle: BrowsePuzzleDto) => {
      if (pendingActionId?.id === puzzle.id) return;
      const confirmText = t(
        'precision.deleteConfirm',
        'Delete this puzzle? This cannot be undone.',
      );
      if (typeof window !== 'undefined' && !window.confirm(confirmText)) {
        return;
      }
      setPendingActionId({ id: puzzle.id, action: 'delete' });
      try {
        await api.delete(`/puzzles/${puzzle.id}`);
        // KS-2673: вместо `window.location.reload()` (убогий UX —
        // моргание, потеря скролла и фильтров) делаем локальную
        // мутацию через `removeLocally`. Карточка моментально
        // пропадает из списка без нового сетевого запроса.
        removeLocally(puzzle.id);
        showToast(
          t('precision.toasts.deleted', 'Puzzle deleted'),
          'success',
        );
      } catch {
        showToast(
          t('precision.toasts.deleteError', 'Failed to delete puzzle'),
          'error',
        );
      } finally {
        setPendingActionId((cur) =>
          cur && cur.id === puzzle.id ? null : cur,
        );
      }
    },
    [pendingActionId, removeLocally, showToast, t],
  );

  // KS-2719 F2 / ADR-056 §3.4. Источник top-блока — отдельный
  // endpoint `/precision/stats/me` (precision-aggregates: accuracy,
  // preserved/lost ratio, wdl-leak, до первой ошибки). Старый блок
  // c `attempts/solved/lastAttempt` из `/puzzles/stats/me` удалён —
  // его заменили 4 карточки. До выкатки KS-2718 endpoint вернёт 404,
  // мы грейсфолим в null → UI показывает placeholder «Сыграй первую
  // попытку».
  const fetchStats = useCallback(async () => {
    if (!user) {
      setStats(null);
      return;
    }
    try {
      const data = await api
        .get<PrecisionStatsResponse>('/precision/stats/me')
        .catch(() => null);
      setStats(data);
    } catch {
      setStats(null);
    }
  }, [user]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  const pageState: 'loading' | 'ready' | 'empty' | 'error' = loading
    ? 'loading'
    : error
      ? 'error'
      : puzzles.length === 0
        ? 'empty'
        : 'ready';

  // KS-2746 / ADR-057 §3.3. CTA «Начать тренировку» в empty-state ведёт
  // фокус и скролл к первой карточке сетки. Если сетка пустая —
  // фоллбэк на скролл к самому контейнеру сетки.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollToFirstCard = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const firstCard = grid.querySelector<HTMLElement>(
      '[data-testid="play-vs-engine-card"] [data-testid="play-vs-engine-card-solve"]',
    );
    if (firstCard) {
      firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstCard.focus();
    } else {
      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  return (
    <div
      className="play-vs-engine-puzzles"
      data-testid="play-vs-engine-puzzles"
      data-state={pageState}
      data-mine={mineParam ? 'true' : 'false'}
      data-visibility={visibility ?? 'all'}
    >
      {/* KS-2746 / ADR-057 §3: SubNav сверху для всех 3 precision-страниц.
          Активный пункт «Тренировка» вычисляется внутри SubNav по
          useLocation. */}
      <PrecisionSubNav />
      <header className="play-vs-engine-puzzles__header">
        <h1>{t('precision.title', 'Precision training')}</h1>
        <p className="play-vs-engine-puzzles__intro">
          {t(
            'precision.intro',
            'Practice positions where a Stockfish-strong engine punishes mistakes. Find the precise sequence and outplay the machine.',
          )}
        </p>
        <div className="play-vs-engine-puzzles__nav">
          <Link to="/puzzles" className="play-vs-engine-puzzles__back-link">
            ← {t('precision.backToAll', 'All puzzles')}
          </Link>
          {/* KS-2661: «Generate from PGN» теперь живёт здесь —
              рядом с результатом (generated → /precision). */}
          {user && (
            <button
              type="button"
              className="generate-puzzles-btn"
              data-testid="precision-generate-btn"
              onClick={() => setShowGenerator(true)}
            >
              {t('puzzleGenerator.fromPgn', 'Generate from PGN')}
            </button>
          )}
        </div>
        {/* KS-2661: табы «Все / Мои» — фильтр по `?mine=true|`.
            Гостям не показываем — без авторизации «Мои» пусто. */}
        {user && (
          <nav
            className="precision-tabs"
            data-testid="precision-tabs"
            aria-label={t('precision.tabs.label', 'Puzzle filter')}
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!mineParam}
              className={`precision-tab${!mineParam ? ' precision-tab--active' : ''}`}
              data-testid="precision-tab-all"
              onClick={() => {
                const sp = new URLSearchParams(searchParams);
                sp.delete('mine');
                setSearchParams(sp, { replace: false });
              }}
            >
              {t('precision.tabs.all', 'All')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mineParam}
              className={`precision-tab${mineParam ? ' precision-tab--active' : ''}`}
              data-testid="precision-tab-mine"
              onClick={() => {
                const sp = new URLSearchParams(searchParams);
                sp.set('mine', 'true');
                setSearchParams(sp, { replace: false });
              }}
            >
              {t('precision.tabs.mine', 'My puzzles')}
            </button>
          </nav>
        )}
        {/* KS-2754 follow-up: toggle «Показать решённые» — инверсия
            предыдущего «Скрыть удержанные». По умолчанию скрываем
            удержанные позиции (пользователь видит только новые
            задачи); галочка `Показать решённые` → URL `?showSolved=true`
            → бэкенд возвращает все позиции, включая ранее решённые.
            Backend-параметр остался `hideSolved=true`, инверсию делаем
            на фронте (см. `hideSolved = !showSolvedParam`). */}
        {user && (
          <label
            className="precision-show-solved"
            data-testid="precision-show-solved"
          >
            <input
              type="checkbox"
              checked={showSolvedParam}
              onChange={(e) => {
                const sp = new URLSearchParams(searchParams);
                if (e.target.checked) sp.set('showSolved', 'true');
                else sp.delete('showSolved');
                setSearchParams(sp, { replace: false });
              }}
              data-testid="precision-show-solved-input"
            />
            {t('precision.showSolved', 'Show solved')}
          </label>
        )}
        {/* KS-2746 / ADR-057 §3.2: compact top-bar c 2 метриками + ссылка
            «Полная статистика →» на /precision/stats. Заменяет старый
            4-карточечный блок, который теперь живёт на /precision/stats
            (KS-2744). На 1280×800 сетка позиций видна без скролла —
            ради чего весь рефакторинг.
            При totalAttempts=0 рендерим empty-CTA «Начать тренировку»
            (скролл/фокус на первую карточку сетки) вместо нулевых
            метрик. */}
        {user && (() => {
          const hasData = stats != null && stats.totalAttempts > 0;
          if (!hasData) {
            return (
              <div
                className="precision-empty"
                data-testid="precision-empty"
              >
                <p className="precision-empty__title">
                  {t('precision.empty.title', "You don't have any attempts yet.")}
                </p>
                <button
                  type="button"
                  className="precision-empty__cta"
                  data-testid="precision-empty-cta"
                  onClick={scrollToFirstCard}
                >
                  {t('precision.empty.cta', 'Start training')}
                </button>
              </div>
            );
          }
          const accuracyText =
            stats!.avgAccuracyPercent == null
              ? t('precision.stats.noData', '—')
              : `${Math.round(stats!.avgAccuracyPercent)}%`;
          const lostCount = Math.max(
            0,
            stats!.totalAttempts - stats!.preservedCount,
          );
          return (
            <div
              className="precision-compact-stats"
              data-testid="precision-compact-stats"
              data-attempts={String(stats!.totalAttempts)}
              data-preserved={String(stats!.preservedCount)}
            >
              <div
                className="precision-compact-stats__cell"
                data-testid="precision-compact-stats-accuracy"
              >
                <span className="precision-compact-stats__value">
                  {accuracyText}
                </span>
                <span className="precision-compact-stats__label">
                  {t('precision.compactStats.accuracy', 'Move accuracy')}
                </span>
              </div>
              <div
                className="precision-compact-stats__cell"
                data-testid="precision-compact-stats-retained"
              >
                <span className="precision-compact-stats__value">
                  {stats!.preservedCount} / {lostCount}
                </span>
                <span className="precision-compact-stats__label">
                  {t(
                    'precision.compactStats.retainedLost',
                    'Preserved / Lost',
                  )}
                </span>
              </div>
              <Link
                to="/precision/stats"
                className="precision-compact-stats__full-link"
                data-testid="precision-compact-stats-full-link"
              >
                {t(
                  'precision.compactStats.fullStatsLink',
                  'Full statistics →',
                )}
              </Link>
            </div>
          );
        })()}
      </header>

      {pageState === 'loading' && (
        <p
          className="play-vs-engine-puzzles__status"
          data-testid="play-vs-engine-loading"
        >
          {t('common.loading', 'Loading…')}
        </p>
      )}

      {pageState === 'error' && (
        <div
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--error"
          data-testid="play-vs-engine-error"
        >
          <p>{t('precision.loadError', 'Could not load puzzles.')}</p>
          {/* KS-2586: после миграции на хук — повторная попытка через
              перезагрузку страницы; хук сам делает fetch при mount. */}
          <button type="button" onClick={() => window.location.reload()}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {pageState === 'empty' && (
        <p
          className="play-vs-engine-puzzles__status play-vs-engine-puzzles__status--empty"
          data-testid="play-vs-engine-empty"
        >
          {t(
            'precision.gridEmpty',
            'No play-vs-engine puzzles yet — the generator is still filling the bank. Check back soon.',
          )}
        </p>
      )}

      {/* KS-2673: inline-блок publishError удалён — ошибки идут через
          локализованный `showToast` (см. handlePublish/handleDelete). */}

      {pageState === 'ready' && (
        <div
          className="play-vs-engine-puzzles__list"
          ref={gridRef}
          data-testid="play-vs-engine-puzzles-list"
        >
          {puzzles.map((p: BrowsePuzzleDto) => {
            const orientation = sideFromFen(p.fen);
            // KS-2668: backend кладёт владельца в `createdBy`
            // (а не `userId`, как ожидал старый код KS-2663). Из-за
            // несоответствия `isMine` всегда был `false`, owner-кнопки
            // никогда не отображались. После выравнивания — кнопки
            // появляются на действительно своих пазлах. Бэкенд-фильтр
            // `?mine=1` пока не отбрасывает чужие (отдельная задача),
            // но фронт корректно скрывает owner-actions на чужих.
            const ownerId = p.createdBy ?? p.userId ?? null;
            const isMine =
              user !== null && ownerId != null && ownerId === user.id;
            const isDraft = p.isPublic === false;
            const justPublished = recentlyPublishedId === p.id;
            const onClick = () =>
              // KS-2547 / ADR-048 §5: новый канон `?source=precision`.
              // KS-2688: + сохраняем mine/visibility в query, чтобы при
              // возврате со страницы пазла вернуться в тот же фильтр
              // (например, /precision?mine=true&visibility=draft).
              navigate(
                `/puzzle/${p.id}${buildPrecisionPuzzleQuery(searchParams)}`,
              );
            return (
              <article
                key={p.id}
                className="play-vs-engine-card"
                data-testid="play-vs-engine-card"
                data-puzzle-id={p.id}
                data-public={p.isPublic === false ? 'false' : 'true'}
                data-mine={isMine ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="play-vs-engine-card__board-btn"
                  onClick={onClick}
                  aria-label={t('precision.openPuzzle', 'Open puzzle')}
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
                    {t('precision.cardTitle', '#{{id}}', {
                      id: p.id.slice(0, 8),
                    })}
                    {/* KS-2586: badge «Draft» рядом с заголовком — виден
                        пользователю-владельцу, чтобы он знал что пазл
                        пока приватный. После publish исчезает. */}
                    {isMine && isDraft && (
                      <span
                        className="precision-card__badge precision-card__badge--draft"
                        data-testid="precision-card-draft-badge"
                      >
                        {t('precision.draftBadge', 'Draft')}
                      </span>
                    )}
                    {isMine && justPublished && (
                      <span
                        className="precision-card__badge precision-card__badge--published"
                        data-testid="precision-card-published-toast"
                      >
                        {t('precision.publishedBadge', 'Published')}
                      </span>
                    )}
                  </div>
                  <div className="play-vs-engine-card__meta">
                    {/* KS-2689: рейтинг сгенерированных пазлов
                        рассчитывается по упрощённой MVP-формуле
                        (ADR-044 §3.5) и в UX путает пользователя.
                        Скрываем span до тех пор, пока формула не
                        будет доработана. Поле `p.rating` остаётся
                        в DTO/БД и используется backend'ом. */}
                    <span
                      className="play-vs-engine-card__side"
                      data-side={orientation}
                    >
                      {orientation === 'white'
                        ? t('drills.side.whiteToMove', 'White to move')
                        : t('drills.side.blackToMove', 'Black to move')}
                    </span>
                  </div>
                  {/* KS-2754 follow-up: контекст исходной партии и
                      ход-зевок. Источник — `sourceGame` + sourceMoveNum
                      + playVsEngine.{blunderMove, fenBeforeBlunder} из
                      backend 96eb4acd. SAN зевка собираем chess.js'ом
                      из fenBeforeBlunder+blunderMove. Аннотация `?`
                      рядом с SAN — это и есть «зевок». */}
                  {(() => {
                    const sg = p.sourceGame ?? null;
                    const pve = p.playVsEngine ?? null;
                    const players =
                      sg && (sg.white || sg.black)
                        ? `${sg.white ?? '?'} — ${sg.black ?? '?'}`
                        : null;
                    let blunderSan: string | null = null;
                    if (pve?.blunderMove && pve.fenBeforeBlunder) {
                      try {
                        const c = new Chess(pve.fenBeforeBlunder);
                        const mv = c.move({
                          from: pve.blunderMove.slice(0, 2),
                          to: pve.blunderMove.slice(2, 4),
                          promotion:
                            pve.blunderMove.length > 4
                              ? pve.blunderMove[4]
                              : undefined,
                        });
                        if (mv) blunderSan = mv.san;
                      } catch {
                        /* fallback: показываем UCI как SAN */
                        blunderSan = pve.blunderMove;
                      }
                    }
                    if (!players && !blunderSan && p.sourceMoveNum == null) {
                      return null;
                    }
                    return (
                      <div
                        className="play-vs-engine-card__source"
                        data-testid="play-vs-engine-card-source"
                      >
                        {players && (
                          <div
                            className="play-vs-engine-card__source-players"
                            data-testid="play-vs-engine-card-source-players"
                          >
                            {players}
                            {sg?.event ? ` · ${sg.event}` : ''}
                          </div>
                        )}
                        {(blunderSan || p.sourceMoveNum != null) && (
                          <div
                            className="play-vs-engine-card__source-blunder"
                            data-testid="play-vs-engine-card-source-blunder"
                          >
                            {p.sourceMoveNum != null
                              ? t(
                                  'precision.card.blunderAt',
                                  'Blunder at move {{n}}',
                                  { n: p.sourceMoveNum },
                                )
                              : t('precision.card.blunderLabel', 'Blunder')}
                            {blunderSan ? `: ${blunderSan}?` : ''}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {/* KS-2670: текстовые кнопки заменены на иконки
                      (по образцу .my-courses-page__action--icon, KS-2654).
                      Текст действия → `aria-label` + `title` (нативный
                      tooltip + CSS-tooltip из puzzle.css). */}
                  <div className="play-vs-engine-card__actions">
                    <button
                      type="button"
                      className="precision-card__icon-action precision-card__icon-action--solve"
                      data-testid="play-vs-engine-card-solve"
                      onClick={onClick}
                      aria-label={t('puzzleBrowser.solve', 'Solve')}
                      title={t('puzzleBrowser.solve', 'Solve')}
                    >
                      <svg
                        className="precision-card__icon"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </button>
                    {/* KS-2586/KS-2670/KS-2673: индивидуальный publish —
                        только владельцу + только для draft. С KS-2673
                        переведена на icon-action с зелёным акцентом —
                        чтобы все кнопки строки одинакового размера и
                        умещались в одну строку на mobile.
                        Текст в `aria-label`/`title`, локализован. */}
                    {isMine && isDraft && (
                      <button
                        type="button"
                        className="precision-card__icon-action precision-card__icon-action--publish"
                        data-testid="precision-card-publish"
                        onClick={() => void handlePublish(p.id)}
                        disabled={publishingId === p.id}
                        aria-label={
                          publishingId === p.id
                            ? t('precision.publishing', 'Publishing…')
                            : t(
                                'precision.actions.makePublic',
                                'Make public',
                              )
                        }
                        title={t(
                          'precision.actions.makePublic',
                          'Make public',
                        )}
                      >
                        <svg
                          className="precision-card__icon"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          focusable="false"
                        >
                          {/* eye-open: для public (toggle make-public) */}
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                    )}
                    {/* KS-2663/KS-2670: админка автора — Copy link /
                        Visibility toggle / Delete. Иконки в одну строку,
                        видны только владельцу. */}
                    {isMine && (
                      <button
                        type="button"
                        className="precision-card__icon-action precision-card__icon-action--copy"
                        data-testid="precision-card-copy-link"
                        onClick={() => void handleCopyLink(p)}
                        aria-label={t('precision.actions.copyLink', 'Copy link')}
                        title={t('precision.actions.copyLink', 'Copy link')}
                      >
                        <svg
                          className="precision-card__icon"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
                          <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
                        </svg>
                      </button>
                    )}
                    {/* Make private — для public; Make public — отдельная
                        Publish-кнопка выше (зелёная). */}
                    {isMine && p.isPublic !== false && (
                      <button
                        type="button"
                        className="precision-card__icon-action precision-card__icon-action--visibility"
                        data-testid="precision-card-make-private"
                        onClick={() => void handleToggleVisibility(p)}
                        disabled={
                          pendingActionId?.id === p.id &&
                          pendingActionId.action === 'visibility'
                        }
                        aria-label={
                          pendingActionId?.id === p.id &&
                          pendingActionId.action === 'visibility'
                            ? t('precision.actions.updating', 'Updating…')
                            : t(
                                'precision.actions.makePrivate',
                                'Make private',
                              )
                        }
                        title={t(
                          'precision.actions.makePrivate',
                          'Make private',
                        )}
                      >
                        <svg
                          className="precision-card__icon"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                          <path d="M1 1l22 22" />
                        </svg>
                      </button>
                    )}
                    {isMine && (
                      <button
                        type="button"
                        className="precision-card__icon-action precision-card__icon-action--delete"
                        data-testid="precision-card-delete"
                        onClick={() => void handleDelete(p)}
                        disabled={
                          pendingActionId?.id === p.id &&
                          pendingActionId.action === 'delete'
                        }
                        aria-label={
                          pendingActionId?.id === p.id &&
                          pendingActionId.action === 'delete'
                            ? t('precision.actions.deleting', 'Deleting…')
                            : t('precision.actions.delete', 'Delete')
                        }
                        title={t('precision.actions.delete', 'Delete')}
                      >
                        <svg
                          className="precision-card__icon"
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showGenerator && (
        <PuzzleGeneratorModal
          onClose={() => {
            setShowGenerator(false);
          }}
        />
      )}

      {/* KS-2663: floating toast для действий автора (copy link /
          visibility / delete). Образец из MyCoursesView (KS-2621). */}
      {toast && (
        <div
          className={`precision-toast precision-toast--${toast.tone}`}
          role="status"
          aria-live="polite"
          data-testid="precision-toast"
          data-tone={toast.tone}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
