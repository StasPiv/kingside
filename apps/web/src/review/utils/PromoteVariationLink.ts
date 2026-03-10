import {
    safeClone,
    linkAllMovesRecursively,
    searchInHistory,
    buildLineFromMove,
    buildLineFromVariation,
    cloneMoveWithoutVariations,
    findFirstMoveInLine
} from './ChessHistoryUtils';

/**
 * Результат поиска хода в истории
 */
interface MoveSearchResult {
    foundMove: any;           // Найденный ход (с перенесенными вариациями + parentLine)
    parentMove: any | null;   // Родительский ход (без вариаций)
    parentLine: any[];        // Вся линия родительского хода (без вариаций)
    foundLine: any[];         // Вся линия найденного хода (без вариаций)
    updatedHistory: any[];    // История с удаленной parentLine
}

/**
 * Создает глубокую копию хода с перенесенными вариациями и добавленной родительской линией
 * @param move - исходный ход
 * @param variationsToTransfer - массив вариаций для переноса
 * @param parentLineToAdd - родительская линия для добавления как вариация
 * @returns копия хода с новыми вариациями
 */
function cloneMoveWithTransferredVariationsAndParentLine(move: any, variationsToTransfer: any[], parentLineToAdd: any[]): any {
    const clonedMove = safeClone(move);

    // Собираем все вариации
    const existingVariations = clonedMove.variations || [];
    const allVariations = [...existingVariations, ...variationsToTransfer];

    // Добавляем родительскую линию как дополнительную вариацию, если она не пустая
    if (parentLineToAdd && parentLineToAdd.length > 0) {
        // Создаем копию родительской линии без вариаций для каждого хода
        const parentLineVariation = updateParentLineWithoutVariations(parentLineToAdd, parentLineToAdd[0]);
        allVariations.push(parentLineVariation);
    }

    if (allVariations.length > 0) {
        clonedMove.variations = allVariations;
    } else {
        delete clonedMove.variations;
    }

    return clonedMove;
}

/**
 * Обновляет линию ходов, заменяя родительский ход на версию без вариаций
 * @param parentLine - исходная линия ходов
 * @param parentMove - родительский ход
 * @returns обновленная линия ходов без вариаций у родительского хода
 */
function updateParentLineWithoutVariations(parentLine: any[], parentMove: any): any[] {
    return parentLine.map(move => {
        if (move.globalIndex === parentMove.globalIndex) {
            // Только у parentMove удаляем вариации
            return cloneMoveWithoutVariations(move);
        }
        // У остальных ходов сохраняем вариации
        return safeClone(move);
    });
}

/**
 * Обновляет линию найденного хода, очищая вариации у всех ходов
 * @param foundLine - исходная линия найденного хода
 * @returns обновленная линия без вариаций у всех ходов
 */
function updateFoundLineWithoutVariations(foundLine: any[]): any[] {
    return foundLine.map(move => safeClone(move));
}

/**
 * Заменяет ходы из parentLine на ходы из foundLine в истории ходов (включая все вложенные вариации)
 * @param history - история ходов
 * @param parentLine - линия ходов для замены
 * @param foundLine - линия ходов, на которую заменяем
 * @returns история с замененными ходами
 */
function replaceParentLineWithFoundLine(history: any[], parentLine: any[], foundLine: any[]): any[] {
    if (parentLine.length === 0) {
        return foundLine.length > 0 ? [...foundLine, ...history] : history;
    }

    if (foundLine.length === 0) {
        // Если foundLine пустая, просто удаляем parentLine
        const parentLineIndices = new Set(parentLine.map(move => move.globalIndex));

        const filterMovesRecursively = (moves: any[]): any[] => {
            return moves
                .filter(move => !parentLineIndices.has(move.globalIndex))
                .map(move => {
                    if (move.variations && move.variations.length > 0) {
                        const filteredVariations = move.variations
                            .map((variation: any[]) => filterMovesRecursively(variation))
                            .filter((variation: any[]) => variation.length > 0);

                        return {
                            ...move,
                            variations: filteredVariations.length > 0 ? filteredVariations : undefined
                        };
                    }

                    return move;
                });
        };

        return filterMovesRecursively(history);
    }

    // Создаем Set из globalIndex ходов в parentLine для быстрого поиска
    const parentLineIndices = new Set(parentLine.map(move => move.globalIndex));

    /**
     * Рекурсивно обрабатывает массив ходов, заменяя parentLine на foundLine
     * @param moves - массив ходов для обработки
     * @param shouldInsertFoundLine - нужно ли вставить foundLine в этом месте
     * @returns обработанный массив ходов
     */
    const processMovesRecursively = (moves: any[], shouldInsertFoundLine: boolean = false): any[] => {
        const result: any[] = [];
        let foundLineInserted = false;

        for (let i = 0; i < moves.length; i++) {
            const move = moves[i];

            // Если это ход из parentLine
            if (parentLineIndices.has(move.globalIndex)) {
                // Вставляем foundLine только один раз и только на месте первого хода parentLine
                if (!foundLineInserted && shouldInsertFoundLine) {
                    result.push(...foundLine);
                    foundLineInserted = true;
                }
                // Пропускаем все остальные ходы из parentLine
                continue;
            }

            // Если у хода есть вариации, рекурсивно обрабатываем их
            if (move.variations && move.variations.length > 0) {
                const processedVariations: any[][] = [];

                for (const variation of move.variations) {
                    // Проверяем, есть ли в этой вариации ходы из parentLine
                    const hasParentLineMoves = variation.some((varMove: any) =>
                        parentLineIndices.has(varMove.globalIndex)
                    );

                    const processedVariation = processMovesRecursively(variation, hasParentLineMoves);

                    // Добавляем вариацию только если она не пустая
                    if (processedVariation.length > 0) {
                        processedVariations.push(processedVariation);
                    }
                }

                // Обновляем ход с обработанными вариациями
                result.push({
                    ...move,
                    variations: processedVariations.length > 0 ? processedVariations : undefined
                });
            } else {
                // Обычный ход без вариаций
                result.push(move);
            }
        }

        // Если foundLine не была вставлена, но должна быть (например, parentLine была в конце)
        if (!foundLineInserted && shouldInsertFoundLine) {
            result.push(...foundLine);
        }

        return result;
    };

    // Находим позицию первого хода из parentLine
    let isInMainLine = false;

    // Проверяем, находится ли первый ход parentLine в основной линии
    for (let i = 0; i < history.length; i++) {
        if (parentLineIndices.has(history[i].globalIndex)) {
            isInMainLine = true;
            break;
        }
    }

    // Если parentLine находится в основной линии
    if (isInMainLine) {
        return processMovesRecursively(history, true);
    } else {
        // parentLine находится в вариациях, обрабатываем рекурсивно
        return processMovesRecursively(history, false);
    }
}

/**
 * Расширенный поиск хода с информацией о родителе и его линии
 * @param moves - массив ходов для поиска
 * @param targetGlobalIndex - globalIndex искомого хода
 * @param fullHistory - полная история для построения линии родителя
 * @returns результат поиска с найденным ходом, его родителем и линией родителя, или null если не найден
 */
function searchMoveWithParentInfo(moves: any[], targetGlobalIndex: number, fullHistory: any[]): MoveSearchResult | null {
    // Проходим по всем ходам в текущем массиве
    for (const move of moves) {
        // Проверяем, является ли текущий ход искомым
        if (move.globalIndex === targetGlobalIndex) {
            // Ход найден в основной линии, у него нет родителя
            // Строим линию найденного хода из основной линии
            const originalFoundLine = buildLineFromMove(fullHistory, move);
            const updatedFoundLine = updateFoundLineWithoutVariations(originalFoundLine);

            // Заменяем первый элемент foundLine на найденный ход (с вариациями)
            if (updatedFoundLine.length > 0) {
                updatedFoundLine[0] = move;
            }

            return {
                foundMove: move,
                parentMove: null,
                parentLine: [],
                foundLine: updatedFoundLine,
                updatedHistory: fullHistory // История не изменяется, так как нет parentLine для замены
            };
        }

        // Если у хода есть вариации, ищем в них рекурсивно
        if (move.variations && move.variations.length > 0) {
            for (let variationIndex = 0; variationIndex < move.variations.length; variationIndex++) {
                const variation = move.variations[variationIndex];

                // Ищем в данной вариации
                for (const varMove of variation) {
                    if (varMove.globalIndex === targetGlobalIndex) {
                        // Ход найден в вариации

                        // Получаем все остальные вариации (кроме текущей с найденным ходом)
                        const otherVariations = move.variations.filter((_: any, index: number) => index !== variationIndex);

                        // Создаем родительский ход без вариаций
                        const parentMoveWithoutVariations = cloneMoveWithoutVariations(move);

                        // Строим линию родительского хода без вариаций
                        const originalParentLine = buildLineFromMove(fullHistory, move);
                        const updatedParentLine = updateParentLineWithoutVariations(originalParentLine, move);

                        // Строим линию найденного хода из его вариации
                        const originalFoundLine = buildLineFromVariation(variation, varMove);
                        const updatedFoundLine = updateFoundLineWithoutVariations(originalFoundLine);

                        // Создаем копию найденного хода с перенесенными вариациями И добавленной родительской линией
                        const foundMoveWithTransferredVariationsAndParentLine = cloneMoveWithTransferredVariationsAndParentLine(
                            varMove,
                            otherVariations,
                            updatedParentLine
                        );

                        // Заменяем первый элемент foundLine на найденный ход (с вариациями)
                        if (updatedFoundLine.length > 0) {
                            updatedFoundLine[0] = foundMoveWithTransferredVariationsAndParentLine;
                        }

                        // Заменяем parentLine на foundLine в истории
                        const updatedHistory = replaceParentLineWithFoundLine(fullHistory, updatedParentLine, updatedFoundLine);

                        return {
                            foundMove: foundMoveWithTransferredVariationsAndParentLine,
                            parentMove: parentMoveWithoutVariations,
                            parentLine: updatedParentLine,
                            foundLine: updatedFoundLine,
                            updatedHistory: updatedHistory
                        };
                    }
                }

                // Рекурсивно ищем в подвариациях
                const recursiveResult = searchMoveWithParentInfo(variation, targetGlobalIndex, fullHistory);
                if (recursiveResult) {
                    return recursiveResult;
                }
            }
        }
    }

    return null;
}

/**
 * Продвигает вариацию в основную линию
 * @param currentMove - текущий ход для продвижения
 * @param history - история ходов
 * @param withLinks - если true, добавляет ссылки next/previous к ходам
 * @returns обновленная история ходов
 */
export function promoteVariationLink(
    currentMove: any,
    history: any[],
    withLinks: boolean = false
): any {
    // Безопасно клонируем историю для избежания мутации
    const updatedHistory = safeClone(history);

    // Находим первый ход в линии currentMove
    const firstMoveInCurrentLine = findFirstMoveInLine(updatedHistory, currentMove);

    // Ищем currentMove в истории
    const searchResult = searchMoveWithParentInfo(updatedHistory, firstMoveInCurrentLine.globalIndex, updatedHistory);

    // Если ход не найден, возвращаем историю без изменений
    if (!searchResult) {
        return history;
    }

    // Если ход найден в основной линии (нет родителя), то продвигать нечего
    if (!searchResult.parentMove) {
        return history;
    }

    // Добавляем ссылки next/previous ко всем ходам в обновленной истории, если требуется
    if (withLinks) {
        linkAllMovesRecursively(searchResult.updatedHistory);
    }

    return searchResult.updatedHistory;
}