import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { PrecisionSubNav } from '../components/precision/PrecisionSubNav';
import { PrecisionAttemptsList } from '../components/precision/PrecisionAttemptsList';

/**
 * KS-2745 / ADR-057 §4 — страница `/precision/history`. История попыток
 * текущего пользователя (перенос блока «История попыток» из главной
 * `/precision`, чтобы освободить первый экран под сетку позиций).
 *
 * Компоненты:
 *   - `<PrecisionSubNav />`        — общая навигация (KS-2743).
 *   - `<PrecisionAttemptsList />`  — список попыток с фильтрами
 *                                    (All / Preserved / Lost) и
 *                                    пагинацией (KS-2724).
 *
 * Backend без изменений: `GET /precision/attempts/me?limit=&offset=`
 * (ADR-056 §2.2).
 *
 * Решения по §4 ADR-057:
 *   - Toggle «Скрыть удержанные» (`hideRetained`/`hideSolved`) убран.
 *     Он жил на старой `/precision` поверх сетки PUZZLES (фильтр для
 *     показа задач). На `/history` его смысл дублирует встроенные
 *     фильтры списка «Все / Удержано / Упущено» — поэтому избыточен.
 *   - CTA «Начать тренировку → /precision» вынесена в шапку страницы:
 *     видна и при заполненной истории (полезна как back-link) и при
 *     empty-state (когда у юзера 0 попыток `PrecisionAttemptsList` сам
 *     рендерит «У тебя пока нет попыток», CTA рядом ведёт к действию).
 *     Так не трогаем существующий `PrecisionAttemptsList` (task explicit:
 *     «без правок»).
 *
 * Гостям эндпоинт `/precision/attempts/me` вернёт 401 — рендерим
 * empty-state с CTA «Войти и начать тренироваться» (Link `/login`).
 *
 * Роут не зарегистрирован — это задача F5 (KS-2747).
 *
 * # DOM
 *   <div class="precision-history-page" data-testid="precision-history-page"
 *        data-auth="guest|user">
 *     <PrecisionSubNav />
 *     <header class="precision-history-page__header">
 *       <h1>…title…</h1>
 *       <a href="/precision" data-testid="precision-history-start-cta">
 *         …Start training…
 *       </a>
 *     </header>
 *
 *     // guest:
 *     <section data-testid="precision-history-guest-cta">…</section>
 *
 *     // user:
 *     <PrecisionAttemptsList />
 *   </div>
 */
export function PrecisionHistoryPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isGuest = !user;

  return (
    <div
      className="precision-history-page"
      data-testid="precision-history-page"
      data-auth={isGuest ? 'guest' : 'user'}
    >
      <PrecisionSubNav />

      <header className="precision-history-page__header">
        <h1 className="precision-history-page__title">
          {t('precision.history.title', 'Attempt history')}
        </h1>
        {!isGuest && (
          <Link
            to="/precision"
            className="precision-history-page__start-cta"
            data-testid="precision-history-start-cta"
          >
            {t('precision.history.startTraining', 'Start training →')}
          </Link>
        )}
      </header>

      {isGuest && (
        <section
          className="precision-history-page__guest"
          data-testid="precision-history-guest-cta"
        >
          <p className="precision-history-page__guest-message">
            {t(
              'precision.history.guest.message',
              'Sign in to see the history of your precision attempts.',
            )}
          </p>
          <Link
            to="/login"
            className="precision-history-page__guest-cta"
            data-testid="precision-history-guest-cta-link"
          >
            {t(
              'precision.history.guest.cta',
              'Sign in and start training',
            )}
          </Link>
        </section>
      )}

      {!isGuest && <PrecisionAttemptsList hideTitle />}
    </div>
  );
}
