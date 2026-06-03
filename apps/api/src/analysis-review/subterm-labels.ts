/**
 * KS-3651 / ADR-107 rev 2 §6 (B1). Человекочитаемые описания
 * позиционных подкомпонент Stockfish 16 (см. ID-список в
 * `packages/shared/src/types/api-contracts.ts::PositionalSubtermId`).
 *
 * Используется в `ReviewCommentService` для подстановки в few-shot
 * пары и для нормализации `positional_subterms[]` в `FactsInput`
 * (отбрасывание неизвестных `id` с WARN).
 *
 * Покрытие: 51 идентификатор, синхронизировано с
 * `@kingside/shared.PositionalSubtermId`. При расширении списка ID
 * (новый Subterm в evaluate.cpp нашего форка SF, KS-3648) — обновить
 * `PositionalSubtermId` в shared и таблицу здесь синхронно.
 *
 * Фронт (KS-3650) применяет свой `VALID_IDS` — подмножество ~47 ID,
 * актуальные для категориального сигнала; чисто статистические
 * (`pawn_connected`, `minor_behind_pawn`, и т.п.) могут не приходить.
 * Бэк это терпит: лишние ключи `id` пропускаются с WARN, отсутствие
 * ключа в `positional_subterms[]` — нормально (просто пустой массив).
 */
import type { PositionalSubtermId } from '@kingside/shared';

export interface SubtermLabel {
  ru: string;
  en: string;
}

/**
 * Полная таблица человекочитаемых описаний (RU + EN). Каждое поле —
 * краткая фраза для подстановки в LLM-prompt («плохой слон», «конь
 * на форпосте», и т.д.).
 */
export const SUBTERM_LABELS: Record<PositionalSubtermId, SubtermLabel> = {
  // ─── Pawns (pawns.cpp::evaluate, 7) ─────────────────────────────
  pawn_doubled_early: {
    ru: 'рано сдвоенные пешки',
    en: 'pawns doubled early in the game',
  },
  pawn_connected: {
    ru: 'связанные пешки',
    en: 'connected pawns',
  },
  pawn_doubled: {
    ru: 'сдвоенные пешки',
    en: 'doubled pawns',
  },
  pawn_isolated: {
    ru: 'изолированная пешка',
    en: 'isolated pawn',
  },
  pawn_backward: {
    ru: 'отсталая пешка',
    en: 'backward pawn',
  },
  pawn_lever_double: {
    ru: 'сдвоенные пешки под двойным размером соперника',
    en: 'doubled pawns under multiple enemy levers',
  },
  pawn_blocked: {
    ru: 'заблокированная пешка на 5-6 ряду',
    en: 'blocked pawn on 5th/6th rank',
  },

  // ─── Shelter & storm (pawns.cpp::evaluate_shelter, 4) ───────────
  king_shelter_strength: {
    ru: 'прочность пешечного щита короля',
    en: "king's pawn shelter strength",
  },
  king_blocked_storm: {
    ru: 'заблокированная пешка-штурмовик противника',
    en: 'blocked enemy storm pawn',
  },
  king_unblocked_storm: {
    ru: 'открытая пешка-штурмовик противника',
    en: 'unblocked enemy storm pawn',
  },
  king_on_file: {
    ru: 'король на полу-открытой или открытой вертикали',
    en: 'king on (semi-)open file',
  },

  // ─── Pieces (evaluate.cpp::pieces, 17) ──────────────────────────
  rook_on_king_ring: {
    ru: 'ладья в зоне вокруг чужого короля',
    en: 'rook in the enemy king ring',
  },
  bishop_on_king_ring: {
    ru: 'слон в зоне вокруг чужого короля',
    en: 'bishop in the enemy king ring',
  },
  knight_uncontested_outpost: {
    ru: 'конь на неоспоримом форпосте',
    en: 'knight on an uncontested outpost',
  },
  outpost_knight: {
    ru: 'конь на форпосте',
    en: 'knight on an outpost',
  },
  outpost_bishop: {
    ru: 'слон на форпосте',
    en: 'bishop on an outpost',
  },
  knight_reachable_outpost: {
    ru: 'у коня есть достижимый форпост',
    en: 'knight has a reachable outpost',
  },
  minor_behind_pawn: {
    ru: 'лёгкая фигура спрятана за своей пешкой',
    en: 'minor piece sheltered behind own pawn',
  },
  knight_king_protector_distance: {
    ru: 'конь далеко от своего короля (штраф защитнику)',
    en: 'knight far from own king (protector penalty)',
  },
  bishop_king_protector_distance: {
    ru: 'слон далеко от своего короля (штраф защитнику)',
    en: 'bishop far from own king (protector penalty)',
  },
  bishop_pawns: {
    ru: 'плохой слон: много своих пешек на цвете слона',
    en: "bad bishop: many own pawns on the bishop's color",
  },
  bishop_xray_pawns: {
    ru: 'слон рентгенит чужие пешки сквозь свои',
    en: 'bishop x-rays enemy pawns through own pawns',
  },
  bishop_long_diagonal: {
    ru: 'слон на длинной диагонали (видит оба центральных поля)',
    en: 'bishop on the long diagonal (controls both center squares)',
  },
  bishop_cornered: {
    ru: 'слон зажат в углу собственной пешкой (Chess960)',
    en: 'bishop cornered by own pawn (Chess960)',
  },
  rook_on_open_file: {
    ru: 'ладья на открытой или полу-открытой линии',
    en: 'rook on (semi-)open file',
  },
  rook_on_closed_file: {
    ru: 'ладья на закрытой линии со своей заблокированной пешкой',
    en: 'rook on a closed file with own blocked pawn',
  },
  rook_trapped: {
    ru: 'ладья зажата собственным королём',
    en: 'rook trapped by own king',
  },
  queen_weak: {
    ru: 'ферзь под рентгеном (под связкой или вскрытым нападением)',
    en: 'queen under x-ray (pinned or threatened by discovered attack)',
  },

  // ─── King safety (evaluate.cpp::king, 8) ────────────────────────
  king_safety_pawn: {
    ru: 'общая безопасность короля по пешечному щиту и штурму',
    en: 'overall king safety from pawn shelter and storm',
  },
  king_danger: {
    ru: 'общая опасность королю (составной king-danger)',
    en: 'overall king danger (composite kingDanger score)',
  },
  king_safe_check_rook: {
    ru: 'безопасный шах ладьёй угрожает королю',
    en: 'safe rook check threatens the king',
  },
  king_safe_check_queen: {
    ru: 'безопасный шах ферзём угрожает королю',
    en: 'safe queen check threatens the king',
  },
  king_safe_check_bishop: {
    ru: 'безопасный шах слоном угрожает королю',
    en: 'safe bishop check threatens the king',
  },
  king_safe_check_knight: {
    ru: 'безопасный шах конём угрожает королю',
    en: 'safe knight check threatens the king',
  },
  king_pawnless_flank: {
    ru: 'фланг короля без пешек',
    en: "pawnless flank near the king",
  },
  king_flank_attacks: {
    ru: 'атаки соперника по флангу короля',
    en: "enemy attacks on the king's flank",
  },

  // ─── Threats (evaluate.cpp::threats, 10) ────────────────────────
  threat_by_minor: {
    ru: 'угроза лёгкой фигурой',
    en: 'threat by a minor piece',
  },
  threat_by_rook: {
    ru: 'угроза ладьёй',
    en: 'threat by a rook',
  },
  threat_by_king: {
    ru: 'король атакует слабую фигуру',
    en: 'king attacks a weak piece',
  },
  threat_hanging: {
    ru: 'висячая фигура без защиты',
    en: 'hanging piece (undefended)',
  },
  threat_weak_queen_protection: {
    ru: 'фигура защищена только ферзём',
    en: 'piece defended only by the queen',
  },
  threat_restricted_piece: {
    ru: 'фигуры соперника ограничены в подвижности',
    en: 'opponent pieces are movement-restricted',
  },
  threat_by_safe_pawn: {
    ru: 'угроза безопасной пешкой',
    en: 'threat by a safe pawn',
  },
  threat_by_pawn_push: {
    ru: 'угроза проходом пешки на следующий ход',
    en: 'threat from a pawn push on the next move',
  },
  threat_knight_on_queen: {
    ru: 'конь грозит атакой на ферзя',
    en: 'knight threatens the enemy queen',
  },
  threat_slider_on_queen: {
    ru: 'дальнобойная фигура (слон или ладья) грозит ферзю',
    en: 'slider piece (bishop or rook) threatens the enemy queen',
  },

  // ─── Passed pawns (evaluate.cpp::passed, 4) ─────────────────────
  passed_rank: {
    ru: 'проходная пешка на пройденном ряду',
    en: 'passed pawn at its current rank',
  },
  passed_king_proximity: {
    ru: 'близость королей к проходной пешке',
    en: 'kings proximity to the passed pawn',
  },
  passed_path_advance: {
    ru: 'путь проходной к полю превращения свободен',
    en: "passed pawn's path to promotion is clear",
  },
  passed_file_edge: {
    ru: 'штраф проходной за близость к краю доски',
    en: 'passed pawn penalty for being near the edge',
  },

  // ─── Space (evaluate.cpp::space, 1) ─────────────────────────────
  space: {
    ru: 'пространственный перевес',
    en: 'space advantage',
  },
};

/**
 * Список всех известных `PositionalSubtermId` (полученный из ключей
 * `SUBTERM_LABELS`). Используется в сервисе для проверки `id` на
 * валидность при сборке prompt'а — неизвестные id отбрасываются с
 * WARN, не валят запрос.
 */
export const KNOWN_SUBTERM_IDS: ReadonlySet<string> = new Set(
  Object.keys(SUBTERM_LABELS),
);

/**
 * Получить человекочитаемое описание подкомпоненты по её ID.
 * Если ID неизвестен — возвращает `null` (caller сам решает что
 * делать: использовать сырой id, отбросить с WARN, и т.д.).
 */
export function labelForSubtermId(
  id: string,
  lang: 'ru' | 'en',
): string | null {
  if (!KNOWN_SUBTERM_IDS.has(id)) return null;
  return SUBTERM_LABELS[id as PositionalSubtermId][lang];
}
