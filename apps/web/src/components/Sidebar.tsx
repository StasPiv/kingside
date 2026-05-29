import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FeatureFlags } from '@kingside/shared';
import { FeedbackModal } from './FeedbackModal';
import { SidebarSubmenu, type SidebarSubmenuItem } from './SidebarSubmenu';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useAdminStatus } from '../hooks/useAdminStatus';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';

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
  /**
   * KS-2840 (ADR-058 §11.1): подменю для двухуровневой навигации.
   * На desktop рендерится `SidebarSubmenu` (hover-поповер + click-toggle).
   * На mobile (`useIsMobile()`) submenu не активен — пункт ведёт прямо
   * на лобби-страницу (`/train`, `/analyze`).
   *
   * Каждый child имеет собственный gate (featureFlag) — поповер
   * скрывает выключенные подпункты.
   */
  children?: SubItem[];
}

/**
 * KS-2840: облегчённая форма подпункта (без customGate / adminOnly /
 * authOnly — для подменю это пока не нужно). Совместима с
 * `SidebarSubmenuItem` (id = path, match[], icon, label).
 */
interface SubItem {
  path: string;
  icon: string;
  i18nKey: string;
  i18nFallback: string;
  match: string[];
  featureFlag?: keyof FeatureFlags;
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
  // KS-2848: добавили submenu «Турниры» внутри «Играть» (вместо
  // выпиленного top-level пункта). По модели KS-2840 — то же самое,
  // что Train/Analyze: parent открывает поповер, подпункты ведут на
  // /play (быстрая партия) и /tournaments. На mobile — обычный Link
  // на /play (см. Sidebar.tsx fallback логика для submenu без children
  // или isMobile=true).
  {
    path: '/play',
    icon: '♟',
    i18nKey: 'nav.play',
    match: ['/play', '/tournaments'],
    children: [
      {
        path: '/play',
        icon: '♟',
        i18nKey: 'nav.play',
        i18nFallback: 'Play',
        match: ['/play'],
      },
      {
        path: '/tournaments',
        icon: '🏆',
        i18nKey: 'nav.tournaments',
        i18nFallback: 'Tournaments',
        match: ['/tournaments'],
        featureFlag: 'tournamentsEnabled',
      },
    ],
  },
  // KS-2800 / KS-2811 (ADR-058 §4.1): групповая «Тренировка». Скрыта,
  // если оба контентных gate-флага off (`puzzlesEnabled=false &&
  // drillsEnabled=false`). Puzzle Rush сам по себе открыт всегда, но
  // в этом edge-case Sidebar не показывает пункт «Тренировка»
  // (Rush остаётся доступен по прямому URL `/puzzle-rush`).
  {
    path: '/train',
    icon: '🧠',
    i18nKey: 'nav.train',
    match: ['/train', '/puzzles', '/puzzle', '/puzzle-rush', '/drills', '/precision', '/opening-trainer', '/guess'],
    // KS-3276: Opening Trainer всегда доступен (нет отдельного флага),
    // поэтому пункт «Тренировка» теперь виден даже если
    // puzzlesEnabled=false и drillsEnabled=false.
    customGate: () => true,
    // KS-2840 (ADR-058 §11.1): подменю Train. На desktop открывается
    // поповером по hover/click; на mobile submenu не активен — клик
    // ведёт на лобби /train (Sidebar решает по `useIsMobile()`).
    children: [
      {
        path: '/puzzles',
        icon: '🧩',
        i18nKey: 'nav.puzzles',
        i18nFallback: 'Puzzles',
        match: ['/puzzles', '/puzzle'],
        featureFlag: 'puzzlesEnabled',
      },
      {
        path: '/puzzle-rush',
        icon: '⚡',
        i18nKey: 'nav.puzzleRush',
        i18nFallback: 'Puzzle Rush',
        match: ['/puzzle-rush'],
      },
      {
        path: '/drills',
        icon: '🧠',
        i18nKey: 'nav.drills',
        i18nFallback: 'Drills',
        match: ['/drills'],
        featureFlag: 'drillsEnabled',
      },
      {
        path: '/precision',
        // KS-2845: используем `nav.precisionShort` («Точность») вместо
        // длинного `nav.precision` («Тренировка точности») — в поповере
        // компактнее, нет переноса строки на длинных языках.
        icon: '🎯',
        i18nKey: 'nav.precisionShort',
        i18nFallback: 'Precision',
        match: ['/precision'],
        featureFlag: 'puzzlesEnabled',
      },
      {
        // KS-3276: Opening Trainer (ADR-077 M1). Без feature-flag'а —
        // фича доступна всем авторизованным (внутри страниц
        // ProtectedRoute уже стоит). Если потребуется gating без
        // редеплоя — backend заведёт `openingTrainerEnabled` в
        // shared FeatureFlags.
        path: '/opening-trainer',
        icon: '♔',
        i18nKey: 'nav.openingTrainer',
        i18nFallback: 'Openings',
        match: ['/opening-trainer'],
      },
      {
        // KS-3413 (ADR-086): «Угадай ход» — тренировочный режим на реальной
        // партии (PGN/archive), геймификация (очки/звёзды/стрик). Gating
        // через локальный `GUESS_ENTRY_ENABLED` снят при общем релизе
        // связки — пункт виден всем. Если потребуется рантайм-отключение
        // админом — backend заведёт `guessEnabled` в shared FeatureFlags.
        path: '/guess',
        icon: '🤔',
        i18nKey: 'nav.guess',
        i18nFallback: 'Guess the move',
        match: ['/guess'],
      },
    ],
  },
  {
    path: '/lessons',
    icon: '🎓',
    i18nKey: 'nav.lessons',
    match: ['/lessons'],
    featureFlag: 'lessonsEnabled',
  },
  // ADR-067 (KS-3130): пункт «Студии» удалён вместе с модулем.
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
    children: [
      {
        path: '/workshop',
        icon: '🔬',
        i18nKey: 'nav.workshop',
        i18nFallback: 'Workshop',
        match: ['/workshop', '/analysis'],
      },
      {
        path: '/archive',
        icon: '📚',
        i18nKey: 'archive:menuTitle',
        i18nFallback: 'Archive',
        match: ['/archive'],
      },
    ],
  },
];

/**
 * KS-2801 (ADR-058 §4.1, §9.3, §6.2 T5) — футер sidebar'а.
 * Утилитарные пункты, отделены от контентной навигации `sidebar-spacer`'ом
 * и `sidebar-divider`'ом в разметке.
 *
 * Состав сверху-вниз:
 *   👤 Профиль   → /profile     (authOnly — у гостя профиля нет)
 *   👥 Друзья    → /friends     (authOnly; отдельным пунктом по §9.3)
 *   ⚙ Настройки  → /settings    (authOnly)
 *   📝 Feedback  — модалка (рендерится отдельной <button>, не в массиве)
 *   🛡 Админка   → /admin/...   (adminOnly)
 *
 * KS-2801: «Возможности» (/features) убран из футера sidebar'а;
 * доступ остаётся через прямой URL и через mobile drawer (T10).
 */
const FOOTER_NAV: NavItem[] = [
  {
    path: '/profile',
    icon: '👤',
    i18nKey: 'nav.profile',
    match: ['/profile'],
    authOnly: true,
  },
  {
    path: '/friends',
    icon: '👥',
    i18nKey: 'nav.friends',
    match: ['/friends'],
    authOnly: true,
  },
  {
    path: '/settings',
    icon: '⚙',
    i18nKey: 'nav.settings',
    match: ['/settings'],
    authOnly: true,
  },
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
  // KS-2840: какой submenu сейчас открыт (один за раз; null — все закрыты).
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  // KS-2105: runtime feature-flags из контекста (backend `GET /config`).
  const { flags } = useFeatureFlags();
  // KS-2109: статус админа (`GET /profile/me/admin-status`).
  const { isAdmin } = useAdminStatus();
  // KS-2622: «Мои курсы» только для залогиненных.
  const { user } = useAuth();
  // KS-2840: на mobile submenu не активен — родитель ведёт прямо на лобби.
  const isMobile = useIsMobile();

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

  // KS-2800: общий фильтр видимости — учитывает customGate, featureFlag,
  // adminOnly, authOnly. Применяется к MAIN_NAV и FOOTER_NAV.
  const filterVisible = (items: NavItem[]) =>
    items.filter((it) => {
      if (it.customGate) {
        if (!it.customGate(flags)) return false;
      } else if (it.featureFlag && !flags[it.featureFlag]) {
        return false;
      }
      if (it.adminOnly && !isAdmin) return false;
      if (it.authOnly && !user) return false;
      return true;
    });

  const mainItems = filterVisible(NAV_ITEMS);
  const footerItems = filterVisible(FOOTER_NAV);

  // KS-2840: фильтрация подпунктов по их featureFlag — выключенные
  // не появляются в поповере. Если все подпункты выключены, родитель
  // всё равно может остаться видимым (его собственный `customGate`
  // решает на уровне MAIN_NAV — см. customGate для /train).
  const visibleChildren = (
    children: SubItem[] | undefined,
  ): SidebarSubmenuItem[] => {
    if (!children) return [];
    return children
      .filter((c) => !c.featureFlag || flags[c.featureFlag])
      .map((c) => ({
        id: c.path.replace(/^\//, '').replace(/\//g, '-'),
        to: c.path,
        match: c.match,
        icon: c.icon,
        labelKey: c.i18nKey,
        labelFallback: c.i18nFallback,
      }));
  };

  const renderItem = (item: NavItem) => {
    // KS-2840: пункт с подменю — рендерим SidebarSubmenu на desktop,
    // обычный Link на mobile (там submenu не показываем — Lobby
    // покрывает разводку).
    if (item.children && !isMobile) {
      const childItems = visibleChildren(item.children);
      // Если все подпункты выключены — fallback на обычный Link
      // (parent уже прошёл customGate, значит хоть что-то должно быть
      // видно; ссылка ведёт на лобби-страницу).
      if (childItems.length === 0) {
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
      }
      const submenuId = item.path.replace(/^\//, '');
      return (
        <SidebarSubmenu
          key={item.path}
          id={submenuId}
          icon={item.icon}
          titleKey={item.i18nKey}
          titleFallback={item.i18nKey}
          items={childItems}
          active={isActive(item.path, item.match)}
          isOpen={openSubmenuId === submenuId}
          onOpen={() => setOpenSubmenuId(submenuId)}
          onClose={() =>
            setOpenSubmenuId((curr) => (curr === submenuId ? null : curr))
          }
        />
      );
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
  };

  return (
    <>
      <aside className="sidebar">
        {/* KS-2801: главная навигация — 5 групповых контентных пунктов. */}
        <div className="sidebar-main" data-testid="sidebar-main">
          {mainItems.map(renderItem)}
        </div>
        <div className="sidebar-spacer" />
        {/* KS-2801: футер — утилитарные пункты (Профиль/Друзья/Настройки/
            Feedback/Admin). Отделён от основной навигации `sidebar-spacer`
            (растягивается на свободное место) и визуальным `sidebar-divider`. */}
        <div className="sidebar-divider" />
        <div className="sidebar-footer" data-testid="sidebar-footer">
          {footerItems.map(renderItem)}
          {/* KS-2252: эмодзи изменена с 💬 на 📝, чтобы кнопка обратной
              связи не путалась с иконкой `ChatWidget` (ассистент в правом
              нижнем углу — KS-2228, default `assistantEnabled=false`).
              Пользователь жаловался на «бейджик ассистента» именно из-за
              совпадающей 💬 — функционально кнопка относится к feedback,
              под `assistantEnabled` её прятать неверно. */}
          <button
            className="sidebar-item sidebar-feedback-btn"
            onClick={() => setShowFeedback(true)}
            title={t('feedback.title', 'Feedback')}
            data-testid="sidebar-feedback-btn"
          >
            <span className="sidebar-icon">📝</span>
          </button>
        </div>
      </aside>
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
    </>
  );
}
