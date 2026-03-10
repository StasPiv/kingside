import { ChessMove } from '../types';

/**
 * Удаляет все ходы после текущего в той линии, в которой он находится.
 * Если текущий ход находится в основной линии, удаляет все ходы после него в основной линии.
 * Если текущий ход находится в варианте, удаляет все ходы после него только в этом варианте.
 */
export function deleteRemaining(currentMove: ChessMove, history: ChessMove[]): ChessMove[] {
    if (!currentMove || !history || history.length === 0) {
        return history;
    }

    const currentGlobalIndex = currentMove.globalIndex;

    /**
     * Проверяет, находится ли ход в основной линии
     */
    function isInMainLine(globalIndex: number): boolean {
        return history.some(move => move.globalIndex === globalIndex);
    }

    /**
     * Обрезает основную линию после указанного хода
     */
    function truncateMainLine(globalIndex: number): ChessMove[] {
        const result: ChessMove[] = [];
        
        for (const move of history) {
            if (move.globalIndex === globalIndex) {
                // Добавляем текущий ход, но очищаем его next и вариации от удаляемых ходов
                result.push({
                    ...move,
                    next: undefined,
                    variations: move.variations ? cleanVariationsFromRemovedMoves(move.variations, globalIndex) : undefined
                });
                break;
            } else {
                result.push(move);
            }
        }
        
        return result;
    }

    /**
     * Очищает вариации от ходов, которые должны быть удалены
     */
    function cleanVariationsFromRemovedMoves(variations: ChessMove[][], afterGlobalIndex: number): ChessMove[][] | undefined {
        if (!variations || variations.length === 0) {
            return undefined;
        }

        const cleanedVariations = variations.map(variation => 
            cleanVariationFromRemovedMoves(variation, afterGlobalIndex)
        ).filter(variation => variation.length > 0);

        return cleanedVariations.length > 0 ? cleanedVariations : undefined;
    }

    /**
     * Очищает одну вариацию от ходов, которые должны быть удалены
     */
    function cleanVariationFromRemovedMoves(variation: ChessMove[], afterGlobalIndex: number): ChessMove[] {
        return variation.map(move => ({
            ...move,
            variations: move.variations ? cleanVariationsFromRemovedMoves(move.variations, afterGlobalIndex) : undefined
        }));
    }

    /**
     * Обрезает вариацию после указанного хода
     */
    function truncateVariationAtMove(variation: ChessMove[], globalIndex: number): ChessMove[] {
        const result: ChessMove[] = [];
        
        for (const move of variation) {
            if (move.globalIndex === globalIndex) {
                // Добавляем текущий ход без next и с очищенными вариациями
                result.push({
                    ...move,
                    next: undefined,
                    variations: move.variations ? cleanVariationsFromRemovedMoves(move.variations, globalIndex) : undefined
                });
                break;
            } else {
                result.push({
                    ...move,
                    variations: move.variations ? processVariationsForTruncation(move.variations, globalIndex) : undefined
                });
            }
        }
        
        return result;
    }

    /**
     * Обрабатывает вариации для обрезания
     */
    function processVariationsForTruncation(variations: ChessMove[][], targetGlobalIndex: number): ChessMove[][] | undefined {
        if (!variations || variations.length === 0) {
            return undefined;
        }

        const processedVariations = variations.map(variation => {
            // Проверяем, содержит ли эта вариация целевой ход
            const containsTarget = variation.some(move => move.globalIndex === targetGlobalIndex);
            
            if (containsTarget) {
                return truncateVariationAtMove(variation, targetGlobalIndex);
            } else {
                // Рекурсивно обрабатываем вложенные вариации
                return variation.map(move => ({
                    ...move,
                    variations: move.variations ? processVariationsForTruncation(move.variations, targetGlobalIndex) : undefined
                }));
            }
        }).filter(variation => variation.length > 0);

        return processedVariations.length > 0 ? processedVariations : undefined;
    }

    /**
     * Основная функция обработки истории
     */
    function processHistory(): ChessMove[] {
        // Если текущий ход находится в основной линии
        if (isInMainLine(currentGlobalIndex)) {
            return truncateMainLine(currentGlobalIndex);
        }

        // Если текущий ход находится в вариации
        return history.map(move => ({
            ...move,
            variations: move.variations ? processVariationsForTruncation(move.variations, currentGlobalIndex) : undefined
        }));
    }

    return processHistory();
}
