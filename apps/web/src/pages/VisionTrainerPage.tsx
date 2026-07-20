/**
 * KS-4984 / ADR-167 §7 (задача 3/7). Точка входа Vision-тренажёра
 * «зрения доски». Маршрут `/vision`.
 *
 * Setup-экран (лобби: режим/время/сложность) → по «Начать» монтируем
 * `<VisionSessionRunner>`. Выход обратно на лобби — через `onExit`
 * (кнопка «Играть ещё» в финале). Открыт гостю: результат гостя не
 * сохраняется (backend `OptionalJwtGuard`, ADR §5).
 *
 * Стили — задача 5/7 (layout); лидерборд/статистика/история — 4/7.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import {
  VisionLobby,
  type VisionSessionConfig,
} from '../components/vision/VisionLobby';
import { VisionSessionRunner } from '../components/vision/VisionSessionRunner';

export function VisionTrainerPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [config, setConfig] = useState<VisionSessionConfig | null>(null);

  const handleStart = useCallback((cfg: VisionSessionConfig) => {
    setConfig(cfg);
  }, []);
  const handleExit = useCallback(() => setConfig(null), []);

  if (config) {
    return (
      <div
        className="vision-page"
        data-testid="vision-page"
        data-state="playing"
      >
        <div className="vision-page__header">
          <button
            type="button"
            className="vision-page__back"
            data-testid="vision-page-back"
            onClick={handleExit}
          >
            ← {t('vision.setup.back', 'New game')}
          </button>
        </div>
        <VisionSessionRunner config={config} onExit={handleExit} />
      </div>
    );
  }

  return (
    <div className="vision-page" data-testid="vision-page" data-state="setup">
      {!user && (
        <div className="guest-banner" data-testid="vision-guest-banner">
          <Link to="/login">
            {t('auth.loginToSaveProgress', 'Sign in to save your progress')}
          </Link>
        </div>
      )}
      <h1 data-testid="vision-page-title">
        {t('vision.setup.title', 'Board vision')}
      </h1>
      <p className="vision-page__intro">
        {t(
          'vision.setup.intro',
          'Sharpen your board sight: square colors, coordinates, relations and piece geometry. Pick a mode, a sprint length and a difficulty, then answer as many as you can before the time runs out.',
        )}
      </p>
      <VisionLobby onStart={handleStart} />
    </div>
  );
}
