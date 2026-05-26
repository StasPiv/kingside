/**
 * KS-3348 (ADR-079 §3.4) + KS-3362 (ADR-080 §7 F2). Sticky-кнопка
 * «Начать тренировку» на странице `/precision`. По нажатию вызывает
 * `GET /precision/next` с текущими фильтрами (scope / objective /
 * blundererElo / hideSolved / themes) и навигирует на пазл-страницу
 * с `?source=precision&<preserved-params>`.
 *
 * Состояния:
 *   - idle: «Начать тренировку».
 *   - loading: disabled + «Подбираем…».
 *   - empty: «Нет подходящих задач в выбранном фильтре».
 *   - emptyThemes: «Нет задач по выбранным темам, расширьте фильтр»
 *     (KS-3362 — backend reason='no_puzzles_for_themes').
 *   - error: «Не удалось подобрать задачу» (network/5xx).
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext';
import { precisionApi } from '../../api/precisionApi';
import { buildPrecisionNextParams } from '../../utils/puzzleNav';

type Status = 'idle' | 'loading' | 'empty' | 'emptyThemes' | 'error';

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
        // KS-3348 / KS-3362: 404. Discriminated reason
        // (PickNextPrecisionEmptyReason):
        //   - no_puzzles_for_themes — выбранные темы не дают пазлов,
        //     показываем спец-сообщение «расширьте фильтр».
        //   - no_puzzles_available — общий «нет задач» (рейтинг-окно).
        const reason = (res as { reason?: string }).reason;
        setStatus(reason === 'no_puzzles_for_themes' ? 'emptyThemes' : 'empty');
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
      {status === 'emptyThemes' && (
        <p
          className="precision-start-training__hint precision-start-training__hint--empty"
          data-testid="precision-start-training-empty-themes"
          role="status"
        >
          {t(
            'precision.themes.noPuzzlesForThemes',
            'No puzzles match selected themes, broaden the filter',
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
