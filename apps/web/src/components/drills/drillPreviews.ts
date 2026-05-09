import type { TacticDrillType } from '@kingside/shared';
import type {
  MiniBoardArrow,
  MiniBoardSquare,
} from '../puzzle/PuzzleMiniBoard';

/**
 * KS-2685 — иллюстративные миниатюры для лобби тренажёров.
 *
 * Источник данных: KS-2684 (devops подобрал по одному
 * представительному пазлу для каждого типа из prod `tactic_drills`).
 * Конвенция стрелок/подсветок:
 *   - `green`   — наш ход (UCI from→to из `answer`).
 *   - `orange`  — линия атаки/связки/вилки (визуальный акцент).
 *   - `yellow`  — целевая клетка / фигура-объект задачи.
 *   - `red`     — клетка, для которой считаем атакующих.
 *
 * Карточки рендерятся через `<DrillTypeCard preview={…} />` в
 * `DrillsLobbyPage`. Дополнительная карточка SPRINT_PREVIEW —
 * для CTA-блока «Спринт» (берём find-fork как яркий общий мотив,
 * по решению координатора).
 */

export interface DrillPreview {
  fen: string;
  arrows?: MiniBoardArrow[];
  squares?: MiniBoardSquare[];
  orientation?: 'white' | 'black';
}

export const DRILL_PREVIEWS: Record<TacticDrillType, DrillPreview> = {
  'find-fork': {
    fen: '8/8/8/6P1/8/pr6/3Q4/k5K1 w - - 3 56',
    arrows: [
      { from: 'd2', to: 'd1', color: 'green' },
      { from: 'd1', to: 'a1', color: 'orange' },
      { from: 'd1', to: 'b3', color: 'orange' },
    ],
    squares: [
      { square: 'a1', color: 'yellow' },
      { square: 'b3', color: 'yellow' },
    ],
  },
  'count-attackers': {
    fen: '8/8/8/2K5/2P4k/p7/B7/3b4 w - - 0 61',
    arrows: [
      { from: 'c5', to: 'c4', color: 'orange' },
      { from: 'a2', to: 'c4', color: 'orange' },
    ],
    squares: [{ square: 'c4', color: 'red' }],
  },
  'find-loose-piece': {
    fen: 'Q7/1K4R1/8/8/1r3k2/6p1/8/8 w - - 0 60',
    squares: [{ square: 'b4', color: 'yellow' }],
  },
  'find-hanging-piece': {
    fen: '8/6R1/8/2k2n2/6P1/3K4/8/6r1 w - - 0 67',
    arrows: [{ from: 'g4', to: 'f5', color: 'green' }],
    squares: [{ square: 'f5', color: 'yellow' }],
  },
  'find-all-checks': {
    fen: '8/5K1P/6B1/8/8/8/1p1k4/7r b - - 2 71',
    arrows: [
      { from: 'h1', to: 'f1', color: 'green' },
      { from: 'h1', to: 'h7', color: 'green' },
    ],
    squares: [
      { square: 'f1', color: 'yellow' },
      { square: 'h7', color: 'yellow' },
    ],
    orientation: 'black',
  },
  'find-pin': {
    fen: '3R4/8/8/8/P2b4/3k4/r7/4K3 w - - 10 81',
    arrows: [{ from: 'd8', to: 'd3', color: 'orange' }],
    squares: [{ square: 'd4', color: 'yellow' }],
  },
  'find-undefended-attack': {
    fen: '3r4/8/8/4p1R1/2K5/7p/5k2/8 w - - 0 66',
    arrows: [
      { from: 'g5', to: 'h5', color: 'green' },
      { from: 'h5', to: 'h3', color: 'orange' },
    ],
    squares: [{ square: 'h3', color: 'yellow' }],
  },
};

/**
 * KS-2685: превью CTA-блока «Спринт» — яркий мотив вилки.
 * (KS-2684 решение координатора: take find-fork as common spotlight.)
 */
export const SPRINT_PREVIEW: DrillPreview = DRILL_PREVIEWS['find-fork'];
