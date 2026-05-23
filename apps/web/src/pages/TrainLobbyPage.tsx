import { useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useFeatureFlag } from '../context/FeatureFlagsContext';
import { useIsMobile } from '../hooks/useIsMobile';

/**
 * KS-2796 (ADR-058 §6.1 T1) — лобби группы «Тренировка» (`/train`).
 *
 * Объединяет в одной точке входа 4 тренировочных раздела (Задачи,
 * Puzzle Rush, Тренажёры, Точность). Каждая карточка ведёт на свой
 * существующий маршрут; gating — через feature-flag'и.
 *
 * Если все 4 подраздела выключены — рендерится «coming soon»-заглушка,
 * а `Sidebar` (KS-2800) скрывает пункт `Train` из навигации.
 *
 * Композиция — по образцу `DiscoverCoursesPage.tsx` (KS-1923).
 * Доступна и авторизованным, и гостям — gating решает дочерний
 * маршрут (`<ProtectedRoute>` где нужно).
 */

interface LobbyCardItem {
  id: 'puzzles' | 'puzzle-rush' | 'drills' | 'precision' | 'opening-trainer';
  to: string;
  icon: string;
  titleKey: string;
  titleDefault: string;
  descKey: string;
  descDefault: string;
  enabled: boolean;
}

export function TrainLobbyPage() {
  const { t } = useTranslation();
  const puzzlesEnabled = useFeatureFlag('puzzlesEnabled');
  const drillsEnabled = useFeatureFlag('drillsEnabled');
  // KS-2844 (ADR-058 §11.5): на desktop лобби-страница — redirect на
  // первый разрешённый подраздел (sidebar-submenu даёт прямой доступ
  // ко всем). На mobile рендерим грид карточек как раньше.
  const isMobile = useIsMobile();

  useEffect(() => {
    const prevTitle = document.title;
    document.title = `${t('train.lobby.title', 'Train')} — Kingside`;
    return () => {
      document.title = prevTitle;
    };
  }, [t]);

  // Desktop redirect (порядок приоритета по ADR-058 §11.5):
  //   puzzlesEnabled → /puzzles
  //   иначе → /puzzle-rush (Rush открыт всегда)
  //   фоллбек (теоретический — Rush всегда есть): drills/precision/lobby.
  if (!isMobile) {
    let target: string;
    if (puzzlesEnabled) target = '/puzzles';
    else target = '/puzzle-rush';
    // Дальнейшие проверки оставлены для будущего gating'а Rush'а:
    //   if (drillsEnabled) target = '/drills';
    //   else if (puzzlesEnabled) target = '/precision';
    //   else target = '/lobby';
    // На момент KS-2844 Rush открыт безусловно → fallback'и не нужны.
    void drillsEnabled; // silence unused-warn при текущей логике
    return <Navigate to={target} replace />;
  }

  const items: LobbyCardItem[] = [
    {
      id: 'puzzles',
      to: '/puzzles',
      icon: '🧩',
      titleKey: 'train.lobby.puzzles.title',
      titleDefault: 'Puzzles',
      descKey: 'train.lobby.puzzles.desc',
      descDefault: 'Solve curated tactics, build your puzzle rating.',
      enabled: puzzlesEnabled,
    },
    {
      id: 'puzzle-rush',
      to: '/puzzle-rush',
      icon: '⚡',
      titleKey: 'train.lobby.puzzleRush.title',
      titleDefault: 'Puzzle Rush',
      descKey: 'train.lobby.puzzleRush.desc',
      descDefault: 'Race the clock — how many tactics in 3 minutes?',
      // Rush сейчас не имеет отдельного feature-flag'а — открыт всегда,
      // как и `/puzzle-rush` маршрут (см. App.tsx).
      enabled: true,
    },
    {
      id: 'drills',
      to: '/drills',
      icon: '🧠',
      titleKey: 'train.lobby.drills.title',
      titleDefault: 'Drills',
      descKey: 'train.lobby.drills.desc',
      descDefault: 'Pattern-focused mini-exercises (forks, pins, etc).',
      enabled: drillsEnabled,
    },
    {
      id: 'precision',
      to: '/precision',
      icon: '🎯',
      titleKey: 'train.lobby.precision.title',
      titleDefault: 'Precision',
      descKey: 'train.lobby.precision.desc',
      descDefault: 'Play out puzzles vs Stockfish — measure precision.',
      enabled: puzzlesEnabled,
    },
    {
      // KS-3276 (ADR-077 M1): новая точка входа в Opening Trainer.
      // Feature-flag `openingTrainerEnabled` отдельно НЕ заводили —
      // фича уже под `ProtectedRoute`, доступ ограничен авторизацией.
      // Если потребуется gating без redeploy — backend добавит флаг в
      // FeatureFlags (нужен PR в packages/shared + config-service), и
      // тут `enabled: useFeatureFlag('openingTrainerEnabled')`.
      id: 'opening-trainer',
      to: '/opening-trainer',
      icon: '♔',
      titleKey: 'train.lobby.openingTrainer.title',
      titleDefault: 'Openings',
      descKey: 'train.lobby.openingTrainer.desc',
      descDefault: 'Train your own repertoire variations.',
      enabled: true,
    },
  ];

  const visibleItems = items.filter((it) => it.enabled);
  const allDisabled = visibleItems.length === 0;

  return (
    <div className="lobby-page lobby-page--train" data-testid="train-lobby-page">
      <header className="lobby-page__header">
        <h1>{t('train.lobby.title', 'Train')}</h1>
        <p className="lobby-page__subtitle">
          {t(
            'train.lobby.subtitle',
            'Sharpen tactics, patterns and precision.',
          )}
        </p>
      </header>

      {allDisabled ? (
        <div
          className="lobby-page__coming-soon"
          data-testid="train-lobby-coming-soon"
        >
          {t(
            'train.lobby.comingSoon',
            'All training modules are temporarily disabled. Come back soon.',
          )}
        </div>
      ) : (
        <div className="lobby-card-grid" data-testid="train-lobby-grid">
          {visibleItems.map((it) => (
            <Link
              key={it.id}
              to={it.to}
              className="lobby-card"
              data-testid={`train-lobby-card-${it.id}`}
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
      )}
    </div>
  );
}
