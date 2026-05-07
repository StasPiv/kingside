/**
 * KS-2456 §5.3 + KS-2454. Explanation для `find-pin`.
 *
 * shape='square': `correctAnswer.square` — pinned-фигура.
 *
 * KS-2455: алгоритм `findPinAnchor` опубликован в `@kingside/shared` —
 * единый источник истины с backend predicate'ом. Здесь — только
 * адаптация результата к `DrillExplanation`.
 *
 * Стрелки (KS-2454, методика chess-expert):
 *  - **одна** `pin-line` от attacker → anchor. Луч связки геометрически
 *    единый, две стрелки разрывают его визуально. UI рендерит arrow
 *    как одну линию через клетку pinned (clip behind highlight).
 *
 * Подсветки:
 *  - `target` = pinned (это «ответ»).
 *  - `correct` = pinned.
 *  - `context` = anchor + attacker.
 *  - `wrong` = userAnswer.square при ошибке.
 *
 * Notes (методика chess-expert):
 *  - `correctAbsolute` если anchor = король (разорвать связку нельзя).
 *  - `correctRelative` если anchor — более ценная не-королевская фигура
 *    (можно ходом pinned-фигуры, ценой материала).
 *  - `wrong` — ошибка пользователя.
 *
 * Различие absolute/relative — методически обязательно.
 */
import { Chess, type Square } from 'chess.js';
import { findPinAnchor } from '@kingside/shared';
import type {
  DrillExplanation,
  DrillExplanationArrow,
  DrillExplanationHighlight,
  DrillExplanationNote,
  ExplainDrillInput,
} from '../types';
import { EMPTY_EXPLANATION } from '../types';

export function explainFindPin(input: ExplainDrillInput): DrillExplanation {
  const { drill, correctAnswer, userAnswer, solved } = input;
  if (correctAnswer.shape !== 'square') return EMPTY_EXPLANATION;

  let chess: Chess;
  try {
    chess = new Chess(drill.fen);
  } catch {
    return EMPTY_EXPLANATION;
  }

  const pinnedSq = correctAnswer.square as Square;
  const pinned = chess.get(pinnedSq);
  if (!pinned) return EMPTY_EXPLANATION;

  const info = findPinAnchor(chess, pinnedSq, pinned.color);
  if (!info) {
    // Аномалия: drill говорит «здесь связка», но геометрию не нашли.
    // Возвращаем минимальный highlight, чтобы UI хоть что-то показал.
    return {
      arrows: [],
      highlights: [
        { square: pinnedSq, role: 'target' },
        { square: pinnedSq, role: 'correct' },
      ],
      notes: [
        {
          key: 'drills.explanation.findPin.correctAbsolute',
          params: { pinnedSquare: pinnedSq },
          tone: solved ? 'success' : 'info',
        },
      ],
    };
  }

  const attackerPiece = chess.get(info.sliderSq);
  const attackerType = attackerPiece?.type ?? 'q';
  const isAbsolute = info.anchorType === 'k';

  const arrows: DrillExplanationArrow[] = [
    { from: info.sliderSq, to: info.anchorSq, role: 'pin-line' },
  ];
  const highlights: DrillExplanationHighlight[] = [
    { square: pinnedSq, role: 'target' },
    { square: pinnedSq, role: 'correct' },
    { square: info.anchorSq, role: 'context' },
    { square: info.sliderSq, role: 'context' },
  ];

  const noteKey = isAbsolute
    ? 'drills.explanation.findPin.correctAbsolute'
    : 'drills.explanation.findPin.correctRelative';
  const notes: DrillExplanationNote[] = [
    {
      key: noteKey,
      params: {
        attacker: attackerType,
        attackerKey: `chess.pieces.${attackerType}`,
        fromSquare: info.sliderSq,
        pinned: pinned.type,
        pinnedKey: `chess.pieces.${pinned.type}`,
        pinnedSquare: pinnedSq,
        anchor: info.anchorType,
        anchorKey: `chess.pieces.${info.anchorType}`,
        anchorSquare: info.anchorSq,
      },
      tone: solved ? 'success' : 'info',
    },
  ];

  if (userAnswer && userAnswer.shape === 'square' && !solved) {
    const wrongSq = userAnswer.square as Square;
    if (wrongSq !== pinnedSq) {
      highlights.push({ square: wrongSq, role: 'wrong' });
    }
    notes.push({
      key: 'drills.explanation.findPin.wrong',
      params: { square: wrongSq },
      tone: 'wrong',
    });
  }

  return { arrows, highlights, notes };
}
