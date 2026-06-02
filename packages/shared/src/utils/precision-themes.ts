/**
 * KS-3359 / ADR-080 §2.3, §7-S1. Whitelist precision-релевантных тем
 * и группировка для UI bottom-sheet'а.
 *
 * Whitelist отбирает ~53 темы из `PuzzleTheme` enum, исключая
 * lichess-метаданные (`long`, `short`, `oneMove`, `veryLong`,
 * `master`, `masterVsMaster`, `superGM`) — эти атрибуты не описывают
 * содержание задачи и не релевантны фильтру.
 *
 * Группы (6 секций UI) покрывают всё whitelist'е без пересечений:
 * каждая тема ровно в одной группе.
 */
import type { PuzzleTheme } from '../types/puzzle.js';

export type PrecisionThemeGroupKey =
  | 'tactics'
  | 'mates'
  | 'endgame'
  | 'phase'
  | 'advantage'
  | 'misc';

/**
 * Темы тактических мотивов — основной фильтр в UI. 15 элементов.
 */
const TACTICS_THEMES: PuzzleTheme[] = [
  'pin',
  'fork',
  'skewer',
  'discoveredAttack',
  'doubleCheck',
  'sacrifice',
  'deflection',
  'attraction',
  'clearance',
  'interference',
  'intermezzo',
  'xRayAttack',
  'hangingPiece',
  'capturingDefender',
  'trappedPiece',
];

/**
 * Темы матовых конструкций. 14 элементов.
 * ADR-080 упоминал `anastasiaMate` — в `PuzzleTheme` enum он
 * сохранён под именем `anapierce` (lichess-data legacy). Используем
 * имя из enum.
 */
const MATES_THEMES: PuzzleTheme[] = [
  'mate',
  'mateIn1',
  'mateIn2',
  'mateIn3',
  'mateIn4',
  'mateIn5',
  'backRankMate',
  'smotheredMate',
  'arabianMate',
  'anapierce',
  'bodenMate',
  'dovetailMate',
  'hookMate',
  'doubleBishopMate',
];

/**
 * Темы эндшпиля. 11 элементов.
 * ADR-080 упоминал `opposite-colors-bishops` — в `PuzzleTheme` enum
 * такого нет, пропускаем.
 *
 * KS-3574 / ADR-094 §8.11: добавлен `mixedEndgame` — для эндшпилей со
 * смесью тяжёлых/лёгких фигур (R+N, B+N, Q+R+B и т.п.), которые не
 * попадают ни в один из чистых подвидов. По audit'у KS-3569 этот класс
 * составлял 69.7% всех generated-эндшпилей; раньше получал только
 * зонтичный `endgame`, теперь дополнительно — `mixedEndgame`.
 */
const ENDGAME_THEMES: PuzzleTheme[] = [
  'endgame',
  'pawnEndgame',
  'rookEndgame',
  'queenEndgame',
  'knightEndgame',
  'bishopEndgame',
  'queenRookEndgame',
  'mixedEndgame',
  'promotion',
  'underPromotion',
  'advancedPawn',
];

/**
 * Фазы партии. 2 элемента.
 */
const PHASE_THEMES: PuzzleTheme[] = ['opening', 'middlegame'];

/**
 * Превосходство — overlap с `objective` через chips-bar, но также
 * имеет отдельную семантику theme. 3 элемента.
 */
const ADVANTAGE_THEMES: PuzzleTheme[] = ['advantage', 'crushing', 'equality'];

/**
 * Прочие важные темы. 9 элементов.
 */
const MISC_THEMES: PuzzleTheme[] = [
  'zugzwang',
  'kingsideAttack',
  'queensideAttack',
  'attackingF2F7',
  'exposedKing',
  'defensiveMove',
  'quietMove',
  'enPassant',
  'castling',
];

/**
 * KS-3359 / ADR-080. Группировка тем для UI bottom-sheet'а.
 * Каждая тема ровно в одной группе. Union всех групп =
 * `PRECISION_RELEVANT_THEMES`.
 */
export const PRECISION_THEME_GROUPS: Record<
  PrecisionThemeGroupKey,
  readonly PuzzleTheme[]
> = {
  tactics: TACTICS_THEMES,
  mates: MATES_THEMES,
  endgame: ENDGAME_THEMES,
  phase: PHASE_THEMES,
  advantage: ADVANTAGE_THEMES,
  misc: MISC_THEMES,
};

/**
 * KS-3359 / ADR-080 §2.3. Whitelist precision-релевантных тем.
 * Backend валидирует входящие `themesAnd[]`/`themesOr[]` против
 * этого массива (защита от инъекций в LIKE). Темы из БД, не
 * входящие в whitelist (`master`, `oneMove`, ...) не показываются
 * UI, но если задача имеет такой тег рядом с релевантным — фильтр
 * по релевантному корректно её найдёт.
 *
 * 54 элемента: tactics(15) + mates(14) + endgame(11) + phase(2) +
 * advantage(3) + misc(9). KS-3574 расширил endgame на mixedEndgame.
 */
export const PRECISION_RELEVANT_THEMES: readonly PuzzleTheme[] = [
  ...TACTICS_THEMES,
  ...MATES_THEMES,
  ...ENDGAME_THEMES,
  ...PHASE_THEMES,
  ...ADVANTAGE_THEMES,
  ...MISC_THEMES,
];

/**
 * KS-3359. Type guard: тема входит в whitelist.
 * Используется backend'ом для валидации query-параметров.
 */
export function isPrecisionRelevantTheme(
  theme: string,
): theme is PuzzleTheme {
  return (PRECISION_RELEVANT_THEMES as readonly string[]).includes(theme);
}
