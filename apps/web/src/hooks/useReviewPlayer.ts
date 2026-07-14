/**
 * KS-4944 (ADR-165 §5-§6). Хук-проигрыватель `ReviewPlayer`: rAF-степпер
 * плана разбора в дерево партии по одному полуходу за тик.
 *
 * Вся детерминированная логика (применение операций, тайминги, поиск
 * узлов, прогресс) — в чистом `review/reviewPlayer.ts`, покрыта unit-
 * тестами. Здесь — React-обвязка: rAF-цикл, play/pause/step/replay,
 * множитель скорости, prefers-reduced-motion → пошаговый режим,
 * блокировка ручного ввода на автопроигрывании.
 *
 * Защита от гонки async dispatch (ADR §7): ровно одна операция за тик.
 * `move` пишет узел, а `idIndex` (id узла плана→globalIndex для goto к
 * развилкам) обновляется пост-коммит-эффектом, когда React уже применил
 * dispatch и `currentFen`/`currentGlobalIndex` актуальны.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyReviewOp,
  clampReviewSpeed,
  DEFAULT_REVIEW_TIMINGS,
  effectiveHoldMs,
  holdMsForOp,
  reviewProgress,
  type ApplyOpContext,
  type ReviewPlayerReviewApi,
  type ReviewTimings,
} from '../review/reviewPlayer';
import type { ReviewPlan } from '../lib/review/positionReview';
import type { ChessMove } from '../review/types';

export type ReviewPlayerStatus = 'idle' | 'playing' | 'paused' | 'done';

/** Live-читатели review-состояния (из useReviewState, обновляются каждый рендер). */
export interface ReviewPlayerReviewState extends ReviewPlayerReviewApi {
  currentMove: ChessMove | null;
}

export interface UseReviewPlayerOptions {
  plan: ReviewPlan | null;
  review: ReviewPlayerReviewState;
  timings?: ReviewTimings;
  /** prefers-reduced-motion: анимация off + пошаговый режим (нет авто-адванса). */
  reducedMotion?: boolean;
  /**
   * KS-4950: globalIndex узла, из которого запущен разбор (текущая
   * позиция). Возврат к корню ведёт сюда, а не в начало партии. `-1` —
   * корень = стартовая позиция.
   */
  rootGlobalIndex?: number;
}

export interface UseReviewPlayerResult {
  status: ReviewPlayerStatus;
  /** Индекс последней применённой операции плана (−1 до старта). */
  opIndex: number;
  /** «узел i из N» по move-операциям. */
  progress: { current: number; total: number };
  speed: number;
  /** true — идёт автопроигрывание: ручной ввод/навигацию блокировать. */
  isAutoplaying: boolean;
  /** true — reduced-motion: авто-адванса нет, доступен только Step. */
  stepMode: boolean;
  /** Комментарий текущего узла (для строки-подписи UI). */
  currentComment: string | null;
  play: () => void;
  pause: () => void;
  step: () => void;
  replay: () => void;
  setSpeed: (speed: number) => void;
}

export function useReviewPlayer(
  options: UseReviewPlayerOptions,
): UseReviewPlayerResult {
  const {
    plan,
    review,
    timings = DEFAULT_REVIEW_TIMINGS,
    reducedMotion = false,
    rootGlobalIndex = -1,
  } = options;

  const [status, setStatus] = useState<ReviewPlayerStatus>('idle');
  const [opIndex, setOpIndex] = useState<number>(-1);
  const [speed, setSpeedState] = useState<number>(1);

  // Ref на актуальное review-состояние — rAF-колбэк читает через него,
  // чтобы не завязываться на устаревшее замыкание рендера.
  const reviewRef = useRef(review);
  reviewRef.current = review;

  // Ref-зеркала для rAF-замыкания.
  const opIndexRef = useRef(opIndex);
  opIndexRef.current = opIndex;
  const statusRef = useRef(status);
  statusRef.current = status;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const accRef = useRef(0);
  // id узла плана → globalIndex созданного узла (для goto к развилке).
  const idIndexRef = useRef<Map<number, number>>(new Map());

  const reviewApi = useMemo<ReviewPlayerReviewApi>(
    () => ({
      makeVariantMove: (f, t, p) => reviewRef.current.makeVariantMove(f, t, p),
      gotoMove: (m) => reviewRef.current.gotoMove(m),
      gotoFirst: () => reviewRef.current.gotoFirst(),
      setNag: (gi, n) => reviewRef.current.setNag(gi, n),
      setComment: (gi, c) => reviewRef.current.setComment(gi, c),
      getHistory: () => reviewRef.current.getHistory(),
      getCurrentGlobalIndex: () => reviewRef.current.getCurrentGlobalIndex(),
      getCurrentFen: () => reviewRef.current.getCurrentFen(),
    }),
    [],
  );

  const ctxRef = useRef<ApplyOpContext>({
    idIndex: idIndexRef.current,
    rootGlobalIndex,
  });
  ctxRef.current = { idIndex: idIndexRef.current, rootGlobalIndex };

  /** Применить следующую операцию плана. Возвращает false, если план кончился. */
  const advance = useCallback((): boolean => {
    if (!plan) return false;
    const next = opIndexRef.current + 1;
    if (next >= plan.ops.length) {
      setStatus('done');
      return false;
    }
    applyReviewOp(plan.ops[next], reviewApi, ctxRef.current);
    opIndexRef.current = next;
    setOpIndex(next);
    return true;
  }, [plan, reviewApi]);

  // Пост-коммит-эффект: после применения `move`-операции React уже
  // закоммитил dispatch — записываем id узла плана → globalIndex созданного
  // узла, чтобы goto к развилке нашёл РОВНО тот узел (без FEN-неоднозначности
  // при транспозициях). Защита от гонки async dispatch (ADR §7).
  useEffect(() => {
    if (!plan || opIndex < 0 || opIndex >= plan.ops.length) return;
    const op = plan.ops[opIndex];
    if (op.type === 'move') {
      const gi = reviewRef.current.getCurrentGlobalIndex();
      if (gi >= 0) idIndexRef.current.set(op.id, gi);
    }
  }, [opIndex, plan]);

  // rAF-цикл автопроигрывания. В reduced-motion не запускается —
  // пошаговый режим (только Step).
  useEffect(() => {
    if (status !== 'playing' || reducedMotion || !plan) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTsRef.current = null;
      return;
    }
    const tick = (ts: number) => {
      const last = lastTsRef.current ?? ts;
      lastTsRef.current = ts;
      accRef.current += ts - last;

      const curOp = plan.ops[opIndexRef.current];
      const base = curOp ? holdMsForOp(curOp, timings, reducedMotion) : 0;
      const hold = effectiveHoldMs(base, speedRef.current);
      if (accRef.current >= hold) {
        accRef.current = 0;
        const advanced = advance();
        if (!advanced) {
          if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          return; // план кончился, status → done в advance()
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTsRef.current = null;
    };
  }, [status, reducedMotion, plan, timings, advance]);

  const play = useCallback(() => {
    if (!plan) return;
    if (opIndexRef.current + 1 >= plan.ops.length) return; // уже в конце
    accRef.current = 0;
    lastTsRef.current = null;
    if (reducedMotion) {
      // Пошаговый режим: «play» = один шаг.
      advance();
      return;
    }
    setStatus('playing');
  }, [plan, reducedMotion, advance]);

  const pause = useCallback(() => {
    setStatus((s) => (s === 'playing' ? 'paused' : s));
  }, []);

  const step = useCallback(() => {
    setStatus((s) => (s === 'playing' ? 'paused' : s));
    advance();
  }, [advance]);

  const replay = useCallback(() => {
    // Повтор: возврат в стартовую позицию и сброс индекса. makeVariantMove
    // при повторе дедуплицирует (GOTO_MOVE к существующим узлам) — дерево
    // не дублируется, плеер повторно проходит уже записанные варианты.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    reviewRef.current.gotoFirst();
    accRef.current = 0;
    lastTsRef.current = null;
    opIndexRef.current = -1;
    setOpIndex(-1);
    setStatus('idle');
  }, []);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(clampReviewSpeed(s));
  }, []);

  const progress = useMemo(
    () => (plan ? reviewProgress(plan, opIndex) : { current: 0, total: 0 }),
    [plan, opIndex],
  );

  const isAutoplaying = status === 'playing' && !reducedMotion;
  const currentComment = review.currentMove?.comment ?? null;

  return {
    status,
    opIndex,
    progress,
    speed,
    isAutoplaying,
    stepMode: reducedMotion,
    currentComment,
    play,
    pause,
    step,
    replay,
    setSpeed,
  };
}
