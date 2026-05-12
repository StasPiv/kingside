import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BoardSettingsProvider } from './context/BoardSettingsContext';
import { ChatProvider } from './context/ChatContext';
import { FeatureFlagsProvider } from './context/FeatureFlagsContext';
import { ThemeProvider } from './context/ThemeContext';
import { App } from './App';
import { initClientLogger } from './utils/clientLogger';
import { initGA4 } from './utils/analytics';
import './i18n';
import { attachLessonsResourceLoader } from './i18n/lessonsResourceLoader';
import './styles.css';

initClientLogger();
initGA4();
attachLessonsResourceLoader();

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
                <App />
              </BoardSettingsProvider>
            </ChatProvider>
          </FeatureFlagsProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
