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
/**
 * KS-2114: размер доски на странице анализа.
 * Применяется через CSS-переменную `--analysis-board-size-scale` на body
 * (атрибут `data-board-size`), которая умножается на текущий max-width
 * `.analysis-page .board-container`. Сохраняется в localStorage.
 */
export type BoardSizeId = 'sm' | 'md' | 'lg';

/**
 * KS-3198: скорость авто-повтора при long-press на кнопках навигации
 * по ходам (`←` / `→` / `⇤` / `⇥`). Значение — это `tickInterval` в мс.
 * `slow`/`medium`/`fast` сохраняется в localStorage; в `useLongPress`
 * передаётся как число.
 */
export type NavAutoRepeatSpeedId = 'slow' | 'medium' | 'fast';

export interface NavAutoRepeatSpeedPreset {
  id: NavAutoRepeatSpeedId;
  /** Короткая метка для select / button (S/M/F). */
  shortLabel: string;
  /** Полное название (Slow / Medium / Fast). */
  label: string;
  /** Интервал tick'а в мс. */
  intervalMs: number;
}

/**
 * KS-3198: пресеты скорости. `medium` — дефолт, ≈7 ходов/сек.
 * `fast` — 75ms, ≈13 ходов/сек (для длинных партий); `slow` — 250ms,
 * 4 хода/сек (комфорт для обучения).
 */
export const NAV_AUTO_REPEAT_SPEEDS: NavAutoRepeatSpeedPreset[] = [
  { id: 'slow',   shortLabel: 'S', label: 'Slow',   intervalMs: 250 },
  { id: 'medium', shortLabel: 'M', label: 'Medium', intervalMs: 150 },
  { id: 'fast',   shortLabel: 'F', label: 'Fast',   intervalMs: 75 },
];

/**
 * KS-3099: размер шрифта правой панели анализа (Stockfish/нотация/
 * «База партий»). Аналогично `boardSize`: переключатель S/M/L пишет
 * `data-sidebar-font-size` на body, CSS-переменная
 * `--analysis-sidebar-font-scale` умножает базовые font-size.
 * Сохраняется в localStorage под ключом `analysisSidebarFontSize`.
 */
export type SidebarFontSizeId = 'sm' | 'md' | 'lg';

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

export interface BoardSizePreset {
  id: BoardSizeId;
  label: string;
  /** Множитель к max-width контейнера доски (см. CSS analysis.css). */
  scale: number;
}

export const BOARD_SIZES: BoardSizePreset[] = [
  { id: 'sm', label: 'S', scale: 0.78 },
  { id: 'md', label: 'M', scale: 0.92 },
  { id: 'lg', label: 'L', scale: 1.0 },
];

export interface SidebarFontSizePreset {
  id: SidebarFontSizeId;
  label: string;
  /** Множитель для font-size элементов внутри `.analysis-sidebar`. */
  scale: number;
}

/**
 * KS-3099: пресеты размера шрифта правой панели. Базовые размеры
 * (md = 1.0) — текущие 13–14px. lg чуть крупнее, sm — компактнее.
 */
export const SIDEBAR_FONT_SIZES: SidebarFontSizePreset[] = [
  { id: 'sm', label: 'S', scale: 0.85 },
  { id: 'md', label: 'M', scale: 1.0 },
  { id: 'lg', label: 'L', scale: 1.18 },
];

const LS_THEME_KEY = 'boardTheme';
const LS_PIECE_SET_KEY = 'pieceSet';
const LS_NOTATION_KEY = 'showNotation';
const LS_INPUT_MODE_KEY = 'inputMode';
const LS_BOARD_SIZE_KEY = 'analysisBoardSize';
const LS_SIDEBAR_FONT_SIZE_KEY = 'analysisSidebarFontSize';
/**
 * KS-2970: «Автопревращение пешки в ферзя». Действует ТОЛЬКО в режиме
 * игры (`/game/*`). При значении `true` промоушн-ход сразу применяется
 * с ферзём (UCI с суффиксом `q`), без модалки выбора фигуры. В анализе,
 * пазлах и студиях настройка игнорируется — модалка показывается всегда.
 * Default `false`.
 */
const LS_AUTO_PROMOTE_QUEEN_KEY = 'autoPromoteToQueen';
/**
 * KS-3198: скорость авто-повтора long-press на кнопках навигации.
 * Значения 'slow' | 'medium' | 'fast' (см. NAV_AUTO_REPEAT_SPEEDS).
 */
const LS_NAV_AUTO_REPEAT_SPEED_KEY = 'navAutoRepeatSpeed';

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

function readBoardSize(): BoardSizeId {
  try {
    const stored = localStorage.getItem(LS_BOARD_SIZE_KEY) as BoardSizeId | null;
    if (stored && BOARD_SIZES.some((s) => s.id === stored)) return stored;
  } catch {
    /* ignore */
  }
  return 'md';
}

function readSidebarFontSize(): SidebarFontSizeId {
  try {
    const stored = localStorage.getItem(
      LS_SIDEBAR_FONT_SIZE_KEY,
    ) as SidebarFontSizeId | null;
    if (stored && SIDEBAR_FONT_SIZES.some((s) => s.id === stored)) return stored;
  } catch {
    /* ignore */
  }
  return 'md';
}

/**
 * KS-2970: автопромоушн в ферзя в режиме игры. По умолчанию `false` —
 * сохраняем существующий UX (модалка выбора Q/R/B/N). Юзер включает
 * сознательно через настройки.
 */
function readAutoPromoteToQueen(): boolean {
  try {
    const stored = localStorage.getItem(LS_AUTO_PROMOTE_QUEEN_KEY);
    if (stored === null) return false;
    return stored === 'true';
  } catch {
    return false;
  }
}

/**
 * KS-3198: чтение navAutoRepeatSpeed. Default 'medium' (150ms).
 * Если в localStorage лежит мусор (например legacy-ключ из другой
 * сборки) — fallback на default, как и остальные read* функции.
 */
function readNavAutoRepeatSpeed(): NavAutoRepeatSpeedId {
  try {
    const stored = localStorage.getItem(
      LS_NAV_AUTO_REPEAT_SPEED_KEY,
    ) as NavAutoRepeatSpeedId | null;
    if (stored && NAV_AUTO_REPEAT_SPEEDS.some((s) => s.id === stored)) {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return 'medium';
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
  boardSize: BoardSizeId;
  /** KS-3099: размер шрифта правой панели анализа (S/M/L). */
  sidebarFontSize: SidebarFontSizeId;
  /** KS-2970: автопромоушн в ферзя в режиме игры. */
  autoPromoteToQueen: boolean;
  /** KS-3198: скорость long-press авто-повтора навигации по ходам. */
  navAutoRepeatSpeed: NavAutoRepeatSpeedId;
  selectTheme: (id: BoardThemeId) => void;
  selectPieceSet: (id: PieceSetId) => void;
  setShowNotation: (value: boolean) => void;
  setInputMode: (mode: InputMode) => void;
  setBoardSize: (size: BoardSizeId) => void;
  setSidebarFontSize: (size: SidebarFontSizeId) => void;
  setAutoPromoteToQueen: (value: boolean) => void;
  setNavAutoRepeatSpeed: (id: NavAutoRepeatSpeedId) => void;
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
  const [boardSize, setBoardSizeState] = useState<BoardSizeId>(readBoardSize);
  const [sidebarFontSize, setSidebarFontSizeState] = useState<SidebarFontSizeId>(
    readSidebarFontSize,
  );
  const [autoPromoteToQueen, setAutoPromoteToQueenState] = useState<boolean>(
    readAutoPromoteToQueen,
  );
  const [navAutoRepeatSpeed, setNavAutoRepeatSpeedState] =
    useState<NavAutoRepeatSpeedId>(readNavAutoRepeatSpeed);

  useEffect(() => {
    document.body.setAttribute('data-board-theme', boardTheme);
  }, [boardTheme]);

  // KS-2114: пробрасываем размер доски как data-атрибут body, чтобы CSS
  // в `analysis.css` мог через селектор `body[data-board-size="lg"]`
  // выставить нужный множитель `--analysis-board-size-scale`.
  useEffect(() => {
    document.body.setAttribute('data-board-size', boardSize);
  }, [boardSize]);

  // KS-3099 v2: data-атрибут на body для шрифта правой панели.
  // CSS в `analysis.css` через `body[data-sidebar-font-size="lg"]`
  // выставляет `--analysis-sidebar-font-scale`, который умножает
  // базовые font-size элементов sidebar'а.
  useEffect(() => {
    document.body.setAttribute('data-sidebar-font-size', sidebarFontSize);
  }, [sidebarFontSize]);

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

  const setBoardSize = useCallback((size: BoardSizeId) => {
    try {
      localStorage.setItem(LS_BOARD_SIZE_KEY, size);
    } catch {
      /* ignore */
    }
    setBoardSizeState(size);
  }, []);

  const setSidebarFontSize = useCallback((size: SidebarFontSizeId) => {
    try {
      localStorage.setItem(LS_SIDEBAR_FONT_SIZE_KEY, size);
    } catch {
      /* ignore */
    }
    setSidebarFontSizeState(size);
  }, []);

  /**
   * KS-2970: сохраняем в localStorage. Setter всегда пишет (как
   * `setShowNotation` выше) — для предсказуемой UX-логики toggle'ов.
   */
  const setAutoPromoteToQueen = useCallback((value: boolean) => {
    try {
      localStorage.setItem(LS_AUTO_PROMOTE_QUEEN_KEY, String(value));
    } catch {
      /* ignore */
    }
    setAutoPromoteToQueenState(value);
  }, []);

  /**
   * KS-3198: setter навAutoRepeatSpeed с persist в localStorage.
   * Падение setItem (Safari Private Mode, переполненный storage) не
   * блокирует обновление state — UI всё равно меняется.
   */
  const setNavAutoRepeatSpeed = useCallback((id: NavAutoRepeatSpeedId) => {
    try {
      localStorage.setItem(LS_NAV_AUTO_REPEAT_SPEED_KEY, id);
    } catch {
      /* ignore */
    }
    setNavAutoRepeatSpeedState(id);
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
      boardSize,
      sidebarFontSize,
      autoPromoteToQueen,
      navAutoRepeatSpeed,
      selectTheme,
      selectPieceSet,
      setShowNotation,
      setInputMode,
      setBoardSize,
      setSidebarFontSize,
      setAutoPromoteToQueen,
      setNavAutoRepeatSpeed,
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
      boardSize,
      sidebarFontSize,
      autoPromoteToQueen,
      navAutoRepeatSpeed,
      selectTheme,
      selectPieceSet,
      setShowNotation,
      setInputMode,
      setBoardSize,
      setSidebarFontSize,
      setAutoPromoteToQueen,
      setNavAutoRepeatSpeed,
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
