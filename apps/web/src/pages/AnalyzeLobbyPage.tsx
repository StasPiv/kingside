import { useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useIsMobile } from '../hooks/useIsMobile';

/**
 * KS-2797 (ADR-058 §6.1 T2) — лобби группы «Анализ» (`/analyze`).
 *
 * 2 карточки: Лаборатория (Workshop) и Архив. Композиция/стиль —
 * как у `TrainLobbyPage` (KS-2796) и `DiscoverCoursesPage`. Без
 * feature-flag-gating — обе фичи всегда доступны.
 *
 * Маршрут `/analysis` (старый) сохраняется как редирект на
 * `/workshop` — настраивается в App.tsx (KS-2799).
 */

interface LobbyCardItem {
  id: 'workshop' | 'archive';
  to: string;
  icon: string;
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
}

const ITEMS: LobbyCardItem[] = [
  {
    id: 'workshop',
    to: '/workshop',
    icon: '🔬',
    titleKey: 'analyze.lobby.workshop.title',
    titleDefault: 'Workshop',
    descKey: 'analyze.lobby.workshop.desc',
    descDefault: 'Deep analysis with Stockfish, variations and annotations.',
  },
  {
    id: 'archive',
    to: '/archive',
    icon: '📚',
    titleKey: 'analyze.lobby.archive.title',
    titleDefault: 'Archive',
    descKey: 'analyze.lobby.archive.desc',
    descDefault: 'Browse master games and your own past games.',
  },
];

export function AnalyzeLobbyPage() {
  const { t } = useTranslation();
  // KS-2844 (ADR-058 §11.5): на desktop /analyze → редирект на
  // /workshop (primary). Archive доступен через sidebar-submenu или
  // прямой URL. На mobile — рендер карточек.
  const isMobile = useIsMobile();

  // KS-4222: document.title больше не подменяем — конфликтует с
  // SeoHelmet/PageSeo (см. BlindBoardLandingPage).

  if (!isMobile) {
    return <Navigate to="/workshop" replace />;
  }

  return (
    <div className="lobby-page lobby-page--analyze" data-testid="analyze-lobby-page">
      <header className="lobby-page__header">
        <h1>{t('analyze.lobby.title', 'Analyze')}</h1>
        <p className="lobby-page__subtitle">
          {t(
            'analyze.lobby.subtitle',
            'Dive into your games and study positions in depth.',
          )}
        </p>
      </header>

      <div className="lobby-card-grid" data-testid="analyze-lobby-grid">
        {ITEMS.map((it) => (
          <Link
            key={it.id}
            to={it.to}
            className="lobby-card"
            data-testid={`analyze-lobby-card-${it.id}`}
          >
            <span className="lobby-card__icon" aria-hidden="true">
              {it.icon}
            </span>
            <div className="lobby-card__text">
              <span className="lobby-card__title">
                {t(it.titleKey, it.titleDefault)}
              </span>
              <span className="lobby-card__desc">
                {t(it.descKey, it.descDefault)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
