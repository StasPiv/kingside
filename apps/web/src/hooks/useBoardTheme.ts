import { useState, useCallback, useMemo } from 'react';
import type React from 'react';

export type BoardThemeId = 'classic' | 'green' | 'blue' | 'dark';
export type PieceSetId = 'standard';

export interface BoardTheme {
  id: BoardThemeId;
  label: string;
  darkSquare: string;
  lightSquare: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: 'classic', label: 'Classic', darkSquare: '#b58863', lightSquare: '#f0d9b5' },
  { id: 'green', label: 'Green', darkSquare: '#4d7c4d', lightSquare: '#ffffdd' },
  { id: 'blue', label: 'Blue', darkSquare: '#4b7399', lightSquare: '#dde6ef' },
  { id: 'dark', label: 'Dark', darkSquare: '#4a4a4a', lightSquare: '#8a8a8a' },
];

const LS_THEME_KEY = 'boardTheme';
const LS_PIECE_SET_KEY = 'pieceSet';

function readTheme(): BoardThemeId {
  const stored = localStorage.getItem(LS_THEME_KEY) as BoardThemeId | null;
  if (stored && BOARD_THEMES.some((t) => t.id === stored)) return stored;
  return 'classic';
}

function readPieceSet(): PieceSetId {
  const stored = localStorage.getItem(LS_PIECE_SET_KEY) as PieceSetId | null;
  if (stored === 'standard') return stored;
  return 'standard';
}

export interface BoardThemeOptions {
  darkSquareStyle: React.CSSProperties;
  lightSquareStyle: React.CSSProperties;
}

export function useBoardTheme() {
  const [themeId, setThemeId] = useState<BoardThemeId>(readTheme);
  const [pieceSet, setPieceSet] = useState<PieceSetId>(readPieceSet);

  const selectTheme = useCallback((id: BoardThemeId) => {
    setThemeId(id);
    localStorage.setItem(LS_THEME_KEY, id);
  }, []);

  const selectPieceSet = useCallback((id: PieceSetId) => {
    setPieceSet(id);
    localStorage.setItem(LS_PIECE_SET_KEY, id);
  }, []);

  const theme = useMemo(
    () => BOARD_THEMES.find((t) => t.id === themeId) ?? BOARD_THEMES[0],
    [themeId],
  );

  const boardThemeOptions = useMemo<BoardThemeOptions>(
    () => ({
      darkSquareStyle: { backgroundColor: theme.darkSquare },
      lightSquareStyle: { backgroundColor: theme.lightSquare },
    }),
    [theme],
  );

  return { themeId, pieceSet, selectTheme, selectPieceSet, boardThemeOptions, theme };
}
