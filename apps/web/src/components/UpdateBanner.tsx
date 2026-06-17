/**
 * KS-4307: баннер «Доступна новая версия» — показывается при активации
 * нового Service Worker'а (см. `main.tsx` блок KS-3315/KS-4307).
 *
 * Поток событий:
 *   1. SW активирован → `main.tsx` шлёт `CustomEvent('kingside:update-
 *      available')` + `pendingReload=true`.
 *   2. `UpdateBanner` ловит событие → показывает баннер.
 *   3. Клик «Обновить» → шлёт `CustomEvent('kingside:apply-update')`,
 *      `main.tsx` делает `location.reload()`.
 *   4. Если пользователь баннер игнорирует — `main.tsx` сам перезагрузит
 *      через 10 минут ИЛИ при потере visibility, что раньше; на
 *      странице активной партии (`/game/<id>`, `/play/local-bot`)
 *      автоматическая перезагрузка отключена — только по клику.
 *
 * Кнопка «Позже» закрывает баннер до следующей активации SW (флаг в
 * памяти, не в storage). После перезагрузки баннера больше нет.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function UpdateBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onUpdate = () => setVisible(true);
    window.addEventListener('kingside:update-available', onUpdate);
    return () => window.removeEventListener('kingside:update-available', onUpdate);
  }, []);

  if (!visible) return null;

  const applyUpdate = () => {
    try {
      window.dispatchEvent(new CustomEvent('kingside:apply-update'));
    } catch {
      // Очень старые браузеры — прямой reload.
      window.location.reload();
    }
  };

  return (
    <div
      className="update-banner"
      role="status"
      aria-live="polite"
      data-testid="update-banner"
    >
      <span className="update-banner__text">
        {t('app.updateAvailable', 'Доступна новая версия')}
      </span>
      <button
        type="button"
        className="update-banner__btn update-banner__btn--primary"
        onClick={applyUpdate}
        data-testid="update-banner-apply"
      >
        {t('app.updateApply', 'Обновить')}
      </button>
      <button
        type="button"
        className="update-banner__btn update-banner__btn--dismiss"
        onClick={() => setVisible(false)}
        aria-label={t('app.updateDismiss', 'Позже')}
        data-testid="update-banner-dismiss"
      >
        &times;
      </button>
    </div>
  );
}
