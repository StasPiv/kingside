import { linkAllMovesRecursively } from './ChessHistoryUtils';

/**
 * Добавляет новый ход к текущему ходу и обновляет историю ходов
 * @param newMove - новый ход для добавления
 * @param currentMove - текущий ход (может быть null для начала игры)
 * @param history - история ходов
 * @returns объект с обновленным текущим ходом и историей
 */
export function addMoveToHistory(
    newMove: any,
    currentMove: any | null,
    history: any[]
): { updatedCurrentMove: any; updatedHistory: any[] } {
    /**
     * Проверяет, находится ли ход в основной линии
     */
    function isInMainLine(move: any, history: any[]): boolean {
        return history.some(historyMove => historyMove.globalIndex === move.globalIndex);
    }

    /**
     * Добавляет ход в правильное место в истории
     */
    function addMoveToCorrectLocation(
        history: any[],
        currentMove: any | null,
        newMove: any
    ): any[] {
        if (!currentMove) {
            return [newMove];
        }

        if (isInMainLine(currentMove, history)) {
            return [...history, newMove];
        }

        function updateInHistory(moves: any[]): any[] {
            if (!currentMove) {
                console.warn('addMoveToHistory: currentMove is null in updateInHistory');
                return moves;
            }

            return moves.map(move => {
                if (move.globalIndex === currentMove.globalIndex) {
                    return {
                        ...move,
                        next: newMove
                    };
                }

                if (move.variations && move.variations.length > 0) {
                    return {
                        ...move,
                        variations: move.variations.map((variation: any) => {
                            const containsCurrentMove = variation.some((varMove: any) =>
                                varMove.globalIndex === currentMove.globalIndex
                            );

                            if (containsCurrentMove) {
                                return [...variation, newMove];
                            }

                            return updateInHistory(variation);
                        })
                    };
                }

                return move;
            });
        }

        return updateInHistory(history);
    }

    /**
     * Обновляет ссылку next предыдущего хода на новый ход
     */
    function updatePreviousMoveNext(
        history: any[],
        currentMove: any | null,
        newMove: any
    ): any[] {
        if (!currentMove) return history;

        function updateInHistory(moves: any[]): any[] {
            if (!currentMove) {
                console.warn('addMoveToHistory: currentMove is null in updatePreviousMoveNext');
                return moves;
            }

            return moves.map(move => {
                if (move.globalIndex === currentMove.globalIndex) {
                    return {
                        ...move,
                        next: newMove
                    };
                }

                if (move.variations && move.variations.length > 0) {
                    return {
                        ...move,
                        variations: move.variations.map((variation: any) => updateInHistory(variation))
                    };
                }

                return move;
            });
        }

        return updateInHistory(history);
    }

    const newHistory = addMoveToCorrectLocation(history, currentMove, newMove);
    const updatedHistory = updatePreviousMoveNext(newHistory, currentMove, newMove);

    // Связываем все ходы рекурсивно после добавления нового хода
    linkAllMovesRecursively(updatedHistory);

    return {
        updatedCurrentMove: newMove,
        updatedHistory: updatedHistory
    };
}