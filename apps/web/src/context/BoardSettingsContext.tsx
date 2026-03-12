import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from 'react';

export type BoardThemeId = 'default' | 'green' | 'blue' | 'brown';
export type PieceSetId = 'standard' | 'cburnett' | 'alpha' | 'merida';
export type InputMode = 'drag' | 'click';

export interface BoardTheme {
  id: BoardThemeId;
  label: string;
  light: string;
  dark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: 'default', label: 'Classic', light: '#f0d9b5', dark: '#b58863' },
  { id: 'green',   label: 'Green',   light: '#ffffdd', dark: '#86a666' },
  { id: 'blue',    label: 'Blue',    light: '#dde6ef', dark: '#4b7399' },
  { id: 'brown',   label: 'Brown',   light: '#d4b896', dark: '#6b3a2a' },
];

export interface PieceSet {
  id: PieceSetId;
  label: string;
}

export const PIECE_SETS: PieceSet[] = [
  { id: 'standard', label: 'Standard' },
  { id: 'cburnett', label: 'Cburnett' },
  { id: 'alpha',    label: 'Alpha' },
  { id: 'merida',   label: 'Merida' },
];

const LS_THEME_KEY = 'boardTheme';
const LS_PIECE_SET_KEY = 'pieceSet';
const LS_NOTATION_KEY = 'showNotation';
const LS_INPUT_MODE_KEY = 'inputMode';

function readTheme(): BoardThemeId {
  const stored = localStorage.getItem(LS_THEME_KEY) as BoardThemeId | null;
  if (stored && BOARD_THEMES.some((t) => t.id === stored)) return stored;
  return 'default';
}

function readPieceSet(): PieceSetId {
  const stored = localStorage.getItem(LS_PIECE_SET_KEY) as PieceSetId | null;
  if (stored && PIECE_SETS.some((s) => s.id === stored)) return stored;
  return 'standard';
}

function readShowNotation(): boolean {
  const stored = localStorage.getItem(LS_NOTATION_KEY);
  if (stored === null) return true;
  return stored === 'true';
}

function detectDefaultInputMode(): InputMode {
  if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) {
    return 'click';
  }
  return 'drag';
}

function readInputMode(): InputMode {
  const stored = localStorage.getItem(LS_INPUT_MODE_KEY) as InputMode | null;
  if (stored === 'drag' || stored === 'click') return stored;
  return detectDefaultInputMode();
}

type PieceRenderer = (props?: {
  fill?: string;
  square?: string;
  svgStyle?: React.CSSProperties;
}) => React.JSX.Element;

type CustomPieces = Record<string, PieceRenderer>;

function buildCustomPieces(pieceSet: PieceSetId): CustomPieces | undefined {
  if (pieceSet === 'standard') return undefined;

  const pieces = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];

  const result: CustomPieces = {};
  for (const piece of pieces) {
    const src = `/pieces/${pieceSet}/${piece}.svg`;
    result[piece] = ({ svgStyle } = {}) => (
      <img
        src={src}
        alt={piece}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          ...(svgStyle ?? {}),
        }}
      />
    ) as React.JSX.Element;
  }
  return result;
}

interface BoardSettingsContextValue {
  boardTheme: BoardThemeId;
  pieceSet: PieceSetId;
  showNotation: boolean;
  inputMode: InputMode;
  selectTheme: (id: BoardThemeId) => void;
  selectPieceSet: (id: PieceSetId) => void;
  setShowNotation: (value: boolean) => void;
  setInputMode: (mode: InputMode) => void;
  currentTheme: BoardTheme;
  customPieces: CustomPieces | undefined;
  darkSquareStyle: React.CSSProperties;
  lightSquareStyle: React.CSSProperties;
}

export const BoardSettingsContext = createContext<BoardSettingsContextValue | null>(null);

export function BoardSettingsProvider({ children }: { children: ReactNode }) {
  const [boardTheme, setBoardTheme] = useState<BoardThemeId>(readTheme);
  const [pieceSet, setPieceSet] = useState<PieceSetId>(readPieceSet);
  const [showNotation, setShowNotationState] = useState<boolean>(readShowNotation);
  const [inputMode, setInputModeState] = useState<InputMode>(readInputMode);

  useEffect(() => {
    document.body.setAttribute('data-board-theme', boardTheme);
  }, [boardTheme]);

  const selectTheme = useCallback((id: BoardThemeId) => {
    localStorage.setItem(LS_THEME_KEY, id);
    setBoardTheme(id);
  }, []);

  const selectPieceSet = useCallback((id: PieceSetId) => {
    localStorage.setItem(LS_PIECE_SET_KEY, id);
    setPieceSet(id);
  }, []);

  const setShowNotation = useCallback((value: boolean) => {
    localStorage.setItem(LS_NOTATION_KEY, String(value));
    setShowNotationState(value);
  }, []);

  const setInputMode = useCallback((mode: InputMode) => {
    localStorage.setItem(LS_INPUT_MODE_KEY, mode);
    setInputModeState(mode);
  }, []);

  const currentTheme = useMemo(
    () => BOARD_THEMES.find((t) => t.id === boardTheme) ?? BOARD_THEMES[0],
    [boardTheme],
  );

  const darkSquareStyle = useMemo<React.CSSProperties>(
    () => ({ backgroundColor: currentTheme.dark }),
    [currentTheme],
  );

  const lightSquareStyle = useMemo<React.CSSProperties>(
    () => ({ backgroundColor: currentTheme.light }),
    [currentTheme],
  );

  const customPieces = useMemo(
    () => buildCustomPieces(pieceSet),
    [pieceSet],
  );

  const value = useMemo<BoardSettingsContextValue>(
    () => ({
      boardTheme,
      pieceSet,
      showNotation,
      inputMode,
      selectTheme,
      selectPieceSet,
      setShowNotation,
      setInputMode,
      currentTheme,
      customPieces,
      darkSquareStyle,
      lightSquareStyle,
    }),
    [
      boardTheme,
      pieceSet,
      showNotation,
      inputMode,
      selectTheme,
      selectPieceSet,
      setShowNotation,
      setInputMode,
      currentTheme,
      customPieces,
      darkSquareStyle,
      lightSquareStyle,
    ],
  );

  return (
    <BoardSettingsContext.Provider value={value}>
      {children}
    </BoardSettingsContext.Provider>
  );
}

export function useBoardSettingsContext(): BoardSettingsContextValue {
  const ctx = useContext(BoardSettingsContext);
  if (!ctx) {
    throw new Error('useBoardSettingsContext must be used within BoardSettingsProvider');
  }
  return ctx;
}
