import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  CustomPuzzle,
  PuzzleDto,
  PuzzleStepPayload,
  PuzzleTheme,
} from '@kingside/shared';

import { puzzleApi } from '../../../api-puzzle';
import { lessonsApi } from '../../../api/lessonsApi';
import { PuzzleBoard } from '../../PuzzleBoard';
import { useSounds, soundEventFromSan } from '../../../hooks/useSounds';
import { useAuth } from '../../../context/AuthContext';

/**
 * PuzzleStep — обёртка над `PuzzleBoard` для шагов уроков (L-09, KS-1764).
 *
 * Загружает курируемый набор задач через батч-эндпоинт
 * `POST /lessons/puzzle-step/resolve` (KS-1777 / KS-1780). Backend сам
 * разбирает `payload.selection`:
 *   • mode 'ids'    → задачи в порядке `puzzleIds`
 *   • mode 'filter' → ≤ `limit` уникальных задач по темам+рейтингу
 *   • mode 'custom' → авторские задачи прямо из payload (ADR-029,
 *     KS-1910). Никаких сетевых запросов, рейтинг не считается.
 *
 * Попытки идут в существующий `PuzzleAttempt` через `puzzleApi.submitAttempt`
 * (никаких новых таблиц — Gherkin: «не дублируем»). Для custom puzzle
 * `submitAttempt` пропускается (`isCustom===true`) — в БД её нет,
 * Glicko-2-update'ы ей не нужны.
 *
 * Шаг считается пройденным, когда количество правильно решённых задач
 * достигает `payload.minSolved` (по умолчанию = всем задачам набора).
 * После прохождения порога вызывается `onStepDone()` — интеграция с
 * `useLessonProgress` (L-11) на стороне `LessonPage`.
 *
 * # Custom puzzle: firstMoveIsUser (ADR-029 §5.6)
 *
 * Для системных Lichess puzzle первый ход в `moves` — setup, его
 * runner проигрывает автоматически с задержкой 300 ms; пользователь
 * играет со второго хода. Для custom puzzle (`firstMoveIsUser===true`)
 * первый ход — это ход ученика: setup-блок пропускается, доска ждёт
 * хода пользователя сразу.
 */

/**
 * Локальный тип-расширение `PuzzleDto` для runner'а: позволяет custom
 * puzzle нести `orientation`, явно заданную автором в payload, не
 * расширяя shared-DTO ради FE-only поля.
 */
type RunnerPuzzle = PuzzleDto & { customOrientation?: 'white' | 'black' };

/**
 * Маппит `CustomPuzzle` (из `payload.selection.customPuzzles`) в
 * `RunnerPuzzle` для существующего runner-кода. ADR-029 §5:
 * - `id` искусственный, в БД нет;
 * - `rating === null`, `isCustom = true` → `submitAttempt` skip;
 * - `firstMoveIsUser = true` → setup-ход не воспроизводится.
 */
export function customToInMemoryPuzzle(
  custom: CustomPuzzle,
  index: number,
): RunnerPuzzle {
  return {
    id: `custom:${index}`,
    fen: custom.fen,
    moves: custom.solutionMoves.join(' '),
    rating: null,
    ratingDeviation: 0,
    popularity: 0,
    nbPlays: 0,
    // `CustomPuzzle.themes` — свободные строки, не PuzzleTheme[];
    // в runner используются только для отображения, cast безопасен.
    themes: ((custom.themes ?? []) as unknown) as PuzzleTheme[],
    gameUrl: '',
    openingTags: '',
    isCustom: true,
    firstMoveIsUser: true,
    customOrientation: custom.orientation,
  };
}

interface PuzzleStepProps {
  payload: PuzzleStepPayload;
  onStepDone?: () => void;
  hideNext?: boolean;
}

type Status = 'thinking' | 'correct' | 'incorrect' | 'done';

interface AttemptCounters {
  solved: number;
  failed: number;
}

export function PuzzleStep({ payload, onStepDone, hideNext }: PuzzleStepProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { playSound } = useSounds();

  // Стабильные ссылки для use-в эффектах (i18next и useSounds возвращают
  // новые ссылки на каждый рендер; без ref'ов эффекты ниже зацикливаются).
  const tRef = useRef(t);
  tRef.current = t;
  const playSoundRef = useRef(playSound);
  playSoundRef.current = playSound;

  const [puzzles, setPuzzles] = useState<RunnerPuzzle[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  // overrideGame используется для применения setup-хода и хода игрока. Базовый
  // game вычисляется синхронно из currentPuzzle (см. ниже) — это устраняет
  // race-condition «board уже в DOM, а game ещё null», который ловили тесты.
  const [overrideGame, setOverrideGame] = useState<Chess | null>(null);
  const [moveIndex, setMoveIndex] = useState(0);
  const [status, setStatus] = useState<Status>('thinking');
  const [counters, setCounters] = useState<AttemptCounters>({ solved: 0, failed: 0 });

  const startTimeRef = useRef<number>(Date.now());
  const userMovesRef = useRef<string[]>([]);
  const attemptSubmittedRef = useRef<boolean>(false);
  const stepDoneFiredRef = useRef<boolean>(false);

  // Сериализация selection для стабильного dep — payload.selection часто
  // приходит «новым объектом каждый рендер», и сравнение по ссылке зацикливает
  // эффект загрузки.
  const selectionKey = JSON.stringify(payload.selection);

  // ─── Загрузка набора задач ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setPuzzles(null);
    setLoadError(null);
    setIndex(0);
    setCounters({ solved: 0, failed: 0 });
    stepDoneFiredRef.current = false;

    resolvePuzzles(payload)
      .then((list) => {
        if (cancelled) return;
        if (list.length === 0) {
          // KS-1912: для mode='custom' даём свой текст — это шаг
          // без авторских данных, не «нет задач из БД». Не помечаем
          // step done — нечего проходить.
          if (payload.selection.mode === 'custom') {
            setLoadError(
              tRef.current(
                'lessons.puzzle.customEmpty',
                'This step has no puzzles yet. Ask the course author to add some.',
              ),
            );
          } else {
            setLoadError(
              tRef.current('lessons.puzzleEmpty', 'No puzzles available for this step'),
            );
          }
          return;
        }
        setPuzzles(list);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(
          tRef.current('lessons.puzzleLoadError', 'Failed to load puzzles'),
        );
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  // ─── Инициализация текущей задачи ────────────────────────────────
  const currentPuzzle = puzzles?.[index] ?? null;
  const currentMoves = useMemo<string[]>(() => {
    if (!currentPuzzle) return [];
    const m = currentPuzzle.moves;
    return Array.isArray(m) ? m : m.split(' ');
  }, [currentPuzzle]);

  const boardOrientation = useMemo<'white' | 'black'>(() => {
    if (!currentPuzzle) return 'white';
    // Custom: автор может задать orientation вручную (ADR-029 §5).
    if (currentPuzzle.customOrientation) return currentPuzzle.customOrientation;
    const setup = new Chess(currentPuzzle.fen);
    // Custom firstMoveIsUser=true: setup-ход не воспроизводится,
    // игрок ходит цветом sideToMove из FEN.
    if (currentPuzzle.firstMoveIsUser) {
      return setup.turn() === 'w' ? 'white' : 'black';
    }
    if (currentMoves.length <= 1) {
      return setup.turn() === 'w' ? 'white' : 'black';
    }
    // Lichess-задачи: первый ход — setup, игрок — противоположной стороны.
    return setup.turn() === 'w' ? 'black' : 'white';
  }, [currentPuzzle, currentMoves]);

  // Базовая позиция: синхронно из currentPuzzle.fen (без useEffect).
  const baseGame = useMemo<Chess | null>(() => {
    if (!currentPuzzle) return null;
    return new Chess(currentPuzzle.fen);
  }, [currentPuzzle?.id, currentPuzzle?.fen]);

  // Эффективная позиция = override (после хода или setup) ?? baseGame.
  const game = overrideGame ?? baseGame;

  // Стабильный ключ задачи — id + сериализованные ходы, без ссылок.
  const puzzleKey = currentPuzzle
    ? `${currentPuzzle.id}|${currentMoves.join(' ')}`
    : '';

  // При смене задачи сбрасываем override / индекс / счётчики попытки.
  useEffect(() => {
    setOverrideGame(null);
    setMoveIndex(0);
    setStatus('thinking');
    userMovesRef.current = [];
    attemptSubmittedRef.current = false;
    startTimeRef.current = Date.now();

    if (!currentPuzzle) return;
    // KS-1910: для custom puzzle (`firstMoveIsUser=true`) первый ход —
    // ход ученика, setup-блок пропускается. ADR-029 §5.6.
    if (currentPuzzle.firstMoveIsUser) return;
    if (currentMoves.length > 1) {
      // Setup-ход — короткая задержка для UX (как в PuzzlePage).
      const uci = currentMoves[0];
      const timer = setTimeout(() => {
        const post = new Chess(currentPuzzle.fen);
        const result = post.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined,
        });
        if (result) playSoundRef.current(soundEventFromSan(result.san));
        setOverrideGame(post);
        setMoveIndex(1);
      }, 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzleKey]);

  // ─── Запись попытки ──────────────────────────────────────────────
  const submitAttempt = useCallback(
    async (puzzle: RunnerPuzzle, solved: boolean) => {
      if (attemptSubmittedRef.current) return;
      attemptSubmittedRef.current = true;
      // KS-1910 / ADR-029 §5.2: для custom puzzle id искусственный,
      // в БД её нет — submitAttempt пропускаем (BE отбил бы 404, но
      // primary path всё равно skip на FE). Glicko-2 / счётчик puzzle
      // / mistakes — ничего этого custom не делает.
      if (puzzle.isCustom) return;
      if (!user) return; // гости: попытки не пишем (как в PuzzlePage)
      const timeMs = Date.now() - startTimeRef.current;
      const userMoves = userMovesRef.current.join(' ');
      try {
        await puzzleApi.submitAttempt(puzzle.id, {
          result: solved ? 'solved' : 'failed',
          timeMs,
          userMoves,
        });
      } catch {
        /* транзиентная ошибка — UX задачи не блокируем */
      }
    },
    [user],
  );

  // ─── Обработчик хода ─────────────────────────────────────────────
  const onPieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare || !game || !currentPuzzle || status !== 'thinking') return false;
      if (moveIndex >= currentMoves.length) return false;

      const expected = currentMoves[moveIndex];
      const expectedFrom = expected.slice(0, 2);
      const expectedTo = expected.slice(2, 4);
      const expectedPromotion = expected.length > 4 ? expected[4] : undefined;
      const playerUci = sourceSquare + targetSquare;
      userMovesRef.current.push(playerUci);

      // MVP: принимаем только точно ожидаемый ход. Альтернативные ходы
      // (engine-проверка) не реализуем — это PuzzlePage-фича, не Gherkin
      // L-09. Если задача требует разнообразия, подбирай payload через ids.
      if (sourceSquare !== expectedFrom || targetSquare !== expectedTo) {
        // Пытаемся применить ход визуально — если ход легальный, покажем его,
        // потом откатим и покажем «неверно».
        const test = new Chess(game.fen());
        const tested = test.move({ from: sourceSquare, to: targetSquare });
        if (!tested) return false;
        playSoundRef.current(soundEventFromSan(tested.san));
        setOverrideGame(test);
        setStatus('incorrect');
        playSoundRef.current('puzzle-incorrect');
        setCounters((c) => ({ ...c, failed: c.failed + 1 }));
        void submitAttempt(currentPuzzle, false);
        return true;
      }

      const copy = new Chess(game.fen());
      const move = copy.move({ from: expectedFrom, to: expectedTo, promotion: expectedPromotion });
      if (!move) return false;
      playSoundRef.current(soundEventFromSan(move.san));
      setOverrideGame(copy);

      const nextIndex = moveIndex + 1;
      setMoveIndex(nextIndex);

      if (nextIndex >= currentMoves.length) {
        // Задача решена
        setStatus('correct');
        playSoundRef.current('puzzle-correct');
        setCounters((c) => ({ ...c, solved: c.solved + 1 }));
        void submitAttempt(currentPuzzle, true);
        return true;
      }

      // Автоход соперника
      setTimeout(() => {
        const opponent = currentMoves[nextIndex];
        const next = new Chess(copy.fen());
        const oMove = next.move({
          from: opponent.slice(0, 2),
          to: opponent.slice(2, 4),
          promotion: opponent[4] as 'q' | 'r' | 'b' | 'n' | undefined,
        });
        if (oMove) playSoundRef.current(soundEventFromSan(oMove.san));
        setOverrideGame(next);
        const after = nextIndex + 1;
        setMoveIndex(after);
        if (after >= currentMoves.length) {
          setStatus('correct');
          playSoundRef.current('puzzle-correct');
          setCounters((c) => ({ ...c, solved: c.solved + 1 }));
          void submitAttempt(currentPuzzle, true);
        }
      }, 300);

      return true;
    },
    [game, currentPuzzle, status, moveIndex, currentMoves, submitAttempt],
  );

  // ─── Прогресс по шагу / завершение ───────────────────────────────
  const total = puzzles?.length ?? 0;
  const minSolved = payload.minSolved ?? total;
  const stepPassed = total > 0 && counters.solved >= minSolved;
  const allTried = total > 0 && counters.solved + counters.failed >= total;

  useEffect(() => {
    if (stepPassed && !stepDoneFiredRef.current) {
      stepDoneFiredRef.current = true;
      onStepDone?.();
    }
  }, [stepPassed, onStepDone]);

  const goNextPuzzle = useCallback(() => {
    if (index + 1 < total) {
      setIndex((i) => i + 1);
    } else {
      setStatus('done');
    }
  }, [index, total]);

  // ─── Render ───────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="lesson-puzzle-step__error" data-testid="lesson-puzzle-step-error">
        {loadError}
      </div>
    );
  }

  if (!puzzles || !currentPuzzle) {
    return (
      <div className="lesson-puzzle-step__loading" data-testid="lesson-puzzle-step-loading">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="lesson-puzzle-step" data-testid="lesson-puzzle-step">
      <header className="lesson-puzzle-step__header">
        <span data-testid="lesson-puzzle-step-progress">
          {t('lessons.puzzleProgress', {
            current: index + 1,
            total,
            defaultValue: 'Puzzle {{current}}/{{total}}',
          })}
        </span>
        <span data-testid="lesson-puzzle-step-counters">
          {t('lessons.puzzleCounters', {
            solved: counters.solved,
            failed: counters.failed,
            min: minSolved,
            defaultValue: 'Solved {{solved}} • Failed {{failed}} • Need {{min}}',
          })}
        </span>
      </header>

      {currentPuzzle.isCustom && (
        <p
          className="lesson-puzzle-step__custom-note"
          data-testid="lesson-puzzle-step-custom-note"
          role="status"
        >
          {t(
            'lessons.puzzle.customNote',
            "Author's puzzle — rating doesn't change",
          )}
        </p>
      )}

      <PuzzleBoard
        game={game}
        boardOrientation={boardOrientation}
        enabled={status === 'thinking'}
        onPieceDrop={onPieceDrop}
        status={status === 'done' ? null : status}
      />

      <div className="lesson-puzzle-step__actions">
        {status === 'correct' && (
          <p
            className="lesson-puzzle-step__result lesson-puzzle-step__result--correct"
            data-testid="lesson-puzzle-step-correct"
          >
            {t('lessons.puzzleCorrect', 'Correct!')}
          </p>
        )}
        {status === 'incorrect' && (
          <p
            className="lesson-puzzle-step__result lesson-puzzle-step__result--incorrect"
            data-testid="lesson-puzzle-step-incorrect"
          >
            {t('lessons.puzzleIncorrect', 'Not quite — try the next one')}
          </p>
        )}

        {(status === 'correct' || status === 'incorrect') && index + 1 < total && (
          <button
            type="button"
            className="lesson-puzzle-step__next"
            data-testid="lesson-puzzle-step-next-puzzle"
            onClick={goNextPuzzle}
          >
            {t('lessons.puzzleNext', 'Next puzzle')}
          </button>
        )}

        {(status === 'done' || (allTried && status !== 'thinking')) && !hideNext && (
          <button
            type="button"
            className="lesson-puzzle-step__complete"
            data-testid="lesson-puzzle-step-complete"
            onClick={() => onStepDone?.()}
            disabled={!stepPassed}
          >
            {stepPassed
              ? t('lessons.puzzleStepComplete', 'Continue')
              : t('lessons.puzzleStepNeedMore', 'Need more correct')}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Резолвит `payload` в массив puzzle для runner'а.
 *
 * - `mode='ids'`    → батч-эндпоинт `POST /lessons/puzzle-step/resolve`
 *                     (KS-1777). Пустой список → `[]` без сетевого
 *                     вызова (бэк бы тоже вернул `[]`).
 * - `mode='filter'` → тот же эндпоинт. Backend сам разбирает темы,
 *                     рейтинг, лимит.
 * - `mode='custom'` → синхронный mapping `customPuzzles` через
 *                     `customToInMemoryPuzzle()`. Никаких сетевых
 *                     запросов (ADR-029 §5).
 *
 * Экспортируется для тестов.
 */
export async function resolvePuzzles(
  payload: PuzzleStepPayload,
): Promise<RunnerPuzzle[]> {
  const { selection } = payload;
  if (selection.mode === 'ids' && selection.puzzleIds.length === 0) {
    return [];
  }
  if (selection.mode === 'custom') {
    // KS-1912: пропускаем puzzle с пустым solutionMoves — без хода
    // решения runner некуда вести ученика. Если все puzzle такие
    // (или customPuzzles пуст) — runner покажет empty-state.
    return selection.customPuzzles
      .filter((cp) => cp.solutionMoves.length > 0)
      .map((cp, i) => customToInMemoryPuzzle(cp, i));
  }
  return lessonsApi.resolvePuzzleStep(payload);
}
