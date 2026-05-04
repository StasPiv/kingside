import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * KS-2374 — promp при наличии новой версии bundle.
 *
 * Реализован через нативный `navigator.serviceWorker` API (без
 * `virtual:pwa-register/react`-обёртки vite-plugin-pwa) — это даёт
 * unit-тестируемость в jsdom и не зависит от runtime-модулей плагина.
 *
 * Поведение:
 *   1. Регистрируем `/sw.js` (vite-plugin-pwa собирает его в build).
 *   2. На событие `updatefound` слушаем `statechange` нового SW. Когда
 *      он перешёл в `installed` И уже есть активный контроллер
 *      (`navigator.serviceWorker.controller`) — это значит «обновление,
 *      а не первая установка» → показываем плашку.
 *   3. «Перезагрузить» → `location.reload()`. workbox
 *      `skipWaiting: true` + `clientsClaim: true` гарантирует, что
 *      новый SW активируется и захватит клиентов сразу.
 *   4. «Позже» → плашка скрывается, пользователь продолжает на старом
 *      bundle до собственного перезахода. Без принудительного reload —
 *      не теряем состояние формы / партии.
 *   5. Каждые 60 минут вызываем `registration.update()` — если за
 *      время сессии deploy подложил новый /sw.js, ловим без F5.
 *
 * Если SW не поддерживается (старый браузер) или окно не secure
 * context — компонент просто молчит.
 */
export function PwaUpdatePrompt() {
  const { t } = useTranslation();
  const [needRefresh, setNeedRefresh] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Dev-режим SW пропускаем: main.tsx сам unregister'ит при DEV.
    // (Боковая защита: тесты в vitest идут с import.meta.env.DEV=true.)
    if (import.meta.env?.DEV) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let cleanupListeners: Array<() => void> = [];

    const handleNewWorker = (newWorker: ServiceWorker) => {
      const onStateChange = () => {
        if (cancelled) return;
        if (
          newWorker.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          // Это апгрейд (controller был активен до новой инсталляции).
          // На самой первой установке (controller=null) промпт не нужен.
          setNeedRefresh(true);
        }
      };
      newWorker.addEventListener('statechange', onStateChange);
      cleanupListeners.push(() =>
        newWorker.removeEventListener('statechange', onStateChange),
      );
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (cancelled) return;
        // Уже есть «ожидающий» SW (вкладка была открыта при предыдущем
        // deploy + skipWaiting не сработал) — сразу показываем плашку.
        if (registration.waiting && navigator.serviceWorker.controller) {
          setNeedRefresh(true);
        }
        const onUpdateFound = () => {
          if (cancelled) return;
          if (registration.installing) {
            handleNewWorker(registration.installing);
          }
        };
        registration.addEventListener('updatefound', onUpdateFound);
        cleanupListeners.push(() =>
          registration.removeEventListener('updatefound', onUpdateFound),
        );
        // Периодический check для долгоживущих вкладок (например, PWA
        // standalone у пользователя «открыта неделями»).
        intervalId = setInterval(
          () => {
            void registration.update().catch(() => undefined);
          },
          60 * 60 * 1000,
        );
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
      for (const cleanup of cleanupListeners) cleanup();
      cleanupListeners = [];
    };
  }, []);

  const onReload = useCallback(() => {
    // skipWaiting+clientsClaim в workbox config — на reload свежий
    // SW сразу активируется и контроль клиентов забирает он.
    window.location.reload();
  }, []);

  if (!needRefresh) return null;

  return (
    <div
      className="pwa-update-prompt"
      data-testid="pwa-update-prompt"
      role="status"
      aria-live="polite"
    >
      <p className="pwa-update-prompt__message">
        {t(
          'pwa.updateAvailable',
          'A new version of the app is available.',
        )}
      </p>
      <div className="pwa-update-prompt__actions">
        <button
          type="button"
          className="pwa-update-prompt__reload"
          data-testid="pwa-update-prompt-reload"
          onClick={onReload}
        >
          {t('pwa.reload', 'Reload')}
        </button>
        <button
          type="button"
          className="pwa-update-prompt__dismiss"
          data-testid="pwa-update-prompt-dismiss"
          onClick={() => setNeedRefresh(false)}
        >
          {t('pwa.later', 'Later')}
        </button>
      </div>
    </div>
  );
}
