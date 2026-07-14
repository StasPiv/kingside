/**
 * KS-4945/4949/4950 (ADR-165 §5-§6). Невидимый контроллер разбора позиции.
 *
 * Разбор показывается ТОЛЬКО на самой доске: ходы применяются к дереву
 * по мере расчёта (streaming через `onOp`), а не «накопили план → потом
 * проиграли». Фигуры двигаются с первого же посчитанного хода —
 * независимо от глубины/числа узлов. Никакого видимого интерфейса.
 *
 * Запуск/остановка — из «…»-меню доски (startToken/stopToken). Возврат к
 * развилке идёт по стабильному id узла плана (idIndex), корень разбора —
 * текущая позиция пользователя (rootGlobalIndex).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createDefaultEngines } from '../../hooks/useGameReview';
import { usePositionReview } from '../../hooks/usePositionReview';
import {
  applyReviewOp,
  effectiveHoldMs,
  holdMsForOp,
  type ApplyOpContext,
  type ReviewPlayerReviewApi,
  type ReviewTimings,
} from '../../review/reviewPlayer';
import type { ChessMove } from '../../review/types';
import {
  defaultReviewConfig,
  type ReviewPlanOp,
} from '../../lib/review/positionReview';
import {
  createReviewEngines,
  isStockfishAvailable,
  whiteEvalLineFromWdlAfter,
} from '../../lib/review/reviewEnginesAdapter';
import type { EvalLine } from '../../hooks/useStockfish';

/** movetime Stockfish на узел разбора (мс). */
const REVIEW_MOVETIME_MS = 1000;

/** Тайминги проигрывания на доске — паузы, чтобы фигуры не мельтешили. */
const REVIEW_TIMINGS: ReviewTimings = {
  animateMoveMs: 300,
  holdMoveMs: 1800,
  holdKeyMs: 2800,
  resetMs: 300,
};

/** Минимальная пауза, чтобы React успел закоммитить ход до чтения индекса. */
const COMMIT_MIN_MS = 60;

/** prefers-reduced-motion: без анимации/пауз (ходы применяются мгновенно). */
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

/** Live-читатели/действия useReviewState. */
export interface ReviewPanelReviewState extends ReviewPlayerReviewApi {
  currentMove: ChessMove | null;
}

export interface ReviewPanelProps {
  /** FEN текущей позиции доски — корень разбора. */
  currentFen: string;
  /** ELO уровня Maia (рейтинг игрока или 1500). */
  elo: number;
  /** Actions/читатели useReviewState для записи разбора в дерево. */
  review: ReviewPanelReviewState;
  /** Идёт разбор — блокировать ручной ввод/навигацию. */
  onAutoplayingChange?: (active: boolean) => void;
  /** KS-4949: инкремент запускает разбор текущей позиции (пункт меню). */
  startToken?: number;
  /** KS-4950: инкремент останавливает разбор (пункт «Стоп разбор»). */
  stopToken?: number;
  /** KS-4950: активен ли разбор — для смены пункта меню Разобрать⇄Стоп. */
  onActiveChange?: (active: boolean) => void;
  /**
   * KS-4950: текущая оценка разбора для градусника (EvalBar) — основной
   * движок выключен, оценку даёт сам разбор. `null` — сбросить.
   */
  onEvalChange?: (line: EvalLine | null) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function ReviewPanel({
  currentFen,
  elo,
  review,
  onAutoplayingChange,
  startToken = 0,
  stopToken = 0,
  onActiveChange,
  onEvalChange,
}: ReviewPanelProps) {
  const reducedMotion = usePrefersReducedMotion();

  const reviewRef = useRef(review);
  reviewRef.current = review;
  const onEvalChangeRef = useRef(onEvalChange);
  onEvalChangeRef.current = onEvalChange;

  // Выделенный промис-драйвер SF+Maia на время жизни панели.
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
      // Кандидаты — только ходы Maia с вероятностью ≥15%. Нет таких —
      // ветка обрывается с оценкой SF (см. buildReviewPlan). rel/nucleus
      // отключены (0 / 1) — фильтр только по абсолютному порогу 15%.
      thresholds: {
        ...base.thresholds,
        pFloor: 0.15,
        pNucleus: 1,
        rel: 0,
        nMax: 6,
      },
      limits: {
        ...base.limits,
        maxDepth: 10,
        maxNodes: 100,
        maxBranchPerSource: 6,
      },
    };
  }, [elo]);

  // Навигация плана: id узла → globalIndex; корень = текущая позиция.
  const idIndexRef = useRef<Map<number, number>>(new Map());
  const rootGiRef = useRef(-1);
  const ctxRef = useRef<ApplyOpContext>({
    idIndex: idIndexRef.current,
    rootGlobalIndex: -1,
  });

  const reviewApi = useMemo<ReviewPlayerReviewApi>(
    () => ({
      makeVariantMove: (f, t, p) => reviewRef.current.makeVariantMove(f, t, p),
      gotoMove: (m) => reviewRef.current.gotoMove(m),
      gotoFirst: () => reviewRef.current.gotoFirst(),
      setNag: (gi, n) => reviewRef.current.setNag(gi, n),
      setComment: (gi, c) => reviewRef.current.setComment(gi, c),
      promoteVariation: (m) => reviewRef.current.promoteVariation(m),
      getHistory: () => reviewRef.current.getHistory(),
      getCurrentGlobalIndex: () => reviewRef.current.getCurrentGlobalIndex(),
      getCurrentFen: () => reviewRef.current.getCurrentFen(),
    }),
    [],
  );

  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  // Streaming: применяем каждую операцию к доске сразу, держим паузу,
  // затем (для хода) фиксируем id узла → globalIndex после коммита React.
  const onOp = useCallback(
    async (op: ReviewPlanOp) => {
      applyReviewOp(op, reviewApi, ctxRef.current);
      const base = holdMsForOp(op, REVIEW_TIMINGS, reducedRef.current);
      const hold = reducedRef.current
        ? COMMIT_MIN_MS
        : Math.max(COMMIT_MIN_MS, effectiveHoldMs(base, 1));
      await sleep(hold);
      if (op.type === 'move') {
        const gi = reviewApi.getCurrentGlobalIndex();
        if (gi >= 0) idIndexRef.current.set(op.id, gi);
        // Градусник: оценка с точки зрения белых (основной движок off).
        // wdlAfter — POV ходившего; цвет ходившего = обратный стороне на
        // ходу в позиции ПОСЛЕ хода (childFen).
        if (op.wdlAfter) {
          const childStm = reviewApi.getCurrentFen().split(' ')[1];
          const moverIsWhite = childStm === 'b';
          onEvalChangeRef.current?.(
            whiteEvalLineFromWdlAfter(op.wdlAfter, moverIsWhite),
          );
        }
      }
    },
    [reviewApi],
  );

  const posReview = usePositionReview({ engines: adapter, config, onOp });

  // Активность разбора = идёт расчёт/проигрывание. Блокирует ручной ввод.
  const active = posReview.status === 'building';
  useEffect(() => {
    onActiveChange?.(active);
    onAutoplayingChange?.(active);
  }, [active, onActiveChange, onAutoplayingChange]);

  // KS-4949: запуск из меню. Корень разбора = текущая позиция.
  const runRef = useRef(posReview.run);
  runRef.current = posReview.run;
  const currentFenRef = useRef(currentFen);
  currentFenRef.current = currentFen;
  useEffect(() => {
    if (startToken > 0) {
      idIndexRef.current = new Map();
      rootGiRef.current = reviewRef.current.getCurrentGlobalIndex();
      ctxRef.current = {
        idIndex: idIndexRef.current,
        rootGlobalIndex: rootGiRef.current,
      };
      onEvalChangeRef.current?.(null);
      void runRef.current(currentFenRef.current);
    }
  }, [startToken]);

  // KS-4950: «Стоп разбор» — прерываем расчёт/проигрывание.
  const cancelRef = useRef(posReview.cancel);
  cancelRef.current = posReview.cancel;
  const resetRef = useRef(posReview.reset);
  resetRef.current = posReview.reset;
  useEffect(() => {
    if (stopToken > 0) {
      cancelRef.current();
      resetRef.current();
      onEvalChangeRef.current?.(null);
    }
  }, [stopToken]);

  // Разбор виден только на доске — своего интерфейса у панели нет.
  return null;
}
