import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// KS-4464. Переключатель языка должен переписывать URL'ы, у которых
// первый сегмент — локаль (`/<lang>/blog/...`), иначе после
// `i18n.changeLanguage` страница тут же подтягивает старую локаль из
// URL (BlogFeedPage/BlogPostPage синхронизируют `i18n.language` из
// `useParams`). Хелпер общий — поддержит будущие префиксные разделы.
import { rewriteLangPrefix } from '../utils/langPath';
import { toBlogLocale } from '../utils/blogUrl';
import { FcGoogle } from 'react-icons/fc';
import { FaFacebook, FaTelegram, FaCode, FaEnvelope, FaBell, FaUserFriends } from 'react-icons/fa';
import { useAuth } from '../context/AuthContext';
import { useFocusMode } from '../context/FocusModeContext';
import { api } from '../api';
import { useChallenge } from '../hooks/useChallenge';
import { useNotifications } from '../hooks/useNotifications';
import { useActiveGame } from '../hooks/useActiveGame';
import { IncomingChallengeToast } from '../components/IncomingChallengeToast';
import { NotificationDropdown } from '../components/NotificationDropdown';
import { MobileBottomBar } from '../components/MobileBottomBar';
import { Sidebar } from '../components/Sidebar';
import { ThemeToggle } from '../components/ThemeToggle';
// KS-4589. Inline-SVG логотипа Patreon (для кнопки в шапке).
import { PatreonLogo } from '../components/PatreonLogo';
import { redirectToTelegramOAuth } from '../utils/telegramOAuth';
import { ChatWidget } from '../components/ChatWidget';
import { CookieBanner } from '../components/cookie-banner/CookieBanner';
import { EventsBootstrap } from '../lib/eventsBootstrap';
import { HintHost } from '../components/hints/HintHost';
import { InfoBar, InfoBarProvider } from '../components/info-bar/InfoBar';

const DEV_BYPASS_SECRET = import.meta.env.VITE_DEV_BYPASS_SECRET;
const isLocalhost = window.location.hostname === 'localhost';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      handler();
    };
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [ref, handler]);
}

export function MainLayout() {
  const { user, logout } = useAuth();
  const { t, i18n } = useTranslation();
  // KS-3188 (ADR-073 §7 F1): focus-mode для шагов вроде game-партии на
  // mobile. Активность — глобальный контекст, реальное визуальное
  // переключение делает CSS через `@media (max-width: 767px)` на классе
  // `.app.focus-mode-active`. Desktop не трогаем по условию задачи.
  const { active: focusModeActive, disable: disableFocusMode } = useFocusMode();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const { incoming, acceptChallenge, declineChallenge } = useChallenge();
  const [notifOpen, setNotifOpen] = useState(false);
  const {
    notifications,
    unreadCount: notifUnreadCount,
    loading: notifLoading,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
  } = useNotifications(!!user);
  const { activeGame } = useActiveGame(!!user);

  const handleNotifToggle = useCallback(() => {
    setNotifOpen((prev) => {
      if (!prev) fetchNotifications();
      return !prev;
    });
  }, [fetchNotifications]);

  const handleNotifClose = useCallback(() => setNotifOpen(false), []);

  const userMenuRef = useRef<HTMLDivElement>(null);

  useClickOutside(userMenuRef, () => setUserMenuOpen(false));

  // Poll unread message count via REST (no WS dependency)
  useEffect(() => {
    if (!user) { setUnreadCount(0); return; }
    const fetchUnread = () => {
      api.get<{ count: number }>('/messages/unread-count')
        .then((data) => setUnreadCount(data.count))
        .catch(() => {});
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 15_000);

    const onMessagesRead = () => fetchUnread();
    window.addEventListener('messages:read', onMessagesRead);

    return () => {
      clearInterval(interval);
      window.removeEventListener('messages:read', onMessagesRead);
    };
  }, [user]);

  // Online players count
  const [onlineCount, setOnlineCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchCount = () => {
      fetch(`${API_URL}/players/online?limit=1`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: { total?: number } | null) => {
          if (data?.total != null) setOnlineCount(data.total);
        })
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

  const [appVersion, setAppVersion] = useState('');

  // KS-4183 / ADR-128 §7.6.1: больше не подменяем `document.title` —
  // он конфликтовал с `<SeoHelmet>`, который ставит per-page title.
  // Версия отображается отдельным элементом в шапке/футере (state
  // `appVersion` остаётся доступен).
  useEffect(() => {
    fetch('/version.json')
      .then((r) => r.json())
      .then((data: { version: string }) => {
        setAppVersion(data.version);
      })
      .catch(() => {});
  }, []);

  const location = useLocation();
  const navigate = useNavigate();

  const closeAll = () => {
    setUserMenuOpen(false);
  };

  // Hide mobile bottom bar during active game (sidebar always visible).
  // KS-4299: `/play/local-bot` использует ту же `GameShell` с
  // `<GameActionBar>` (Сдаться / Ничья / Чат / Ещё). Стационарное
  // нижнее меню (Анализ / Тренировка / Играть / Ещё) перекрывало бы
  // действия партии и удваивало нижнюю панель. Скрываем его и здесь,
  // как уже скрыто на `/game/<id>`.
  const hideBottomBar =
    location.pathname.startsWith('/game/') ||
    location.pathname.startsWith('/play/local-bot');
  // KS-4287 / ADR-134 §5: AI ChatWidget FAB перекрывает кнопки действий
  // на странице партии и параллельный AI-чат во время игры не нужен —
  // полностью убираем виджет из DOM на `/game/:id` и `/play/local-bot`.
  const hideAssistantFab =
    location.pathname.startsWith('/game/') ||
    location.pathname.startsWith('/play/local-bot');

  return (
    <InfoBarProvider>
    <div
      className={`app${focusModeActive ? ' focus-mode-active' : ''}`}
      data-focus-mode={focusModeActive ? 'true' : 'false'}
    >
      {/* KS-4323: баннер «Доступна новая версия» удалён — был
          временным решением KS-4307. Обновление SW штатно идёт через
          visibility:hidden или 10-минутный авто-reload (см. main.tsx
          обработчик `controllerchange`). */}
      {/* KS-3188: compact-header виден только на mobile при focus-mode-
          active (см. CSS). Один пункт «← Назад к уроку» отключает фокус-
          режим — у пользователя нет других обязательных действий внутри
          шага game (Stockfish/tree/explorer уже на странице урока), а
          обычный header остаётся одной кнопкой возврата. */}
      <header
        className="header header--focus-compact"
        data-testid="main-layout-focus-compact-header"
        aria-hidden={!focusModeActive}
      >
        <button
          type="button"
          className="header--focus-compact__back"
          data-testid="main-layout-focus-back"
          onClick={disableFocusMode}
        >
          {t('focusMode.backToLesson', '← Back to lesson')}
        </button>
      </header>
      <header className="header">
        <nav className="header-nav">
          {/* LEFT: Logo */}
          <div className="header-left">
            <Link to="/" className="logo" onClick={closeAll} title={appVersion ? `v.${appVersion}` : undefined}>
              Kingside <span className="logo-beta">Beta</span>
            </Link>
          </div>

          {/* RIGHT: Utilities + Profile */}
          <div className="header-right">
            {activeGame && !location.pathname.startsWith(`/game/${activeGame.gameId}`) && (
              <Link to={`/game/${activeGame.gameId}`} className="active-game-btn">
                {t('nav.backToGame', 'Back to game')}
              </Link>
            )}
            {/* Bell + Messages: always visible (even mobile) */}
            {user && (
              <div className="nav-notification-wrapper">
                <button
                  className="header-icon-btn"
                  onClick={handleNotifToggle}
                  title={t('notifications.title', 'Notifications')}
                >
                  <FaBell size={15} />
                  {notifUnreadCount > 0 && (
                    <span className="header-icon-badge">
                      {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
                    </span>
                  )}
                </button>
                {notifOpen && (
                  <NotificationDropdown
                    notifications={notifications}
                    loading={notifLoading}
                    onClose={handleNotifClose}
                    onMarkAsRead={markAsRead}
                    onMarkAllAsRead={markAllAsRead}
                  />
                )}
              </div>
            )}
            {user && (
              <Link to="/messages" className="header-icon-btn" onClick={closeAll} title={t('nav.messages')}>
                <FaEnvelope size={15} />
                {unreadCount > 0 && (
                  <span className="header-icon-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
                )}
              </Link>
            )}

            {/* Online counter (muted) */}
            {onlineCount != null && onlineCount > 0 && (
              <span className="online-counter" title={t('nav.online', '{{count}} online', { count: onlineCount })}>
                <span className="online-counter__dot" />
                {onlineCount}
              </span>
            )}

            {/* KS-4589: Patreon-кнопка в шапке. Видна на всех страницах
                для авторизованных и для гостей. Цвет — фирменный
                коралловый (#F96854), белый логотип и подпись. На mobile
                подпись скрыта стилем (`.header-patreon-btn__label`), чтобы
                кнопка не отнимала место — иконка остаётся. */}
            <a
              className="header-patreon-btn"
              href="https://www.patreon.com/kingside_site"
              target="_blank"
              rel="noopener noreferrer"
              title={t('support.cta', 'Support on Patreon')}
              data-testid="header-patreon-btn"
            >
              <PatreonLogo
                className="header-patreon-btn__logo"
                size={14}
                title=""
              />
              <span className="header-patreon-btn__label">
                {t('support.footerLink', 'Support')}
              </span>
            </a>

            {/* Theme toggle (KS-1693) */}
            <ThemeToggle />

            {/* Language switcher.
                KS-2102: переключатель ДВОИТ — i18next + PATCH
                /users/me/settings { locale }. Backend (KS-2101) хранит
                локаль в `User.locale` и из неё резолвит API курсов; без
                PATCH /lessons возвращал бы старый язык. PATCH делаем
                ПЕРВЫМ (await), и только после успеха переключаем
                i18n.language — чтобы effect-ы страниц курсов сделали
                рефетч уже с обновлённой серверной локалью. Если PATCH
                упал — всё равно переключаем UI (не блокируем
                пользователя), но логируем — рассинхрон UI/курсы
                устранится при следующей удачной смене. Для гостей
                (user==null) PATCH не делаем — бэк всё равно отдаёт ru
                fallback.

                KS-4464: на префиксных URL'ах (`/<lang>/blog[/...]`)
                одной смены `i18n.language` недостаточно — страница
                сразу синхронизирует язык обратно из `useParams`-lang
                и UI «откатывается». Решение: после смены языка, если
                первый сегмент пути — поддерживаемая локаль, делаем
                `navigate` на тот же путь с новым префиксом. На
                страницах без префикса (`/`, `/lessons`, …) ничего
                не навигируется — поведение прежнее. */}
            {/* KS-4586. Переключатель показывает обе локали с
                подсветкой активной. Старая версия выводила только
                «противоположный» язык (`EN` при текущей ru), и
                пользователи воспринимали это как «сейчас русский».
                Теперь видно текущий язык явно. Клик меняет язык на
                противоположный — действие то же самое. */}
            <button
              className="lang-switcher"
              data-testid="lang-switcher"
              aria-label={
                i18n.language === 'ru'
                  ? 'Switch to English'
                  : 'Переключить на русский'
              }
              title={
                i18n.language === 'ru'
                  ? 'Switch to English'
                  : 'Переключить на русский'
              }
              onClick={async () => {
                const next = i18n.language === 'ru' ? 'en' : 'ru';
                if (user) {
                  try {
                    await api.patch('/users/me/settings', { locale: next });
                  } catch (e) {
                    console.warn('[locale] PATCH /users/me/settings failed', e);
                  }
                }
                await i18n.changeLanguage(next);
                localStorage.setItem('locale', next);
                // KS-4464. Переписываем URL под новый язык, если он
                // содержит языковой префикс. `toBlogLocale` гарантирует
                // фолбэк на 'en', если в `next` придёт неизвестное
                // значение (защита на случай будущих расширений
                // переключателя).
                const rewritten = rewriteLangPrefix(
                  location.pathname,
                  toBlogLocale(next),
                );
                if (rewritten) {
                  navigate(
                    `${rewritten}${location.search}${location.hash}`,
                    { replace: true },
                  );
                }
              }}
            >
              <span
                className={
                  'lang-switcher__opt' +
                  (i18n.language === 'en' ? ' lang-switcher__opt--active' : '')
                }
                aria-current={i18n.language === 'en' ? 'true' : undefined}
              >
                EN
              </span>
              <span className="lang-switcher__sep" aria-hidden="true">
                |
              </span>
              <span
                className={
                  'lang-switcher__opt' +
                  (i18n.language === 'ru' ? ' lang-switcher__opt--active' : '')
                }
                aria-current={i18n.language === 'ru' ? 'true' : undefined}
              >
                RU
              </span>
            </button>

            {/* User dropdown / Login */}
            {user ? (
              <div className="dropdown" ref={userMenuRef}>
                <button
                  className="dropdown-toggle nav-user"
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                >
                  <span className="nav-user__icon">&#128100;</span>
                  <span className="nav-user__text">{user.username}{user.ratingBlitz != null && ` (${user.ratingBlitz})`}</span>
                  <span className="dropdown-arrow">&#9662;</span>
                </button>
                {userMenuOpen && (
                  <div className="dropdown-menu dropdown-menu--right">
                    <Link to="/profile" onClick={closeAll}>{t('nav.profile')}</Link>
                    <Link to="/friends" onClick={closeAll}>
                      <FaUserFriends size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
                      {t('nav.friends', 'Friends')}
                    </Link>
                    {/* KS-4646: пункт «Лекции» удалён из dropdown'а
                        профиля — он переехал в основную навигацию
                        (Sidebar.tsx → NAV_ITEMS) и теперь виден гостям и
                        Googlebot'у. Дубль в личном меню избыточен. */}
                    <Link to="/settings" onClick={closeAll}>{t('nav.settings')}</Link>
                    <button onClick={() => { logout(); closeAll(); }}>{t('nav.logout')}</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="social-login-buttons">
                <a href={`${API_URL}/auth/google`} className="social-login-btn social-login-btn--google" aria-label="Google">
                  <FcGoogle size={20} />
                </a>
                <a href={`${API_URL}/auth/facebook`} className="social-login-btn social-login-btn--facebook" aria-label="Facebook">
                  <FaFacebook size={20} color="#1877F2" />
                </a>
                <a
                  href="#"
                  className="social-login-btn social-login-btn--telegram"
                  aria-label="Telegram"
                  onClick={(e) => {
                    e.preventDefault();
                    redirectToTelegramOAuth();
                  }}
                >
                  <FaTelegram size={20} color="#26A5E4" />
                </a>
                {isLocalhost && DEV_BYPASS_SECRET && (
                  <a
                    href={`?dev_bypass=${DEV_BYPASS_SECRET}`}
                    className="social-login-btn social-login-btn--dev"
                    aria-label="Dev Bypass"
                    title="Dev Bypass Login"
                  >
                    <FaCode size={20} color="#f59e0b" />
                  </a>
                )}
              </div>
            )}
          </div>
        </nav>
      </header>
      {/* KS-4815. Узкая информационная полоса под основным header'ом.
          Канал для контекстных подсказок (HintHost) и будущих системных
          уведомлений. Рендерится только при наличии активного entry —
          иначе `<InfoBar />` возвращает `null`. */}
      <InfoBar />
      <div className="app-body">
        {/* KS-4128 / ADR-128 §4: Sidebar рендерим и гостям. Сам
            Sidebar отфильтрует authOnly-пункты (Profile/Friends/
            Settings/Admin) через `filterVisible` — гостю покажет
            только групповые контентные пункты (Play/Train/Lessons/
            Broadcasts/Analyze). */}
        <Sidebar />
        <main className="main">
          <Outlet />
        </main>
      </div>
      {user && incoming && (
        <IncomingChallengeToast
          challenge={incoming}
          onAccept={acceptChallenge}
          onDecline={declineChallenge}
        />
      )}
      {/* KS-4128 / ADR-128 §4: MobileBottomBar рендерим и гостям.
          Внутри `useTopNavStats` для гостя возвращает пустой массив
          → bar показывает DEFAULT_TOP (`play`/`train`/`learn`).
          Personal-пункты в drawer'е «Ещё» (Profile/Friends/Settings/
          Lectures) уже фильтруются по `user`. */}
      {!hideBottomBar && <MobileBottomBar />}
      {/* KS-3070: NavOnboardingTooltip удалён — окно показа KS-2814
          закрылось, плюс плашка ломала Playwright-скриншоты на
          чистом localStorage. */}
      {!hideAssistantFab && <ChatWidget />}
      {/* KS-4684 / ADR-147 §2.2. Инициализация events-клиента —
          один раз, реконфигурируется при смене user/token/consent. */}
      <EventsBootstrap />
      {/* KS-4698 / ADR-147 §6.2. Cookie-banner с чекбоксом аналитики.
          Сам компонент решает, показывать ли (для авторизованного — пока
          consent не выставлен; для гостя — пока пользователь не закрыл
          его на 30 дней). */}
      <CookieBanner />
      {/* KS-4703 / ADR-147 §4 + KS-4815. Хост контекстных подсказок —
          слушает WS для user / поллит pending для гостя; пушит активную
          подсказку в общую `<InfoBar />` (под header'ом). Anchor-привязки
          и floating-ui popover больше не используются. */}
      <HintHost />
    </div>
    </InfoBarProvider>
  );
}
