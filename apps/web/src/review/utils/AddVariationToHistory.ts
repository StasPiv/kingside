import { linkAllMovesRecursively } from './ChessHistoryUtils';

/**
 * Добавляет новый ход как вариацию к следующему ходу после текущего
 * @param newMove - новый ход для добавления как вариация
 * @param currentMove - текущий ход
 * @param history - история ходов
 * @returns объект с обновленной историей
 */
export function addVariationToHistory(
    newMove: any,
    currentMove: any,
    history: any[]
): { updatedHistory: any[] } {
    if (!currentMove.next) {
        console.warn('addVariationToHistory: currentMove has no next move');
        return { updatedHistory: history };
    }

    const targetGlobalIndex = currentMove.next.globalIndex;

    /**
     * Рекурсивно обновляет историю, добавляя вариацию к нужному ходу
     */
    function updateInHistory(moves: any[]): any[] {
        return moves.map((move: any) => {
            // Если это ход, к которому добавляем вариацию
            if (move.globalIndex === targetGlobalIndex) {
                const existingVariations = move.variations || [];
                return {
                    ...move,
                    variations: [...existingVariations, [newMove]]
                };
            }

            // Рекурсивно обрабатываем вариации
            if (move.variations && move.variations.length > 0) {
                return {
                    ...move,
                    variations: move.variations.map((variation: any) => updateInHistory(variation))
                };
            }

            return move;
        });
    }

    const updatedHistory = updateInHistory(history);

    // Связываем все ходы рекурсивно после добавления вариации
    linkAllMovesRecursively(updatedHistory);

    return {
        updatedHistory: updatedHistory
    };
}