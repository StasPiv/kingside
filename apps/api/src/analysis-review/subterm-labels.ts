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
 * краткая фраза для подстановки в системную инструкцию модели
 * («конь на форпосте», «изолированная пешка», и т.д.). Формулировки
 * подбираются так, чтобы их можно было склеить с существительным
 * в предложении без тавтологии (см. правку bishop_pawns 2026-06-06).
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
    ru: 'крайне слабая пешка',
    en: 'doubled pawns under multiple enemy levers',
  },
  pawn_blocked: {
    ru: 'заблокированная пешка на 5-6 ряду',
    en: 'blocked pawn on 5th/6th rank',
  },

  // ─── Shelter & storm (pawns.cpp::evaluate_shelter, 4) ───────────
  king_shelter_strength: {
    ru: 'прочность пешечного прикрытия короля',
    en: "king's pawn shelter strength",
  },
  king_blocked_storm: {
    ru: 'надвинутая пешка соперника, заблокированная нашей пешкой',
    en: 'blocked enemy storm pawn',
  },
  king_unblocked_storm: {
    ru: 'надвигающаяся незаблокированная пешка соперника к нашему королю',
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
    // Обратная связь пользователя (2026-06-06): прежний префикс «плохой
    // слон:» приводил к тавтологии вида «плохой слон у этого слона
    // остался» — модель цитировала префикс как самостоятельную фразу.
    // Оставлено только описание самого фактора по Stockfish.
    ru: 'много своих пешек на цвете слона',
    en: "many own pawns on the bishop's colour",
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
    ru: 'общая безопасность короля по пешечному прикрытию и штурму',
    en: 'overall king safety from pawn shelter and storm',
  },
  king_danger: {
    ru: 'общая опасность королю (составной king-danger)',
    en: 'overall king danger (composite kingDanger score)',
  },
  king_safe_check_rook: {
    ru: 'шах ладьёй',
    en: 'safe rook check threatens the king',
  },
  king_safe_check_queen: {
    ru: 'шах ферзём',
    en: 'safe queen check threatens the king',
  },
  king_safe_check_bishop: {
    ru: 'шах слоном',
    en: 'safe bishop check threatens the king',
  },
  king_safe_check_knight: {
    ru: 'шах конём',
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
  // KS-4070. Stockfish включает в эти подкомпоненты и пешки. В прежней
  // подписи стояло «фигура», что в шахматной терминологии исключает
  // пешку — модель путалась и называла пешку фигурой. Уточнено: цель
  // на `square` может быть и пешкой; `color` — сторона, которая
  // атакует / получает плюс, а уязвимый объект стоит у противоположной
  // стороны.
  threat_hanging: {
    ru: 'фигура или пешка стороны, противоположной `color`, стоит без защиты под боем стороны `color` (висячий объект; `square` — поле объекта; обязательно сверяться с FEN: на `square` может быть пешка, тогда называть «пешка», а не «фигура»)',
    en: 'a piece OR pawn of the side opposite to `color` is attacked and undefended by side `color` (a hanging object; `square` is the object square; ALWAYS check the FEN — if a pawn stands on `square`, call it "pawn", not "piece")',
  },
  threat_weak_queen_protection: {
    ru: 'фигура или пешка стороны, противоположной `color`, защищена только своим ферзём (слабая защита; `square` — поле объекта; обязательно сверяться с FEN: на `square` может быть пешка, тогда называть «пешка», а не «фигура»; `color` — сторона, которая угрожает)',
    en: 'a piece OR pawn of the side opposite to `color` is defended only by its own queen (weak defense; `square` is the object square; ALWAYS check the FEN — if a pawn stands on `square`, call it "pawn", not "piece"; `color` is the threatening side)',
  },
  threat_restricted_piece: {
    ru: 'фигуры соперника ограничены в подвижности',
    en: 'opponent pieces are movement-restricted',
  },
  threat_by_safe_pawn: {
    ru: 'угроза пешкой',
    en: 'threat by a safe pawn',
  },
  // KS-4070. Жалоба пользователя: модель описывала фактор как «угроза
  // проходом пешки на c4», слово «проход» в русском прочно связано с
  // «проходной пешкой» / «прорывом к превращению», а здесь Stockfish
  // имеет в виду pawn push — пешка соперника после хода на одну
  // клетку вперёд встаёт так, что атакует нашу фигуру. Формулировка
  // согласована с пользователем: «фигура под пешечной угрозой».
  threat_by_pawn_push: {
    ru: 'фигура под пешечной угрозой (после хода пешки соперника вперёд)',
    en: "piece is under a pawn threat (after an opponent's pawn push)",
  },
  // KS-4070. Жалоба пользователя на формулировку модели «угроза
  // тяжёлой фигурой по полю d4 с чёрным ферзём в качестве мишени».
  // Слово «тяжёлая» применено неверно (тяжёлые = ладья + ферзь,
  // не слон). Кроме того, у этих подкомпонент `square` — это клетка
  // ферзя-мишени, а не атакующей фигуры. Подписи переписаны так,
  // чтобы оба нюанса были явными: для slider — «фигура дальнего
  // боя (ладья или слон)», для knight — «конь»; в обоих случаях
  // `square` — поле ферзя.
  threat_knight_on_queen: {
    ru: "конь стороны `color` может одним ходом напасть на ферзя противоположной стороны; `square` — поле ферзя-мишени (стоит у стороны, противоположной `color`), а не клетка коня",
    en: "a knight of side `color` can attack the enemy queen in one move; `square` is the target queen square (the queen belongs to the side OPPOSITE to `color`), not the knight square",
  },
  threat_slider_on_queen: {
    ru: "фигура дальнего боя — ладья или слон — стороны `color` может одним ходом напасть на ферзя противоположной стороны; `square` — поле ферзя-мишени (стоит у стороны, противоположной `color`), а не клетка атакующей фигуры; слово «тяжёлая фигура» здесь НЕ применимо: тяжёлые — ладья и ферзь, а угрожать может и слон",
    en: "a long-range piece — rook or bishop — of side `color` can attack the enemy queen in one move; `square` is the target queen square (the queen belongs to the side OPPOSITE to `color`), not the attacker; do NOT call this a 'major piece threat' — major = rook/queen, but the attacker may be a bishop",
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
    ru: 'пространство',
    en: 'space',
  },

  // ─── Mobility per piece (KS-3677, ADR-107 rev 2 §2.2, фаза 10 C1a) ──
  mobility_knight: {
    ru: 'мобильность коня',
    en: 'knight mobility',
  },
  mobility_bishop: {
    ru: 'мобильность слона',
    en: 'bishop mobility',
  },
  mobility_rook: {
    ru: 'мобильность ладьи',
    en: 'rook mobility',
  },
  mobility_queen: {
    ru: 'мобильность ферзя',
    en: 'queen mobility',
  },

  // ─── King attackers агрегаты (KS-3677) ──────────────────────────
  king_attackers_count: {
    ru: 'количество фигур, атакующих короля',
    en: 'count of pieces attacking the king',
  },
  king_attackers_weight: {
    ru: 'суммарный вес атакующих короля фигур',
    en: 'total weight of pieces attacking the king',
  },

  // ─── Material / imbalance (KS-3678 follow-up; KS-4070 уточнено) ─
  // KS-4070. Жалоба пользователя: модель писала «нехватка материала
  // и имбаланса» при равном составе фигур. Подписи прежней редакции
  // («материальный перевес», «имбаланс — комбинация фигур, дающая
  // позиционный вклад») допускали буквальное прочтение «у X не хватает
  // материала». Уточнено: эти id — знаковые оценочные подкомпоненты,
  // у которых значение указывает направление, а не количество.
  // Дополнительный запрет на формулировки «нехватка/недостаток X»
  // вынесен в системную инструкцию `position-comment.service.ts`.
  material: {
    ru: 'материальная подкомпонента оценки Stockfish (значение со знаком: + в пользу белых, − в пользу чёрных; может отклоняться от нуля даже при равном составе фигур)',
    en: "Stockfish material evaluation subterm (signed value: + favours White, − favours Black; may deviate from zero even with equal piece count)",
  },
  imbalance: {
    ru: 'оценочный дисбаланс комбинации фигур по Stockfish (значение со знаком: + в пользу белых, − в пользу чёрных)',
    en: 'Stockfish piece-combination imbalance subterm (signed value: + favours White, − favours Black)',
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
