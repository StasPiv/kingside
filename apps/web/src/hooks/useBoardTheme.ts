import { useMemo } from 'react';
import { useBoardSettingsContext } from '../context/BoardSettingsContext';
import type React from 'react';

export interface BoardThemeOptions {
  darkSquareStyle: React.CSSProperties;
  lightSquareStyle: React.CSSProperties;
}

/**
 * Thin adapter over BoardSettingsContext for backward compat.
 * Use useBoardSettings (from context) for new code.
 */
export function useBoardTheme() {
  const { boardTheme, pieceSet, selectTheme, selectPieceSet, currentTheme, customPieces, darkSquareStyle, lightSquareStyle } =
    useBoardSettingsContext();

  const boardThemeOptions = useMemo<BoardThemeOptions>(
    () => ({ darkSquareStyle, lightSquareStyle }),
    [darkSquareStyle, lightSquareStyle],
  );

  return {
    themeId: boardTheme,
    pieceSet,
    selectTheme,
    selectPieceSet,
    boardThemeOptions,
    theme: currentTheme,
    customPieces,
  };
}
