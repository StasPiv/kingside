import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';

/**
 * KS-2743 / ADR-057 §3, §4, §5, §6 — общий sub-nav для раздела
 * «Тренировка точности».
 *
 * KS-3244 (ADR-076 §7 F2): на mobile sub-nav обогащён двумя iconButton'ами
 * справа от вкладок:
 *   - `ⓘ` → popover с описанием раздела (заменяет скрываемый на mobile
 *     `<p class="play-vs-engine-puzzles__intro">`).
 *   - `⋮` → dropdown с action'ами «← Все пазлы» и «Генерация из PGN»
 *     (заменяет скрываемый на mobile `.play-vs-engine-puzzles__nav`).
 *
 * Оба меню видны только на mobile (CSS `@media (max-width: 767px)` в
 * puzzle.css). На desktop иконки скрыты — actions/intro остаются в
 * header'е PrecisionPage как раньше.
 */

type SubNavItem = {
  readonly path: string;
  readonly i18nKey: string;
  readonly fallback: string;
  readonly testKey: 'training' | 'progress' | 'history';
  readonly authOnly: boolean;
};

const ITEMS: readonly SubNavItem[] = [
  {
    path: '/precision',
    i18nKey: 'precision.subnav.training',
    fallback: 'Training',
    testKey: 'training',
    authOnly: false,
  },
  {
    path: '/precision/stats',
    i18nKey: 'precision.subnav.progress',
    fallback: 'Progress',
    testKey: 'progress',
    authOnly: true,
  },
  {
    path: '/precision/history',
    i18nKey: 'precision.subnav.history',
    fallback: 'History',
    testKey: 'history',
    authOnly: true,
  },
];

/**
 * KS-3244: optional callback на «Генерация из PGN». Передаётся
 * только PrecisionPage'ом — на /precision/stats и /precision/history
 * генератор недоступен. Если не передан — пункт меню скрыт.
 */
export interface PrecisionSubNavProps {
  onGenerateClick?: () => void;
}

export function PrecisionSubNav({ onGenerateClick }: PrecisionSubNavProps = {}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const isGuest = !user;

  const visibleItems = ITEMS.filter((item) => !item.authOnly || !isGuest);

  // KS-3244: state двух popup'ов (info + dots). Закрываем по click-outside
  // / Esc. Один общий useEffect — UX-канон, оба меню взаимоисключают.
  const [infoOpen, setInfoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!infoOpen && !menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInfoOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [infoOpen, menuOpen]);

  return (
    <nav
      className="precision-subnav"
      role="tablist"
      aria-label={t('precision.subnav.label', 'Precision sections')}
      data-testid="precision-subnav"
      data-guest={isGuest ? 'true' : 'false'}
    >
      {visibleItems.map((item) => {
        const active = location.pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            className={`precision-subnav__item${active ? ' precision-subnav__item--active' : ''}`}
            data-testid={`precision-subnav-${item.testKey}`}
            data-active={active ? 'true' : 'false'}
          >
            {t(item.i18nKey, item.fallback)}
          </Link>
        );
      })}

      {/* KS-3244: ⓘ + ⋮ — mobile-only. На desktop скрыты CSS-ом. */}
      <div
        className="precision-subnav__mobile-actions"
        ref={wrapperRef}
        data-testid="precision-subnav-mobile-actions"
      >
        <button
          type="button"
          className="precision-subnav__icon-btn"
          data-testid="precision-subnav-info-btn"
          aria-label={t('precision.subnav.about', 'About precision training')}
          aria-expanded={infoOpen}
          onClick={() => {
            setMenuOpen(false);
            setInfoOpen((v) => !v);
          }}
        >
          ⓘ
        </button>
        {/* ⋮ виден только если есть actions (PrecisionPage передал
            onGenerateClick). На /precision/stats и /history он скрыт. */}
        {onGenerateClick && (
          <button
            type="button"
            className="precision-subnav__icon-btn"
            data-testid="precision-subnav-menu-btn"
            aria-label={t('precision.subnav.moreActions', 'More actions')}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => {
              setInfoOpen(false);
              setMenuOpen((v) => !v);
            }}
          >
            ⋮
          </button>
        )}

        {infoOpen && (
          <div
            className="precision-subnav__popover"
            data-testid="precision-subnav-info-popover"
            role="dialog"
            aria-label={t('precision.subnav.about', 'About precision training')}
          >
            {t(
              'precision.intro',
              'Practice positions where a Stockfish-strong engine punishes mistakes. Find the precise sequence and outplay the machine.',
            )}
          </div>
        )}
        {menuOpen && onGenerateClick && (
          <div
            className="precision-subnav__menu"
            data-testid="precision-subnav-menu"
            role="menu"
          >
            <Link
              to="/puzzles"
              className="precision-subnav__menu-item"
              data-testid="precision-subnav-menu-back"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              ← {t('precision.backToAll', 'All puzzles')}
            </Link>
            <button
              type="button"
              className="precision-subnav__menu-item"
              data-testid="precision-subnav-menu-generate"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onGenerateClick();
              }}
            >
              {t('puzzleGenerator.fromPgn', 'Generate from PGN')}
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
