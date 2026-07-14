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
import { useEffect, useMemo, useRef, useState } from 'react';

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

/** movetime Stockfish на узел разбора (мс). */
const REVIEW_MOVETIME_MS = 1000;

/** Тайминги проигрывания на доске — паузы больше, чтобы не мельтешило. */
const REVIEW_TIMINGS = {
  animateMoveMs: 300,
  holdMoveMs: 1800,
  holdKeyMs: 2800,
  resetMs: 300,
};

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
  /**
   * KS-4949: внешний запуск разбора (из контекстного меню доски).
   * Каждый инкремент значения > 0 стартует разбор текущей позиции.
   * Точка входа вынесена из панели в меню — своей кнопки «Разобрать»
   * панель больше не рендерит, а в idle не занимает места в макете.
   */
  startToken?: number;
  /** KS-4950: инкремент останавливает текущий разбор (пункт «Стоп разбор»). */
  stopToken?: number;
  /** KS-4950: активен ли разбор — для смены пункта меню Разобрать⇄Стоп. */
  onActiveChange?: (active: boolean) => void;
}

export function ReviewPanel({
  currentFen,
  elo,
  review,
  onAutoplayingChange,
  startToken = 0,
  stopToken = 0,
  onActiveChange,
}: ReviewPanelProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Актуальный review для чтения текущего узла в момент запуска.
  const reviewRef = useRef(review);
  reviewRef.current = review;
  // KS-4950: узел, из которого запущен разбор (текущая позиция). Возврат
  // к корню ведёт сюда, а не в начало партии.
  const [rootGlobalIndex, setRootGlobalIndex] = useState(-1);

  // KS-4950: интерактивность важнее исчерпывающей глубины — короткий
  // быстрый обход, чтобы движение фигур начиналось за несколько секунд,
  // а не после полной 2-минутной сборки. Меньше movetime + жёстче лимиты.
  const engines = useMemo(() => createDefaultEngines(REVIEW_MOVETIME_MS), []);
  useEffect(() => () => engines.terminate(), [engines]);

  const sfAvailable = useMemo(() => isStockfishAvailable(), []);
  const adapter = useMemo(
    () => createReviewEngines(engines, { sfEnabled: sfAvailable }),
    [engines, sfAvailable],
  );
  const config = useMemo(() => {
    const base = defaultReviewConfig(elo);
    return {
      ...base,
      limits: { ...base.limits, maxDepth: 10, maxNodes: 100 },
    };
  }, [elo]);

  const posReview = usePositionReview({ engines: adapter, config });
  const player = useReviewPlayer({
    plan: posReview.plan,
    review,
    reducedMotion,
    rootGlobalIndex,
    timings: REVIEW_TIMINGS,
  });

  // Проброс флага автопроигрывания наверх (блокировка ручного ввода §6).
  useEffect(() => {
    onAutoplayingChange?.(player.isAutoplaying);
  }, [player.isAutoplaying, onAutoplayingChange]);

  // KS-4950: активность разбора (для пункта меню Разобрать⇄Стоп).
  // Активно, пока идёт расчёт или проигрывание не завершено.
  const active =
    posReview.status === 'building' ||
    (posReview.status === 'ready' && player.status !== 'done');
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // KS-4950: как только план готов — сразу автопроигрывание, чтобы
  // фигуры двигались по доске сами, ход за ходом (без нажатия «Играть»).
  const playRef = useRef(player.play);
  playRef.current = player.play;
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (posReview.status === 'ready' && !autoStartedRef.current) {
      autoStartedRef.current = true;
      playRef.current();
    } else if (posReview.status !== 'ready') {
      autoStartedRef.current = false;
    }
  }, [posReview.status]);

  // KS-4949: запуск разбора приходит извне (пункт контекстного меню
  // доски), а не из своей кнопки. Каждый инкремент startToken стартует
  // разбор текущей позиции. currentFen читаем через ref, чтобы эффект
  // не перезапускался на смену позиции — только на явный запуск.
  const runRef = useRef(posReview.run);
  runRef.current = posReview.run;
  const currentFenRef = useRef(currentFen);
  currentFenRef.current = currentFen;
  useEffect(() => {
    if (startToken > 0) {
      // Корень разбора = текущая позиция пользователя (узел, из которого
      // запущено). Возврат к корню в плане приведёт сюда.
      setRootGlobalIndex(reviewRef.current.getCurrentGlobalIndex());
      void runRef.current(currentFenRef.current);
    }
  }, [startToken]);

  // KS-4950: «Стоп разбор» из меню — прерываем расчёт и проигрывание.
  const cancelRef = useRef(posReview.cancel);
  cancelRef.current = posReview.cancel;
  const resetRef = useRef(posReview.reset);
  resetRef.current = posReview.reset;
  useEffect(() => {
    if (stopToken > 0) {
      cancelRef.current();
      resetRef.current();
    }
  }, [stopToken]);

  // KS-4950: разбор показывается ТОЛЬКО на самой доске — фигуры двигаются
  // ход за ходом (автопроигрывание при готовности плана). Никакого
  // видимого интерфейса: ни панели, ни кнопок, ни статусной строки.
  // Компонент — невидимый контроллер: запуск из «…»-меню доски, дальше
  // ходы сами применяются к дереву и анимируются на доске.
  return null;
}
