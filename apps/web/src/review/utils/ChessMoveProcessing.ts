import { ChessMove, VariationColor } from '../types';

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
  /**
   * KS-2288 (ADR-038 §6, VC E2) — пользовательский цвет вариации,
   * рассчитанный для этого хода. Берётся с root'а вариации
   * (`moves[0].variationColor`); при отсутствии наследуется от
   * родительской вариации (через `inheritedVariationColor` параметр
   * в `processMoveHierarchy`). Подвариация с СВОИМ root.variationColor
   * переопределяет наследуемый.
   *
   * `undefined` для main-line ходов и для вариаций без явного цвета,
   * чьи родители тоже без цвета. Render-side (`getMoveClasses`) при
   * отсутствии этого поля fallback'ает на auto-coloring
   * `.variation-level-N` (ADR-037 / KS-2275).
   */
  variationColor?: VariationColor;
}

export interface BracketItem {
  type: 'bracket';
  bracketType: 'open' | 'close';
  level: number;
  path: any[];
  variationIndex: number;
  parentMoveIndex: number;
  /**
   * KS-2288 (ADR-038 §6, VC E2) — пользовательский цвет вариации,
   * к которой относится скобка. См. `ProcessedMove.variationColor`.
   */
  variationColor?: VariationColor;
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
 * Форматирует отображение хода с учетом контекста.
 *
 * KS-2828: учитываем случай «main-line, первый ход — чёрный» (стартовая
 * позиция из FEN, где `... b ...` или fullmove != 1). До фикса
 * `formatMoveDisplay` для этого случая возвращал просто `move.san` без
 * префикса `<N>...`, и пользователь видел нумерацию белых для чёрного
 * хода (например, `1.h6` вместо `25...h6` при ходе чёрных). PgnDeserializer
 * уже правильно вычисляет `ply` из FEN-headers (см. startPly), но рендер
 * этим не пользовался.
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
  } else if (level === 0 && moveIndex === 0 && !isWhiteMove) {
    // KS-2828: main-line, первый ход — чёрный (стартовая позиция из FEN
    // с side-to-move=b или fullmove != 1). Префикс `<N>...` обязателен,
    // иначе нотация выглядит как ход белых с тем же номером.
    return `${moveNumber}...${move.san}`;
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
 * Обрабатывает иерархию ходов, возвращая плоский массив обработанных элементов.
 *
 * KS-2288 (ADR-038 §6, VC E2) — пробрасывает `variationColor` каждому
 * `ProcessedMove` и `BracketItem` варианта:
 *  - root вариации (moves[0]) задаёт цвет ветки (если у него `variationColor`);
 *  - все потомки вариации наследуют этот цвет;
 *  - подвариация со СВОИМ `root.variationColor` переопределяет
 *    наследуемый цвет;
 *  - main-line (level=0) не получает variationColor (variation-color
 *    применим только к веткам).
 *
 * @param inheritedVariationColor — цвет от родительской вариации
 *   (для рекурсивных вызовов). На главной линии не используется.
 */
export function processMoveHierarchy(
  moves: ChessMove[],
  currentMoveIndex: number | null,
  parentPath: any[] = [],
  level: number = 0,
  inheritedVariationColor?: VariationColor
): ProcessedItem[] {
  const result: ProcessedItem[] = [];

  if (!moves || !Array.isArray(moves) || moves.length === 0) {
    return result;
  }

  // KS-2288: цвет ВСЕЙ текущей вариации.
  // Main-line (level=0) — без цвета.
  // Variation root (moves[0]) задаёт цвет; иначе наследуем от родителя.
  const branchColor: VariationColor | undefined =
    level > 0
      ? moves[0]?.variationColor ?? inheritedVariationColor
      : undefined;

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
      originalMove: move,
      // KS-2288: цвет всей ветки (включая root и всех потомков
      // одной вариации). На main-line — undefined.
      variationColor: branchColor,
    };

    result.push(processedMove);

    // Обработка вариантов
    if (move.variations && Array.isArray(move.variations) && move.variations.length > 0) {
      for (let varIndex = 0; varIndex < move.variations.length; varIndex++) {
        const variation = move.variations[varIndex];

        if (!variation) {
          continue;
        }

        const variationMoves = extractVariationMoves(variation);
        // KS-2288: цвет подвариации = свой root.variationColor или
        // наследует от текущей ветки (branchColor для не-main-line,
        // undefined для main-line как parent).
        const subBranchColor: VariationColor | undefined =
          variationMoves[0]?.variationColor ?? branchColor;

        // Открывающая скобка
        const openBracket: BracketItem = {
          type: 'bracket',
          bracketType: 'open',
          level,
          path: currentPath,
          variationIndex: varIndex,
          parentMoveIndex: move.globalIndex,
          // KS-2288: скобка визуально принадлежит вариации, которую
          // обрамляет — берёт subBranchColor.
          variationColor: subBranchColor,
        };
        result.push(openBracket);

        // Рекурсивно обрабатываем варианты
        const variationPath = [...currentPath, { variation: varIndex }];

        const processedVariation = processMoveHierarchy(
          variationMoves,
          currentMoveIndex,
          variationPath,
          level + 1,
          subBranchColor,
        );

        result.push(...processedVariation);

        // Закрывающая скобка
        const closeBracket: BracketItem = {
          type: 'bracket',
          bracketType: 'close',
          level,
          path: currentPath,
          variationIndex: varIndex,
          parentMoveIndex: move.globalIndex,
          variationColor: subBranchColor,
        };
        result.push(closeBracket);
      }
    }
  }

  return result;
}

/**
 * Генерирует CSS классы для хода.
 *
 * KS-2288 (ADR-038 §6, VC E2): если у `processedMove.variationColor`
 * задан пользовательский цвет — добавляем override-класс
 * `.variation-color-{green|blue|yellow|red}` ВМЕСТО auto-coloring
 * `.variation-level-N`. Логика «либо то, либо то» в коде, а не на
 * уровне CSS-специфики, чтобы DOM-тесты могли проверить точное
 * множество классов.
 */
export function getMoveClasses(processedMove: ProcessedMove): string {
  const classes = ['move-item'];

  if (processedMove.isCurrent) {
    classes.push('current');
  }

  if (processedMove.isVariation) {
    classes.push('variation-move');
  }

  if (processedMove.variationColor) {
    // Override: пользовательский цвет вытесняет auto-coloring по уровню.
    classes.push(`variation-color-${processedMove.variationColor}`);
  } else if (processedMove.level > 0) {
    const levelClass = `variation-level-${Math.min(processedMove.level, 4)}`;
    classes.push(levelClass);
  }

  return classes.filter(Boolean).join(' ');
}

/**
 * Генерирует CSS классы для скобок.
 *
 * KS-2275: `variation-level-N` для auto-coloring по уровню вариации
 * (`--c-subline-N`). `BracketItem.level` хранит уровень РОДИТЕЛЯ;
 * скобка принадлежит самой вариации → `level + 1` (clamp до 4).
 *
 * KS-2288: если задан `bracket.variationColor` (пользовательский
 * цвет ветки) — override-класс `.variation-color-{name}` ВМЕСТО
 * auto-coloring (как в `getMoveClasses`).
 */
export function getBracketClasses(bracket: BracketItem): string {
  const classes = [
    'variation-bracket',
    `variation-bracket-${bracket.bracketType}`,
  ];
  if (bracket.variationColor) {
    classes.push(`variation-color-${bracket.variationColor}`);
  } else {
    classes.push(`variation-level-${Math.min(bracket.level + 1, 4)}`);
  }

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