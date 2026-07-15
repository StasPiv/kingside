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
  reviewConfigForPreset,
  estimateReviewSize,
  type ReviewPlanOp,
  type ReviewPreset,
  type ReviewPlan,
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
  // KS-4958 (ADR-165 rev5 §6): пресет глубины/ширины + оценка размера до
  // старта. Этапы UI: idle → config (выбор пресета) → building → done.
  const [preset, setPreset] = useState<ReviewPreset>('standard');
  const [uiState, setUiState] = useState<'idle' | 'config' | 'building' | 'done'>(
    'idle',
  );
  const [doneStats, setDoneStats] = useState<ReviewPlan['stats'] | null>(null);
  const config = useMemo(() => reviewConfigForPreset(preset, elo), [preset, elo]);
  const estimate = useMemo(() => estimateReviewSize(config), [config]);

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

  // Активно (пункт меню «Стоп») — пока идёт настройка/расчёт. Ручной ввод
  // блокируем только на самом расчёте (доска в это время двигает фигуры).
  const active = uiState === 'config' || uiState === 'building';
  useEffect(() => {
    onActiveChange?.(active);
    onAutoplayingChange?.(uiState === 'building');
  }, [active, uiState, onActiveChange, onAutoplayingChange]);

  const currentFenRef = useRef(currentFen);
  currentFenRef.current = currentFen;
  const runRef = useRef(posReview.run);
  runRef.current = posReview.run;

  // KS-4949/4958: пункт меню открывает диалог выбора пресета (не запускает).
  useEffect(() => {
    if (startToken > 0) {
      setDoneStats(null);
      setUiState('config');
    }
  }, [startToken]);

  // Старт разбора из диалога: корень = текущая позиция, конфиг = пресет.
  const startReview = useCallback(() => {
    idIndexRef.current = new Map();
    rootGiRef.current = reviewRef.current.getCurrentGlobalIndex();
    ctxRef.current = {
      idIndex: idIndexRef.current,
      rootGlobalIndex: rootGiRef.current,
    };
    onEvalChangeRef.current?.(null);
    setUiState('building');
    void runRef.current(currentFenRef.current);
  }, []);

  // KS-4950: «Стоп разбор» — прерываем и закрываем подачу.
  const cancelRef = useRef(posReview.cancel);
  cancelRef.current = posReview.cancel;
  const resetRef = useRef(posReview.reset);
  resetRef.current = posReview.reset;
  const closeReview = useCallback(() => {
    cancelRef.current();
    resetRef.current();
    onEvalChangeRef.current?.(null);
    setUiState('idle');
    setDoneStats(null);
  }, []);
  useEffect(() => {
    if (stopToken > 0) closeReview();
  }, [stopToken, closeReview]);

  // Завершение расчёта → итоговая сводка; отмена/ошибка → закрыть.
  useEffect(() => {
    if (uiState !== 'building') return;
    if (posReview.status === 'ready') {
      setDoneStats(posReview.plan?.stats ?? null);
      setUiState('done');
    } else if (posReview.status === 'cancelled' || posReview.status === 'error') {
      setUiState('idle');
    }
  }, [posReview.status, posReview.plan, uiState]);

  if (uiState === 'idle') return null;

  return (
    <ReviewHud
      uiState={uiState}
      preset={preset}
      onPreset={setPreset}
      estimate={estimate}
      dTarget={config.limits.dTarget}
      builtNodes={posReview.builtNodes}
      stats={doneStats}
      onStart={startReview}
      onClose={closeReview}
      onShowRare={() => {
        setPreset('detailed');
        setDoneStats(null);
        setUiState('config');
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// KS-4958: подача границы разбора (пресет/оценка/прогресс/итог). Оверлей —
// не влияет на вёрстку. Тонкая стилизация — задача layout.
// ---------------------------------------------------------------------------

const PRESET_LABELS: Record<ReviewPreset, string> = {
  brief: 'Кратко',
  standard: 'Стандарт',
  detailed: 'Подробно',
};

function ReviewHud({
  uiState,
  preset,
  onPreset,
  estimate,
  dTarget,
  builtNodes,
  stats,
  onStart,
  onClose,
  onShowRare,
}: {
  uiState: 'config' | 'building' | 'done';
  preset: ReviewPreset;
  onPreset: (p: ReviewPreset) => void;
  estimate: number;
  dTarget: number;
  builtNodes: number;
  stats: ReviewPlan['stats'] | null;
  onStart: () => void;
  onClose: () => void;
  onShowRare: () => void;
}) {
  // KS-4959: на мобильном HUD прячется за нижней панелью (.mobile-bottom-bar,
  // z-index 90) — позиционирование/адаптив вынесены в CSS (styles/review.css,
  // media-query), здесь только структура и модификаторы состояния.
  if (uiState === 'config') {
    return (
      <div
        className="review-hud review-hud--config"
        data-testid="review-hud-config"
      >
        <div className="review-hud__title">Разбор репертуара</div>
        <div className="review-hud__presets">
          {(['brief', 'standard', 'detailed'] as ReviewPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              className="review-hud__preset"
              data-testid={`review-preset-${p}`}
              aria-pressed={preset === p}
              onClick={() => onPreset(p)}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="review-hud__estimate" data-testid="review-estimate">
          ~{estimate} позиций, до {dTarget}-го хода
        </div>
        <div className="review-hud__actions">
          <button
            type="button"
            className="review-hud__btn review-hud__btn--primary"
            data-testid="review-hud-start"
            onClick={onStart}
          >
            Начать разбор
          </button>
          <button
            type="button"
            className="review-hud__btn"
            data-testid="review-hud-cancel"
            onClick={onClose}
          >
            Отмена
          </button>
        </div>
      </div>
    );
  }

  if (uiState === 'building') {
    return (
      <div
        className="review-hud review-hud--building"
        data-testid="review-hud-progress"
      >
        <div>
          <span className="review-hud__progress-text">
            построено {builtNodes} из ~{estimate} позиций
          </span>
          <div className="review-hud__progress-bar" aria-hidden="true" />
        </div>
        <button
          type="button"
          className="review-hud__btn"
          data-testid="review-hud-stop"
          onClick={onClose}
        >
          Стоп
        </button>
      </div>
    );
  }

  // done
  const s = stats;
  const variants = s
    ? s.leaves.theory +
      s.leaves.refuted +
      s.leaves.transposition +
      s.leaves.depth +
      s.leaves.rare +
      s.leaves.budget +
      s.leaves.terminal
    : 0;
  const depthMoves = s ? Math.ceil(s.maxPlyReached / 2) : 0;
  const omitted = s ? s.leaves.rare + s.leaves.budget : 0;
  return (
    <div className="review-hud review-hud--done" data-testid="review-hud-done">
      <div className="review-hud__summary" data-testid="review-summary">
        Готово: {variants} вариантов, глубина до хода {depthMoves}
        {omitted > 0 ? `, опущено ${omitted}` : ''}
      </div>
      <div className="review-hud__actions review-hud__actions--done">
        {s && s.leaves.rare > 0 && (
          <button
            type="button"
            className="review-hud__btn"
            data-testid="review-show-rare"
            onClick={onShowRare}
          >
            Показать редкие линии
          </button>
        )}
        <button
          type="button"
          className="review-hud__btn"
          data-testid="review-hud-close"
          onClick={onClose}
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}
