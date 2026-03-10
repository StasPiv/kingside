/**
 * Общие утилиты для работы с историей ходов в шахматах
 */

/**
 * Безопасное клонирование объекта с циклическими ссылками
 */
export function safeClone(obj: any, visited = new WeakMap()): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (visited.has(obj)) {
        return {}; // Возвращаем пустой объект для разрыва цикла
    }

    visited.set(obj, true);

    if (Array.isArray(obj)) {
        return obj.map(item => safeClone(item, visited));
    }

    const cloned: any = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            // Пропускаем циклические ссылки при клонировании
            // Их восстановим позже через linkAllMovesRecursively
            if (key === 'next' || key === 'previous') {
                continue;
            }
            cloned[key] = safeClone(obj[key], visited);
        }
    }

    return cloned;
}

/**
 * Добавляет ссылки next и previous для каждого хода в массиве
 * @param moves - массив ходов для связывания
 */
export function linkMovesInArray(moves: any[]): void {
    // Фильтруем пустые объекты перед связыванием
    const validMoves = moves.filter(move => 
        move && 
        typeof move === 'object' && 
        move.globalIndex !== undefined
    );
    
    for (let i = 0; i < validMoves.length; i++) {
        validMoves[i].next = i < validMoves.length - 1 ? validMoves[i + 1] : null;
        validMoves[i].previous = i > 0 ? validMoves[i - 1] : null;
    }
    
    // Обновляем исходный массив, удаляя пустые объекты
    moves.length = 0;
    moves.push(...validMoves);
}

/**
 * Обрабатывает вариации без перезаписи связей в основной линии
 * @param moves - массив ходов для обработки
 */
function processVariationsOnly(moves: any[]): void {
    moves.forEach(move => {
        if (move.variations && Array.isArray(move.variations)) {
            move.variations.forEach((variation: any[]) => {
                // Связываем ходы внутри вариации
                linkMovesInArray(variation);

                // Устанавливаем previous для первого хода вариации
                if (variation.length > 0 && move.previous) {
                    variation[0].previous = move.previous;
                }

                // Рекурсивно обрабатываем подвариации
                processVariationsOnly(variation);
            });
        }
    });
}

/**
 * Рекурсивно добавляет ссылки next и previous ко всем ходам в истории, включая вариации
 * @param history - история ходов для связывания
 */
export function linkAllMovesRecursively(history: any[]): void {
    // Связываем основную линию
    linkMovesInArray(history);

    // Обрабатываем все вариации
    processVariationsOnly(history);
}

/**
 * Рекурсивно ищет ход по globalIndex в истории ходов, включая все вариации
 * @param moves - массив ходов для поиска
 * @param targetGlobalIndex - globalIndex искомого хода
 * @returns найденный ход или null если не найден
 */
export function searchInHistory(moves: any[], targetGlobalIndex: number): any | null {
    for (const move of moves) {
        if (move.globalIndex === targetGlobalIndex) {
            return move;
        }

        // Search in variations
        if (move.variations && move.variations.length > 0) {
            for (const variation of move.variations) {
                const moveInVariation = searchInHistory(variation, targetGlobalIndex);
                if (moveInVariation) {
                    return moveInVariation;
                }
            }
        }
    }
    return null;
}

/**
 * Находит родительский ход для указанного хода в вариации
 * @param history - полная история ходов
 * @param targetMove - ход, для которого нужно найти родителя
 * @returns родительский ход или null если не найден
 */
export function findParentMoveOfVariation(history: any[], targetMove: any): any | null {
    const searchForParent = (moves: any[]): any | null => {
        for (const move of moves) {
            // Если у хода есть вариации, ищем в них
            if (move.variations && move.variations.length > 0) {
                for (const variation of move.variations) {
                    // Проверяем, есть ли targetMove в этой вариации
                    const foundInVariation = variation.find((varMove: any) => varMove.globalIndex === targetMove.globalIndex);
                    if (foundInVariation) {
                        return move; // Возвращаем родительский ход
                    }

                    // Рекурсивно ищем в подвариациях
                    const foundInDeepVariation = searchForParent(variation);
                    if (foundInDeepVariation) {
                        return foundInDeepVariation;
                    }
                }
            }
        }
        return null;
    };

    return searchForParent(history);
}

/**
 * Находит первый ход в вариации, содержащей указанный ход
 * @param history - полная история ходов
 * @param targetMove - ход, для которого нужно найти первый ход в вариации
 * @returns первый ход в вариации или null если ход не найден в вариации
 */
export function findFirstMoveInVariation(history: any[], targetMove: any): any | null {
    const searchForFirstMoveInVariation = (moves: any[]): any | null => {
        for (const move of moves) {
            // Если у хода есть вариации, ищем в них
            if (move.variations && move.variations.length > 0) {
                for (const variation of move.variations) {
                    // Проверяем, есть ли targetMove в этой вариации
                    const foundInVariation = variation.find((varMove: any) => varMove.globalIndex === targetMove.globalIndex);
                    if (foundInVariation) {
                        return variation[0]; // Возвращаем первый ход в вариации
                    }

                    // Рекурсивно ищем в подвариациях
                    const foundInDeepVariation = searchForFirstMoveInVariation(variation);
                    if (foundInDeepVariation) {
                        return foundInDeepVariation;
                    }
                }
            }
        }
        return null;
    };

    return searchForFirstMoveInVariation(history);
}

/**
 * Строит линию ходов, начиная с указанного хода и продолжая до конца его линии
 * @param history - полная история ходов
 * @param startMove - начальный ход, с которого строить линию
 * @returns массив ходов в линии, начиная с startMove
 */
export function buildLineFromMove(history: any[], startMove: any): any[] {
    const line: any[] = [];

    // Рекурсивно находим ход и строим его линию
    const findAndBuildLine = (moves: any[], currentIndex: number = 0): boolean => {
        for (let i = currentIndex; i < moves.length; i++) {
            const move = moves[i];

            if (move.globalIndex === startMove.globalIndex) {
                // Найден стартовый ход - добавляем все ходы начиная с него
                for (let j = i; j < moves.length; j++) {
                    line.push(moves[j]);
                }
                return true;
            }

            // Ищем в вариациях
            if (move.variations && move.variations.length > 0) {
                for (const variation of move.variations) {
                    if (findAndBuildLine(variation, 0)) {
                        return true;
                    }
                }
            }
        }
        return false;
    };

    // Если не удалось найти в рекурсивном поиске, возвращаем только сам ход
    if (!findAndBuildLine(history)) {
        line.push(startMove);
    }

    return line;
}

/**
 * Строит линию ходов из вариации, начиная с указанного хода и продолжая до конца вариации
 * @param variation - массив ходов вариации
 * @param startMove - начальный ход, с которого строить линию
 * @returns массив ходов в линии, начиная с startMove
 */
export function buildLineFromVariation(variation: any[], startMove: any): any[] {
    const line: any[] = [];

    // Находим индекс начального хода в вариации
    const startIndex = variation.findIndex(move => move.globalIndex === startMove.globalIndex);

    if (startIndex !== -1) {
        // Добавляем все ходы начиная с найденного
        for (let i = startIndex; i < variation.length; i++) {
            line.push(variation[i]);
        }
    } else {
        // Если не найден в вариации, возвращаем только сам ход
        line.push(startMove);
    }

    return line;
}

/**
 * Создает глубокую копию хода без вариаций
 * @param move - исходный ход
 * @returns копия хода без вариаций
 */
export function cloneMoveWithoutVariations(move: any): any {
    const clonedMove = safeClone(move);

    if (clonedMove.variations) {
        delete clonedMove.variations;
    }

    return clonedMove;
}

/**
 * Находит первый ход в линии, содержащей указанный ход
 * @param history - полная история ходов
 * @param targetMove - ход, для которого нужно найти первый ход в линии
 * @returns первый ход в линии или сам targetMove если он уже первый
 */
export function findFirstMoveInLine(history: any[], targetMove: any): any {
    // Сначала проверяем, находится ли ход в основной линии
    const isInMainLine = history.some(move => move.globalIndex === targetMove.globalIndex);
    
    if (isInMainLine) {
        // Если в основной линии, возвращаем первый ход основной линии
        return history[0] || targetMove;
    }

    // Если не в основной линии, ищем в вариациях
    const searchInVariations = (moves: any[]): any => {
        for (const move of moves) {
            if (move.variations && move.variations.length > 0) {
                for (const variation of move.variations) {
                    // Проверяем, содержит ли эта вариация целевой ход
                    const foundInVariation = variation.find((varMove: any) => varMove.globalIndex === targetMove.globalIndex);
                    if (foundInVariation) {
                        return variation[0]; // Возвращаем первый ход в вариации
                    }

                    // Рекурсивно ищем в подвариациях
                    const foundInSubvariations = searchInVariations(variation);
                    if (foundInSubvariations) {
                        return foundInSubvariations;
                    }
                }
            }
        }
        return null;
    };

    const firstMove = searchInVariations(history);
    return firstMove || targetMove;
}
