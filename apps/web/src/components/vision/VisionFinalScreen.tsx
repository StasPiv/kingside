/**
 * KS-4984 / ADR-167 §7 (задача 3/7). Экран итогов Sprint-сессии.
 * На маунте один раз отправляет `POST /vision/results` (ADR §5):
 * гость → бэкенд отвечает `saved:false` (не сохраняется), авторизованный
 * → результат уходит в БД. Статус сохранения показываем пользователю.
 *
 * Лидерборд/личный рекорд — задача 4/7; здесь только табло + сабмит +
 * «Играть ещё».
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VisionResult } from '@kingside/shared';

import { visionApi } from '../../api/visionApi';

type SaveState = 'idle' | 'saving' | 'saved' | 'guest' | 'error';

export interface VisionFinalScreenProps {
  result: VisionResult;
  onPlayAgain: () => void;
  /** DI для тестов. */
  api?: typeof visionApi;
}

export function VisionFinalScreen({
  result,
  onPlayAgain,
  api = visionApi,
}: VisionFinalScreenProps) {
  const { t } = useTranslation();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;
    setSaveState('saving');
    void (async () => {
      try {
        const res = await api.submitResult(result);
        setSaveState(res.saved ? 'saved' : 'guest');
      } catch {
        setSaveState('error');
      }
    })();
  }, [api, result]);

  const accuracyPct = Math.round(result.accuracy * 100);

  return (
    <div className="vision-final" data-testid="vision-final">
      <h2 className="vision-final__title" data-testid="vision-final-title">
        {t('vision.final.title', 'Session complete')}
      </h2>
      <dl className="vision-final__stats">
        <Stat
          testid="vision-final-score"
          label={t('vision.final.score', 'Score')}
          value={`${result.score}/${result.total}`}
        />
        <Stat
          testid="vision-final-accuracy"
          label={t('vision.final.accuracy', 'Accuracy')}
          value={`${accuracyPct}%`}
        />
        <Stat
          testid="vision-final-streak"
          label={t('vision.final.maxStreak', 'Best streak')}
          value={String(result.maxStreak)}
        />
        <Stat
          testid="vision-final-avg"
          label={t('vision.final.avg', 'Avg time')}
          value={`${(result.avgResponseMs / 1000).toFixed(2)}s`}
        />
      </dl>

      <p
        className="vision-final__save"
        data-testid="vision-final-save"
        data-save-state={saveState}
      >
        {saveState === 'saving' &&
          t('vision.final.saving', 'Saving result…')}
        {saveState === 'saved' &&
          t('vision.final.saved', 'Result saved')}
        {saveState === 'guest' &&
          t('vision.final.guest', 'Sign in to save your results')}
        {saveState === 'error' &&
          t('vision.final.saveError', 'Could not save the result')}
      </p>

      <button
        type="button"
        className="vision-final__again play-btn"
        data-testid="vision-final-again"
        onClick={onPlayAgain}
      >
        {t('vision.final.playAgain', 'Play again')}
      </button>
    </div>
  );
}

function Stat({
  testid,
  label,
  value,
}: {
  testid: string;
  label: string;
  value: string;
}) {
  return (
    <div className="vision-final__stat" data-testid={testid}>
      <dt className="vision-final__stat-label">{label}</dt>
      <dd className="vision-final__stat-value">{value}</dd>
    </div>
  );
}
