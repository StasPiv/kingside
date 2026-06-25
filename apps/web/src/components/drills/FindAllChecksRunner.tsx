import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Chess, type Square as ChessSquare } from 'chess.js';
import type {
  AnswerData,
  TacticDrillAttemptResponse,
  TacticDrillDto,
} from '@kingside/shared';

import { DrillBoard, type DrillBoardArrow } from './DrillBoard';
import { DrillFeedbackOverlay } from './DrillFeedbackOverlay';
import { DrillInstructions } from './DrillInstructions';
import { DrillExplanationPanel } from './DrillExplanationPanel';
// KS-2423: drill-звуки.
import { useDrillSounds } from '../../hooks/useDrillSounds';
// KS-2460: explanation-engine для финального экрана.
import { explainDrill } from './explanation/explainDrill';
import type { ArrowRole } from './explanation/types';

/** KS-2460: matchMedia для prefers-reduced-motion (SSR-safe). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * KS-2460: placeholder-цвета стрелок по `ArrowRole`. Дублируется с
 * DrillRunner — не выносим, чтобы FACR не зависел от внутренностей
 * DrillRunner. Финальные цвета — KS-2458 (layout) через CSS-токены
 * `--drill-arrow-*`.
 */
function arrowRoleColor(role: ArrowRole): string {
  switch (role) {
    case 'correct-attack':
    case 'correct-move':
      return '#16a34a';
    case 'missed-attack':
      return '#94a3b8';
    case 'wrong-attack':
      return '#dc2626';
    case 'pin-line':
      return '#f97316';
    case 'defense':
      return '#3b82f6';
    case 'threat-target':
      return '#dc2626';
  }
}

/**
 * KS-2326 (KS-2324 design / methodology §11) — multi-step UX для
 * drill `find-all-checks`. Юзер делает реальные ходы на доске; runner
 * валидирует каждый против списка expectedMoves (приходит из drill.meta
 * после KS-2325 backend), показывает 3 типа feedback'а и авто-undo'ит
 * каждый ход чтобы доска оставалась в исходной позиции.
 *
 * State-machine:
 *   - `loading` — первичная загрузка drill через `loadDrill()`.
 *   - `idle` — ожидание хода юзера. Доска в исходном FEN.
 *   - `feedback-correct` — найден новый шах (`expectedMoves` ∋ move,
 *     ∉ `found`). Зелёная подсветка 600мс → undo + found.add → idle.
 *   - `feedback-already` — этот шах уже найден. Жёлтая подсветка 400мс
 *     → undo (без штрафа) → idle.
 *   - `feedback-wrong` — ход НЕ из `expectedMoves`. Красная подсветка
 *     600мс → undo → attempts++ → idle.
 *   - `submitting` — отправка финального submitAnswer (auto-submit
 *     при `found.size === expected.size` или клик «Готово»).
 *   - `done` — feedback от backend получен, viewing-state.
 *
 * Auto-undo: после каждого show-feedback timeout доска возвращается к
 * исходному FEN — юзер может пробовать следующий ход.
 *
 * Финал → `submitAnswer` с `userAnswer={shape:'squares', squares:[]}`
 * (compatible legacy back-end до KS-2325). После KS-2325 формат может
 * поменяться на `{shape:'moves', moves:[...]}` — заменим одной правкой.
 *
 * # DOM
 *
 *   <div class="find-all-checks-runner" data-testid="find-all-checks-runner"
 *        data-state="idle|feedback-correct|feedback-already|feedback-wrong|submitting|done"
 *        data-found="N" data-expected="M">
 *     {headerSlot}
 *     <div data-testid="facr-hud">N / M шахов</div>
 *     <DrillInstructions tone="info|success|error">…</DrillInstructions>
 *     <DrillBoard … />
 *     <button data-testid="facr-finish">Готово</button>     // optional
 *     <button data-testid="facr-skip">Пропустить</button>   // optional
 *   </div>
 */

type FindAllChecksState =
  | 'loading'
  | 'idle'
  | 'feedback-correct'
  | 'feedback-already'
  | 'feedback-wrong'
  | 'submitting'
  | 'done'
  | 'error';

interface MoveDto {
  from: string;
  to: string;
}

export interface FindAllChecksRunnerProps {
  /**
   * Drill DTO (TacticDrillDto). Должен содержать `meta.expectedMoves`
   * — массив строк UCI (например, `['e2e4','g1f3']`) или объектов
   * `{from, to}`. Если поле отсутствует — runner показывает error-state
   * (нечего валидировать).
   */
  drill: TacticDrillDto & {
    meta?: {
      highlightedSquare?: string;
      expectedCount?: number;
      expectedMoves?: Array<string | MoveDto>;
    };
  };
  /** Отправить финальный submit. */
  submitAnswer: (input: {
    drillId: string;
    userAnswer: AnswerData;
    timeMs: number;
  }) => Promise<TacticDrillAttemptResponse>;
  /** Колбэк после получения feedback от submit (success | fail). */
  onComplete?: (result: { solved: boolean; foundCount: number }) => void;
  headerSlot?: ReactNode;
  /** Скрыть встроенный таймер. */
  hideTimer?: boolean;
  /** Длительность correct-feedback (default 600мс). */
  correctFlashMs?: number;
  /** Длительность already-found-feedback (default 400мс). */
  alreadyFlashMs?: number;
  /** Длительность wrong-feedback (default 600мс). */
  wrongFlashMs?: number;
  /**
   * KS-2460: задержка между финальным `state='done'` и `onComplete()`
   * для случая `solved=true`. По умолчанию `0` (быстрое продолжение
   * — пользователь нашёл всё). Manual «Дальше» через панель прерывает
   * таймер. При `prefers-reduced-motion: reduce` runtime-override → 0.
   */
  autoNextDelayCorrectMs?: number;
  /**
   * KS-2460: то же для `solved=false` (что-то пропустил/ошибся). По
   * умолчанию `3500` — дать время рассмотреть стрелки missed-шахов и
   * клетки FP-кликов (методика KS-2454).
   */
  autoNextDelayIncorrectMs?: number;
}

function uciToMove(s: string): MoveDto | null {
  if (s.length < 4) return null;
  return { from: s.slice(0, 2), to: s.slice(2, 4) };
}

function normalizeMoves(arr: Array<string | MoveDto>): MoveDto[] {
  const out: MoveDto[] = [];
  for (const m of arr) {
    if (typeof m === 'string') {
      const p = uciToMove(m);
      if (p) out.push(p);
    } else if (m && typeof m === 'object' && m.from && m.to) {
      out.push({ from: m.from, to: m.to });
    }
  }
  return out;
}

function moveKey(m: MoveDto): string {
  return `${m.from}${m.to}`;
}

export function FindAllChecksRunner({
  drill,
  submitAnswer,
  onComplete,
  headerSlot,
  hideTimer = false,
  correctFlashMs = 600,
  alreadyFlashMs = 400,
  wrongFlashMs = 600,
  autoNextDelayCorrectMs = 0,
  // KS-2481: при solved=false auto-complete не запускается, prop
  // оставлен в типе для backward-compat и явно съедается alias'ом `_*`.
  autoNextDelayIncorrectMs: _autoNextDelayIncorrectMs = 3500,
}: FindAllChecksRunnerProps) {
  const { t } = useTranslation();
  // KS-2423.
  const { play: playDrillSound } = useDrillSounds();

  const expected: MoveDto[] = useMemo(
    () => normalizeMoves(drill.meta?.expectedMoves ?? []),
    [drill.meta?.expectedMoves],
  );
  const expectedKeys = useMemo(
    () => new Set(expected.map(moveKey)),
    [expected],
  );

  const [state, setState] = useState<FindAllChecksState>('idle');
  const [found, setFound] = useState<Set<string>>(new Set());
  const [attempts, setAttempts] = useState(0);
  const [lastMove, setLastMove] = useState<MoveDto | null>(null);
  // KS-2460: накапливаем `to`-клетки ошибочных кликов (FP — клик на
  // клетку, которая НЕ является целью ни одного шахующего хода). Нужны
  // для `wrong`-highlight'ов в финальном explanation. Если to-клетка
  // совпадает с правильной (другой шах ходит туда же — редко, но
  // возможно), не считаем её FP.
  const [wrongTos, setWrongTos] = useState<Set<string>>(new Set());
  // KS-2460: ответ от backend сохраняем для финального explanation —
  // `correctAnswer` нужен engine'у, `solved` определяет роль стрелок.
  const [submitResp, setSubmitResp] =
    useState<TacticDrillAttemptResponse | null>(null);

  const startedAtRef = useRef<number>(Date.now());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // KS-2460: таймер задержанного onComplete на финальном экране.
  // Manual «Дальше» в панели делает clearTimeout + onComplete.
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  // KS-2460: чтобы avoid double-onComplete если manual click и
  // авто-таймер сработают одновременно.
  const onCompleteCalledRef = useRef(false);

  // KS-2460: клетки правильных шахов (для отбора FP-кликов в wrongTos).
  const expectedToSet = useMemo(
    () => new Set(expected.map((m) => m.to)),
    [expected],
  );

  // Сбрасываем при смене drill (например, ResultsRunner перерендер).
  useEffect(() => {
    setState(expected.length === 0 ? 'error' : 'idle');
    setFound(new Set());
    setAttempts(0);
    setLastMove(null);
    // KS-2460: новый drill — очищаем накопленные FP-клетки и сохранённый
    // backend-ответ, освобождаем done-таймер.
    setWrongTos(new Set());
    setSubmitResp(null);
    onCompleteCalledRef.current = false;
    startedAtRef.current = Date.now();
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
    };
  }, [drill.id, expected.length]);

  // Авто-submit когда нашли все.
  const finalSubmit = useCallback(async () => {
    if (state === 'submitting' || state === 'done') return;
    setState('submitting');
    const timeMs = Date.now() - startedAtRef.current;
    try {
      // Backend (KS-2325 ещё в работе) пока ожидает legacy
      // shape='squares' с TO-клетками. После KS-2325 заменим на
      // shape='moves'/'multi' одной правкой.
      const userAnswer: AnswerData = {
        shape: 'squares',
        squares: Array.from(found.values()).map((k) => k.slice(2, 4)),
      };
      const resp = await submitAnswer({
        drillId: drill.id,
        userAnswer,
        timeMs,
      });
      // KS-2460: НЕ вызываем onComplete сразу. Сохраняем ответ, рендерим
      // финальный экран с DrillExplanationPanel, ждём auto-next-таймер
      // или manual «Дальше» в панели.
      setSubmitResp(resp);
      setState('done');
    } catch {
      setState('error');
    }
  }, [drill.id, found, state, submitAnswer]);

  // Trigger auto-submit когда found достиг expected.length.
  useEffect(() => {
    if (state !== 'idle') return;
    if (expected.length === 0) return;
    if (found.size === expected.length) {
      void finalSubmit();
    }
  }, [state, found, expected.length, finalSubmit]);

  // KS-2460: после `state='done'` запускаем отложенный onComplete —
  // даём пользователю время рассмотреть финальный разбор. Manual
  // «Дальше» через DrillExplanationPanel снимает таймер и вызывает
  // onComplete сразу.
  const callOnComplete = useCallback(
    (solved: boolean, foundCount: number) => {
      if (onCompleteCalledRef.current) return;
      onCompleteCalledRef.current = true;
      if (completeTimerRef.current) {
        clearTimeout(completeTimerRef.current);
        completeTimerRef.current = null;
      }
      onCompleteRef.current?.({ solved, foundCount });
    },
    [],
  );

  useEffect(() => {
    if (state !== 'done' || !submitResp) return;
    // KS-2481: auto-complete отключён при solved=false — пользователь
    // должен сам нажать «Дальше», чтобы успеть рассмотреть финальный
    // разбор (missed-стрелки, FP-клетки, текстовые notes). Manual
    // переход через DrillExplanationPanel.onNext остаётся.
    if (!submitResp.solved) return;
    const reduced = prefersReducedMotion();
    const delay = reduced ? 0 : autoNextDelayCorrectMs;
    completeTimerRef.current = setTimeout(() => {
      callOnComplete(submitResp.solved, found.size);
    }, Math.max(0, delay));
    return () => {
      if (completeTimerRef.current) {
        clearTimeout(completeTimerRef.current);
        completeTimerRef.current = null;
      }
    };
  }, [
    state,
    submitResp,
    autoNextDelayCorrectMs,
    callOnComplete,
    found.size,
  ]);

  // Возвращаем feedback-state в idle через delay.
  useEffect(() => {
    if (
      state !== 'feedback-correct' &&
      state !== 'feedback-already' &&
      state !== 'feedback-wrong'
    ) {
      return;
    }
    const delay =
      state === 'feedback-correct'
        ? correctFlashMs
        : state === 'feedback-already'
        ? alreadyFlashMs
        : wrongFlashMs;
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setState('idle');
      setLastMove(null);
    }, Math.max(0, delay));
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [state, correctFlashMs, alreadyFlashMs, wrongFlashMs]);

  // Validate ход против expected.
  const onMove = useCallback(
    (move: MoveDto) => {
      if (state !== 'idle') return;
      if (!move.from || !move.to) return;
      // Validate через chess.js — отбрасываем фантастические ходы
      // (например, фигуры противника). Реальный шах валидируется
      // backend'ом (KS-2325), здесь нам важно соответствие
      // expectedMoves списку.
      try {
        const c = new Chess(drill.fen);
        const legal = c.move({
          from: move.from as ChessSquare,
          to: move.to as ChessSquare,
          promotion: 'q',
        });
        if (!legal) return;
      } catch {
        return;
      }
      const key = moveKey(move);
      setLastMove(move);
      if (!expectedKeys.has(key)) {
        setAttempts((a) => a + 1);
        setState('feedback-wrong');
        // KS-2460: накапливаем `to`-клетку FP-хода для wrong-highlight'а
        // в финальном экране — но только если она действительно «не в
        // целях»: если другая правильная стрелка ведёт в ту же клетку,
        // не маркируем (engine всё равно отбрасывает FP, попавшие в
        // correctSquares).
        if (!expectedToSet.has(move.to)) {
          setWrongTos((prev) => {
            if (prev.has(move.to)) return prev;
            const next = new Set(prev);
            next.add(move.to);
            return next;
          });
        }
        // KS-2423: ход-промах.
        playDrillSound('puzzle-incorrect');
        return;
      }
      if (found.has(key)) {
        setState('feedback-already');
        // KS-2423: уже найден — тихий «select», как нейтральный фидбек.
        playDrillSound('select');
        return;
      }
      // Новый правильный шах.
      const next = new Set(found);
      next.add(key);
      setFound(next);
      setState('feedback-correct');
      // KS-2423: проигрываем именно «check» — сюжет drill'а.
      playDrillSound('check');
    },
    [state, drill.fen, expectedKeys, expectedToSet, found, playDrillSound],
  );

  // ── Click & Drag handlers ────────────────────────────────────────
  const [pickedFrom, setPickedFrom] = useState<string | null>(null);

  const handleSquareClick = useCallback(
    (sq: ChessSquare) => {
      if (state !== 'idle') return;
      if (pickedFrom === null) {
        // KS-2405: первый клик принимаем только на клетке со своей
        // фигурой (по drill.sideToMove или из 2-го поля FEN). Иначе
        // игнор — никакого подсветки, никакого attempts++.
        try {
          const c = new Chess(drill.fen);
          const piece = c.get(sq);
          const side =
            drill.sideToMove ??
            (drill.fen.split(' ')[1] === 'b' ? 'b' : 'w');
          if (!piece || piece.color !== side) return;
        } catch {
          return;
        }
        // KS-2423: pickup своей фигуры → 'select'.
        playDrillSound('select');
        setPickedFrom(sq);
        return;
      }
      if (pickedFrom === sq) {
        // KS-2423.
        playDrillSound('select');
        setPickedFrom(null);
        return;
      }
      onMove({ from: pickedFrom, to: sq });
      setPickedFrom(null);
    },
    [state, pickedFrom, onMove, drill.fen, drill.sideToMove, playDrillSound],
  );

  const handlePieceDrop = useCallback(
    (args: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (state !== 'idle') return false;
      const { sourceSquare, targetSquare } = args;
      if (!sourceSquare || !targetSquare) return false;
      if (sourceSquare === targetSquare) return false;
      setPickedFrom(null);
      onMove({ from: sourceSquare, to: targetSquare });
      return true;
    },
    [state, onMove],
  );

  // ── Visuals ──────────────────────────────────────────────────────
  // Highlight: при feedback показываем lastMove (зелёный/жёлтый/
  // красный — задаёт DrillFeedbackOverlay поверх). В idle —
  // pickedFrom (если выбрана клетка click-flow'ом).
  const highlightedSquares = useMemo<string[]>(() => {
    if (lastMove && state.startsWith('feedback')) {
      return [lastMove.from, lastMove.to];
    }
    if (pickedFrom) return [pickedFrom];
    return [];
  }, [lastMove, state, pickedFrom]);

  const instructionTone =
    state === 'feedback-correct'
      ? 'success'
      : state === 'feedback-wrong'
      ? 'error'
      : 'info';

  const instructionText = useMemo(() => {
    if (state === 'feedback-correct') {
      return t('drills.findAllChecks.correct', 'Check! +1');
    }
    if (state === 'feedback-already') {
      return t('drills.findAllChecks.already', 'This check is already found');
    }
    if (state === 'feedback-wrong') {
      return t('drills.findAllChecks.wrong', 'Not a check');
    }
    return t(
      'drills.instructions.findAllChecks',
      'Find all checking moves',
    );
  }, [state, t]);

  // KS-2326: HUD прогресса «N / M шахов».
  const hud = `${found.size} / ${expected.length}`;

  // Per-drill таймер для timer-блока (не блокирующий).
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (state === 'done' || state === 'error' || state === 'submitting') return;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [state]);

  // KS-2460: финальный explanation. Считаем когда state='done' и есть
  // submitResp — engine использует backend-ответ (источник истины) +
  // expected-список для рисования стрелок и определения роли каждой.
  // userAnswer — все ответы пользователя (правильные `to`-клетки +
  // FP-клики), engine разделит на correct/missed/wrong.
  const finalExplanation = useMemo(() => {
    if (state !== 'done' || !submitResp) return null;
    // userAnswer.squares = правильные to-клетки (из found) ∪ wrong-to.
    const userTos = [
      ...Array.from(found.values()).map((k) => k.slice(2, 4)),
      ...Array.from(wrongTos.values()),
    ];
    // Гарантируем shape='squares' для correctAnswer; backend для FAC
    // отдаёт именно его (KS-2325).
    const correctAnswer: AnswerData =
      submitResp.correctAnswer.shape === 'squares'
        ? submitResp.correctAnswer
        : {
            shape: 'squares',
            squares: expected.map((m) => m.to),
          };
    return explainDrill({
      drill,
      correctAnswer,
      userAnswer: { shape: 'squares', squares: userTos },
      solved: submitResp.solved,
    });
  }, [state, submitResp, found, wrongTos, drill, expected]);

  const finalArrows = useMemo<DrillBoardArrow[] | undefined>(() => {
    if (!finalExplanation || finalExplanation.arrows.length === 0) {
      return undefined;
    }
    return finalExplanation.arrows.map((a) => ({
      startSquare: a.from,
      endSquare: a.to,
      color: arrowRoleColor(a.role),
    }));
  }, [finalExplanation]);

  const handleManualNext = useCallback(() => {
    if (!submitResp) return;
    callOnComplete(submitResp.solved, found.size);
  }, [submitResp, found.size, callOnComplete]);

  // ── Error: нет expectedMoves ─────────────────────────────────────
  if (state === 'error' && expected.length === 0) {
    return (
      <div
        className="find-all-checks-runner find-all-checks-runner--no-data"
        data-testid="find-all-checks-runner"
        data-state="error"
      >
        {headerSlot}
        <DrillInstructions tone="error">
          {t(
            'drills.findAllChecks.missingData',
            'No data to validate against. Please try again later.',
          )}
        </DrillInstructions>
      </div>
    );
  }

  return (
    <div
      className="find-all-checks-runner"
      data-testid="find-all-checks-runner"
      data-state={state}
      data-found={found.size}
      data-expected={expected.length}
      data-attempts={attempts}
    >
      {headerSlot}

      {/* KS-2559: ряд stats-ячеек (Найдено / Попыток / Время) — общий
          класс `.drill-runner__stats` из KS-2558, чтобы шапка
          `find-all-checks` совпадала с остальными drill-типами. data-
          testid `facr-hud` и `facr-timer` сохранены на cell'ах. */}
      <div
        className="drill-runner__stats find-all-checks-runner__hud"
        data-testid="facr-hud"
        data-found={found.size}
        data-expected={expected.length}
      >
        <div className="drill-runner__stats-cell">
          <span className="drill-runner__stats-value">{hud}</span>
          <span className="drill-runner__stats-label">
            {t('drills.runner.stats.solved', 'Solved')}
          </span>
        </div>

        <div
          className="drill-runner__stats-cell"
          data-testid="facr-attempts"
          data-attempts={attempts}
        >
          <span className="drill-runner__stats-value">{attempts}</span>
          <span className="drill-runner__stats-label">
            {t('drills.runner.stats.attempts', 'Attempts')}
          </span>
        </div>

        {!hideTimer && (
          <div
            className="drill-runner__stats-cell find-all-checks-runner__timer"
            data-testid="facr-timer"
            data-elapsed-ms={elapsedMs}
          >
            <span className="drill-runner__stats-value">
              {Math.floor(elapsedMs / 1000)}s
            </span>
            <span className="drill-runner__stats-label">
              {t('drills.runner.stats.time', 'Time')}
            </span>
          </div>
        )}
      </div>

      <DrillInstructions tone={instructionTone}>
        {instructionText}
      </DrillInstructions>

      {drill.sideToMove && (
        <div
          className="find-all-checks-runner__side"
          data-testid="facr-side"
          data-side={drill.sideToMove}
        >
          {drill.sideToMove === 'w'
            ? t('drills.side.whiteToMove', 'White to move')
            : t('drills.side.blackToMove', 'Black to move')}
        </div>
      )}

      {/* KS-2460: на финальном экране (`done`) рендерим board+panel
          в обёртке `__board-and-panel` — то же layout, что у DrillRunner
          (mobile column / desktop row через CSS-брейкпоинт 768px). */}
      <div className="drill-runner__board-and-panel">
        <DrillBoard
          position={drill.fen}
          boardOrientation={drill.sideToMove === 'b' ? 'black' : 'white'}
          highlightedSquares={
            state === 'done' ? undefined : highlightedSquares
          }
          // KS-2460: на финальном экране подсветки и стрелки приходят
          // из explainDrill — engine знает о found / wrongTos.
          roleHighlights={
            state === 'done' ? finalExplanation?.highlights : undefined
          }
          arrows={state === 'done' ? finalArrows : undefined}
          onSquareClick={state === 'done' ? undefined : handleSquareClick}
          onPieceDrop={state === 'done' ? undefined : handlePieceDrop}
          overlay={
            state === 'feedback-correct' ? (
              <DrillFeedbackOverlay result="correct" />
            ) : state === 'feedback-wrong' ? (
              <DrillFeedbackOverlay result="incorrect" />
            ) : null
          }
        />
        {state === 'done' && finalExplanation && submitResp && (
          <DrillExplanationPanel
            explanation={finalExplanation}
            solved={submitResp.solved}
            onNext={handleManualNext}
          />
        )}
      </div>

      {/* Кнопка «Готово» — для альтернативного завершения если юзер
          считает что больше шахов нет (например, нашёл 2 из 3, но не
          уверен в третьем). */}
      {state === 'idle' && found.size > 0 && found.size < expected.length && (
        <button
          type="button"
          className="find-all-checks-runner__finish"
          data-testid="facr-finish"
          onClick={() => void finalSubmit()}
        >
          {t('drills.findAllChecks.finish', 'Done')}
        </button>
      )}
    </div>
  );
}

