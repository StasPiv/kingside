import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MainLayout } from './layouts/MainLayout';
import { LoginPage } from './pages/LoginPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { DocsUserCoursesPage } from './pages/DocsUserCoursesPage';
import { DiscoverCoursesPage } from './pages/DiscoverCoursesPage';
import { RegisterPage } from './pages/RegisterPage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { SettingsPage } from './pages/SettingsPage';
import { PuzzleBrowserPage } from './pages/PuzzleBrowserPage';
// KS-2484 (ADR-044): отдельный список play-vs-engine пазлов.
import { PrecisionPage } from './pages/PrecisionPage';
// KS-2719 F4 / ADR-056 §5: detail-страница одной precision-попытки.
import { PrecisionAttemptPage } from './pages/PrecisionAttemptPage';
import { PuzzleStatsPage } from './pages/PuzzleStatsPage';
import { PuzzlePage } from './pages/PuzzlePage';
import { PuzzleRushLeaderboardPage } from './pages/PuzzleRushLeaderboardPage';
import { PuzzleRushReviewPage } from './pages/PuzzleRushReviewPage';
import { WorkshopPage } from './pages/WorkshopPage';
import { BroadcastsPage } from './pages/BroadcastsPage';
import { BroadcastTournamentPage } from './pages/BroadcastTournamentPage';
import { BroadcastRoundPage } from './pages/BroadcastRoundPage';
import { BroadcastLiveGamePage } from './pages/BroadcastLiveGamePage';
import { PlayersPage } from './pages/PlayersPage';
import { PlayerProfilePage } from './pages/PlayerProfilePage';
import { MessagesPage } from './pages/MessagesPage';
import { LiveGamesPage } from './pages/LiveGamesPage';
import { WatchGamePage } from './pages/WatchGamePage';
import { ExternalEngineHelpPage } from './pages/ExternalEngineHelpPage';
import { OAuthCallbackPage } from './pages/OAuthCallbackPage';
import { FriendsPage } from './pages/FriendsPage';
import { TournamentsPage } from './pages/TournamentsPage';
import { TournamentLobbyPage } from './pages/TournamentLobbyPage';
import { DevBypassPage } from './pages/DevBypassPage';
import { PlayPage } from './pages/PlayPage';
import { FeedbackBoardPage } from './pages/FeedbackBoardPage';
import { FeedbackDetailPage } from './pages/FeedbackDetailPage';
import { LessonsPage } from './pages/LessonsPage';
import { CoursePage } from './pages/CoursePage';
import { MyActiveCoursesPage } from './pages/MyActiveCoursesPage';
// KS-2650: MyCoursesPage удалён, его UI теперь — таб «Мои» на /lessons.
// Старый маршрут `/lessons/my` редиректит на `/lessons?tab=mine`
// через `<Navigate>` ниже.
import { LessonPage } from './pages/LessonPage';
// KS-1928 / ADR-032: Дневник ошибок переехал в /puzzles namespace.
import { PuzzleMistakesPage } from './pages/PuzzleMistakesPage';
import { PuzzleMistakesPracticePage } from './pages/PuzzleMistakesPracticePage';
import { LessonEditorPage } from './pages/LessonEditorPage';
import { UserCourseEditor } from './components/lessons/editor/user/UserCourseEditor';
// KS-2645 (ADR-054 Phase D): UserCoursePage и UserLessonPage удалены —
// CoursePage / LessonPage теперь работают для обоих типов курсов
// (различение по `course.ownerId`). Старые маршруты `/lessons/my/:slug`
// и `/lessons/my/:slug/:lessonId` редиректят на унифицированные пути
// через `<RedirectMyCourse />` / `<RedirectMyLesson />` ниже —
// сохраняем входящие ссылки.
// KS-2066 (F0/ADR-033 §2): namespace архива — заглушки.
// ArchiveLobbyPage удалён — /archive теперь напрямую показывает ArchiveGamesPage (KS-2210)
import { ArchiveGamesPage } from './pages/ArchiveGamesPage';
import { ArchivePlayerProfilePage } from './pages/ArchivePlayerProfilePage';
import { TermsOfServicePage } from './pages/TermsOfServicePage';
import { ArchiveGamePage } from './pages/ArchiveGamePage';
// KS-2232 (Drills E3): лобби тренажёров /drills под `drillsEnabled`.
import { DrillsLobbyPage } from './pages/DrillsLobbyPage';
// KS-2233 (Drills E3): страница drill /drills/:type под тем же флагом.
import { DrillPage } from './pages/DrillPage';
// KS-2241 (Drills E4): sprint setup/play/results.
import { DrillSprintSetupPage } from './pages/DrillSprintSetupPage';
import { DrillSprintPlayPage } from './pages/DrillSprintPlayPage';
import { DrillSprintResultsPage } from './pages/DrillSprintResultsPage';
// KS-2242 (Drills E4): лидерборд sprint.
import { DrillLeaderboardPage } from './pages/DrillLeaderboardPage';
// KS-2418: публичная страница «Как работают тренажёры».
import { DrillsAboutPage } from './pages/DrillsAboutPage';
import { useAuth } from './context/AuthContext';
import { api } from './api';
import { useFeatureFlag, useFeatureFlags } from './context/FeatureFlagsContext';
// KS-2373: трекаем посещаемость whitelist-разделов, дебаунс ~3.5с.
// Хук подключается один раз на всё приложение.
import { useTrackNavStats } from './hooks/useNavStats';
import { useAdminStatus } from './hooks/useAdminStatus';
import { AdminFeatureFlagsPage } from './pages/AdminFeatureFlagsPage';
import {
  consumeAuthReturnUrl,
  setAuthReturnUrl,
} from './utils/authReturnUrl';

// Lazy-loaded heavy pages
// KS-2747 / ADR-057 §2.1: /precision/stats и /precision/history содержат
// тяжёлые блоки (PrecisionTrendsChart, PrecisionBreakdowns,
// PrecisionAttemptsList с превью досок) — выносим в отдельные чанки,
// чтобы вход на главную /precision не тянул их.
const PrecisionStatsPage = lazy(() =>
  import('./pages/PrecisionStatsPage').then((m) => ({
    default: m.PrecisionStatsPage,
  })),
);
const PrecisionHistoryPage = lazy(() =>
  import('./pages/PrecisionHistoryPage').then((m) => ({
    default: m.PrecisionHistoryPage,
  })),
);
const AnalysisPage = lazy(() => import('./pages/AnalysisPage').then(m => ({ default: m.AnalysisPage })));
// KS-2672: для публичной ссылки используем тот же AnalysisPage с
// `publicMode=true` (читает через `GET /analyses/public/:id`,
// автосохранение/edit-title/share отключены). Отдельный компонент
// `PublicAnalysisPage` упразднён.
const BroadcastGamePage = lazy(() => import('./pages/BroadcastGamePage').then(m => ({ default: m.BroadcastGamePage })));
const PuzzleRushPage = lazy(() => import('./pages/PuzzleRushPage').then(m => ({ default: m.PuzzleRushPage })));
// KS-2796/KS-2797 (ADR-058 §6.1 T1, T2): лобби-страницы группы
// «Тренировка» и «Анализ». Lazy — чтобы не тянуть их JS при заходе
// на не-смежные маршруты.
const TrainLobbyPage = lazy(() =>
  import('./pages/TrainLobbyPage').then((m) => ({ default: m.TrainLobbyPage })),
);
const AnalyzeLobbyPage = lazy(() =>
  import('./pages/AnalyzeLobbyPage').then((m) => ({ default: m.AnalyzeLobbyPage })),
);
// KS-2825 (KS-2815 §B.5): каталог студий `/studies` (Мои/Публичные).
const StudiesPage = lazy(() =>
  import('./pages/StudiesPage').then((m) => ({ default: m.StudiesPage })),
);
// KS-2826 (KS-2815 §B.5): детальная страница студии `/studies/:slug`.
const StudyPage = lazy(() =>
  import('./pages/StudyPage').then((m) => ({ default: m.StudyPage })),
);
// KS-2889 (ADR-060 FC4): студии конкретного автора `/studies/by/:userId`.
const UserStudiesPage = lazy(() =>
  import('./pages/UserStudiesPage').then((m) => ({
    default: m.UserStudiesPage,
  })),
);
// KS-2893 (ADR-060 FC8): accept-flow для приглашения в студию.
const StudyInviteAcceptPage = lazy(() =>
  import('./pages/StudyInviteAcceptPage').then((m) => ({
    default: m.StudyInviteAcceptPage,
  })),
);
// KS-2868 (FS1) / KS-2869 (FS2): редактор и публичный просмотр главы
// студии теперь рендерятся универсальным AnalysisPage в режимах
// studyMode='editor' / 'public-readonly'. Старые лeniwe-импорты
// StudyChapterEditorPage / StudyChapterPublicPage удалены вместе с
// файлами компонентов.
// KS-2068 (F2): `ArchiveGamesByPositionPage` больше не lazy-роут —
// он используется как внутренний компонент `ArchiveGamesPage`
// (by-position режим единого `/archive/games`).

// KS-1821: dev-маршруты за compile-time guard `import.meta.env.DEV`.
// Vite при prod-сборке инлайнит константу в `false`, тернарник сворачивается
// в `null`, вложенный `import('./dev/DevRoutes')` становится мёртвым ещё до
// rollup'а — вся поддерево dev-страниц (включая `DevReviewsUiPage`,
// `DevPlayoffBracketPage` и т.д.) tree-shake'ается и в prod-бандл не
// попадает ни чанком, ни ссылкой.
const DevRoutesLazy = import.meta.env.DEV
  ? lazy(() => import('./dev/DevRoutes'))
  : null;

function LazyFallback() {
  const { t } = useTranslation();
  return <div className="loading">{t('common.loading')}</div>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (!user) {
    // KS-2110: сохраняем точный путь+query в sessionStorage перед
    // редиректом — `state` через react-router не выживает OAuth-флоу
    // (`window.location.href = '/auth/google'` уносит браузер целиком).
    const returnUrl = `${location.pathname}${location.search}`;
    setAuthReturnUrl(returnUrl);
    return (
      <Navigate
        to="/login"
        state={{ returnUrl: location.pathname }}
        replace
      />
    );
  }
  return <>{children}</>;
}

/**
 * KS-2109 — admin-only маршрут. Гости и не-админы редиректятся на
 * корень. Источник правды — `useAdminStatus` (`GET /profile/me/admin-status`).
 * Реальная авторизация эндпоинтов админки — на бэке (KS-2108
 * `AdminUserGuard`); фронт-проверка нужна, чтобы не светить страницу,
 * которая всё равно покажет пустой/error-state не-админу.
 */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { isAdmin, loading: adminLoading } = useAdminStatus();
  const { t } = useTranslation();
  const location = useLocation();
  if (authLoading || adminLoading) {
    return <div className="loading">{t('common.loading')}</div>;
  }
  if (!user) {
    return (
      <Navigate to="/login" state={{ returnUrl: location.pathname }} replace />
    );
  }
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function GuestRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (user) {
    // KS-2110: если уже залогинен и заходит на /login — отправляем
    // на сохранённый returnUrl (одноразово, чтобы не зацикливалось).
    const returnUrl = consumeAuthReturnUrl();
    return <Navigate to={returnUrl ?? '/lobby'} replace />;
  }
  return <>{children}</>;
}

/**
 * KS-1928 / ADR-032: 301-redirect с сохранением query.
 * Для переездов URL'ов между namespace-ами (например
 * `/lessons/mistakes?theme=pin` → `/puzzles/mistakes?theme=pin`).
 *
 * `<Navigate replace>` сам по себе query не сохраняет — нужна явная
 * подмешка `location.search` в target.
 */
function RedirectWithQuery({ to }: { to: string }) {
  const location = useLocation();
  const target = location.search ? `${to}${location.search}` : to;
  return <Navigate to={target} replace />;
}

/**
 * KS-2645 (ADR-054 Phase D): редирект `/lessons/my/:slug` →
 * `/lessons/:slug`. CoursePage сам решит, что курс пользовательский,
 * по `course.ownerId`. Search-параметры сохраняем (хотя у этого URL'а
 * их обычно нет).
 */
function RedirectMyCourse() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const target = `/lessons/${slug ?? ''}${location.search}`;
  return <Navigate to={target} replace />;
}

/**
 * KS-2645 (ADR-054 Phase D): редирект `/lessons/my/:slug/:lessonId` →
 * `/lessons/:slug/:lessonId`. LessonPage найдёт урок по UUID
 * (а не по slug, как в системных курсах) — этот случай явно поддержан
 * в `LessonPage.useEffect` lookup'е.
 */
function RedirectMyLesson() {
  const { slug, lessonId } = useParams<{ slug: string; lessonId: string }>();
  const location = useLocation();
  const target = `/lessons/${slug ?? ''}/${lessonId ?? ''}${location.search}`;
  return <Navigate to={target} replace />;
}

/**
 * KS-2810 (ADR-058 §4.4, §6.5 T13): авторизованный пользователь на
 * корневом `/` сразу попадает на `/play` (вместо устаревшего `/lobby`).
 * `/lobby` остаётся доступен по прямому URL — это не редирект на
 * уровне роута, а только переадресация с index'а.
 * Гостю по-прежнему показывается лендинг (`FeaturesPage`).
 */
function HomePage() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="loading">{t('common.loading')}</div>;
  return user ? <Navigate to="/play" replace /> : <FeaturesPage />;
}

function ProfileRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/" replace />;
  return <Navigate to={`/player/${user.username}`} replace />;
}

function InviteRedirect() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    api.post<{ tournamentId: string }>(`/arena/invite/${code}`, {})
      .then((data) => navigate(`/tournaments/${data.tournamentId}`, { replace: true }))
      .catch(() => setError(t('tournaments.inviteInvalid', 'Invalid or expired invite link')));
  }, [code, navigate, t]);

  if (error) return <div className="error">{error}</div>;
  return <div className="loading">{t('common.loading')}</div>;
}

export function App() {
  const [searchParams] = useSearchParams();
  const devSecret = import.meta.env.VITE_DEV_BYPASS_SECRET;

  const location = useLocation();
  const { t } = useTranslation();
  // KS-2331: чтобы избежать редиректа `/drills → /lobby` при F5 (когда
  // флаги ещё не подгружены и `drillsEnabled` стартует как `false`-дефолт),
  // блокируем рендер `<Routes>` до завершения первого `/config`-запроса.
  // Cache в localStorage делает большинство rerender'ов мгновенными, но
  // на первом холодном заходе мы один раз показываем `loading`-плейсхолдер
  // вместо «не того» маршрута. Решает класс ошибок для всех guard'ов под
  // флагами (puzzles / broadcasts / tournaments / drills / lessons).
  const { loading: flagsLoading } = useFeatureFlags();
  // KS-2373: nav-stats incrementer (no-op без auth; дебаунс ~3.5с).
  useTrackNavStats();
  // KS-2105: runtime флаг «Уроки» — через FeatureFlagsContext
  // (источник правды backend `GET /config`). До этого тикета здесь
  // дёргался build-time `isLessonsEnabledLive()`, который требовал
  // rebuild + redeploy при смене.
  const lessonsEnabled = useFeatureFlag('lessonsEnabled');
  // KS-2218: runtime-флаги для разделов «Задачи» / «Трансляции» / «Турниры».
  // При выключенном флаге соответствующие маршруты редиректят на
  // `/lobby`, чтобы из старых ссылок пользователь не застревал на 404.
  // `/puzzle-rush*` намеренно НЕ под `puzzlesEnabled` — отдельный раздел.
  const puzzlesEnabled = useFeatureFlag('puzzlesEnabled');
  const broadcastsEnabled = useFeatureFlag('broadcastsEnabled');
  const tournamentsEnabled = useFeatureFlag('tournamentsEnabled');
  // KS-2232 (ADR-035 §7): лобби `/drills` доступно только при
  // `drillsEnabled=true` (KS-2231). Default false → старые ссылки
  // редиректят на /lobby по образцу puzzles/broadcasts/tournaments.
  const drillsEnabled = useFeatureFlag('drillsEnabled');

  if (devSecret && searchParams.has('dev_bypass')) {
    const returnParams = new URLSearchParams(searchParams);
    returnParams.delete('dev_bypass');
    returnParams.delete('user');
    const returnSearch = returnParams.toString();
    const returnTo = returnSearch ? `${location.pathname}?${returnSearch}` : location.pathname;
    return <DevBypassPage secret={searchParams.get('dev_bypass') ?? ''} user={searchParams.get('user') ?? undefined} returnTo={returnTo} />;
  }

  // KS-2331: feature-flag guard'ы рендерят `<Navigate>` синхронно при
  // первом рендере. Если флаги ещё не пришли с `/config` — `<Navigate>`
  // успевает переписать URL на `/lobby`. Поэтому держим текущий маршрут
  // до завершения первой загрузки.
  if (flagsLoading) {
    return <div className="loading">{t('common.loading')}</div>;
  }

  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route index element={<HomePage />} />
        <Route path="/features" element={<FeaturesPage />} />
        {/* KS-1895: публичная документация — без ProtectedRoute */}
        <Route path="/docs/user-courses" element={<DocsUserCoursesPage />} />
        {/* KS-2169 (F4): публичные условия использования. */}
        <Route path="/terms" element={<TermsOfServicePage />} />
        <Route path="/terms-of-service" element={<TermsOfServicePage />} />
        <Route path="/login" element={<GuestRoute><LoginPage /></GuestRoute>} />
        <Route path="/register" element={<GuestRoute><RegisterPage /></GuestRoute>} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        <Route path="/lobby" element={<LobbyPage />} />
        <Route path="/play" element={<ProtectedRoute><PlayPage /></ProtectedRoute>} />
        {/* KS-2796 / KS-2797 (ADR-058 §6.1 T3): лобби-страницы
            тренировочной и аналитической групп. Без ProtectedRoute —
            видимы и гостям; gating отдельных модулей — внутри страниц
            и/или дочерних маршрутов. Lazy + Suspense — отдельные чанки,
            не тянем JS на смежных маршрутах. */}
        <Route
          path="/train"
          element={
            <Suspense fallback={<LazyFallback />}>
              <TrainLobbyPage />
            </Suspense>
          }
        />
        <Route
          path="/analyze"
          element={
            <Suspense fallback={<LazyFallback />}>
              <AnalyzeLobbyPage />
            </Suspense>
          }
        />
        {/* KS-2825 (KS-2815 §B.5): каталог Studies. Без ProtectedRoute —
            публичные студии видны и гостям; таб «Мои» в UI рендерится
            только для авторизованных. */}
        <Route
          path="/studies"
          element={
            <Suspense fallback={<LazyFallback />}>
              <StudiesPage />
            </Suspense>
          }
        />
        {/* KS-2889 (ADR-060 FC4): студии конкретного автора. Path
            идёт ВЫШЕ `/studies/:slug`, потому что роутер матчит по
            порядку и `:slug` иначе перехватит `by/...`. */}
        <Route
          path="/studies/by/:userId"
          element={
            <Suspense fallback={<LazyFallback />}>
              <UserStudiesPage />
            </Suspense>
          }
        />
        {/* KS-2893 (ADR-060 FC8): принять приглашение по токену.
            Idem — выше `/studies/:slug`, чтобы slug не перехватил
            `invites/...`. */}
        <Route
          path="/studies/invites/:token"
          element={
            <Suspense fallback={<LazyFallback />}>
              <StudyInviteAcceptPage />
            </Suspense>
          }
        />
        {/* KS-2826: детальная страница студии. Owner-actions показываются
            только если `user.id === study.ownerId` (решает сам компонент). */}
        <Route
          path="/studies/:slug"
          element={
            <Suspense fallback={<LazyFallback />}>
              <StudyPage />
            </Suspense>
          }
        />
        {/* KS-3014: роуты chapter-страниц (editor, public-readonly,
            gamebook reader) временно отключены — Studies переезжают на
            отдельную страницу прохождения, не связанную с AnalysisPage. */}
        <Route path="/games/live" element={<LiveGamesPage />} />
        <Route path="/games/:id/watch" element={<WatchGamePage />} />
        <Route path="/game/:id" element={<ProtectedRoute><GamePage /></ProtectedRoute>} />
        <Route path="/game/:gameId/review" element={<Suspense fallback={<LazyFallback />}><AnalysisPage /></Suspense>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        {/* KS-2109: админ-страница feature-flags. Только для админов
            (whitelist `KS_ADMIN_USERS` на бэке). */}
        <Route
          path="/admin/feature-flags"
          element={<AdminRoute><AdminFeatureFlagsPage /></AdminRoute>}
        />
        {/* KS-2218: `/puzzle-rush*` — отдельный раздел, ВНЕ `puzzlesEnabled`. */}
        <Route path="/puzzle-rush" element={<ProtectedRoute><Suspense fallback={<LazyFallback />}><PuzzleRushPage /></Suspense></ProtectedRoute>} />
        <Route path="/puzzle-rush/leaderboard" element={<PuzzleRushLeaderboardPage />} />
        <Route path="/puzzle-rush/review/:scoreId" element={<ProtectedRoute><PuzzleRushReviewPage /></ProtectedRoute>} />
        {/* KS-2218: `/puzzles/rush` — алиас на `/puzzle-rush`. Оставляем
            всегда, чтобы внешние ссылки на старый URL не ломались даже
            при `puzzlesEnabled=false`. Точный путь матчится раньше
            wildcard-guard'а ниже. */}
        <Route path="/puzzles/rush" element={<Navigate to="/puzzle-rush" replace />} />
        {/* KS-2538 / ADR-048: алиас `/puzzles/play-vs-engine` →
            `/precision` (с сохранением query). Стоит ВЫШЕ wildcard-
            guard'а `/puzzles/*` (см. else-ветку ниже), чтобы при
            `puzzlesEnabled=false` редирект всё равно сработал — иначе
            wildcard поглотил бы путь и увёл в /lobby. Само наполнение
            раздела `/precision` ниже под флагом. */}
        <Route path="/puzzles/play-vs-engine" element={<RedirectWithQuery to="/precision" />} />
        {/* KS-2613: маршрут /daily («Задача дня») удалён по требованию
            пользователя. Старые ссылки/закладки/SEO-индексы редиректим
            на /puzzles, чтобы не возвращать 404 — редирект работает
            одинаково при любом значении puzzlesEnabled (если фича
            выключена, /puzzles ниже под guard'ом сам уйдёт в /lobby). */}
        <Route path="/daily" element={<Navigate to="/puzzles" replace />} />
        <Route path="/daily/*" element={<Navigate to="/puzzles" replace />} />
        {puzzlesEnabled ? (
          <>
            <Route path="/puzzles" element={<PuzzleBrowserPage />} />
            {/* KS-2538 / ADR-048: новый каноничный роут раздела. */}
            <Route path="/precision" element={<PrecisionPage />} />
            {/* KS-2747 / ADR-057 §2.2: вынос статистики и истории
                на отдельные страницы (KS-2744 / KS-2745). Обе через
                lazy() — отдельные чанки, не тянем при заходе на главную
                /precision (там сразу сетка позиций для тренировки). */}
            <Route
              path="/precision/stats"
              element={
                <Suspense fallback={<LazyFallback />}>
                  <PrecisionStatsPage />
                </Suspense>
              }
            />
            <Route
              path="/precision/history"
              element={
                <Suspense fallback={<LazyFallback />}>
                  <PrecisionHistoryPage />
                </Suspense>
              }
            />
            {/* KS-2719 F4 / ADR-056 §5: detail-страница попытки. */}
            <Route
              path="/precision/attempts/:id"
              element={<PrecisionAttemptPage />}
            />
            <Route path="/puzzles/stats" element={<PuzzleStatsPage />} />
            {/* KS-1928 / ADR-032: дневник ошибок в puzzle namespace. */}
            <Route path="/puzzles/mistakes" element={<ProtectedRoute><PuzzleMistakesPage /></ProtectedRoute>} />
            <Route path="/puzzles/mistakes-practice" element={<ProtectedRoute><PuzzleMistakesPracticePage /></ProtectedRoute>} />
            <Route path="/puzzle" element={<PuzzlePage />} />
            <Route path="/puzzle/:id" element={<PuzzlePage />} />
          </>
        ) : (
          // KS-2218: при выключенном флаге раздел «Задачи» полностью
          // недоступен — старые ссылки уводят пользователя в лобби.
          // KS-2613: `/daily` обрабатывается выше, тут уже не нужен.
          <>
            <Route path="/puzzles/*" element={<Navigate to="/lobby" replace />} />
            <Route path="/puzzle/*" element={<Navigate to="/lobby" replace />} />
          </>
        )}
        {lessonsEnabled ? (
          <>
            <Route path="/lessons" element={<ProtectedRoute><LessonsPage /></ProtectedRoute>} />
            {/* KS-1941 (F-4): «Мои активные курсы» — страница со всеми
                активными прогрессами пользователя. */}
            <Route
              path="/lessons/my-active"
              element={<ProtectedRoute><MyActiveCoursesPage /></ProtectedRoute>}
            />
            {/* KS-1923 / ADR-031 §3: Discover-страница, без auth (каталог открыт гостям). */}
            <Route path="/lessons/discover" element={<DiscoverCoursesPage />} />
            <Route path="/lessons/editor" element={<ProtectedRoute><LessonEditorPage /></ProtectedRoute>} />
            {/* KS-2650: страница «Мои курсы» сожжена в таб
                `/lessons?tab=mine`. Старый URL редиректит на новый.
                Должна стоять ВЫШЕ wildcard'а `/lessons/:courseSlug`
                ниже, иначе тот перехватит `/lessons/my`. */}
            <Route
              path="/lessons/my"
              element={
                <ProtectedRoute>
                  <Navigate to="/lessons?tab=mine" replace />
                </ProtectedRoute>
              }
            />
            <Route path="/lessons/my/:slug/edit" element={<ProtectedRoute><UserCourseEditor /></ProtectedRoute>} />
            {/* KS-2645: старые маршруты `/lessons/my/:slug[/:lessonId]`
                редиректят на унифицированные `/lessons/:slug[/:lessonId]`.
                CoursePage и LessonPage сами решают по `course.ownerId`,
                какой UI рисовать. Сохраняем replace=true, чтобы
                back-кнопка не возвращала на legacy URL. */}
            <Route path="/lessons/my/:slug" element={<RedirectMyCourse />} />
            <Route
              path="/lessons/my/:slug/:lessonId"
              element={
                <ProtectedRoute>
                  <RedirectMyLesson />
                </ProtectedRoute>
              }
            />
            {/* KS-1928 / ADR-032: 301-redirect старого расположения дневника
                ошибок в /puzzles namespace. Сохраняем query (например ?theme=pin)
                через `useLocation().search`. */}
            <Route
              path="/lessons/mistakes"
              element={<RedirectWithQuery to="/puzzles/mistakes" />}
            />
            <Route
              path="/lessons/mistakes-practice"
              element={<RedirectWithQuery to="/puzzles/mistakes-practice" />}
            />
            <Route path="/lessons/:courseSlug" element={<ProtectedRoute><CoursePage /></ProtectedRoute>} />
            <Route path="/lessons/:courseSlug/:lessonSlug" element={<ProtectedRoute><LessonPage /></ProtectedRoute>} />
          </>
        ) : (
          // KS-1820: при выключенном флаге все lessons-маршруты
          // редиректят на корень (не просто 404 — чтобы пользователь
          // из старых ссылок не застревал).
          <Route path="/lessons/*" element={<Navigate to="/" replace />} />
        )}
        {/* KS-2232 / KS-2233 / KS-2241 (ADR-035 §5, §5.5, §7): drill-маршруты под drillsEnabled. */}
        {drillsEnabled ? (
          <>
            <Route path="/drills" element={<DrillsLobbyPage />} />
            {/* KS-2418: публичная страница «Как работают тренажёры».
                Размещаем ВЫШЕ `/drills/:type`, иначе about будет
                сматчен как drill-type и редиректнут. */}
            <Route path="/drills/about" element={<DrillsAboutPage />} />
            {/* KS-2241: sprint setup/play/results размещаем ВЫШЕ
                `/drills/:type`, иначе React Router сматчит «sprint»
                как drill-type. */}
            <Route path="/drills/sprint" element={<DrillSprintSetupPage />} />
            <Route path="/drills/sprint/play" element={<DrillSprintPlayPage />} />
            <Route path="/drills/sprint/results" element={<DrillSprintResultsPage />} />
            {/* KS-2242: лидерборд sprint. */}
            <Route path="/drills/sprint/leaderboard" element={<DrillLeaderboardPage />} />
            <Route path="/drills/:type" element={<DrillPage />} />
          </>
        ) : (
          // По образцу KS-2218: всё `/drills*` уводит в /lobby при
          // выключенном флаге.
          <Route path="/drills/*" element={<Navigate to="/lobby" replace />} />
        )}
        {/* KS-1821: compile-time guard. `DevRoutesLazy` = null в prod-сборке,
            поэтому Route не рендерится и мёртвая ветка с импортом
            `./dev/DevRoutes` уходит tree-shake'ом. Внутренние подпути (
            `/dev/position-step`, `/dev/reviews-ui`, …) обрабатываются
            суб-роутером внутри `DevRoutes`. */}
        {DevRoutesLazy && (
          <Route
            path="/dev/*"
            element={
              <Suspense fallback={<LazyFallback />}>
                <DevRoutesLazy />
              </Suspense>
            }
          />
        )}
        <Route path="/feedback" element={<FeedbackBoardPage />} />
        <Route path="/feedback/:id" element={<FeedbackDetailPage />} />
        {/* KS-2218: `/puzzle` и `/puzzle/:id` перенесены в puzzle-блок выше,
            чтобы при `puzzlesEnabled=false` редирект на /lobby сработал. */}
        <Route path="/analysis" element={<Suspense fallback={<LazyFallback />}><AnalysisPage /></Suspense>} />
        <Route path="/help/external-engine" element={<ExternalEngineHelpPage />} />
        {/* KS-2666/KS-2672: публичный read-only анализ — тот же
            AnalysisPage с `publicMode=true` (без auth-guard, грузит
            через public-эндпоинт). Должно стоять ВЫШЕ `/analysis/:id`,
            иначе обычный AnalysisPage попытается загрузить `public`
            как id и упрётся в 404. */}
        <Route
          path="/analysis/public/:id"
          element={
            <Suspense fallback={<LazyFallback />}>
              <AnalysisPage publicMode />
            </Suspense>
          }
        />
        <Route path="/analysis/:id" element={<Suspense fallback={<LazyFallback />}><AnalysisPage /></Suspense>} />
        <Route path="/workshop" element={<WorkshopPage />} />
        <Route path="/workshop/pgn-files" element={<WorkshopPage />} />
        <Route path="/workshop/pgn-files/:fileId" element={<WorkshopPage />} />
        <Route path="/players" element={<PlayersPage />} />
        <Route path="/player/:username" element={<PlayerProfilePage />} />
        <Route path="/friends" element={<ProtectedRoute><FriendsPage /></ProtectedRoute>} />
        <Route path="/messages" element={<ProtectedRoute><MessagesPage /></ProtectedRoute>} />
        <Route path="/messages/:userId" element={<ProtectedRoute><MessagesPage /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><ProfileRedirect /></ProtectedRoute>} />
        {tournamentsEnabled ? (
          <>
            <Route path="/tournaments" element={<TournamentsPage />} />
            <Route path="/tournaments/:id" element={<TournamentLobbyPage />} />
            <Route path="/arena/:id" element={<TournamentLobbyPage />} />
            <Route path="/t/:code" element={<ProtectedRoute><InviteRedirect /></ProtectedRoute>} />
          </>
        ) : (
          // KS-2218: при выключенном `tournamentsEnabled` пользователь
          // не должен попадать ни на список, ни на lobby/arena/инвайт.
          <>
            <Route path="/tournaments/*" element={<Navigate to="/lobby" replace />} />
            <Route path="/arena/*" element={<Navigate to="/lobby" replace />} />
            <Route path="/t/*" element={<Navigate to="/lobby" replace />} />
          </>
        )}
        {/* KS-2066 (F0/ADR-033 §2): namespace архива партий.
            • `/archive` — список партий с фильтрами (metadata + by-position).
            • `/archive/games` — редирект на `/archive` (backward compat).
            • `/archive/players/:slug` — профиль игрока (F3)
            • `/archive/games/:id` — одна партия (F4)
            • `/archive/by-position` — legacy-URL, редирект на `/archive`. */}
        <Route path="/archive" element={<ArchiveGamesPage />} />
        <Route path="/archive/games" element={<Navigate to="/archive" replace />} />
        <Route path="/archive/games/:id" element={<ArchiveGamePage />} />
        <Route path="/archive/players/:slug" element={<ArchivePlayerProfilePage />} />
        <Route
          path="/archive/by-position"
          element={<RedirectWithQuery to="/archive" />}
        />
        {broadcastsEnabled ? (
          <>
            <Route path="/broadcasts" element={<BroadcastsPage />} />
            <Route path="/broadcasts/:tournamentId" element={<BroadcastTournamentPage />} />
            <Route path="/broadcasts/:tournamentId/:roundId" element={<BroadcastRoundPage />} />
            {/* KS-2448: live-режим просмотра партии — отдельный route с
                подпиской на 15s polling. `/broadcasts/:tid/:rid/:gid` без
                /live остаётся прежним лаунчером в Мастерскую (используется
                кнопкой «Открыть в Мастерской» и shareable-ссылками). */}
            <Route path="/broadcasts/:tournamentId/:roundId/:gameId/live" element={<BroadcastLiveGamePage />} />
            <Route path="/broadcasts/:tournamentId/:roundId/:gameId" element={<Suspense fallback={<LazyFallback />}><BroadcastGamePage /></Suspense>} />
          </>
        ) : (
          // KS-2218: при выключенном `broadcastsEnabled` любой
          // /broadcasts/* уводит в лобби.
          <Route path="/broadcasts/*" element={<Navigate to="/lobby" replace />} />
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
