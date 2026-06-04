/*
  Stockfish, a UCI chess playing engine derived from Glaurung 2.1
  Copyright (C) 2004-2023 The Stockfish developers (see AUTHORS file)

  Stockfish is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  Stockfish is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

#ifndef EVALUATE_H_INCLUDED
#define EVALUATE_H_INCLUDED

#include <string>
#include <optional>

#include "types.h"

namespace Stockfish {

class Position;

namespace Eval {

  // KS-3648 / ADR-107 rev 2 §3. Идентификаторы позиционных
  // подкомпонент classical-оценки (~50 штук, соответствует
  // packages/shared `PositionalSubtermId`, KS-3649). Используется
  // pawns.cpp и evaluate.cpp для вызова Eval::add_subterm в TRACE-
  // режиме. Порядок согласован с таблицей `subterm_id_names` в
  // evaluate.cpp.
  enum Subterm {
    // pawns.cpp::evaluate<Color> (7 подкомпонент)
    SUBT_PAWN_DOUBLED_EARLY,
    SUBT_PAWN_CONNECTED,
    SUBT_PAWN_DOUBLED,
    SUBT_PAWN_ISOLATED,
    SUBT_PAWN_BACKWARD,
    SUBT_PAWN_LEVER_DOUBLE,
    SUBT_PAWN_BLOCKED,
    // pawns.cpp::Entry::evaluate_shelter (4)
    SUBT_KING_SHELTER_STRENGTH,
    SUBT_KING_BLOCKED_STORM,
    SUBT_KING_UNBLOCKED_STORM,
    SUBT_KING_ON_FILE,
    // evaluate.cpp::pieces (17)
    SUBT_ROOK_ON_KING_RING,
    SUBT_BISHOP_ON_KING_RING,
    SUBT_KNIGHT_UNCONTESTED_OUTPOST,
    SUBT_OUTPOST_KNIGHT,
    SUBT_OUTPOST_BISHOP,
    SUBT_KNIGHT_REACHABLE_OUTPOST,
    SUBT_MINOR_BEHIND_PAWN,
    SUBT_KNIGHT_KING_PROTECTOR_DISTANCE,
    SUBT_BISHOP_KING_PROTECTOR_DISTANCE,
    SUBT_BISHOP_PAWNS,
    SUBT_BISHOP_XRAY_PAWNS,
    SUBT_BISHOP_LONG_DIAGONAL,
    SUBT_BISHOP_CORNERED,
    SUBT_ROOK_ON_OPEN_FILE,
    SUBT_ROOK_ON_CLOSED_FILE,
    SUBT_ROOK_TRAPPED,
    SUBT_QUEEN_WEAK,
    // evaluate.cpp::king (8)
    SUBT_KING_SAFETY_PAWN,
    SUBT_KING_DANGER,
    SUBT_KING_SAFE_CHECK_ROOK,
    SUBT_KING_SAFE_CHECK_QUEEN,
    SUBT_KING_SAFE_CHECK_BISHOP,
    SUBT_KING_SAFE_CHECK_KNIGHT,
    SUBT_KING_PAWNLESS_FLANK,
    SUBT_KING_FLANK_ATTACKS,
    // evaluate.cpp::threats (10)
    SUBT_THREAT_BY_MINOR,
    SUBT_THREAT_BY_ROOK,
    SUBT_THREAT_BY_KING,
    SUBT_THREAT_HANGING,
    SUBT_THREAT_WEAK_QUEEN_PROTECTION,
    SUBT_THREAT_RESTRICTED_PIECE,
    SUBT_THREAT_BY_SAFE_PAWN,
    SUBT_THREAT_BY_PAWN_PUSH,
    SUBT_THREAT_KNIGHT_ON_QUEEN,
    SUBT_THREAT_SLIDER_ON_QUEEN,
    // evaluate.cpp::passed (4)
    SUBT_PASSED_RANK,
    SUBT_PASSED_KING_PROXIMITY,
    SUBT_PASSED_PATH_ADVANCE,
    SUBT_PASSED_FILE_EDGE,
    // evaluate.cpp::space (1)
    SUBT_SPACE,
    // KS-3648 Phase 10: PSQT (piece-square table) per-piece разметка.
    // Эмитятся в Eval::trace_json после Evaluation<TRACE>, цикл по всем
    // фигурам на доске — каждая получает свой PSQT-вклад на своём
    // квадрате. POV: знак score POV владельца (white-фигура → положит.
    // полю даёт плюс белым; flip_rank делает SF в psqt.cpp::init).
    SUBT_PSQT_PAWN,
    SUBT_PSQT_KNIGHT,
    SUBT_PSQT_BISHOP,
    SUBT_PSQT_ROOK,
    SUBT_PSQT_QUEEN,
    SUBT_PSQT_KING,
    // KS-3648 Phase 10: mobility per-piece. SF суммирует через
    // MobilityBonus[Pt-2][popcount(...)] в evaluate.cpp::pieces.
    // Здесь разнесено по типу фигуры — для каждого коня/слона/ладьи/
    // ферзя видно вклад мобильности per piece на своём квадрате.
    SUBT_MOBILITY_KNIGHT,
    SUBT_MOBILITY_BISHOP,
    SUBT_MOBILITY_ROOK,
    SUBT_MOBILITY_QUEEN,
    // KS-3648 Phase 10: атакующие на king_ring противника. SF
    // накапливает kingAttackersCount/Weight в pieces() цикле и
    // использует их в king() для kingDanger. Здесь — отдельные
    // суммарные подкомпоненты per side (без square).
    SUBT_KING_ATTACKERS_COUNT,
    SUBT_KING_ATTACKERS_WEIGHT,
    // KS-3678 follow-up: материал и имбаланс из evaluate(), эмитятся
    // в trace_json после Evaluation<TRACE>. Material = pos.psq_score()
    // (включает PSQT-составляющую, уже разнесённую по piece-type выше);
    // Imbalance = me->imbalance() — несимметричные комбинации фигур.
    // Без square / без color (общая мера, POV WHITE).
    SUBT_MATERIAL,
    SUBT_IMBALANCE,
    SUBT_NB
  };

  // KS-3648. Записать одну подкомпоненту в общий накопитель
  // (`Trace::subterms` в evaluate.cpp). Безопасно для multi-call'ов
  // — caller'у достаточно один раз позвать `Eval::trace_json()`,
  // который вызовет `Trace::clear_sub` перед накоплением. Pawns.cpp
  // вызывает её под `if constexpr (T == TRACE)`.
  void add_subterm(Subterm id, Color c, Score s, Square sq = SQ_NONE);

  std::string trace(Position& pos);

  // KS-3648 / ADR-107 rev 2 §3. Расширенный classical-trace с
  // per-subterm выводом в JSON. Вызывается из UCI команды
  // `eval json`. Внутри: классическая оценка с template<Tracing T =
  // TRACE> + сбор всех ~50 подкомпонент с привязкой к квадрату/цвету
  // через Eval::add_subterm. Pawn-cache в TRACE режиме обходится
  // отдельным вызовом `Pawns::trace_for<Color>`.
  std::string trace_json(Position& pos);

  Value evaluate(const Position& pos);

  // KS-3648 / ADR-107 rev 2 §3. Tracing-флаг для template'ов
  // `Evaluation<T>` в evaluate.cpp и `evaluate<T, Color>` /
  // `evaluate_shelter<T, Color>` в pawns.cpp. NO_TRACE = накладные
  // расходы нулевые (макрос-обёртка под `if constexpr (T)` удаляется
  // компилятором); TRACE = вызывает `add_subterm` для каждой
  // подкомпоненты.
  enum Tracing { NO_TRACE, TRACE };

  extern bool useNNUE;
  extern std::string currentEvalFileName;

  // The default net name MUST follow the format nn-[SHA256 first 12 digits].nnue
  // for the build process (profile-build and fishtest) to work. Do not change the
  // name of the macro, as it is used in the Makefile.
  #define EvalFileDefaultName   "nn-5af11540bbfe.nnue"

  namespace NNUE {

    void init();
    void verify();

  } // namespace NNUE

} // namespace Eval

// KS-3648 / ADR-107 rev 2 §3. Макросы-обёртки вокруг
// `Eval::add_subterm`. Применяются внутри `template<Tracing T>`
// функций. При `T == NO_TRACE` компилятор полностью удаляет вызов
// (zero overhead).
#define SF_TRACE_ADD_SUB(id, c, s, sq) \
    do { if constexpr (T == Eval::TRACE) Eval::add_subterm(id, c, s, sq); } while (0)
#define SF_TRACE_ADD_SUB_NS(id, c, s) \
    do { if constexpr (T == Eval::TRACE) Eval::add_subterm(id, c, s); } while (0)

} // namespace Stockfish

#endif // #ifndef EVALUATE_H_INCLUDED
