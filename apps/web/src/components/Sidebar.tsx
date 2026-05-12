import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FeatureFlags } from '@kingside/shared';
import { FeedbackModal } from './FeedbackModal';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useAdminStatus } from '../hooks/useAdminStatus';
import { useAuth } from '../context/AuthContext';

interface NavItem {
  path: string;
  icon: string;
  i18nKey: string;
  match: string[];
  /**
   * KS-2105: ключ feature-flag из `FeatureFlags`. Если задан — пункт
   * рендерится только когда соответствующий флаг включён через
   * `FeatureFlagsContext` (источник — backend `GET /config`).
   */
  featureFlag?: keyof FeatureFlags;
  /**
   * KS-2109: пункт виден только админам (`useAdminStatus().isAdmin`).
   * Авторизация на бэке независима — это эстетика sidebar.
   */
  adminOnly?: boolean;
  /**
   * KS-2622 / ADR-052 §3.3.1: пункт виден только залогиненному
   * пользователю. У гостя своих курсов нет — ссылка теряет смысл, а
   * `userCoursesApi.list({scope:'own'})` всё равно вернёт 401.
   */
  authOnly?: boolean;
  /**
   * KS-2800 (ADR-058 §4.1): кастомный gate для групповых пунктов —
   * `Тренировка` (`/train`) виден если хотя бы один из четырёх
   * подразделов разрешён (`puzzlesEnabled || drillsEnabled` —
   * Puzzle Rush открыт всегда, поэтому в этой версии условие всегда
   * истинно; оставляем хук на будущее, когда Rush получит свой
   * feature-flag). Если задан — `featureFlag` игнорируется.
   */
  customGate?: (flags: FeatureFlags) => boolean;
}

/**
 * KS-2800 (ADR-058 §4.1, §6.2 T4) — новые групповые контентные пункты
 * sidebar'а. Тренировочные и аналитические подразделы съехали внутрь
 * лобби-страниц `/train` и `/analyze` (KS-2796 / KS-2797), на топ-уровне
 * остаются только 5 крупных групп.
 *
 * Список (порядок сверху вниз):
 *   1. ♟ Играть       → `/play`
 *   2. 🧠 Тренировка  → `/train`   (gated: Rush открыт всегда → виден всегда)
 *   3. 🎓 Уроки       → `/lessons` (gated: `lessonsEnabled`)
 *   4. 📺 Трансляции  → `/broadcasts` (gated: `broadcastsEnabled`)
 *   5. 🔬 Анализ      → `/analyze` (без gating — Workshop + Archive открыты)
 *
 * Пункты `/lobby`, `/tournaments`, `/puzzles`, `/puzzle-rush`, `/drills`,
 * `/precision`, `/workshop`, `/archive` из топ-уровня удалены — доступ
 * к ним через лобби-страницы.
 *
 * Турниры (`/tournaments`) — переезжают в drawer «Ещё» на мобильном
 * (KS-2807) и в подгруппу «Соревнования» внутри `/play` на десктопе
 * (вне scope этого тикета; временно остаются только через прямой URL).
 *
 * Футер (Профиль / Друзья / Настройки / Feedback / Admin) — KS-2801.
 * В текущем коммите эта секция остаётся в нижней половине Sidebar'а
 * как есть; T5 разделит её на отдельный блок.
 */
const NAV_ITEMS: NavItem[] = [
  // KS-2803: match покрывает /play* и /tournaments* — оба относятся к
  // группе «Играть» (ADR-058 §4.3). Турниры с топ-уровня sidebar'а
  // удалены (KS-2800), но прямые URL остаются — подсветка должна
  // указывать на «Играть», иначе на /tournaments активна никакая
  // группа.
  { path: '/play', icon: '♟', i18nKey: 'nav.play', match: ['/play', '/tournaments'] },
  // KS-2800: групповая «Тренировка». Виден если puzzlesEnabled ИЛИ
  // drillsEnabled — иначе подразделы пусты (Rush всегда есть, но он
  // один не делает группу осмысленной для пользователя; всё же оставлю
  // group-гейтом visible if any of {puzzlesEnabled, drillsEnabled, true(Rush)}).
  {
    path: '/train',
    icon: '🧠',
    i18nKey: 'nav.train',
    match: ['/train', '/puzzles', '/puzzle', '/puzzle-rush', '/drills', '/precision'],
    customGate: (flags) =>
      // Rush открыт всегда → группа всегда видна. Хук для будущего
      // gating'а Rush'а: если все 4 подраздела закрыты — скрыть группу.
      flags.puzzlesEnabled || flags.drillsEnabled || true,
  },
  {
    path: '/lessons',
    icon: '🎓',
    i18nKey: 'nav.lessons',
    match: ['/lessons'],
    featureFlag: 'lessonsEnabled',
  },
  {
    path: '/broadcasts',
    icon: '📺',
    i18nKey: 'nav.tv',
    match: ['/broadcasts'],
    featureFlag: 'broadcastsEnabled',
  },
  // KS-2800: групповой «Анализ». Workshop + Archive — без gating'а.
  // Match покрывает все подмаршруты обоих, чтобы при заходе на
  // /workshop, /analysis, /archive подсветка стояла на этом пункте.
  {
    path: '/analyze',
    icon: '🔬',
    i18nKey: 'nav.analyze',
    match: ['/analyze', '/workshop', '/analysis', '/archive'],
  },
  // KS-2801: ниже — футер (Профиль / Друзья / Настройки / Feedback /
  // Admin). Текущий divider + список остаются в коде до отдельного
  // разделения; разметка переедет в KS-2801 (T5).
  { path: '', icon: '', i18nKey: '', match: [] }, // divider
  { path: '/feedback', icon: '📋', i18nKey: 'nav.feedback', match: ['/feedback'] },
  { path: '/features', icon: '✨', i18nKey: 'nav.features', match: ['/features'] },
  { path: '/friends', icon: '👥', i18nKey: 'nav.friends', match: ['/friends'] },
  { path: '/settings', icon: '⚙', i18nKey: 'nav.settings', match: ['/settings'] },
  // KS-2109: пункт «Админка» — только для админов (env `KS_ADMIN_USERS`).
  {
    path: '/admin/feature-flags',
    icon: '🛡',
    i18nKey: 'nav.admin',
    match: ['/admin'],
    adminOnly: true,
  },
];

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const [showFeedback, setShowFeedback] = useState(false);
  // KS-2105: runtime feature-flags из контекста (backend `GET /config`).
  const { flags } = useFeatureFlags();
  // KS-2109: статус админа (`GET /profile/me/admin-status`).
  const { isAdmin } = useAdminStatus();
  // KS-2622: «Мои курсы» только для залогиненных.
  const { user } = useAuth();

  // KS-2790: строгое path-segment совпадение. Прежний `startsWith`
  // ловил `/puzzle-rush` как match для `/puzzle` → на странице
  // /puzzle-rush подсвечивались сразу два пункта (Puzzles + Puzzle
  // Rush). Теперь префикс считается совпадением только если
  // pathname либо ровно равен ему, либо начинается с `<prefix>/`
  // (т.е. след. символ — `/`, разделитель segment'а). MobileBottomBar
  // уже использует тот же приём.
  const isActive = (_path: string, match: string[]) =>
    match.some(
      (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
    );

  const visibleItems = NAV_ITEMS.filter((it) => {
    // KS-2800: customGate имеет приоритет над featureFlag — для
    // групповых пунктов (`/train`, `/analyze`) условие может быть
    // составным («хотя бы один подраздел открыт»).
    if (it.customGate) {
      if (!it.customGate(flags)) return false;
    } else if (it.featureFlag && !flags[it.featureFlag]) {
      return false;
    }
    if (it.adminOnly && !isAdmin) return false;
    if (it.authOnly && !user) return false;
    return true;
  });

  return (
    <>
      <aside className="sidebar">
        {visibleItems.map((item, i) => {
          if (!item.path) {
            return <div key={i} className="sidebar-divider" />;
          }
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`sidebar-item${isActive(item.path, item.match) ? ' sidebar-item--active' : ''}`}
              title={t(item.i18nKey)}
            >
              <span className="sidebar-icon">{item.icon}</span>
            </Link>
          );
        })}
        <div className="sidebar-spacer" />
        {/*
          KS-2252: эмодзи изменена с 💬 на 📝, чтобы кнопка обратной
          связи не путалась с иконкой `ChatWidget` (ассистент в правом
          нижнем углу — KS-2228, default `assistantEnabled=false`).
          Пользователь жаловался на «бейджик ассистента» именно из-за
          совпадающей 💬 — функционально кнопка относится к feedback,
          под `assistantEnabled` её прятать неверно.
         */}
        <button
          className="sidebar-item sidebar-feedback-btn"
          onClick={() => setShowFeedback(true)}
          title={t('feedback.title', 'Feedback')}
          data-testid="sidebar-feedback-btn"
        >
          <span className="sidebar-icon">📝</span>
        </button>
      </aside>
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </>
  );
}
