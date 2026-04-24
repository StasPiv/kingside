import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { OpeningDrillStepPayload } from '@kingside/shared';

import { MemoChessboard } from '../../MemoChessboard';
import { useStockfish } from '../../../hooks/useStockfish';
import { parseAnnotatedPgn } from '../../../review/utils/PgnDeserializer';
import type { ChessMove } from '../../../review/types';

/**
 * Дебютный тренажёр (L-32, KS-1801).
 *
 * Ученик играет за `playerSide`, тренажёр — за соперника. Соперник
 * отвечает по PGN-дереву из `payload.pgn`, случайно выбирая между
 * основной линией и вариантами (если есть). Если ход ученика совпадает
 * с одним из вариантов в дереве — тренажёр продолжает этой линией.
 *
 * Поведение при отклонении (`payload.onDeviation`):
 * - `show_correction` — пауза, сообщение «В репертуаре: <san>», кнопка
 *   «Вернуться и попробовать снова». Движок не подключается.
 * - `engine_punish` — переход в «engine»-режим: `useStockfish` с
 *   `engineSkillLevel` играет за соперника до мата / пата / кнопки
 *   «Сдаться». ADR-025 §2.8: только wasm.
 *
 * После завершения основной линии (курсор дошёл до хода без `next`) —
 * статус `line_complete`, `onStepDone()`.
 */

interface OpeningDrillStepProps {
  payload: OpeningDrillStepPayload;
  onStepDone?: () => void;
  hideNext?: boolean;
}

type DrillStatus =
  | 'playing'
  | 'line_complete'
  | 'deviated_correction'
  | 'engine_punish'
  | 'engine_lost'
  | 'engine_drew';

/**
 * Кандидаты-ходы от текущего узла: основной next (если есть) + все
 * первые ходы подвариантов. Все узлы находятся на ОДНОЙ позиции (одно
 * и то же `before`-FEN). Экспортируется для unit-тестов.
 */
export function candidateMoves(current: ChessMove | null, line: ChessMove[]): ChessMove[] {
  const candidates: ChessMove[] = [];
  const nextMove = current === null ? line[0] : current.next ?? null;
  if (nextMove) candidates.push(nextMove);
  // Варианты «прикреплены» к первому ходу ветки (в parseAnnotatedPgn
  // альтернативы к `line[0]` лежат в `line[0].variations`, к очередному
  // ходу — в `nextMove.variations`). Текущий узел `current` сам вариантов
  // «в его позиции» не содержит — они на следующем ходу.
  const variationHost = nextMove;
  const variations = variationHost?.variations ?? [];
  for (const v of variations) {
    if (v.length > 0) candidates.push(v[0]);
  }
  return candidates;
}

function uciOfMove(m: ChessMove): string {
  return m.from + m.to + (m.promotion ? m.promotion : '');
}

export function OpeningDrillStep({
  payload,
  onStepDone,
  hideNext = false,
}: OpeningDrillStepProps) {
  const { t } = useTranslation();

  // Парсим PGN один раз. Если PGN невалидный или пустой — дерево пустое,
  // тренажёр сразу завершается (backend-валидатор отсекает такие seed'ы).
  const tree = useMemo<ChessMove[]>(() => {
    try {
      return parseAnnotatedPgn(payload.pgn);
    } catch {
      return [];
    }
  }, [payload.pgn]);

  // Стартовая позиция = `before` первого хода или standard start.
  const startFen = tree[0]?.before ?? new Chess().fen();

  const [chess, setChess] = useState<Chess>(() => new Chess(startFen));
  const [cursor, setCursor] = useState<ChessMove | null>(null);
  const [status, setStatus] = useState<DrillStatus>('playing');
  const [deviations, setDeviations] = useState(0);
  const [playerMoves, setPlayerMoves] = useState(0);
  const [correctionMove, setCorrectionMove] = useState<ChessMove | null>(null);
  const [engineActive, setEngineActive] = useState(false);
  const stepDoneFiredRef = useRef(false);

  const engine = useStockfish({
    skillLevel: payload.engineSkillLevel,
    depth: Math.min(20, Math.max(4, (payload.engineSkillLevel ?? 10) + 3)),
    multiPv: 1,
  });

  const playerSide = payload.playerSide;
  const opponentSide = playerSide === 'white' ? 'black' : 'white';

  // ─── Engine punish: применяем bestMove ─────────────────────────────
  const engineBestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engineActive) return;
    if (!engine.bestMove) return;
    if (engine.bestMove === engineBestRef.current) return;
    engineBestRef.current = engine.bestMove;
    if (status !== 'engine_punish') return;
    const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
    if (sideToMove !== opponentSide) return;
    const uci = engine.bestMove;
    if (!uci || uci === '(none)') return;
    try {
      const next = new Chess(chess.fen());
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length === 5 ? uci[4] : undefined;
      const move = next.move({ from, to, promotion });
      if (!move) return;
      setChess(next);
    } catch {
      /* ignore stale bestmove */
    }
  }, [engine.bestMove, engineActive, chess, opponentSide, status]);

  // Чей ход сейчас — и если движок-соперник, отдаём ему evaluate(fen).
  useEffect(() => {
    if (status !== 'engine_punish') return;
    if (!engineActive) return;
    const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
    if (sideToMove !== opponentSide) return;
    engineBestRef.current = null;
    engine.evaluate(chess.fen());
  }, [chess, opponentSide, status, engineActive, engine]);

  // Проверка терминальных статусов в режиме engine_punish.
  useEffect(() => {
    if (status !== 'engine_punish') return;
    if (chess.isCheckmate()) {
      const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
      // Мат ученику ходит после его собственного хода → sideToMove=player, мат им.
      // Если sideToMove=player и checkmate → engine нас заматовал → engine_lost для ученика.
      setStatus(sideToMove === playerSide ? 'engine_lost' : 'line_complete');
      return;
    }
    if (chess.isStalemate() || chess.isDraw() || chess.isInsufficientMaterial()) {
      setStatus('engine_drew');
    }
  }, [chess, status, playerSide]);

  // ─── Tree-drill: ход тренажёра по дереву ───────────────────────────
  const playTreeMove = useCallback(
    (next: ChessMove) => {
      setChess(new Chess(next.after));
      setCursor(next);
    },
    [],
  );

  // Автоматически ходим за соперника сразу после хода ученика / старта.
  useEffect(() => {
    if (status !== 'playing') return;
    const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
    if (sideToMove !== opponentSide) return;
    const candidates = candidateMoves(cursor, tree);
    if (candidates.length === 0) {
      // Линия закончилась на ходе соперника — шаг пройден.
      setStatus('line_complete');
      return;
    }
    // Случайный выбор между вариантами (имитация живого соперника).
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    // Маленькая задержка для наглядности (в тестах можно не ждать).
    const timer = setTimeout(() => playTreeMove(chosen), 250);
    return () => clearTimeout(timer);
  }, [chess, status, cursor, tree, opponentSide, playTreeMove]);

  // После хода соперника (tree-move) проверяем — закончилась ли линия.
  useEffect(() => {
    if (status !== 'playing') return;
    if (cursor === null) return;
    const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
    if (sideToMove !== playerSide) return;
    // Сейчас очередь ученика — проверяем, есть ли у него ходы по дереву.
    const candidates = candidateMoves(cursor, tree);
    if (candidates.length === 0) {
      // Основная линия / ветка пройдена до конца.
      setStatus('line_complete');
    }
  }, [cursor, chess, status, playerSide, tree]);

  useEffect(() => {
    if (status === 'line_complete' && !stepDoneFiredRef.current) {
      stepDoneFiredRef.current = true;
      onStepDone?.();
    }
  }, [status, onStepDone]);

  // ─── Ход ученика ────────────────────────────────────────────────────
  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string }) => {
      if (status !== 'playing' && status !== 'engine_punish') return false;
      const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
      if (sideToMove !== playerSide) return false;
      try {
        const next = new Chess(chess.fen());
        const move = next.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: 'q',
        });
        if (!move) return false;
        const uci = move.from + move.to + (move.promotion ?? '');

        if (status === 'engine_punish') {
          // В режиме наказания ученик может играть любой ход — мы не
          // сверяемся с деревом, просто применяем, дальше движок ответит.
          setChess(next);
          return true;
        }

        // Сверяемся с деревом.
        const candidates = candidateMoves(cursor, tree);
        const match = candidates.find(
          (cand) => uciOfMove(cand) === uci || cand.san === move.san,
        );
        setPlayerMoves((n) => n + 1);
        if (match) {
          setChess(next);
          setCursor(match);
          return true;
        }
        // Отклонение
        setDeviations((n) => n + 1);
        if (payload.onDeviation === 'show_correction') {
          // Позиция НЕ меняется — показываем корректный ход.
          setCorrectionMove(candidates[0] ?? null);
          setStatus('deviated_correction');
          return false; // ход не применён
        }
        // engine_punish: применяем ход и переключаем в engine-режим.
        setChess(next);
        setEngineActive(true);
        setStatus('engine_punish');
        return true;
      } catch {
        return false;
      }
    },
    [chess, playerSide, status, cursor, tree, payload.onDeviation],
  );

  // ─── Reset / retry ──────────────────────────────────────────────────
  const retryFromStart = useCallback(() => {
    setChess(new Chess(startFen));
    setCursor(null);
    setStatus('playing');
    setDeviations(0);
    setPlayerMoves(0);
    setCorrectionMove(null);
    setEngineActive(false);
    engineBestRef.current = null;
    stepDoneFiredRef.current = false;
  }, [startFen]);

  const retryAfterCorrection = useCallback(() => {
    // Курсор остаётся на предыдущем ходе (до отклонения), позиция
    // восстанавливается до before-хода; игрок продолжает с того же места.
    const restoreFen = cursor ? cursor.after : startFen;
    setChess(new Chess(restoreFen));
    setCorrectionMove(null);
    setStatus('playing');
  }, [cursor, startFen]);

  // ─── Render ─────────────────────────────────────────────────────────
  const statusLabel: Record<DrillStatus, string> = {
    playing: t('lessons.opening.status.playing', 'Your move'),
    line_complete: t('lessons.opening.status.complete', 'Line completed'),
    deviated_correction: t('lessons.opening.status.correction', 'Not in repertoire'),
    engine_punish: t('lessons.opening.status.enginePunish', 'Engine is punishing the deviation'),
    engine_lost: t('lessons.opening.status.engineLost', 'Engine won — try again.'),
    engine_drew: t('lessons.opening.status.engineDrew', 'Draw — try again.'),
  };

  const statsText = t('lessons.opening.stats', {
    deviations,
    total: playerMoves,
    defaultValue: '{{deviations}} deviations of {{total}} moves',
  });

  return (
    <div
      className="lesson-opening-step"
      data-testid="lesson-opening-step"
      data-status={status}
    >
      <div className="lesson-opening-step__board">
        <MemoChessboard
          options={{
            position: chess.fen(),
            boardOrientation: playerSide,
            allowDragging: status === 'playing' || status === 'engine_punish',
            showNotation: true,
            animationDurationInMs: 150,
            onPieceDrop: handlePieceDrop,
          }}
        />
      </div>

      <div
        className="lesson-opening-step__side"
        data-testid="lesson-opening-step-side"
      >
        <div
          className="lesson-opening-step__status"
          data-testid="lesson-opening-step-status"
        >
          {statusLabel[status]}
        </div>
        {status === 'deviated_correction' && correctionMove && (
          <div
            className="lesson-opening-step__correction"
            data-testid="lesson-opening-step-correction"
          >
            {t('lessons.opening.correction', {
              san: correctionMove.san,
              defaultValue: 'In repertoire: {{san}}',
            })}
          </div>
        )}
        <div
          className="lesson-opening-step__stats"
          data-testid="lesson-opening-step-stats"
        >
          {statsText}
        </div>

        <div className="lesson-opening-step__controls">
          {status === 'deviated_correction' && (
            <button
              type="button"
              onClick={retryAfterCorrection}
              data-testid="lesson-opening-step-retry-correction"
              className="lesson-opening-step__retry"
            >
              {t('lessons.opening.retry', 'Try again')}
            </button>
          )}
          {(status === 'engine_lost' ||
            status === 'engine_drew' ||
            status === 'engine_punish' ||
            status === 'line_complete') && (
            <button
              type="button"
              onClick={retryFromStart}
              data-testid="lesson-opening-step-restart"
              className="lesson-opening-step__restart"
            >
              {t('lessons.opening.restart', 'Restart drill')}
            </button>
          )}
          {status === 'line_complete' && !hideNext && (
            <button
              type="button"
              onClick={() => onStepDone?.()}
              data-testid="lesson-opening-step-next"
              className="lesson-opening-step__next"
            >
              {t('lessons.opening.next', 'Next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
