import { ChessMove } from '../types';

export interface ProcessedMove {
  globalIndex: number;
  display: string;
  level: number;
  isVariation: boolean;
  isCurrent: boolean;
  needsBracket?: 'open' | 'close';
  path: any[];
  san: string;
  fen?: string | null; // Исправлено: убрали undefined
  ply?: number;
  originalMove?: ChessMove;
}

export interface BracketItem {
  type: 'bracket';
  bracketType: 'open' | 'close';
  level: number;
  path: any[];
  variationIndex: number;
  parentMoveIndex: number;
}

export type ProcessedItem = ProcessedMove | BracketItem;

/**
 * Извлекает массив ходов из объекта вариации
 */
function extractVariationMoves(variation: any): ChessMove[] {
  if (variation.moves && Array.isArray(variation.moves)) {
    return variation.moves;
  } else if (Array.isArray(variation)) {
    return variation;
  } else if (variation.history && Array.isArray(variation.history)) {
    return variation.history;
  }
  return [];
}

/**
 * Форматирует отображение хода с учетом контекста
 */
function formatMoveDisplay(
  move: ChessMove,
  moveIndex: number,
  moves: ChessMove[],
  level: number
): string {
  const ply = move.ply || (moveIndex + 1);
  const moveNumber = Math.ceil(ply / 2);
  const isWhiteMove = ply % 2 === 1;

  let needsMoveNumberAfterVariation = false;

  // Проверяем, нужен ли номер хода после вариантов
  if (moveIndex > 0) {
    const prevMove = moves[moveIndex - 1];
    if (prevMove && prevMove.variations && prevMove.variations.length > 0 && !isWhiteMove) {
      needsMoveNumberAfterVariation = true;
    }
  }

  // Форматирование хода
  if (level > 0 && moveIndex === 0) {
    // Первый ход в вариации
    if (isWhiteMove) {
      return `${moveNumber}.${move.san}`;
    } else {
      return `${moveNumber}...${move.san}`;
    }
  } else if (needsMoveNumberAfterVariation) {
    // Ход после завершения вариации
    return `${moveNumber}...${move.san}`;
  } else {
    // Обычный ход
    if (isWhiteMove) {
      return `${moveNumber}.${move.san}`;
    } else {
      return move.san;
    }
  }
}

/**
 * Обрабатывает иерархию ходов, возвращая плоский массив обработанных элементов
 */
export function processMoveHierarchy(
  moves: ChessMove[],
  currentMoveIndex: number | null,
  parentPath: any[] = [],
  level: number = 0
): ProcessedItem[] {
  const result: ProcessedItem[] = [];

  if (!moves || !Array.isArray(moves) || moves.length === 0) {
    return result;
  }

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];

    if (!move || !move.san || move.globalIndex === undefined) {
      continue;
    }

    const currentPath = [...parentPath, i];

    // Формируем обработанный ход
    const processedMove: ProcessedMove = {
      globalIndex: move.globalIndex,
      display: formatMoveDisplay(move, i, moves, level),
      level,
      isVariation: level > 0,
      isCurrent: move.globalIndex === currentMoveIndex,
      path: currentPath,
      san: move.san,
      fen: move.fen, // Теперь TypeScript не будет ругаться
      ply: move.ply,
      originalMove: move
    };

    result.push(processedMove);

    // Обработка вариантов
    if (move.variations && Array.isArray(move.variations) && move.variations.length > 0) {
      for (let varIndex = 0; varIndex < move.variations.length; varIndex++) {
        const variation = move.variations[varIndex];

        if (!variation) {
          continue;
        }

        // Открывающая скобка
        const openBracket: BracketItem = {
          type: 'bracket',
          bracketType: 'open',
          level,
          path: currentPath,
          variationIndex: varIndex,
          parentMoveIndex: move.globalIndex
        };
        result.push(openBracket);

        // Рекурсивно обрабатываем варианты
        const variationPath = [...currentPath, { variation: varIndex }];
        const variationMoves = extractVariationMoves(variation);

        const processedVariation = processMoveHierarchy(
          variationMoves,
          currentMoveIndex,
          variationPath,
          level + 1
        );

        result.push(...processedVariation);

        // Закрывающая скобка
        const closeBracket: BracketItem = {
          type: 'bracket',
          bracketType: 'close',
          level,
          path: currentPath,
          variationIndex: varIndex,
          parentMoveIndex: move.globalIndex
        };
        result.push(closeBracket);
      }
    }
  }

  return result;
}

/**
 * Генерирует CSS классы для хода
 */
export function getMoveClasses(processedMove: ProcessedMove): string {
  const classes = ['move-item'];

  if (processedMove.isCurrent) {
    classes.push('current');
  }

  if (processedMove.isVariation) {
    classes.push('variation-move');
  }

  if (processedMove.level > 0) {
    const levelClass = `variation-level-${Math.min(processedMove.level, 4)}`;
    classes.push(levelClass);
  }

  return classes.filter(Boolean).join(' ');
}

/**
 * Генерирует CSS классы для скобок
 */
export function getBracketClasses(bracket: BracketItem): string {
  const classes = [
    'variation-bracket',
    `variation-bracket-${bracket.bracketType}`
  ];

  return classes.join(' ');
}

/**
 * Проверяет, является ли элемент ходом
 */
export function isProcessedMove(item: ProcessedItem): item is ProcessedMove {
  return 'globalIndex' in item && 'display' in item;
}

/**
 * Проверяет, является ли элемент скобкой
 */
export function isBracketItem(item: ProcessedItem): item is BracketItem {
  return 'type' in item && item.type === 'bracket';
}