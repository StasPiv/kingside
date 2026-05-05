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

import { DrillBoard } from './DrillBoard';
import { DrillFeedbackOverlay } from './DrillFeedbackOverlay';
import { DrillInstructions } from './DrillInstructions';
// KS-2423: drill-звуки.
import { useDrillSounds } from '../../hooks/useDrillSounds';

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

  const startedAtRef = useRef<number>(Date.now());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Сбрасываем при смене drill (например, ResultsRunner перерендер).
  useEffect(() => {
    setState(expected.length === 0 ? 'error' : 'idle');
    setFound(new Set());
    setAttempts(0);
    setLastMove(null);
    startedAtRef.current = Date.now();
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
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
      setState('done');
      onComplete?.({ solved: resp.solved, foundCount: found.size });
    } catch {
      setState('error');
    }
  }, [drill.id, found, state, submitAnswer, onComplete]);

  // Trigger auto-submit когда found достиг expected.length.
  useEffect(() => {
    if (state !== 'idle') return;
    if (expected.length === 0) return;
    if (found.size === expected.length) {
      void finalSubmit();
    }
  }, [state, found, expected.length, finalSubmit]);

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
    [state, drill.fen, expectedKeys, found, playDrillSound],
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
      return t('drills.findAllChecks.correct', 'Шах! +1');
    }
    if (state === 'feedback-already') {
      return t('drills.findAllChecks.already', 'Этот шах уже найден');
    }
    if (state === 'feedback-wrong') {
      return t('drills.findAllChecks.wrong', 'Это не шах');
    }
    return t(
      'drills.instructions.findAllChecks',
      'Сделайте все ходы с шахом',
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
            'Нет данных для проверки. Попробуйте позже.',
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

      <div
        className="find-all-checks-runner__hud"
        data-testid="facr-hud"
        data-found={found.size}
        data-expected={expected.length}
      >
        {hud}
      </div>

      {!hideTimer && (
        <div
          className="find-all-checks-runner__timer"
          data-testid="facr-timer"
          data-elapsed-ms={elapsedMs}
        >
          {Math.floor(elapsedMs / 1000)}s
        </div>
      )}

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

      <DrillBoard
        position={drill.fen}
        boardOrientation={drill.sideToMove === 'b' ? 'black' : 'white'}
        highlightedSquares={highlightedSquares}
        onSquareClick={handleSquareClick}
        onPieceDrop={handlePieceDrop}
        overlay={
          state === 'feedback-correct' ? (
            <DrillFeedbackOverlay result="correct" />
          ) : state === 'feedback-wrong' ? (
            <DrillFeedbackOverlay result="incorrect" />
          ) : null
        }
      />

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
          {t('drills.findAllChecks.finish', 'Готово')}
        </button>
      )}
    </div>
  );
}

