/**
 * KS-4918. Человекочитаемые названия тем пазлов для текстов занятий
 * (заголовок урока, шаблоны, уведомления). Значения скопированы из
 * словаря фронта (apps/web i18n puzzleBrowser.themes) — единый язык UI.
 * Темы вне словаря (редкие внутренние ключи банка) — humanize:
 * camelCase → раздельные слова.
 */

const THEME_LABELS: Record<'ru' | 'en', Record<string, string>> = {
  ru: {
    advancedPawn: 'Проходная пешка',
    advantage: 'Преимущество',
    anapierce: 'Ана Пирс',
    arabianMate: 'Арабский мат',
    attackingF2F7: 'Атака f2/f7',
    attraction: 'Завлечение',
    backRankMate: 'Мат на последней горизонтали',
    bishopEndgame: 'Слоновый эндшпиль',
    bodenMate: 'Мат Бодена',
    capturingDefender: 'Уничтожение защитника',
    castling: 'Рокировка',
    clearance: 'Освобождение поля',
    convertAdvantage: 'Реализуй перевес',
    crushing: 'Разгром',
    defensiveMove: 'Защитный ход',
    deflection: 'Отвлечение',
    discoveredAttack: 'Вскрытая атака',
    doubleBishopMate: 'Мат двумя слонами',
    doubleCheck: 'Двойной шах',
    dovetailMate: 'Мат Костыля',
    enPassant: 'Взятие на проходе',
    endgame: 'Эндшпиль',
    equality: 'Уравнение',
    exposedKing: 'Открытый король',
    fork: 'Вилка',
    hangingPiece: 'Висящая фигура',
    hookMate: 'Мат крючком',
    interference: 'Перекрытие',
    intermezzo: 'Промежуточный ход',
    kingsideAttack: 'Атака на королевском фланге',
    knightEndgame: 'Коневой эндшпиль',
    long: 'Длинная',
    master: 'Мастер',
    masterVsMaster: 'Мастер против мастера',
    mate: 'Мат',
    mateIn1: 'Мат в 1 ход',
    mateIn2: 'Мат в 2 хода',
    mateIn3: 'Мат в 3 хода',
    mateIn4: 'Мат в 4 хода',
    mateIn5: 'Мат в 5 ходов',
    middlegame: 'Миттельшпиль',
    mixedEndgame: 'Смешанный эндшпиль',
    oneMove: 'Один ход',
    opening: 'Дебют',
    pawnEndgame: 'Пешечный эндшпиль',
    pin: 'Связка',
    playVsEngine: 'Против движка',
    promotion: 'Превращение',
    queenEndgame: 'Ферзевый эндшпиль',
    queenRookEndgame: 'Ферзево-ладейный эндшпиль',
    queensideAttack: 'Атака на ферзевом фланге',
    quietMove: 'Тихий ход',
    rookEndgame: 'Ладейный эндшпиль',
    sacrifice: 'Жертва',
    saveEquality: 'Спасение в ничью',
    short: 'Короткая',
    skewer: 'Линейный удар',
    smotheredMate: 'Спёртый мат',
    superGM: 'Супер ГМ',
    trappedPiece: 'Ловля фигуры',
    underPromotion: 'Превращение в лёгкую фигуру',
    veryLong: 'Очень длинная',
    xRayAttack: 'Рентген',
    zugzwang: 'Цугцванг',
  },
  en: {
    advancedPawn: 'Advanced Pawn',
    advantage: 'Advantage',
    anapierce: 'Ana Pierce',
    arabianMate: 'Arabian Mate',
    attackingF2F7: 'Attacking f2/f7',
    attraction: 'Attraction',
    backRankMate: 'Back Rank Mate',
    bishopEndgame: 'Bishop Endgame',
    bodenMate: 'Boden\'s Mate',
    capturingDefender: 'Capturing Defender',
    castling: 'Castling',
    clearance: 'Clearance',
    convertAdvantage: 'Convert the advantage',
    crushing: 'Crushing',
    defensiveMove: 'Defensive Move',
    deflection: 'Deflection',
    discoveredAttack: 'Discovered Attack',
    doubleBishopMate: 'Double Bishop Mate',
    doubleCheck: 'Double Check',
    dovetailMate: 'Dovetail Mate',
    enPassant: 'En Passant',
    endgame: 'Endgame',
    equality: 'Equality',
    exposedKing: 'Exposed King',
    fork: 'Fork',
    hangingPiece: 'Hanging Piece',
    hookMate: 'Hook Mate',
    interference: 'Interference',
    intermezzo: 'Intermezzo',
    kingsideAttack: 'Kingside Attack',
    knightEndgame: 'Knight Endgame',
    long: 'Long',
    master: 'Master',
    masterVsMaster: 'Master vs Master',
    mate: 'Checkmate',
    mateIn1: 'Mate in 1',
    mateIn2: 'Mate in 2',
    mateIn3: 'Mate in 3',
    mateIn4: 'Mate in 4',
    mateIn5: 'Mate in 5',
    middlegame: 'Middlegame',
    mixedEndgame: 'Mixed endgame',
    oneMove: 'One Move',
    opening: 'Opening',
    pawnEndgame: 'Pawn Endgame',
    pin: 'Pin',
    playVsEngine: 'Play vs Engine',
    promotion: 'Promotion',
    queenEndgame: 'Queen Endgame',
    queenRookEndgame: 'Queen & Rook Endgame',
    queensideAttack: 'Queenside Attack',
    quietMove: 'Quiet Move',
    rookEndgame: 'Rook Endgame',
    sacrifice: 'Sacrifice',
    saveEquality: 'Save the draw',
    short: 'Short',
    skewer: 'Skewer',
    smotheredMate: 'Smothered Mate',
    superGM: 'Super GM',
    trappedPiece: 'Trapped Piece',
    underPromotion: 'Under Promotion',
    veryLong: 'Very Long',
    xRayAttack: 'X-Ray Attack',
    zugzwang: 'Zugzwang',
  },
};

/**
 * KS-4922. Служебные токены генератора задач (tactic-worker пишет их в
 * колонку `themes` вместе с настоящими темами): режим решения и фаза
 * пазла. Это НЕ темы — им нельзя становиться слабой темой профиля или
 * темой занятия (у Stanislav 'reactive' стал темой урока: сырой ключ в
 * названии и пустой puzzle-шаг — задач с таким «токеном» в окне нет).
 */
export const SERVICE_THEME_TOKENS: ReadonlySet<string> = new Set([
  'playVsEngine',
  'reactive',
  'preventive',
]);

/** Название темы на языке пользователя; вне словаря — humanize ключа. */
export function puzzleThemeLabel(theme: string, lang: string): string {
  const l = lang === 'ru' ? 'ru' : 'en';
  const known = THEME_LABELS[l][theme] ?? THEME_LABELS.en[theme];
  if (known) return known;
  // camelCase / snake_case → «Sentence case».
  const words = theme
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
