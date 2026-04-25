import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type { CustomPuzzle } from '@kingside/shared';

import { MemoChessboard } from '../../../MemoChessboard';
import { SetPositionModal } from '../../../SetPositionModal';

/**
 * `CustomPuzzleField` — карточка одной авторской задачи в редакторе
 * шага типа `puzzle` с `selection.mode = 'custom'` (KS-1909).
 *
 * Работает с `CustomPuzzle` из `packages/shared` (KS-1908):
 *   - `fen` — стартовая позиция;
 *   - `solutionMoves` — UCI-последовательность; первый ход — ход
 *     ученика (ADR-029 §5);
 *   - `orientation`, `caption`, `themes` — оформление и UI-теги.
 *
 * # Два режима
 *
 * - **Set Position** — расстановка фигур через `SetPositionModal`
 *   (тот же паттерн что в KS-1875/1906 для лекционных диаграмм и
 *   эндшпиля). FEN-инпут можно править руками.
 * - **Record Solution** — на доске рендерится позиция = `fen` +
 *   проигранные `solutionMoves`. Автор вводит следующий ожидаемый
 *   UCI: либо drag-and-drop (`onPieceDrop`), либо текстом в input
 *   `from-to[+promo]` (полезно для редкого вкуса промоушенов и для
 *   тестов).
 *
 * # Лимиты (FE-side, дублируют ADR §2.5 / KS-1908)
 *
 * - до 40 ходов в `solutionMoves` — после 40-го disable ввода;
 * - illegal move — отклоняем, показываем tooltip;
 * - 0 ходов — warning «No solution recorded yet».
 *
 * # Чётность ходов
 *
 * `solutionMoves[0]` — ход ученика (ADR-029). По чётности `index`:
 * - чётный (0, 2, 4) → «Your turn»
 * - нечётный          → «Opponent»
 *
 * Цвет (white/black) считается из FEN после применения первых
 * `index` ходов: `chess.turn()`.
 */

export interface CustomPuzzleFieldProps {
  index: number;
  puzzle: CustomPuzzle;
  onChange: (next: CustomPuzzle) => void;
  onDelete: () => void;
}

export const MAX_SOLUTION_MOVES = 40;

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface Replay {
  /** Текущий FEN (после применения всех валидных solutionMoves). */
  currentFen: string;
  /** Сколько ходов из solutionMoves удалось проиграть до ошибки. */
  validCount: number;
}

function replayMoves(startFen: string, moves: string[]): Replay {
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    return { currentFen: DEFAULT_FEN, validCount: 0 };
  }
  let validCount = 0;
  for (const uci of moves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    try {
      const m = chess.move({ from, to, promotion });
      if (!m) break;
      validCount += 1;
    } catch {
      break;
    }
  }
  return { currentFen: chess.fen(), validCount };
}

function tryAppendMove(
  startFen: string,
  history: string[],
  uci: string,
): { ok: true; newHistory: string[] } | { ok: false; reason: 'illegal' } {
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    return { ok: false, reason: 'illegal' };
  }
  for (const m of history) {
    try {
      chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    } catch {
      return { ok: false, reason: 'illegal' };
    }
  }
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  try {
    const m = chess.move({ from, to, promotion });
    if (!m) return { ok: false, reason: 'illegal' };
    return { ok: true, newHistory: [...history, uci] };
  } catch {
    return { ok: false, reason: 'illegal' };
  }
}

function turnColor(fen: string): 'white' | 'black' {
  // FEN second field — color to move.
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'black' : 'white';
}

export function CustomPuzzleField({
  index,
  puzzle,
  onChange,
  onDelete,
}: CustomPuzzleFieldProps) {
  const { t } = useTranslation();
  const [boardEditorOpen, setBoardEditorOpen] = useState(false);
  const [mode, setMode] = useState<'setPosition' | 'recordSolution'>(() =>
    puzzle.solutionMoves.length === 0 ? 'setPosition' : 'recordSolution',
  );
  const [uciInput, setUciInput] = useState('');
  const [moveError, setMoveError] = useState<string | null>(null);

  const replay = useMemo(
    () => replayMoves(puzzle.fen, puzzle.solutionMoves),
    [puzzle.fen, puzzle.solutionMoves],
  );

  const movesRecorded = puzzle.solutionMoves.length;
  const canAddMore = movesRecorded < MAX_SOLUTION_MOVES;

  const setFen = (fen: string) => {
    // Смена позиции инвалидирует solution.
    onChange({ ...puzzle, fen, solutionMoves: [] });
    setMode('setPosition');
  };

  const setOrientation = (orientation: 'white' | 'black') =>
    onChange({ ...puzzle, orientation });
  const setCaption = (caption: string) =>
    onChange({ ...puzzle, caption: caption || undefined });
  const setThemes = (raw: string) => {
    const themes = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({ ...puzzle, themes: themes.length > 0 ? themes : undefined });
  };

  const tryAdd = (uci: string): boolean => {
    if (!canAddMore) {
      setMoveError(
        t(
          'editor.step.puzzle.custom.solutionTooLong',
          'Solution too long (max 40 moves)',
        ),
      );
      return false;
    }
    const result = tryAppendMove(puzzle.fen, puzzle.solutionMoves, uci);
    if (!result.ok) {
      setMoveError(
        t('editor.step.puzzle.custom.illegalMove', 'Illegal move'),
      );
      return false;
    }
    setMoveError(null);
    onChange({ ...puzzle, solutionMoves: result.newHistory });
    return true;
  };

  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (!targetSquare) return false;
    return tryAdd(sourceSquare + targetSquare);
  };

  const handleUciSubmit = () => {
    const cleaned = uciInput.trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(cleaned)) {
      setMoveError(
        t('editor.step.puzzle.custom.illegalMove', 'Illegal move'),
      );
      return;
    }
    if (tryAdd(cleaned)) setUciInput('');
  };

  const handleUndo = () => {
    if (puzzle.solutionMoves.length === 0) return;
    onChange({
      ...puzzle,
      solutionMoves: puzzle.solutionMoves.slice(0, -1),
    });
    setMoveError(null);
  };

  const handleResetSolution = () => {
    onChange({ ...puzzle, solutionMoves: [] });
    setMoveError(null);
    setMode('setPosition');
  };

  const orientation = puzzle.orientation ?? turnColor(puzzle.fen);
  const nextMoveIsUserTurn = movesRecorded % 2 === 0;
  const nextMoveColor = turnColor(replay.currentFen);

  return (
    <div
      className="custom-puzzle-card"
      data-testid={`editor-custom-puzzle-${index}`}
    >
      <header className="custom-puzzle-card__header">
        <h5 className="custom-puzzle-card__title">
          {t('editor.step.puzzle.custom.cardTitle', {
            index: index + 1,
            defaultValue: 'Custom puzzle #{{index}}',
          })}
        </h5>
        <button
          type="button"
          className="custom-puzzle-card__delete"
          onClick={onDelete}
          data-testid={`editor-custom-puzzle-${index}-delete`}
          aria-label={t('editor.step.puzzle.custom.delete', '⌫ Delete this puzzle')}
        >
          {t('editor.step.puzzle.custom.delete', '⌫ Delete this puzzle')}
        </button>
      </header>

      <div className="custom-puzzle-card__mode-toggle" role="radiogroup">
        <label>
          <input
            type="radio"
            name={`custom-puzzle-mode-${index}`}
            checked={mode === 'setPosition'}
            onChange={() => setMode('setPosition')}
            data-testid={`editor-custom-puzzle-${index}-mode-set`}
          />
          {t('editor.step.puzzle.custom.setPosition', 'Set Position')}
        </label>
        <label>
          <input
            type="radio"
            name={`custom-puzzle-mode-${index}`}
            checked={mode === 'recordSolution'}
            onChange={() => setMode('recordSolution')}
            data-testid={`editor-custom-puzzle-${index}-mode-record`}
          />
          {t('editor.step.puzzle.custom.recordSolution', 'Record Solution')}
        </label>
      </div>

      <label className="custom-puzzle-card__fen-label">
        FEN
        <div className="custom-puzzle-card__fen-row">
          <input
            value={puzzle.fen}
            onChange={(e) => setFen(e.target.value)}
            data-testid={`editor-custom-puzzle-${index}-fen`}
          />
          <button
            type="button"
            className="custom-puzzle-card__edit-board"
            onClick={() => setBoardEditorOpen(true)}
            data-testid={`editor-custom-puzzle-${index}-edit-board`}
          >
            {t('editor.step.text.editBoard', 'Edit on board')}
          </button>
        </div>
      </label>

      <div className="custom-puzzle-card__body">
        <div className="custom-puzzle-card__board">
          <MemoChessboard
            options={{
              position: replay.currentFen,
              boardOrientation: orientation,
              allowDragging: mode === 'recordSolution' && canAddMore,
              showNotation: true,
              animationDurationInMs: 0,
              onPieceDrop: handlePieceDrop,
            }}
          />
        </div>

        <div
          className="custom-puzzle-card__moves"
          data-testid={`editor-custom-puzzle-${index}-moves`}
        >
          <div className="custom-puzzle-card__next-turn">
            {nextMoveIsUserTurn
              ? t('editor.step.puzzle.custom.yourTurn', {
                  color: nextMoveColor,
                  defaultValue: 'Your turn — {{color}}',
                })
              : t('editor.step.puzzle.custom.opponentTurn', {
                  color: nextMoveColor,
                  defaultValue: 'Opponent — {{color}}',
                })}
          </div>

          {movesRecorded === 0 ? (
            <p
              className="custom-puzzle-card__warning"
              data-testid={`editor-custom-puzzle-${index}-no-solution`}
            >
              {t(
                'editor.step.puzzle.custom.noSolution',
                'No solution recorded yet',
              )}
            </p>
          ) : (
            <ol className="custom-puzzle-card__move-list">
              {puzzle.solutionMoves.map((uci, i) => {
                const isUser = i % 2 === 0;
                return (
                  <li key={i}>
                    <code>{uci}</code>{' '}
                    <span className="custom-puzzle-card__move-tag">
                      {isUser
                        ? t(
                            'editor.step.puzzle.custom.tagYou',
                            '(student)',
                          )
                        : t(
                            'editor.step.puzzle.custom.tagOpp',
                            '(opponent)',
                          )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {mode === 'recordSolution' && (
            <div className="custom-puzzle-card__uci-row">
              <input
                value={uciInput}
                onChange={(e) => {
                  setUciInput(e.target.value);
                  setMoveError(null);
                }}
                placeholder="e2e4"
                disabled={!canAddMore}
                data-testid={`editor-custom-puzzle-${index}-uci-input`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleUciSubmit();
                  }
                }}
              />
              <button
                type="button"
                onClick={handleUciSubmit}
                disabled={!canAddMore}
                data-testid={`editor-custom-puzzle-${index}-uci-submit`}
              >
                +
              </button>
            </div>
          )}

          {moveError && (
            <p
              className="custom-puzzle-card__error"
              data-testid={`editor-custom-puzzle-${index}-move-error`}
              role="status"
            >
              {moveError}
            </p>
          )}

          {!canAddMore && (
            <p
              className="custom-puzzle-card__warning"
              data-testid={`editor-custom-puzzle-${index}-too-long`}
            >
              {t(
                'editor.step.puzzle.custom.solutionTooLong',
                'Solution too long (max 40 moves)',
              )}
            </p>
          )}

          <div className="custom-puzzle-card__solution-actions">
            <button
              type="button"
              onClick={handleUndo}
              disabled={movesRecorded === 0}
              data-testid={`editor-custom-puzzle-${index}-undo`}
            >
              {t('editor.step.puzzle.custom.undo', '↶ Undo last')}
            </button>
            <button
              type="button"
              onClick={handleResetSolution}
              disabled={movesRecorded === 0}
              data-testid={`editor-custom-puzzle-${index}-reset`}
            >
              {t('editor.step.puzzle.custom.reset', 'Reset solution')}
            </button>
          </div>
        </div>
      </div>

      <div className="custom-puzzle-card__meta">
        <label>
          {t('editor.step.puzzle.custom.orientation', 'Orientation')}
          <select
            value={puzzle.orientation ?? orientation}
            onChange={(e) =>
              setOrientation(e.target.value as 'white' | 'black')
            }
            data-testid={`editor-custom-puzzle-${index}-orientation`}
          >
            <option value="white">white</option>
            <option value="black">black</option>
          </select>
        </label>
        <label>
          {t('editor.step.puzzle.custom.caption', 'Caption')}
          <input
            value={puzzle.caption ?? ''}
            onChange={(e) => setCaption(e.target.value)}
            data-testid={`editor-custom-puzzle-${index}-caption`}
          />
        </label>
        <label>
          {t('editor.step.puzzle.custom.themes', 'Themes (comma-separated)')}
          <input
            value={(puzzle.themes ?? []).join(', ')}
            onChange={(e) => setThemes(e.target.value)}
            data-testid={`editor-custom-puzzle-${index}-themes`}
          />
        </label>
      </div>

      {boardEditorOpen && (
        <SetPositionModal
          initialFen={puzzle.fen}
          onApply={(fen) => {
            setFen(fen);
            setBoardEditorOpen(false);
          }}
          onClose={() => setBoardEditorOpen(false)}
        />
      )}
    </div>
  );
}
