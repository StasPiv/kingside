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
/**
 * KS-3320: расширенный список piece-sets из lichess-org/lila/public/piece.
 * Только permissive лицензии (Apache 2.0 / MIT / CC0 / CC BY 4.0 / CC BY-SA 4.0).
 *
 * НЕ ВКЛЮЧЕНЫ:
 * - GPL/AGPL (вирусная copyleft, спред на наш не-AGPL фронт):
 *   cburnett, merida, mono, pirouetti, letter, pixel, mpchess.
 * - CC BY-NC-SA (Non-Commercial, конфликт с Patron/premium):
 *   horsey, california, caliente, maestro, fresca, cardinal, icpieces,
 *   gioco, tatiana, staunty, dubrovny, anarcandy, disguised, cooke,
 *   monarchy, xkcd.
 * - freeware/non-derivative/undefined:
 *   alpha, chess7, companion, leipzig, shahi-ivory-brown, reillycraig,
 *   riohacha.
 *
 * Источник классификации:
 *   https://github.com/lichess-org/lila/blob/master/COPYING.md
 *   («Exceptions (free)» / «Exceptions (non-free)» секции).
 *
 * `cburnett` и `merida` исторически были в коде до KS-3320 (под GPL).
 * Удалены вместе с поддержкой в `PIECE_SETS`. `alpha` — non-commercial.
 */
export type PieceSetId =
  | 'standard'
  | 'chessnut'
  | 'fantasy'
  | 'spatial'
  | 'celtic'
  | 'shapes'
  | 'kiwen-suwi'
  | 'firi'
  | 'totoy'
  | 'rhosgfx';
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
 * KS-3415: скорость авто-повтора задаётся ползунком в МИЛЛИСЕКУНДАХ
 * (интервал между «тиками» при удержании стрелки), без субъективных
 * ярлыков. Меньше мс = быстрее. Диапазон покрывает прежние пресеты
 * (fast 75 / medium 150 / slow 250) с запасом: 50..500 мс, шаг 25.
 */
export const NAV_AUTO_REPEAT_MS_MIN = 50;
export const NAV_AUTO_REPEAT_MS_MAX = 500;
export const NAV_AUTO_REPEAT_MS_STEP = 25;
export const NAV_AUTO_REPEAT_MS_DEFAULT = 150;

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
  /**
   * Английский дефолт-лейбл. Используется как fallback и в местах без
   * i18n (CreditsPage и т. п.).
   */
  label: string;
  /**
   * KS-4568: i18n-ключ для перевода подписи темы доски. Потребители
   * рендерят `t(theme.labelKey, theme.label)` — если ключ отсутствует
   * в локали, остаётся английский фолбэк.
   */
  labelKey?: string;
  light: string;
  dark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: 'default', label: 'Classic', labelKey: 'settings.board.themes.classic', light: '#f0d9b5', dark: '#b58863' },
  { id: 'green',   label: 'Green',   labelKey: 'settings.board.themes.green',   light: '#ffffdd', dark: '#86a666' },
  { id: 'blue',    label: 'Blue',    labelKey: 'settings.board.themes.blue',    light: '#dde6ef', dark: '#4b7399' },
  { id: 'brown',   label: 'Brown',   labelKey: 'settings.board.themes.brown',   light: '#d4b896', dark: '#6b3a2a' },
];

/**
 * KS-3320. Лицензия piece-set. Используется в credits-странице и
 * для предупреждения пользователю при выборе сета.
 */
export interface PieceSetLicense {
  /** Spdx-like идентификатор: 'apache-2.0' | 'mit' | 'cc0-1.0' | 'cc-by-4.0' | 'cc-by-sa-4.0'. */
  spdx: 'apache-2.0' | 'mit' | 'cc0-1.0' | 'cc-by-4.0' | 'cc-by-sa-4.0';
  /** Человекочитаемое имя. */
  name: string;
  /** Canonical URL текста лицензии. */
  url: string;
  /** Автор / автор(ы) — для атрибуции (CC-BY*) или признания (MIT/Apache). */
  author: string;
  /** Ссылка на профиль автора (при наличии). */
  authorUrl?: string;
}

export interface PieceSet {
  id: PieceSetId;
  /**
   * Английский дефолт-лейбл. Для именованных наборов (Chessnut,
   * Fantasy, ...) это собственное имя автора, переводить нельзя.
   * Для `standard` — переводимое слово «Standard» (см. labelKey ниже).
   */
  label: string;
  /**
   * KS-4568: i18n-ключ для перевода подписи. Указан только у наборов
   * с переводимой подписью (на момент тикета — только `standard`).
   * Остальные наборы — авторские имена; потребители используют
   * `t(set.labelKey ?? '', set.label)` — если ключа нет, остаётся
   * `set.label` как есть.
   */
  labelKey?: string;
  /** KS-3320: лицензия и автор. Для 'standard' — null (внутренняя тема). */
  license: PieceSetLicense | null;
}

export const PIECE_SETS: PieceSet[] = [
  { id: 'standard', label: 'Standard', labelKey: 'settings.board.pieceSets.standard', license: null },
  {
    id: 'chessnut',
    label: 'Chessnut',
    license: {
      spdx: 'apache-2.0',
      name: 'Apache 2.0',
      url: 'https://www.apache.org/licenses/LICENSE-2.0',
      author: 'Alexis Luengas',
      authorUrl: 'https://github.com/LexLuengas',
    },
  },
  {
    id: 'fantasy',
    label: 'Fantasy',
    license: {
      spdx: 'mit',
      name: 'MIT',
      url: 'https://opensource.org/license/mit',
      author: 'Maurizio Monge',
      authorUrl: 'https://github.com/maurimo/chess-art',
    },
  },
  {
    id: 'spatial',
    label: 'Spatial',
    license: {
      spdx: 'mit',
      name: 'MIT',
      url: 'https://opensource.org/license/mit',
      author: 'Maurizio Monge',
      authorUrl: 'https://github.com/maurimo/chess-art',
    },
  },
  {
    id: 'celtic',
    label: 'Celtic',
    license: {
      spdx: 'mit',
      name: 'MIT',
      url: 'https://opensource.org/license/mit',
      author: 'Maurizio Monge',
      authorUrl: 'https://github.com/maurimo/chess-art',
    },
  },
  {
    id: 'shapes',
    label: 'Shapes',
    license: {
      spdx: 'cc-by-sa-4.0',
      name: 'CC BY-SA 4.0',
      url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      author: 'flugsio',
      authorUrl: 'https://github.com/flugsio/chess_shapes',
    },
  },
  {
    id: 'kiwen-suwi',
    label: 'Kiwen Suwi',
    license: {
      spdx: 'cc-by-4.0',
      name: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      author: 'neverRare',
      authorUrl: 'https://github.com/neverRare',
    },
  },
  {
    id: 'firi',
    label: 'Firi',
    license: {
      spdx: 'cc-by-4.0',
      name: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      author: 'James Faure',
      authorUrl: 'https://github.com/jfaure/Firi-pieceset',
    },
  },
  {
    id: 'totoy',
    label: 'Totoy',
    license: {
      spdx: 'cc-by-4.0',
      name: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      author: 'Kosal Sen',
    },
  },
  {
    id: 'rhosgfx',
    label: 'RhosGFX',
    license: {
      spdx: 'cc0-1.0',
      name: 'CC0 1.0 (Public Domain)',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      author: 'RhosGFX',
      authorUrl: 'https://rhosgfx.itch.io/',
    },
  },
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
  // KS-4155: дефолт — `standard` (встроенный набор react-chessboard,
  // классический стаунтон). Пользователи жаловались, что chessnut
  // (KS-3320) выглядит непривычно по сравнению с привычным стаунтоном.
  // Лицензионные соображения KS-3320 остаются в силе для тех, кто
  // выберет `chessnut` явно через настройки. Дефолт меняется только
  // для пользователей без сохранённого выбора.
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

/** KS-3415: клемп мс к диапазону [MIN, MAX] (без привязки к шагу — шаг
 *  только для UI-слайдера; вручную сохранённые значения принимаем как есть). */
function clampNavAutoRepeatMs(ms: number): number {
  return Math.max(
    NAV_AUTO_REPEAT_MS_MIN,
    Math.min(NAV_AUTO_REPEAT_MS_MAX, Math.round(ms)),
  );
}

/**
 * KS-3198 → KS-3415: чтение интервала авто-повтора в МС. Default 150.
 * Backward-compat: если в localStorage лежит старый preset-id
 * ('slow'|'medium'|'fast') — мапим в его intervalMs; если число — клемпим
 * к диапазону; иначе default. Тот же ключ `navAutoRepeatSpeed`.
 */
function readNavAutoRepeatMs(): number {
  try {
    const stored = localStorage.getItem(LS_NAV_AUTO_REPEAT_SPEED_KEY);
    if (stored != null) {
      // Legacy preset-id?
      const preset = NAV_AUTO_REPEAT_SPEEDS.find((s) => s.id === stored);
      if (preset) return preset.intervalMs;
      // Число (мс)?
      const n = Number(stored);
      if (Number.isFinite(n) && n > 0) return clampNavAutoRepeatMs(n);
    }
  } catch {
    /* ignore */
  }
  return NAV_AUTO_REPEAT_MS_DEFAULT;
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
  /** KS-3415: интервал (мс) long-press авто-повтора навигации по ходам. */
  navAutoRepeatMs: number;
  selectTheme: (id: BoardThemeId) => void;
  selectPieceSet: (id: PieceSetId) => void;
  setShowNotation: (value: boolean) => void;
  setInputMode: (mode: InputMode) => void;
  setBoardSize: (size: BoardSizeId) => void;
  setSidebarFontSize: (size: SidebarFontSizeId) => void;
  setAutoPromoteToQueen: (value: boolean) => void;
  setNavAutoRepeatMs: (ms: number) => void;
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
  const [navAutoRepeatMs, setNavAutoRepeatMsState] =
    useState<number>(readNavAutoRepeatMs);

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
   * KS-3415: setter интервала авто-повтора (мс) с persist в localStorage
   * (тот же ключ). Клемпим к [MIN, MAX]. Падение setItem (Safari Private
   * Mode, переполненный storage) не блокирует обновление state.
   */
  const setNavAutoRepeatMs = useCallback((ms: number) => {
    const clamped = clampNavAutoRepeatMs(ms);
    try {
      localStorage.setItem(LS_NAV_AUTO_REPEAT_SPEED_KEY, String(clamped));
    } catch {
      /* ignore */
    }
    setNavAutoRepeatMsState(clamped);
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
      navAutoRepeatMs,
      selectTheme,
      selectPieceSet,
      setShowNotation,
      setInputMode,
      setBoardSize,
      setSidebarFontSize,
      setAutoPromoteToQueen,
      setNavAutoRepeatMs,
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
      navAutoRepeatMs,
      selectTheme,
      selectPieceSet,
      setShowNotation,
      setInputMode,
      setBoardSize,
      setSidebarFontSize,
      setAutoPromoteToQueen,
      setNavAutoRepeatMs,
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
