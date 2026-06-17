import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BoardSettingsProvider } from './context/BoardSettingsContext';
import { ChatProvider } from './context/ChatContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { FocusModeProvider } from './context/FocusModeContext';
import { RequireAuthProvider } from './context/RequireAuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { App } from './App';
import { initClientLogger } from './utils/clientLogger';
import { initGA4 } from './utils/analytics';
import './i18n';
import { attachLessonsResourceLoader } from './i18n/lessonsResourceLoader';
// KS-3682: окно консоли для проверки SF-trace через window.__sfTrace.
import './lib/review/__devtools/sfTraceConsole';
// KS-4017: window.__ksPositionalDiff — сравнительная таблица
// «Белые − Чёрные» по позиционным факторам Stockfish для отладки.
import './dev/debugPositionalDiff';
import './styles.css';

initClientLogger();
initGA4();
attachLessonsResourceLoader();

// KS-3766 / ADR-112: разовая чистка легаси-ключа localStorage, в котором
// прошлая версия (KS-3736 → KS-3754) хранила slug активной трансляции
// анализа. Модель в ADR-112 пересмотрена: восстановление идёт через REST
// (`GET /live-analyses/by-analysis/:analysisId`), браузерный кэш не
// используется. Старый ключ у пользователей мог остаться с предыдущих
// сессий — однострочник чистит его при загрузке приложения, чтобы
// гарантированно не оставлять «висящих» данных от снятой модели.
// try/catch — защита от Safari Private Mode, где доступ к localStorage
// может бросать `SecurityError`. Удалить через 2-3 релиза.
try {
  localStorage.removeItem('live-analysis:active-slug');
} catch {
  /* localStorage недоступен — нечего и чистить */
}

// Hide mobile browser address bar by triggering a minimal scroll.
// Only on touch devices, after first load.
if ('ontouchstart' in window && !window.matchMedia('(display-mode: standalone)').matches) {
  window.addEventListener('load', () => {
    setTimeout(() => window.scrollTo(0, 1), 100);
  }, { once: true });
}

// In development mode, unregister any existing Service Workers
// to ensure fresh assets are always served
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister();
    }
  });
}

// KS-2917: graceful-восстановление после удаления старых hash-чанков из
// бакета. Если открытая вкладка ссылается на чанк, которого уже нет на CDN
// (typical после серии деплоев), dynamic import падает с TypeError
// «Failed to fetch dynamically imported module». На активной странице это
// неустранимо без перезагрузки — index.html в памяти уже старый. Решение:
// поймать ошибку на window.onerror / unhandledrejection и сделать
// одноразовый location.reload() с querystring-меткой, чтобы не зациклиться.
// KS-3315: после обновления Service Worker'а через skipWaiting+clientsClaim
// в workbox config, активная вкладка остаётся на старых JS-модулях
// (импортированы в память). Reload нужен чтобы подхватить свежий бандл.
// Слушаем `controllerchange` — событие срабатывает в момент, когда
// новый SW стал контролировать клиента (после `clients.claim()`).
//
// KS-3884: безусловный reload здесь раньше рвал любые активные сессии
// — особенно больно для зрителей live-лекций и WebRTC: после каждого
// нашего деплоя страница сама перезагружалась, состояние терялось,
// пользователь даже не успевал понять, нажал ли он «слушать». Новое
// поведение: ждём, пока вкладка станет скрытой (`visibilitychange` ->
// `document.visibilityState === 'hidden'`). Тогда перезагрузка
// пользователю не заметна. Если пользователь так и не свернёт вкладку
// — следующий заход на страницу с нуля и так подтянет свежий бандл
// через обычный HTTP-кеш + SW.
if (typeof window !== 'undefined' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  // KS-4307: предыдущая логика (KS-3315 + KS-3884) откладывала
  // перезагрузку вкладки исключительно до `visibilityState === 'hidden'`.
  // Если пользователь сидит на kingside.site весь день без переключения
  // вкладки (типичный сценарий — играет шахматную партию), он навсегда
  // застревает на старой сборке. Симптом «бот не ходит за белых,
  // никогда» из жалоб KS-4305..4307 в точности совпадает с поведением
  // `useBotEngine` ДО KS-4303 (таймаут 10 с без предварительной загрузки
  // wasm) — и кэш Service Worker'а как раз держит эту старую сборку.
  //
  // Новая схема:
  //   1. После активации нового SW шлём `CustomEvent('kingside:update-
  //      available')` — `UpdateBanner` (MainLayout) показывает баннер
  //      «Доступна новая версия» с кнопкой «Обновить».
  //   2. Если пользователь не нажимает кнопку, ждём ЛЮБОГО из:
  //      - `visibilityState === 'hidden'` (старая логика);
  //      - истечения `AUTO_RELOAD_DELAY_MS` (10 мин);
  //      что раньше.
  //   3. На странице активной партии (`/game/<id>`, `/play/local-bot`)
  //      автоматическая перезагрузка пропускается — только по явному
  //      клику. Это защищает от потери позиции в середине игры. Баннер
  //      при этом остаётся видим — пользователь сам решает, когда
  //      обновиться.
  const AUTO_RELOAD_DELAY_MS = 10 * 60 * 1000;
  let reloadedOnce = false;
  let pendingReload = false;
  const reloadOnce = (reason: string) => {
    if (reloadedOnce) return;
    try {
      if (sessionStorage.getItem('ks3315-sw-reloaded')) return;
      sessionStorage.setItem('ks3315-sw-reloaded', '1');
    } catch {
      /* ignore — без sessionStorage всё равно reload один раз через флаг */
    }
    reloadedOnce = true;
    // eslint-disable-next-line no-console
    console.info(`[ks3315] reload for fresh bundle (${reason})`);
    window.location.reload();
  };
  const isActiveGamePath = (): boolean => {
    const p = window.location.pathname;
    return p.startsWith('/game/') || p.startsWith('/play/local-bot');
  };
  const tryAutoReload = (reason: string) => {
    if (reloadedOnce) return;
    if (isActiveGamePath()) {
      // На странице партии — только по клику пользователя, чтобы не
      // потерять позицию посреди игры. Баннер остаётся видим.
      // eslint-disable-next-line no-console
      console.info(`[ks3315] auto-reload suppressed on active game page (${reason})`);
      return;
    }
    reloadOnce(reason);
  };
  // Кнопка «Обновить» в баннере шлёт `kingside:apply-update` — снимаем
  // защиту от активной партии (пользователь явно согласен) и перезагружаем.
  window.addEventListener('kingside:apply-update', () => {
    if (reloadedOnce) return;
    reloadOnce('user clicked update');
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedOnce) return;
    if (document.visibilityState === 'hidden') {
      reloadOnce('controllerchange while hidden');
      return;
    }
    if (pendingReload) return;
    pendingReload = true;
    // eslint-disable-next-line no-console
    console.info('[ks3315] new Service Worker activated; banner shown');
    // Сообщаем UI: пора показать баннер «Доступна новая версия».
    try {
      window.dispatchEvent(new CustomEvent('kingside:update-available'));
    } catch {
      /* старые браузеры без CustomEvent — баннер не покажется, fallback на
         visibility / 10-минутный таймер ниже всё равно сработает */
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        document.removeEventListener('visibilitychange', onHidden);
        tryAutoReload('controllerchange + visibility hidden');
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    // Тайм-аут на случай, если пользователь не свернёт вкладку и не
    // нажмёт «Обновить» — на не-игровой странице обновим сами.
    setTimeout(() => {
      tryAutoReload(`controllerchange + ${AUTO_RELOAD_DELAY_MS / 60_000} min idle`);
    }, AUTO_RELOAD_DELAY_MS);
  });
}

if (typeof window !== 'undefined' && import.meta.env.PROD) {
  const RELOAD_MARK = 'ks2917-stale-chunk-reload';
  const isStaleChunkError = (msg: string): boolean =>
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg);
  const tryRecover = (reason: string): void => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(RELOAD_MARK)) return; // уже перезагружались
      url.searchParams.set(RELOAD_MARK, String(Date.now()));
      // eslint-disable-next-line no-console
      console.warn('[ks2917] stale chunk detected → reload:', reason);
      window.location.replace(url.toString());
    } catch {
      // если URL API недоступен — fallback на простой reload
      window.location.reload();
    }
  };
  window.addEventListener('error', (event) => {
    if (event?.message && isStaleChunkError(event.message)) tryRecover(event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    const msg = typeof reason === 'string' ? reason : (reason?.message ?? '');
    if (msg && isStaleChunkError(msg)) tryRecover(msg);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <FeatureFlagsProvider>
            <ChatProvider>
              <BoardSettingsProvider>
                <FocusModeProvider>
                  {/* KS-4124 / ADR-128 §6: глобальный провайдер
                      LoginRequiredModal для auth-gated действий. Должен
                      быть внутри BrowserRouter (useNavigate) и
                      AuthProvider (useAuth), над App, чтобы модалка
                      могла рендериться поверх любого маршрута. */}
                  <RequireAuthProvider>
                    <App />
                  </RequireAuthProvider>
                </FocusModeProvider>
              </BoardSettingsProvider>
            </ChatProvider>
          </FeatureFlagsProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
