import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/**
 * KS-2814 (ADR-058 §6.7 T17, §8 риск №3) — одноразовый dismissible
 * tooltip-баннер о ревизии навигации (KS-2794 пакет).
 *
 * Логика показа:
 *   1. Только авторизованным пользователям (для гостей навигация
 *      выглядит дружелюбно «как впервые» — там нет старой привычки).
 *   2. localStorage-флаг `ks2814NavOnboardingSeen='true'` после dismiss
 *      → больше не показываем.
 *   3. Окно показа: 7 дней с момента деплоя (хардкод `DEPLOY_DATE`).
 *      После окончания окна не показываем, даже если флаг не выставлен —
 *      «новость» устарела, навязчивость снижается.
 *
 * Стиль — минимальный inline, layout по необходимости перепишет в
 * отдельном тикете.
 */

const STORAGE_KEY = 'ks2814NavOnboardingSeen';
/** Дата выкатки KS-2794 на прод. По окончании +7 дней tooltip не показываем. */
const DEPLOY_DATE = new Date('2026-05-12T00:00:00.000Z');
const SHOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function NavOnboardingTooltip() {
  const { t } = useTranslation();
  // Стартуем с false — избегаем мигания при SSR/hydrate; решение
  // принимаем в useEffect (доступ к localStorage только на клиенте).
  const [open, setOpen] = useState<boolean>(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === 'true') return;
    } catch {
      // localStorage недоступен (приватный режим / отключён) — не
      // ломаемся, просто показываем тултип один раз за сессию.
    }
    const now = Date.now();
    if (now > DEPLOY_DATE.getTime() + SHOW_WINDOW_MS) return;
    setOpen(true);
  }, []);

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      /* ignore */
    }
  };

  if (!open) return null;

  return (
    <div
      className="nav-onboarding-tooltip"
      data-testid="nav-onboarding-tooltip"
      role="status"
      aria-live="polite"
    >
      <div className="nav-onboarding-tooltip__body">
        <strong>
          {t('navOnboarding.title', 'Menu reorganized')}
        </strong>
        <p>
          {t(
            'navOnboarding.body',
            'Puzzles, Rush, Drills and Precision are now under «Train». Workshop and Archive are under «Analyze». «Home» and «Tournaments» are accessible by direct link.',
          )}
        </p>
        <Link
          to="/features#navigation"
          className="nav-onboarding-tooltip__link"
        >
          {t('navOnboarding.learnMore', 'Read more')}
        </Link>
      </div>
      <button
        type="button"
        className="nav-onboarding-tooltip__close"
        aria-label={t('navOnboarding.dismiss', 'Dismiss')}
        data-testid="nav-onboarding-tooltip-close"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}
