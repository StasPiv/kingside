/**
 * KS-3348 (ADR-079 §3.4). Sticky-кнопка «Начать тренировку» на
 * странице `/precision`. По нажатию вызывает `GET /precision/next` с
 * текущими фильтрами (scope / objective / blundererElo / hideSolved) и
 * навигирует на пазл-страницу с `?source=precision&<preserved-params>`.
 *
 * Расположение управляется CSS-родителем:
 *   - mobile (≤767px): full-width sticky-баннер над сеткой.
 *   - desktop: inline в шапке.
 *
 * Состояния:
 *   - idle: «Начать тренировку».
 *   - loading: disabled + текст «Подбираем…».
 *   - empty: inline-сообщение «Нет подходящих задач в выбранном фильтре».
 *   - error: «Не удалось подобрать задачу» (network/5xx).
 *
 * data-testid: `precision-start-training`, `precision-start-training-empty`,
 * `precision-start-training-error`.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext';
import { precisionApi } from '../../api/precisionApi';
import { buildPrecisionNextParams } from '../../utils/puzzleNav';

type Status = 'idle' | 'loading' | 'empty' | 'error';

export function PrecisionStartTrainingButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<Status>('idle');

  const handleClick = useCallback(async () => {
    setStatus('loading');
    try {
      const params = buildPrecisionNextParams(searchParams, Boolean(user));
      const res = await precisionApi.pickNext(params);
      if (res.puzzleId) {
        // Сохраняем текущие фильтры в URL пазла — для возврата через
        // back-link и для последующей «Следующая».
        const sp = new URLSearchParams(searchParams);
        sp.set('source', 'precision');
        navigate(`/puzzle/${res.puzzleId}?${sp.toString()}`);
        // Не сбрасываем `loading` — компонент unmount'ится при navigate.
      } else {
        // KS-3348: 404 → no_puzzles_available.
        setStatus('empty');
      }
    } catch {
      setStatus('error');
    }
  }, [searchParams, user, navigate]);

  return (
    <div
      className="precision-start-training"
      data-testid="precision-start-training-wrap"
    >
      <button
        type="button"
        className="precision-start-training__btn"
        data-testid="precision-start-training"
        onClick={handleClick}
        disabled={status === 'loading'}
        data-status={status}
      >
        {status === 'loading'
          ? t('precision.startTraining.loading', 'Picking…')
          : t('precision.startTraining.label', 'Start training')}
      </button>
      {status === 'empty' && (
        <p
          className="precision-start-training__hint precision-start-training__hint--empty"
          data-testid="precision-start-training-empty"
          role="status"
        >
          {t(
            'precision.startTraining.empty',
            'No puzzles match your current filter',
          )}
        </p>
      )}
      {status === 'error' && (
        <p
          className="precision-start-training__hint precision-start-training__hint--error"
          data-testid="precision-start-training-error"
          role="status"
        >
          {t(
            'precision.startTraining.error',
            'Could not pick a puzzle. Try again.',
          )}
        </p>
      )}
    </div>
  );
}
