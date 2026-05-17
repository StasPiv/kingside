import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess, type Square } from 'chess.js';
import type {
  EndgameDrillStepPayload,
  EndgameWinCondition,
} from '@kingside/shared';

import { MemoChessboard } from '../../MemoChessboard';
import { PromotionPicker, type PromotionPiece } from '../../PromotionPicker';
import { useStockfish } from '../../../hooks/useStockfish';
import { EngineLoader } from '../../EngineLoader';

/**
 * Эндшпильный тренажёр против Stockfish WASM (L-24, KS-1800).
 *
 * Ученик играет с позиции `payload.fen` за `payload.playerSide`, движок
 * отвечает с `payload.skillLevel` (UCI 0..20). После каждого хода
 * проверяется `winCondition` — при выполнении шаг `done`.
 *
 * # Правило ADR-025 §2.8
 *
 * Используется только Stockfish WASM (`useStockfish`). Серверный движок
 * и `useExternalEngine` НЕ задействованы. При нестабильности Skill Level
 * митигация — через обновление wasm-сборки, не через backend.
 *
 * # Основной цикл
 *
 * 1. `chess.js` держит актуальную позицию.
 * 2. Ход ученика приходит через `onPieceDrop`. Если ход невалиден —
 *    откатываем; валиден — пишем в историю и проверяем `winCondition`.
 * 3. Если `winCondition` выполнено — `onStepDone()`. Иначе, если сейчас
 *    очередь движка, дергаем `evaluate(fen)`. При приходе `bestMove`
 *    применяем его, снова проверяем winCondition и `maxMoves`.
 * 4. Кнопка «Сдаться» — сбрасывает позицию к `fen` и сохраняет
 *    счётчик `failedAttempts` (для UX).
 * 5. Кнопка «Подсказка» (только если `hintsAllowed=true`) — запускает
 *    отдельный «hint»-инстанс Stockfish (без ограничения силы, большая
 *    глубина) и показывает best move на доске подсветкой. НЕ играет.
 *
 * # История / откат
 *
 * Хранится массив `history: { san, fen, uci }` после каждого полухода.
 * Клик по записи откатывает позицию (`takeback`) и очищает историю
 * после этого индекса — это возможность «попробовать ещё раз с N-го
 * хода». ReviewMoveList требует тяжёлого PGN-дерева состояния и
 * интеграции с AnalysisPage; для эндшпильного тренажёра простой
 * список достаточен и не тянет 1200 строк refactor'а AnalysisPage
 * (см. такой же компромисс в GameReviewStep).
 */

interface EndgameDrillStepProps {
  payload: EndgameDrillStepPayload;
  onStepDone?: () => void;
  hideNext?: boolean;
}

interface HistoryEntry {
  san: string;
  uci: string;
  fenAfter: string;
  /** Чей это был полуход. */
  color: 'white' | 'black';
}

type OutcomeStatus =
  | 'playing'
  | 'player_won'
  | 'engine_won'
  | 'draw'
  | 'max_moves'
  | 'resigned';

/**
 * Проверяет `winCondition` относительно текущей позиции. Возвращает
 * `true`, если условие выполнено _в пользу ученика_. Чистая функция —
 * экспортируется для unit-тестов.
 */
export function evaluateWinCondition(
  chess: Chess,
  initialChess: Chess,
  playerSide: 'white' | 'black',
  cond: EndgameWinCondition,
): boolean {
  switch (cond.kind) {
    case 'mate': {
      // Ученик выиграл, если противник получил мат.
      if (!chess.isCheckmate()) return false;
      // После мата очередь — чей король в мате; мат поставлен предыдущей стороной.
      const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
      // Если сейчас ход соперника-ученика → он в мате → соперник получил мат от ученика.
      return sideToMove !== playerSide;
    }
    case 'promote': {
      const before = countPromotablePieces(initialChess, playerSide);
      const after = countPromotablePieces(chess, playerSide);
      return after > before;
    }
    case 'reach_position': {
      return normalizeFen(chess.fen()) === normalizeFen(cond.fen);
    }
    case 'material_advantage': {
      return materialBalance(chess, playerSide) >= cond.amount;
    }
  }
}

/** Считает ферзей + ладей + слонов + коней у `side` (без пешек/короля). */
function countPromotablePieces(chess: Chess, side: 'white' | 'black'): number {
  const board = chess.board();
  const target = side === 'white' ? 'w' : 'b';
  let count = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.color !== target) continue;
      if (cell.type === 'q' || cell.type === 'r' || cell.type === 'b' || cell.type === 'n') {
        count += 1;
      }
    }
  }
  return count;
}

/** Материальный перевес `side` в пешках (ферзь=9, ладья=5, слон=3, конь=3, пешка=1). */
export function materialBalance(chess: Chess, side: 'white' | 'black'): number {
  const values: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1, k: 0 };
  const board = chess.board();
  let playerMat = 0;
  let opponentMat = 0;
  const target = side === 'white' ? 'w' : 'b';
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      const v = values[cell.type] ?? 0;
      if (cell.color === target) playerMat += v;
      else opponentMat += v;
    }
  }
  return playerMat - opponentMat;
}

/** Нормализация FEN для сравнения reach_position: без счётчиков ходов. */
function normalizeFen(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function EndgameDrillStep({
  payload,
  onStepDone,
  hideNext = false,
}: EndgameDrillStepProps) {
  const { t } = useTranslation();

  // Стартовая позиция — в refs, чтобы не копировалось на каждый рендер.
  const initialChessRef = useRef<Chess>(new Chess(payload.fen));
  useEffect(() => {
    initialChessRef.current = new Chess(payload.fen);
  }, [payload.fen]);

  const [chess, setChess] = useState<Chess>(() => new Chess(payload.fen));
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState<OutcomeStatus>('playing');
  const [hintUci, setHintUci] = useState<string | null>(null);
  /**
   * KS-2969: модалка выбора фигуры при превращении пешки. До этого
   * шаг авто-продвигал в ферзя — для эндшпилей с под-промоушном
   * (Кр+п против Кр и т.п.) ученик не мог выбрать ладью/слона/коня.
   */
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: Square;
    to: Square;
  } | null>(null);
  const stepDoneFiredRef = useRef(false);

  // Движок-соперник (с ограничением силы).
  const engine = useStockfish({
    depth: Math.min(20, Math.max(4, payload.skillLevel + 3)),
    multiPv: 1,
    skillLevel: payload.skillLevel,
  });

  // Отдельный «hint»-инстанс (без ограничения силы, больше глубина).
  // Инициализируется лениво при первом нажатии «Подсказка».
  const hintEngine = useStockfish({
    depth: 20,
    multiPv: 1,
  });

  const playerSide = payload.playerSide;
  const opponentSide = playerSide === 'white' ? 'black' : 'white';

  const fullMovesPlayed = useMemo(() => {
    // Полный ход = ход ученика + ответ движка. Счётчик по ходам ученика.
    return history.filter((e) => e.color === playerSide).length;
  }, [history, playerSide]);

  // ─── Engine reply ──────────────────────────────────────────────────
  const engineBestMoveRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engine.bestMove) return;
    if (engine.bestMove === engineBestMoveRef.current) return;
    engineBestMoveRef.current = engine.bestMove;
    if (status !== 'playing') return;
    // Движок должен ходить только когда очередь противника.
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
      setHistory((h) => [
        ...h,
        {
          san: move.san,
          uci,
          fenAfter: next.fen(),
          color: opponentSide,
        },
      ]);
    } catch {
      // Неконсистентный bestmove — пропускаем (движок может отдать stale-ответ).
    }
  }, [engine.bestMove, chess, opponentSide, status]);

  // ─── Win/max-moves check после каждого изменения позиции ───────────
  useEffect(() => {
    if (status !== 'playing') return;
    if (
      evaluateWinCondition(
        chess,
        initialChessRef.current,
        playerSide,
        payload.winCondition,
      )
    ) {
      setStatus('player_won');
      if (!stepDoneFiredRef.current) {
        stepDoneFiredRef.current = true;
        onStepDone?.();
      }
      return;
    }
    if (chess.isCheckmate()) {
      // Ученик получил мат — учитываем как engine_won (winCondition не
      // выполнено, иначе сработало бы выше).
      setStatus('engine_won');
      return;
    }
    if (chess.isStalemate() || chess.isDraw() || chess.isInsufficientMaterial()) {
      setStatus('draw');
      return;
    }
    if (payload.maxMoves !== undefined && fullMovesPlayed >= payload.maxMoves) {
      setStatus('max_moves');
      return;
    }
  }, [chess, payload.winCondition, payload.maxMoves, playerSide, status, fullMovesPlayed, onStepDone]);

  // ─── Передача хода движку ──────────────────────────────────────────
  useEffect(() => {
    if (status !== 'playing') return;
    const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
    if (sideToMove !== opponentSide) return;
    engineBestMoveRef.current = null;
    engine.evaluate(chess.fen());
  }, [chess, opponentSide, status, engine]);

  // ─── Player move ───────────────────────────────────────────────────

  /**
   * KS-2969: определяет, является ли ход превращением пешки.
   */
  const isPromotionMove = useCallback(
    (sourceSquare: string, targetSquare: string): boolean => {
      const piece = chess.get(sourceSquare as Square);
      if (!piece || piece.type !== 'p') return false;
      const targetRank = targetSquare[1];
      return (
        (piece.color === 'w' && targetRank === '8') ||
        (piece.color === 'b' && targetRank === '1')
      );
    },
    [chess],
  );

  /**
   * KS-2969: применить ход ученика. promotion — выбранная фигура (для
   * не-promotion-ходов параметр игнорируется chess.js).
   */
  const applyStudentMove = useCallback(
    (
      sourceSquare: string,
      targetSquare: string,
      promotion: PromotionPiece = 'q',
    ): boolean => {
      if (status !== 'playing') return false;
      if (targetSquare === sourceSquare) return false;
      const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
      if (sideToMove !== playerSide) return false;

      try {
        const next = new Chess(chess.fen());
        const move = next.move({
          from: sourceSquare,
          to: targetSquare,
          promotion,
        });
        if (!move) return false;
        const uci =
          move.from + move.to + (move.promotion ? move.promotion : '');
        setChess(next);
        setHintUci(null);
        setHistory((h) => [
          ...h,
          {
            san: move.san,
            uci,
            fenAfter: next.fen(),
            color: playerSide,
          },
        ]);
        return true;
      } catch {
        return false;
      }
    },
    [chess, playerSide, status],
  );

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string }) => {
      if (status !== 'playing') return false;
      if (targetSquare === sourceSquare) return false;
      if (isPromotionMove(sourceSquare, targetSquare)) {
        // Проверим легальность хода ферзём — иначе модалку не открываем.
        const testGame = new Chess(chess.fen());
        let testMove: ReturnType<Chess['move']> | null = null;
        try {
          testMove = testGame.move({
            from: sourceSquare,
            to: targetSquare,
            promotion: 'q',
          });
        } catch {
          testMove = null;
        }
        if (!testMove) return false;
        setPendingPromotion({
          from: sourceSquare as Square,
          to: targetSquare as Square,
        });
        return true;
      }
      return applyStudentMove(sourceSquare, targetSquare);
    },
    [status, isPromotionMove, chess, applyStudentMove],
  );

  const handlePromotionChoice = useCallback(
    (piece: PromotionPiece) => {
      if (!pendingPromotion) return;
      const { from, to } = pendingPromotion;
      setPendingPromotion(null);
      applyStudentMove(from, to, piece);
    },
    [pendingPromotion, applyStudentMove],
  );

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  // ─── Сдаться / рестарт / откат ─────────────────────────────────────
  const resetToStart = useCallback(() => {
    setChess(new Chess(payload.fen));
    setHistory([]);
    setHintUci(null);
    setStatus('playing');
    engineBestMoveRef.current = null;
    stepDoneFiredRef.current = false;
    setPendingPromotion(null);
  }, [payload.fen]);

  const handleResign = useCallback(() => {
    setStatus('resigned');
  }, []);

  const takeback = useCallback(
    (idx: number) => {
      // Откатываемся к состоянию ПОСЛЕ полухода idx (0..n-1).
      // idx=-1 — начало (до любых ходов).
      if (idx < -1 || idx >= history.length) return;
      const nextHistory = history.slice(0, idx + 1);
      const nextFen =
        idx === -1 ? payload.fen : nextHistory[nextHistory.length - 1].fenAfter;
      setChess(new Chess(nextFen));
      setHistory(nextHistory);
      setHintUci(null);
      setStatus('playing');
      engineBestMoveRef.current = null;
      stepDoneFiredRef.current = false;
    },
    [history, payload.fen],
  );

  // ─── Подсказка ─────────────────────────────────────────────────────
  const showHint = useCallback(() => {
    if (!payload.hintsAllowed) return;
    if (status !== 'playing') return;
    const sideToMove = chess.turn() === 'w' ? 'white' : 'black';
    if (sideToMove !== playerSide) return;
    hintEngine.evaluate(chess.fen());
  }, [payload.hintsAllowed, status, chess, playerSide, hintEngine]);

  // Когда hint-инстанс отдаёт bestMove — сохраняем для подсветки.
  const prevHintBestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!payload.hintsAllowed) return;
    if (hintEngine.bestMove === prevHintBestRef.current) return;
    prevHintBestRef.current = hintEngine.bestMove;
    if (hintEngine.bestMove && hintEngine.bestMove !== '(none)') {
      setHintUci(hintEngine.bestMove);
    }
  }, [hintEngine.bestMove, payload.hintsAllowed]);

  // ─── Подсветка подсказки на доске ──────────────────────────────────
  const squareStyles = useMemo(() => {
    if (!hintUci) return {};
    const from = hintUci.slice(0, 2);
    const to = hintUci.slice(2, 4);
    const style = { background: 'rgba(255, 215, 0, 0.45)' };
    return { [from]: style, [to]: style } as Record<string, React.CSSProperties>;
  }, [hintUci]);

  // ─── Render ────────────────────────────────────────────────────────
  const statusLabel: Record<OutcomeStatus, string> = {
    playing: t('lessons.endgame.status.playing', 'Your move'),
    player_won: t('lessons.endgame.status.playerWon', 'Win condition met!'),
    engine_won: t('lessons.endgame.status.engineWon', 'Checkmate — try again.'),
    draw: t('lessons.endgame.status.draw', 'Draw — try again.'),
    max_moves: t('lessons.endgame.status.maxMoves', 'Move limit reached — try again.'),
    resigned: t('lessons.endgame.status.resigned', 'You resigned — try again.'),
  };

  const movesLimitText =
    payload.maxMoves !== undefined
      ? t('lessons.endgame.movesCount', {
          current: fullMovesPlayed,
          max: payload.maxMoves,
          defaultValue: 'Moves: {{current}}/{{max}}',
        })
      : t('lessons.endgame.movesCountNoLimit', {
          current: fullMovesPlayed,
          defaultValue: 'Moves: {{current}}',
        });

  return (
    <div
      className="lesson-endgame-step"
      data-testid="lesson-endgame-step"
      data-status={status}
    >
      <div className="lesson-endgame-step__board">
        <MemoChessboard
          options={{
            position: chess.fen(),
            boardOrientation: playerSide,
            allowDragging: status === 'playing',
            showNotation: true,
            animationDurationInMs: 150,
            onPieceDrop: handlePieceDrop,
            squareStyles,
          }}
        />
        {/* KS-3067: индикатор загрузки/ошибки движка-противника. Без него
            ученик видит замершую позицию и не понимает почему движок не
            отвечает. */}
        {(engine.state === 'loading' || engine.state === 'error') && (
          <EngineLoader
            variant="inline"
            state={engine.state}
            loadProgress={engine.loadProgress}
            errorReason={engine.errorReason}
            onRetry={engine.init}
          />
        )}
        {/* KS-2969: модалка выбора фигуры при превращении пешки. */}
        <PromotionPicker
          pending={pendingPromotion}
          color={pendingPromotion?.to[1] === '8' ? 'w' : 'b'}
          onChoice={handlePromotionChoice}
          onCancel={handlePromotionCancel}
          testId="lesson-endgame-promotion-overlay"
        />
      </div>

      <div
        className="lesson-endgame-step__side"
        data-testid="lesson-endgame-step-side"
      >
        <div
          className="lesson-endgame-step__status"
          data-testid="lesson-endgame-step-status"
        >
          {statusLabel[status]}
        </div>
        <div
          className="lesson-endgame-step__counter"
          data-testid="lesson-endgame-step-counter"
        >
          {movesLimitText}
        </div>

        <div className="lesson-endgame-step__history">
          <h4>{t('lessons.endgame.historyTitle', 'History')}</h4>
          <ol
            className="lesson-endgame-step__history-list"
            data-testid="lesson-endgame-step-history"
          >
            <li>
              <button
                type="button"
                onClick={() => takeback(-1)}
                data-testid="lesson-endgame-step-takeback-start"
              >
                {t('lessons.endgame.backToStart', 'Start')}
              </button>
            </li>
            {history.map((entry, idx) => (
              <li
                key={idx}
                className={`lesson-endgame-step__history-item lesson-endgame-step__history-item--${entry.color}`}
              >
                <button
                  type="button"
                  onClick={() => takeback(idx)}
                  data-testid={`lesson-endgame-step-takeback-${idx}`}
                >
                  {idx + 1}. {entry.san}
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="lesson-endgame-step__controls">
          {status === 'playing' && (
            <>
              <button
                type="button"
                onClick={handleResign}
                data-testid="lesson-endgame-step-resign"
                className="lesson-endgame-step__resign"
              >
                {t('lessons.endgame.resign', 'Resign')}
              </button>
              {payload.hintsAllowed && (
                <button
                  type="button"
                  onClick={showHint}
                  data-testid="lesson-endgame-step-hint"
                  className="lesson-endgame-step__hint"
                >
                  {t('lessons.endgame.hint', 'Hint')}
                </button>
              )}
            </>
          )}
          {status !== 'playing' && (
            <button
              type="button"
              onClick={resetToStart}
              data-testid="lesson-endgame-step-restart"
              className="lesson-endgame-step__restart"
            >
              {t('lessons.endgame.restart', 'Try again')}
            </button>
          )}
          {status === 'player_won' && !hideNext && (
            <button
              type="button"
              onClick={() => onStepDone?.()}
              data-testid="lesson-endgame-step-next"
              className="lesson-endgame-step__next"
            >
              {t('lessons.endgame.next', 'Next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
