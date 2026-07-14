/**
 * KS-4945 (ADR-165 §6). UI-панель разбора позиции на AnalysisPage.
 *
 * Оркестратор (`usePositionReview`) + проигрыватель (`useReviewPlayer`)
 * связаны здесь с движками через адаптер `createReviewEngines` поверх
 * промис-драйвера `createDefaultEngines` (SF UCI_ShowWDL + Maia).
 *
 * Состояния: idle → [Разобрать] → building (прогресс узлов + Отмена) →
 * ready (Play/Pause/Step/повтор/скорость + подпись + «узел i из N»).
 * no_coi: Stockfish недоступен → явное сообщение, разбор идёт по Maia.
 *
 * Тонкая стилизация — задача layout (KS-4946); здесь только разметка
 * контейнеров/кнопок с data-testid и минимальными inline-отступами.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createDefaultEngines } from '../../hooks/useGameReview';
import { usePositionReview } from '../../hooks/usePositionReview';
import {
  useReviewPlayer,
  type ReviewPlayerReviewState,
} from '../../hooks/useReviewPlayer';
import { defaultReviewConfig } from '../../lib/review/positionReview';
import {
  createReviewEngines,
  isStockfishAvailable,
} from '../../lib/review/reviewEnginesAdapter';

const SPEEDS: readonly number[] = [0.5, 1, 1.5, 2];

/** prefers-reduced-motion: анимация off + пошаговый режим. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof matchMedia === 'undefined') return false;
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

export interface ReviewPanelProps {
  /** FEN текущей позиции доски — корень разбора. */
  currentFen: string;
  /** ELO уровня Maia (рейтинг игрока или 1500). */
  elo: number;
  /** Actions/читатели useReviewState для записи плана в дерево. */
  review: ReviewPlayerReviewState;
  /** Уведомление о старте/остановке автопроигрывания (для блокировки ввода). */
  onAutoplayingChange?: (autoplaying: boolean) => void;
}

export function ReviewPanel({
  currentFen,
  elo,
  review,
  onAutoplayingChange,
}: ReviewPanelProps) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();

  // Выделенный промис-драйвер SF+Maia на время жизни панели.
  const engines = useMemo(() => createDefaultEngines(), []);
  useEffect(() => () => engines.terminate(), [engines]);

  const sfAvailable = useMemo(() => isStockfishAvailable(), []);
  const adapter = useMemo(
    () => createReviewEngines(engines, { sfEnabled: sfAvailable }),
    [engines, sfAvailable],
  );
  const config = useMemo(() => defaultReviewConfig(elo), [elo]);

  const posReview = usePositionReview({ engines: adapter, config });
  const player = useReviewPlayer({
    plan: posReview.plan,
    review,
    reducedMotion,
  });

  // Проброс флага автопроигрывания наверх (блокировка ручного ввода §6).
  useEffect(() => {
    onAutoplayingChange?.(player.isAutoplaying);
  }, [player.isAutoplaying, onAutoplayingChange]);

  const { status } = posReview;
  const hasPlan = status === 'ready' && !!posReview.plan;

  return (
    <section
      className="review-panel"
      data-testid="review-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}
    >
      <h3 style={{ margin: 0 }}>{t('review.panel.title', 'Разбор позиции')}</h3>

      {!sfAvailable && (
        <p className="review-panel__note" data-testid="review-panel-no-coi">
          {t(
            'review.panel.noCoi',
            'Stockfish недоступен в этом браузере — разбор строится только по Maia.',
          )}
        </p>
      )}

      {/* --- idle / cancelled / error: запуск --- */}
      {(status === 'idle' || status === 'cancelled' || status === 'error') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            data-testid="review-panel-start"
            onClick={() => void posReview.run(currentFen)}
          >
            {t('review.panel.start', 'Разобрать позицию')}
          </button>
          {status === 'cancelled' && (
            <span data-testid="review-panel-cancelled">
              {t('review.panel.cancelled', 'Расчёт отменён')}
            </span>
          )}
          {status === 'error' && (
            <span className="error" data-testid="review-panel-error">
              {posReview.error ?? t('review.panel.error', 'Ошибка расчёта')}
            </span>
          )}
        </div>
      )}

      {/* --- building: прогресс + отмена --- */}
      {status === 'building' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span data-testid="review-panel-building">
            {t('review.panel.building', 'Расчёт плана…')}{' '}
            {t('review.panel.nodes', 'узлов')}: {posReview.builtNodes}
          </span>
          <button
            type="button"
            data-testid="review-panel-cancel"
            onClick={posReview.cancel}
          >
            {t('review.panel.cancel', 'Отмена')}
          </button>
        </div>
      )}

      {/* --- ready: контролы проигрывателя --- */}
      {hasPlan && (
        <div
          className="review-panel__player"
          data-testid="review-panel-player"
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="review-panel-playpause"
              onClick={() =>
                player.isAutoplaying ? player.pause() : player.play()
              }
            >
              {player.isAutoplaying
                ? t('review.panel.pause', 'Пауза')
                : t('review.panel.play', 'Играть')}
            </button>
            <button
              type="button"
              data-testid="review-panel-step"
              onClick={player.step}
            >
              {t('review.panel.step', 'Шаг')}
            </button>
            <button
              type="button"
              data-testid="review-panel-replay"
              onClick={player.replay}
            >
              {t('review.panel.replay', 'Повтор')}
            </button>
            {!reducedMotion && (
              <div
                role="group"
                aria-label={t('review.panel.speed', 'Скорость')}
                style={{ display: 'flex', gap: 2 }}
              >
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    data-testid={`review-panel-speed-${s}`}
                    aria-pressed={player.speed === s}
                    onClick={() => player.setSpeed(s)}
                  >
                    ×{s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            className="review-panel__progress"
            data-testid="review-panel-progress"
          >
            {t('review.panel.node', 'узел')} {player.progress.current}{' '}
            {t('review.panel.of', 'из')} {player.progress.total}
          </div>

          {player.currentComment && (
            <div
              className="review-panel__caption"
              data-testid="review-panel-caption"
            >
              {player.currentComment}
            </div>
          )}

          <button
            type="button"
            data-testid="review-panel-new"
            onClick={posReview.reset}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('review.panel.new', 'Новый разбор')}
          </button>
        </div>
      )}
    </section>
  );
}
