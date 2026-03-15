import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BoardSettingsProvider } from './context/BoardSettingsContext';
import { App } from './App';
import { initClientLogger } from './utils/clientLogger';
import './i18n';
import './styles.css';

initClientLogger();

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
        <BoardSettingsProvider>
          <App />
        </BoardSettingsProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
