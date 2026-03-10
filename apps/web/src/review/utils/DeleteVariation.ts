import {
    safeClone,
    linkAllMovesRecursively,
    searchInHistory,
    findParentMoveOfVariation,
    findFirstMoveInVariation
} from './ChessHistoryUtils';

/**
 * Удаляет вариацию, содержащую указанный ход, из истории
 * @param history - история ходов
 * @param targetMove - ход, вариацию которого нужно удалить
 * @returns обновленная история без указанной вариации
 */
function removeVariationContainingMove(history: any[], targetMove: any): any[] {
    const processMovesRecursively = (moves: any[]): any[] => {
        return moves.map(move => {
            // Если у хода есть вариации, обрабатываем их
            if (move.variations && move.variations.length > 0) {
                const filteredVariations = move.variations.filter((variation: any[]) => {
                    // Проверяем, содержит ли эта вариация целевой ход
                    const containsTargetMove = variation.some((varMove: any) => varMove.globalIndex === targetMove.globalIndex);
                    return !containsTargetMove; // Оставляем только вариации, которые НЕ содержат целевой ход
                });

                // Рекурсивно обрабатываем оставшиеся вариации
                const processedVariations = filteredVariations.map((variation: any[]) => {
                    return processMovesRecursively(variation);
                });

                // Возвращаем ход с обновленными вариациями
                return {
                    ...move,
                    variations: processedVariations.length > 0 ? processedVariations : undefined
                };
            }

            return move;
        });
    };

    return processMovesRecursively(history);
}

/**
 * Результат удаления вариации
 */
interface DeleteVariationResult {
    updatedHistory: any[];
    newCurrentMove: any | null;
}

/**
 * Удаляет вариацию, содержащую указанный ход
 * @param currentMove - ход, вариацию которого нужно удалить
 * @param history - история ходов
 * @param withLinks - если true, добавляет ссылки next/previous к ходам
 * @returns объект с обновленной историей и новым текущим ходом
 */
export function deleteVariation(
    currentMove: any,
    history: any[],
    withLinks: boolean = false
): DeleteVariationResult {
    // Безопасно клонируем историю для избежания мутации
    const updatedHistory = safeClone(history);

    // Проверяем, находится ли currentMove в основной линии
    const isInMainLine = updatedHistory.some((move: any) => move.globalIndex === currentMove.globalIndex);

    if (isInMainLine) {
        // Если ход в основной линии, удалять нечего - возвращаем историю без изменений
        return {
            updatedHistory: history,
            newCurrentMove: currentMove
        };
    }

    // Находим родительский ход для currentMove
    const parentMove = findParentMoveOfVariation(updatedHistory, currentMove);

    if (!parentMove) {
        // Если не нашли родительский ход, возвращаем историю без изменений
        return {
            updatedHistory: history,
            newCurrentMove: currentMove
        };
    }

    // Находим первый ход в вариации, содержащей currentMove
    const firstMoveInVariation = findFirstMoveInVariation(updatedHistory, currentMove);

    if (!firstMoveInVariation) {
        // Если не нашли первый ход в вариации, возвращаем историю без изменений
        return {
            updatedHistory: history,
            newCurrentMove: currentMove
        };
    }

    // Удаляем всю вариацию, содержащую этот ход
    const historyWithRemovedVariation = removeVariationContainingMove(updatedHistory, firstMoveInVariation);

    // Добавляем ссылки next/previous ко всем ходам в обновленной истории, если требуется
    if (withLinks) {
        linkAllMovesRecursively(historyWithRemovedVariation);
    }

    // Находим родительский ход в обновленной истории (с учетом возможных изменений после линковки)
    const newCurrentMove = searchInHistory(historyWithRemovedVariation, parentMove.globalIndex);

    return {
        updatedHistory: historyWithRemovedVariation,
        newCurrentMove: newCurrentMove || parentMove
    };
}