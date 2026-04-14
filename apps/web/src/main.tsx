import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BoardSettingsProvider } from './context/BoardSettingsContext';
import { ChatProvider } from './context/ChatContext';
import { App } from './App';
import { initClientLogger } from './utils/clientLogger';
import './i18n';
import './styles.css';

initClientLogger();

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ChatProvider>
          <BoardSettingsProvider>
            <App />
          </BoardSettingsProvider>
        </ChatProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
