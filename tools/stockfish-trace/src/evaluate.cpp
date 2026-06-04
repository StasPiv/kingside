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

#include <algorithm>
#include <cassert>
#include <cstdlib>
#include <cstring>   // For std::memset
#include <fstream>
#include <iomanip>
#include <sstream>
#include <iostream>
#include <streambuf>
#include <vector>

#include "bitboard.h"
#include "evaluate.h"
#include "material.h"
#include "misc.h"
#include "pawns.h"
#include "psqt.h"  // KS-3648 Phase 10: PSQT::psq для per-piece разметки
#include "thread.h"
#include "timeman.h"
#include "uci.h"
#include "incbin/incbin.h"
#include "nnue/evaluate_nnue.h"

// Macro to embed the default efficiently updatable neural network (NNUE) file
// data in the engine binary (using incbin.h, by Dale Weiler).
// This macro invocation will declare the following three variables
//     const unsigned char        gEmbeddedNNUEData[];  // a pointer to the embedded data
//     const unsigned char *const gEmbeddedNNUEEnd;     // a marker to the end
//     const unsigned int         gEmbeddedNNUESize;    // the size of the embedded file
// Note that this does not work in Microsoft Visual Studio.
#if !defined(_MSC_VER) && !defined(NNUE_EMBEDDING_OFF)
  INCBIN(EmbeddedNNUE, EvalFileDefaultName);
#else
  const unsigned char        gEmbeddedNNUEData[1] = {0x0};
  const unsigned char *const gEmbeddedNNUEEnd = &gEmbeddedNNUEData[1];
  const unsigned int         gEmbeddedNNUESize = 1;
#endif


using namespace std;

namespace Stockfish {

namespace Eval {

  bool useNNUE;
  string currentEvalFileName = "None";

  /// NNUE::init() tries to load a NNUE network at startup time, or when the engine
  /// receives a UCI command "setoption name EvalFile value nn-[a-z0-9]{12}.nnue"
  /// The name of the NNUE network is always retrieved from the EvalFile option.
  /// We search the given network in three locations: internally (the default
  /// network may be embedded in the binary), in the active working directory and
  /// in the engine directory. Distro packagers may define the DEFAULT_NNUE_DIRECTORY
  /// variable to have the engine search in a special directory in their distro.

  void NNUE::init() {

#ifdef __EMSCRIPTEN__
    // KS-3676 / ADR-107 rev 2. В WASM-сборке принудительно идём по
    // classical-evaluation:
    //   - `FILESYSTEM=0` (см. 0004 EMFLAGS) — нет POSIX-FS, любая
    //     попытка `ifstream(...)` из тела ниже падает с
    //     `___syscall_openat → RuntimeError: remainder by zero`
    //     внутри emscripten libc.
    //   - `NNUE_EMBEDDING_OFF` (см. 0004 CXXFLAGS) — `gEmbeddedNNUEData`
    //     пуст, `<internal>`-ветка тоже не загрузит сетку.
    //   - Для `eval json` (наш единственный сценарий) classical-
    //     evaluation достаточна — ровно её данные нужны для подкомпонент
    //     `Eval::trace_json`.
    // Игнорируем Options["Use NNUE"] — даже если фронт случайно прислал
    // `setoption name Use NNUE value true`, NNUE-ветка всё равно не
    // сработает. `verify()` ниже увидит useNNUE=false и просто напечатает
    // `info string classical evaluation enabled` без exit.
    useNNUE = false;
    return;
#else
    useNNUE = Options["Use NNUE"];
    if (!useNNUE)
        return;
#endif

    string eval_file = string(Options["EvalFile"]);
    if (eval_file.empty())
        eval_file = EvalFileDefaultName;

    #if defined(DEFAULT_NNUE_DIRECTORY)
    vector<string> dirs = { "<internal>" , "" , CommandLine::binaryDirectory , stringify(DEFAULT_NNUE_DIRECTORY) };
    #else
    vector<string> dirs = { "<internal>" , "" , CommandLine::binaryDirectory };
    #endif

    for (const string& directory : dirs)
        if (currentEvalFileName != eval_file)
        {
            if (directory != "<internal>")
            {
                ifstream stream(directory + eval_file, ios::binary);
                if (NNUE::load_eval(eval_file, stream))
                    currentEvalFileName = eval_file;
            }

            if (directory == "<internal>" && eval_file == EvalFileDefaultName)
            {
                // C++ way to prepare a buffer for a memory stream
                class MemoryBuffer : public basic_streambuf<char> {
                    public: MemoryBuffer(char* p, size_t n) { setg(p, p, p + n); setp(p, p + n); }
                };

                MemoryBuffer buffer(const_cast<char*>(reinterpret_cast<const char*>(gEmbeddedNNUEData)),
                                    size_t(gEmbeddedNNUESize));
                (void) gEmbeddedNNUEEnd; // Silence warning on unused variable

                istream stream(&buffer);
                if (NNUE::load_eval(eval_file, stream))
                    currentEvalFileName = eval_file;
            }
        }
  }

  /// NNUE::verify() verifies that the last net used was loaded successfully
  void NNUE::verify() {

    string eval_file = string(Options["EvalFile"]);
    if (eval_file.empty())
        eval_file = EvalFileDefaultName;

    if (useNNUE && currentEvalFileName != eval_file)
    {

        string msg1 = "If the UCI option \"Use NNUE\" is set to true, network evaluation parameters compatible with the engine must be available.";
        string msg2 = "The option is set to true, but the network file " + eval_file + " was not loaded successfully.";
        string msg3 = "The UCI option EvalFile might need to specify the full path, including the directory name, to the network file.";
        string msg4 = "The default net can be downloaded from: https://tests.stockfishchess.org/api/nn/" + std::string(EvalFileDefaultName);
        string msg5 = "The engine will be terminated now.";

        sync_cout << "info string ERROR: " << msg1 << sync_endl;
        sync_cout << "info string ERROR: " << msg2 << sync_endl;
        sync_cout << "info string ERROR: " << msg3 << sync_endl;
        sync_cout << "info string ERROR: " << msg4 << sync_endl;
        sync_cout << "info string ERROR: " << msg5 << sync_endl;

        exit(EXIT_FAILURE);
    }

    if (useNNUE)
        sync_cout << "info string NNUE evaluation using " << eval_file << " enabled" << sync_endl;
    else
        sync_cout << "info string classical evaluation enabled" << sync_endl;
  }
}

namespace Trace {

  // KS-3648: Tracing flag перенесён в Eval (evaluate.h) — теперь
  // используется и pawns.cpp. Здесь используем алиас для совместимости
  // с существующими использованиями `NO_TRACE` / `TRACE` в namespace Trace.
  using Eval::Tracing;
  using Eval::NO_TRACE;
  using Eval::TRACE;

  enum Term { // The first 8 entries are reserved for PieceType
    MATERIAL = 8, IMBALANCE, MOBILITY, THREAT, PASSED, SPACE, WINNABLE, TOTAL, TERM_NB
  };

  Score scores[TERM_NB][COLOR_NB];

  // KS-3648 / ADR-107 rev 2 §3. Стабильные строковые ID для JSON-
  // вывода (порядок совпадает с `Eval::Subterm` в evaluate.h).
  // Должен синхронизоваться с
  // `packages/shared/src/types/api-contracts.ts::PositionalSubtermId`
  // в основном репозитории Kingside (KS-3649). Имена в `Eval::`
  // — `SUBT_*`; здесь используются короткие индексы.
  using Eval::Subterm;
  using Eval::SUBT_NB;

  static const char* const subterm_id_names[SUBT_NB] = {
    "pawn_doubled_early",
    "pawn_connected",
    "pawn_doubled",
    "pawn_isolated",
    "pawn_backward",
    "pawn_lever_double",
    "pawn_blocked",
    "king_shelter_strength",
    "king_blocked_storm",
    "king_unblocked_storm",
    "king_on_file",
    "rook_on_king_ring",
    "bishop_on_king_ring",
    "knight_uncontested_outpost",
    "outpost_knight",
    "outpost_bishop",
    "knight_reachable_outpost",
    "minor_behind_pawn",
    "knight_king_protector_distance",
    "bishop_king_protector_distance",
    "bishop_pawns",
    "bishop_xray_pawns",
    "bishop_long_diagonal",
    "bishop_cornered",
    "rook_on_open_file",
    "rook_on_closed_file",
    "rook_trapped",
    "queen_weak",
    "king_safety_pawn",
    "king_danger",
    "king_safe_check_rook",
    "king_safe_check_queen",
    "king_safe_check_bishop",
    "king_safe_check_knight",
    "king_pawnless_flank",
    "king_flank_attacks",
    "threat_by_minor",
    "threat_by_rook",
    "threat_by_king",
    "threat_hanging",
    "threat_weak_queen_protection",
    "threat_restricted_piece",
    "threat_by_safe_pawn",
    "threat_by_pawn_push",
    "threat_knight_on_queen",
    "threat_slider_on_queen",
    "passed_rank",
    "passed_king_proximity",
    "passed_path_advance",
    "passed_file_edge",
    "space",
    // Phase 10: PSQT
    "psqt_pawn",
    "psqt_knight",
    "psqt_bishop",
    "psqt_rook",
    "psqt_queen",
    "psqt_king",
    // Phase 10: mobility per-piece
    "mobility_knight",
    "mobility_bishop",
    "mobility_rook",
    "mobility_queen",
    // Phase 10: king attackers агрегаты
    "king_attackers_count",
    "king_attackers_weight"
  };

  struct SubtermEntry {
    Subterm id;
    Color   color;
    Square  sq;   // SQ_NONE если подкомпонента не привязана к квадрату.
    Score   score;
  };

  // Накопитель подкомпонент за один вызов evaluate в TRACE-режиме.
  // Очищается в `Eval::trace_json()` перед каждым вызовом. Запись
  // идёт через `Eval::add_subterm` (publicly видно из pawns.cpp),
  // вызывается ТОЛЬКО под `if constexpr (T == TRACE)`. В основном
  // поиске (NO_TRACE) накладных нет — макрос разворачивается в пустую
  // конструкцию.
  std::vector<SubtermEntry> subterms;

  static double to_cp(Value v) { return double(v) / UCI::NormalizeToPawnValue; }

  static void add(int idx, Color c, Score s) {
    scores[idx][c] = s;
  }

  static void add(int idx, Score w, Score b = SCORE_ZERO) {
    scores[idx][WHITE] = w;
    scores[idx][BLACK] = b;
  }

  // KS-3648 / ADR-107 rev 2 §3. Сбросить накопитель перед новым
  // прогоном trace_json.
  static void clear_sub() {
    subterms.clear();
  }

  static std::ostream& operator<<(std::ostream& os, Score s) {
    os << std::setw(5) << to_cp(mg_value(s)) << " "
       << std::setw(5) << to_cp(eg_value(s));
    return os;
  }

  static std::ostream& operator<<(std::ostream& os, Term t) {

    if (t == MATERIAL || t == IMBALANCE || t == WINNABLE || t == TOTAL)
        os << " ----  ----"    << " | " << " ----  ----";
    else
        os << scores[t][WHITE] << " | " << scores[t][BLACK];

    os << " | " << scores[t][WHITE] - scores[t][BLACK] << " |\n";
    return os;
  }

  // Сериализатор JSON. UCI-square `SQ_NONE` опускается в выводе,
  // остальные представляются стандартной алгебраической нотацией
  // (a1..h8). `value_mg`/`value_eg` — в пешечных-cp (поделено на
  // NormalizeToPawnValue, как и `Eval::trace`).
  static std::string subterm_to_json(const SubtermEntry& e) {
    std::ostringstream os;
    os << "    {\"id\":\"" << subterm_id_names[e.id]
       << "\",\"color\":\"" << (e.color == WHITE ? "w" : "b")
       << "\"";
    if (e.sq != SQ_NONE) {
      char file = char('a' + file_of(e.sq));
      char rank = char('1' + rank_of(e.sq));
      os << ",\"square\":\"" << file << rank << "\"";
    }
    os << ",\"value_mg\":" << to_cp(mg_value(e.score))
       << ",\"value_eg\":" << to_cp(eg_value(e.score))
       << "}";
    return os.str();
  }
}

// KS-3648: макросы SF_TRACE_ADD_SUB / SF_TRACE_ADD_SUB_NS перенесены
// в evaluate.h — теперь доступны и из pawns.cpp.

using namespace Trace;

namespace {

  // Threshold for lazy and space evaluation
  constexpr Value LazyThreshold1    =  Value(3622);
  constexpr Value LazyThreshold2    =  Value(1962);
  constexpr Value SpaceThreshold    =  Value(11551);

  // KingAttackWeights[PieceType] contains king attack weights by piece type
  constexpr int KingAttackWeights[PIECE_TYPE_NB] = { 0, 0, 76, 46, 45, 14 };

  // SafeCheck[PieceType][single/multiple] contains safe check bonus by piece type,
  // higher if multiple safe checks are possible for that piece type.
  constexpr int SafeCheck[][2] = {
      {}, {}, {805, 1292}, {650, 984}, {1071, 1886}, {730, 1128}
  };

#define S(mg, eg) make_score(mg, eg)

  // MobilityBonus[PieceType-2][attacked] contains bonuses for middle and end game,
  // indexed by piece type and number of attacked squares in the mobility area.
  constexpr Score MobilityBonus[][32] = {
    { S(-62,-79), S(-53,-57), S(-12,-31), S( -3,-17), S(  3,  7), S( 12, 13), // Knight
      S( 21, 16), S( 28, 21), S( 37, 26) },
    { S(-47,-59), S(-20,-25), S( 14, -8), S( 29, 12), S( 39, 21), S( 53, 40), // Bishop
      S( 53, 56), S( 60, 58), S( 62, 65), S( 69, 72), S( 78, 78), S( 83, 87),
      S( 91, 88), S( 96, 98) },
    { S(-60,-82), S(-24,-15), S(  0, 17) ,S(  3, 43), S(  4, 72), S( 14,100), // Rook
      S( 20,102), S( 30,122), S( 41,133), S(41 ,139), S( 41,153), S( 45,160),
      S( 57,165), S( 58,170), S( 67,175) },
    { S(-29,-49), S(-16,-29), S( -8, -8), S( -8, 17), S( 18, 39), S( 25, 54), // Queen
      S( 23, 59), S( 37, 73), S( 41, 76), S( 54, 95), S( 65, 95) ,S( 68,101),
      S( 69,124), S( 70,128), S( 70,132), S( 70,133) ,S( 71,136), S( 72,140),
      S( 74,147), S( 76,149), S( 90,153), S(104,169), S(105,171), S(106,171),
      S(112,178), S(114,185), S(114,187), S(119,221) }
  };

  // BishopPawns[distance from edge] contains a file-dependent penalty for pawns on
  // squares of the same color as our bishop.
  constexpr Score BishopPawns[int(FILE_NB) / 2] = {
    S(3, 8), S(3, 9), S(2, 7), S(3, 7)
  };

  // KingProtector[knight/bishop] contains penalty for each distance unit to own king
  constexpr Score KingProtector[] = { S(9, 9), S(7, 9) };

  // Outpost[knight/bishop] contains bonuses for each knight or bishop occupying a
  // pawn protected square on rank 4 to 6 which is also safe from a pawn attack.
  constexpr Score Outpost[] = { S(54, 34), S(31, 25) };

  // PassedRank[Rank] contains a bonus according to the rank of a passed pawn
  constexpr Score PassedRank[RANK_NB] = {
    S(0, 0), S(2, 38), S(15, 36), S(22, 50), S(64, 81), S(166, 184), S(284, 269)
  };

  constexpr Score RookOnClosedFile = S(10, 5);
  constexpr Score RookOnOpenFile[] = { S(18, 8), S(49, 26) };

  // ThreatByMinor/ByRook[attacked PieceType] contains bonuses according to
  // which piece type attacks which one. Attacks on lesser pieces which are
  // pawn-defended are not considered.
  constexpr Score ThreatByMinor[PIECE_TYPE_NB] = {
    S(0, 0), S(6, 37), S(64, 50), S(82, 57), S(103, 130), S(81, 163)
  };

  constexpr Score ThreatByRook[PIECE_TYPE_NB] = {
    S(0, 0), S(3, 44), S(36, 71), S(44, 59), S(0, 39), S(60, 39)
  };

  constexpr Value CorneredBishop = Value(50);

  // Assorted bonuses and penalties
  constexpr Score UncontestedOutpost  = S(  0, 10);
  constexpr Score BishopOnKingRing    = S( 24,  0);
  constexpr Score BishopXRayPawns     = S(  4,  5);
  constexpr Score FlankAttacks        = S(  8,  0);
  constexpr Score Hanging             = S( 72, 40);
  constexpr Score KnightOnQueen       = S( 16, 11);
  constexpr Score LongDiagonalBishop  = S( 45,  0);
  constexpr Score MinorBehindPawn     = S( 18,  3);
  constexpr Score PassedFile          = S( 13,  8);
  constexpr Score PawnlessFlank       = S( 19, 97);
  constexpr Score ReachableOutpost    = S( 33, 19);
  constexpr Score RestrictedPiece     = S(  6,  7);
  constexpr Score RookOnKingRing      = S( 16,  0);
  constexpr Score SliderOnQueen       = S( 62, 21);
  constexpr Score ThreatByKing        = S( 24, 87);
  constexpr Score ThreatByPawnPush    = S( 48, 39);
  constexpr Score ThreatBySafePawn    = S(167, 99);
  constexpr Score TrappedRook         = S( 55, 13);
  constexpr Score WeakQueenProtection = S( 14,  0);
  constexpr Score WeakQueen           = S( 57, 19);


#undef S

  // Evaluation class computes and stores attacks tables and other working data
  template<Tracing T>
  class Evaluation {

  public:
    Evaluation() = delete;
    explicit Evaluation(const Position& p) : pos(p) {}
    Evaluation& operator=(const Evaluation&) = delete;
    Value value();

  private:
    template<Color Us> void initialize();
    template<Color Us, PieceType Pt> Score pieces();
    template<Color Us> Score king() const;
    template<Color Us> Score threats() const;
    template<Color Us> Score passed() const;
    template<Color Us> Score space() const;
    Value winnable(Score score) const;

    const Position& pos;
    Material::Entry* me;
    Pawns::Entry* pe;
    Bitboard mobilityArea[COLOR_NB];
    Score mobility[COLOR_NB] = { SCORE_ZERO, SCORE_ZERO };

    // attackedBy[color][piece type] is a bitboard representing all squares
    // attacked by a given color and piece type. Special "piece types" which
    // is also calculated is ALL_PIECES.
    Bitboard attackedBy[COLOR_NB][PIECE_TYPE_NB];

    // attackedBy2[color] are the squares attacked by at least 2 units of a given
    // color, including x-rays. But diagonal x-rays through pawns are not computed.
    Bitboard attackedBy2[COLOR_NB];

    // kingRing[color] are the squares adjacent to the king plus some other
    // very near squares, depending on king position.
    Bitboard kingRing[COLOR_NB];

    // kingAttackersCount[color] is the number of pieces of the given color
    // which attack a square in the kingRing of the enemy king.
    int kingAttackersCount[COLOR_NB];

    // kingAttackersWeight[color] is the sum of the "weights" of the pieces of
    // the given color which attack a square in the kingRing of the enemy king.
    // The weights of the individual piece types are given by the elements in
    // the KingAttackWeights array.
    int kingAttackersWeight[COLOR_NB];

    // kingAttacksCount[color] is the number of attacks by the given color to
    // squares directly adjacent to the enemy king. Pieces which attack more
    // than one square are counted multiple times. For instance, if there is
    // a white knight on g5 and black's king is on g8, this white knight adds 2
    // to kingAttacksCount[WHITE].
    int kingAttacksCount[COLOR_NB];
  };


  // Evaluation::initialize() computes king and pawn attacks, and the king ring
  // bitboard for a given color. This is done at the beginning of the evaluation.

  template<Tracing T> template<Color Us>
  void Evaluation<T>::initialize() {

    constexpr Color     Them = ~Us;
    constexpr Direction Up   = pawn_push(Us);
    constexpr Direction Down = -Up;
    constexpr Bitboard LowRanks = (Us == WHITE ? Rank2BB | Rank3BB : Rank7BB | Rank6BB);

    const Square ksq = pos.square<KING>(Us);

    Bitboard dblAttackByPawn = pawn_double_attacks_bb<Us>(pos.pieces(Us, PAWN));

    // Find our pawns that are blocked or on the first two ranks
    Bitboard b = pos.pieces(Us, PAWN) & (shift<Down>(pos.pieces()) | LowRanks);

    // Squares occupied by those pawns, by our king or queen, by blockers to attacks on our king
    // or controlled by enemy pawns are excluded from the mobility area.
    mobilityArea[Us] = ~(b | pos.pieces(Us, KING, QUEEN) | pos.blockers_for_king(Us) | pe->pawn_attacks(Them));

    // Initialize attackedBy[] for king and pawns
    attackedBy[Us][KING] = attacks_bb<KING>(ksq);
    attackedBy[Us][PAWN] = pe->pawn_attacks(Us);
    attackedBy[Us][ALL_PIECES] = attackedBy[Us][KING] | attackedBy[Us][PAWN];
    attackedBy2[Us] = dblAttackByPawn | (attackedBy[Us][KING] & attackedBy[Us][PAWN]);

    // Init our king safety tables
    Square s = make_square(std::clamp(file_of(ksq), FILE_B, FILE_G),
                           std::clamp(rank_of(ksq), RANK_2, RANK_7));
    kingRing[Us] = attacks_bb<KING>(s) | s;

    kingAttackersCount[Them] = popcount(kingRing[Us] & pe->pawn_attacks(Them));
    kingAttacksCount[Them] = kingAttackersWeight[Them] = 0;

    // Remove from kingRing[] the squares defended by two pawns
    kingRing[Us] &= ~dblAttackByPawn;
  }


  // Evaluation::pieces() scores pieces of a given color and type

  template<Tracing T> template<Color Us, PieceType Pt>
  Score Evaluation<T>::pieces() {

    constexpr Color Them = ~Us;
    [[maybe_unused]] constexpr Direction Down = -pawn_push(Us);
    [[maybe_unused]] constexpr Bitboard OutpostRanks = (Us == WHITE ? Rank4BB | Rank5BB | Rank6BB
                                                                    : Rank5BB | Rank4BB | Rank3BB);
    Bitboard b1 = pos.pieces(Us, Pt);
    Bitboard b, bb;
    Score score = SCORE_ZERO;

    attackedBy[Us][Pt] = 0;

    while (b1)
    {
        Square s = pop_lsb(b1);

        // Find attacked squares, including x-ray attacks for bishops and rooks
        b = Pt == BISHOP ? attacks_bb<BISHOP>(s, pos.pieces() ^ pos.pieces(QUEEN))
          : Pt ==   ROOK ? attacks_bb<  ROOK>(s, pos.pieces() ^ pos.pieces(QUEEN) ^ pos.pieces(Us, ROOK))
                         : attacks_bb<Pt>(s, pos.pieces());

        if (pos.blockers_for_king(Us) & s)
            b &= line_bb(pos.square<KING>(Us), s);

        attackedBy2[Us] |= attackedBy[Us][ALL_PIECES] & b;
        attackedBy[Us][Pt] |= b;
        attackedBy[Us][ALL_PIECES] |= b;

        if (b & kingRing[Them])
        {
            kingAttackersCount[Us]++;
            kingAttackersWeight[Us] += KingAttackWeights[Pt];
            kingAttacksCount[Us] += popcount(b & attackedBy[Them][KING]);
        }

        else if (Pt == ROOK && (file_bb(s) & kingRing[Them]))
        {
            score += RookOnKingRing;
            SF_TRACE_ADD_SUB(Eval::SUBT_ROOK_ON_KING_RING, Us, RookOnKingRing, s);
        }

        else if (Pt == BISHOP && (attacks_bb<BISHOP>(s, pos.pieces(PAWN)) & kingRing[Them]))
        {
            score += BishopOnKingRing;
            SF_TRACE_ADD_SUB(Eval::SUBT_BISHOP_ON_KING_RING, Us, BishopOnKingRing, s);
        }

        int mob = popcount(b & mobilityArea[Us]);
        Score mobBonus = MobilityBonus[Pt - 2][mob];
        mobility[Us] += mobBonus;
        // KS-3648 Phase 10: per-piece mobility bonus с привязкой к
        // квадрату. SUBT_MOBILITY_KNIGHT..QUEEN — выбор по Pt через
        // if constexpr (фигура известна на этапе компиляции шаблона).
        if constexpr (Pt == KNIGHT)
            SF_TRACE_ADD_SUB(Eval::SUBT_MOBILITY_KNIGHT, Us, mobBonus, s);
        else if constexpr (Pt == BISHOP)
            SF_TRACE_ADD_SUB(Eval::SUBT_MOBILITY_BISHOP, Us, mobBonus, s);
        else if constexpr (Pt == ROOK)
            SF_TRACE_ADD_SUB(Eval::SUBT_MOBILITY_ROOK, Us, mobBonus, s);
        else if constexpr (Pt == QUEEN)
            SF_TRACE_ADD_SUB(Eval::SUBT_MOBILITY_QUEEN, Us, mobBonus, s);

        if constexpr (Pt == BISHOP || Pt == KNIGHT)
        {
            // Bonus if the piece is on an outpost square or can reach one
            // Bonus for knights (UncontestedOutpost) if few relevant targets
            bb = OutpostRanks & (attackedBy[Us][PAWN] | shift<Down>(pos.pieces(PAWN)))
                              & ~pe->pawn_attacks_span(Them);
            Bitboard targets = pos.pieces(Them) & ~pos.pieces(PAWN);

            if (   Pt == KNIGHT
                && bb & s & ~CenterFiles // on a side outpost
                && !(b & targets)        // no relevant attacks
                && (!more_than_one(targets & (s & QueenSide ? QueenSide : KingSide))))
            {
                Score uncontestedScore = UncontestedOutpost * popcount(pos.pieces(PAWN) & (s & QueenSide ? QueenSide : KingSide));
                score += uncontestedScore;
                SF_TRACE_ADD_SUB(Eval::SUBT_KNIGHT_UNCONTESTED_OUTPOST, Us, uncontestedScore, s);
            }
            else if (bb & s)
            {
                Score outpostScore = Outpost[Pt == BISHOP];
                score += outpostScore;
                if constexpr (Pt == BISHOP)
                    SF_TRACE_ADD_SUB(Eval::SUBT_OUTPOST_BISHOP, Us, outpostScore, s);
                else
                    SF_TRACE_ADD_SUB(Eval::SUBT_OUTPOST_KNIGHT, Us, outpostScore, s);
            }
            else if (Pt == KNIGHT && bb & b & ~pos.pieces(Us))
            {
                score += ReachableOutpost;
                SF_TRACE_ADD_SUB(Eval::SUBT_KNIGHT_REACHABLE_OUTPOST, Us, ReachableOutpost, s);
            }

            // Bonus for a knight or bishop shielded by pawn
            if (shift<Down>(pos.pieces(PAWN)) & s)
            {
                score += MinorBehindPawn;
                SF_TRACE_ADD_SUB(Eval::SUBT_MINOR_BEHIND_PAWN, Us, MinorBehindPawn, s);
            }

            // Penalty if the piece is far from the king
            Score kingProtectorPenalty = KingProtector[Pt == BISHOP] * distance(pos.square<KING>(Us), s);
            score -= kingProtectorPenalty;
            if constexpr (Pt == BISHOP)
                SF_TRACE_ADD_SUB(Eval::SUBT_BISHOP_KING_PROTECTOR_DISTANCE, Us, -kingProtectorPenalty, s);
            else
                SF_TRACE_ADD_SUB(Eval::SUBT_KNIGHT_KING_PROTECTOR_DISTANCE, Us, -kingProtectorPenalty, s);

            if constexpr (Pt == BISHOP)
            {
                // Penalty according to the number of our pawns on the same color square as the
                // bishop, bigger when the center files are blocked with pawns and smaller
                // when the bishop is outside the pawn chain.
                Bitboard blocked = pos.pieces(Us, PAWN) & shift<Down>(pos.pieces());

                Score bishopPawnsPenalty = BishopPawns[edge_distance(file_of(s))] * pos.pawns_on_same_color_squares(Us, s)
                                         * (!(attackedBy[Us][PAWN] & s) + popcount(blocked & CenterFiles));
                score -= bishopPawnsPenalty;
                SF_TRACE_ADD_SUB(Eval::SUBT_BISHOP_PAWNS, Us, -bishopPawnsPenalty, s);

                // Penalty for all enemy pawns x-rayed
                Score bishopXrayPenalty = BishopXRayPawns * popcount(attacks_bb<BISHOP>(s) & pos.pieces(Them, PAWN));
                score -= bishopXrayPenalty;
                SF_TRACE_ADD_SUB(Eval::SUBT_BISHOP_XRAY_PAWNS, Us, -bishopXrayPenalty, s);

                // Bonus for bishop on a long diagonal which can "see" both center squares
                if (more_than_one(attacks_bb<BISHOP>(s, pos.pieces(PAWN)) & Center))
                {
                    score += LongDiagonalBishop;
                    SF_TRACE_ADD_SUB(Eval::SUBT_BISHOP_LONG_DIAGONAL, Us, LongDiagonalBishop, s);
                }

                // An important Chess960 pattern: a cornered bishop blocked by a friendly
                // pawn diagonally in front of it is a very serious problem, especially
                // when that pawn is also blocked.
                if (   pos.is_chess960()
                    && (s == relative_square(Us, SQ_A1) || s == relative_square(Us, SQ_H1)))
                {
                    Direction d = pawn_push(Us) + (file_of(s) == FILE_A ? EAST : WEST);
                    if (pos.piece_on(s + d) == make_piece(Us, PAWN))
                    {
                        Score corneredPenalty = !pos.empty(s + d + pawn_push(Us))
                                              ? make_score(CorneredBishop, CorneredBishop) * 4
                                              : make_score(CorneredBishop, CorneredBishop) * 3;
                        score -= corneredPenalty;
                        SF_TRACE_ADD_SUB(Eval::SUBT_BISHOP_CORNERED, Us, -corneredPenalty, s);
                    }
                }
            }
        }

        if constexpr (Pt == ROOK)
        {
            // Bonuses for rook on a (semi-)open or closed file
            if (pos.is_on_semiopen_file(Us, s))
            {
                Score rookOpenScore = RookOnOpenFile[pos.is_on_semiopen_file(Them, s)];
                score += rookOpenScore;
                SF_TRACE_ADD_SUB(Eval::SUBT_ROOK_ON_OPEN_FILE, Us, rookOpenScore, s);
            }
            else
            {
                // If our pawn on this file is blocked, increase penalty
                if ( pos.pieces(Us, PAWN)
                   & shift<Down>(pos.pieces())
                   & file_bb(s))
                {
                    score -= RookOnClosedFile;
                    SF_TRACE_ADD_SUB(Eval::SUBT_ROOK_ON_CLOSED_FILE, Us, -RookOnClosedFile, s);
                }

                // Penalty when trapped by the king, even more if the king cannot castle
                if (mob <= 3)
                {
                    File kf = file_of(pos.square<KING>(Us));
                    if ((kf < FILE_E) == (file_of(s) < kf))
                    {
                        Score trappedPenalty = TrappedRook * (1 + !pos.castling_rights(Us));
                        score -= trappedPenalty;
                        SF_TRACE_ADD_SUB(Eval::SUBT_ROOK_TRAPPED, Us, -trappedPenalty, s);
                    }
                }
            }
        }

        if constexpr (Pt == QUEEN)
        {
            // Penalty if any relative pin or discovered attack against the queen
            Bitboard queenPinners;
            if (pos.slider_blockers(pos.pieces(Them, ROOK, BISHOP), s, queenPinners))
            {
                score -= WeakQueen;
                SF_TRACE_ADD_SUB(Eval::SUBT_QUEEN_WEAK, Us, -WeakQueen, s);
            }
        }
    }
    if constexpr (T)
        Trace::add(Pt, Us, score);

    return score;
  }


  // Evaluation::king() assigns bonuses and penalties to a king of a given color

  template<Tracing T> template<Color Us>
  Score Evaluation<T>::king() const {

    constexpr Color    Them = ~Us;
    constexpr Bitboard Camp = (Us == WHITE ? AllSquares ^ Rank6BB ^ Rank7BB ^ Rank8BB
                                           : AllSquares ^ Rank1BB ^ Rank2BB ^ Rank3BB);

    Bitboard weak, b1, b2, b3, safe, unsafeChecks = 0;
    Bitboard rookChecks, queenChecks, bishopChecks, knightChecks;
    int kingDanger = 0;
    const Square ksq = pos.square<KING>(Us);

    // Init the score with king shelter and enemy pawns storm
    Score score = pe->king_safety<Us>(pos);
    SF_TRACE_ADD_SUB(Eval::SUBT_KING_SAFETY_PAWN, Us, score, ksq);

    // KS-3648 Phase 10: атакующие противника на нашего короля.
    // kingAttackersCount/Weight[Them] = сколько фигур стороны Them
    // атакуют kingRing[Us]. Эмитим как color=Them (это «атакующие
    // их фигур») — для удобства потребителя «у чёрных N атакующих
    // на короля белых» = запись с color=b, value=N.
    if (kingAttackersCount[Them] > 0)
    {
        Score countScore = make_score(kingAttackersCount[Them], kingAttackersCount[Them]);
        Score weightScore = make_score(kingAttackersWeight[Them], kingAttackersWeight[Them]);
        SF_TRACE_ADD_SUB_NS(Eval::SUBT_KING_ATTACKERS_COUNT, Them, countScore);
        SF_TRACE_ADD_SUB_NS(Eval::SUBT_KING_ATTACKERS_WEIGHT, Them, weightScore);
    }

    // Attacked squares defended at most once by our queen or king
    weak =  attackedBy[Them][ALL_PIECES]
          & ~attackedBy2[Us]
          & (~attackedBy[Us][ALL_PIECES] | attackedBy[Us][KING] | attackedBy[Us][QUEEN]);

    // Analyse the safe enemy's checks which are possible on next move
    safe  = ~pos.pieces(Them);
    safe &= ~attackedBy[Us][ALL_PIECES] | (weak & attackedBy2[Them]);

    b1 = attacks_bb<ROOK  >(ksq, pos.pieces() ^ pos.pieces(Us, QUEEN));
    b2 = attacks_bb<BISHOP>(ksq, pos.pieces() ^ pos.pieces(Us, QUEEN));

    // Enemy rooks checks
    rookChecks = b1 & attackedBy[Them][ROOK] & safe;
    if (rookChecks)
    {
        int v = SafeCheck[ROOK][more_than_one(rookChecks)];
        kingDanger += v;
        // SafeCheck-вклад в king_danger (отрицательный для нашей
        // стороны, т.к. финальный score -= ...). Эмитим как
        // make_score(v,v) с минусом для удобства потребителя.
        SF_TRACE_ADD_SUB(Eval::SUBT_KING_SAFE_CHECK_ROOK, Us, -make_score(v, v), ksq);
    }
    else
        unsafeChecks |= b1 & attackedBy[Them][ROOK];

    // Enemy queen safe checks: count them only if the checks are from squares from
    // which opponent cannot give a rook check, because rook checks are more valuable.
    queenChecks =  (b1 | b2) & attackedBy[Them][QUEEN] & safe
                 & ~(attackedBy[Us][QUEEN] | rookChecks);
    if (queenChecks)
    {
        int v = SafeCheck[QUEEN][more_than_one(queenChecks)];
        kingDanger += v;
        SF_TRACE_ADD_SUB(Eval::SUBT_KING_SAFE_CHECK_QUEEN, Us, -make_score(v, v), ksq);
    }

    // Enemy bishops checks: count them only if they are from squares from which
    // opponent cannot give a queen check, because queen checks are more valuable.
    bishopChecks =  b2 & attackedBy[Them][BISHOP] & safe
                  & ~queenChecks;
    if (bishopChecks)
    {
        int v = SafeCheck[BISHOP][more_than_one(bishopChecks)];
        kingDanger += v;
        SF_TRACE_ADD_SUB(Eval::SUBT_KING_SAFE_CHECK_BISHOP, Us, -make_score(v, v), ksq);
    }
    else
        unsafeChecks |= b2 & attackedBy[Them][BISHOP];

    // Enemy knights checks
    knightChecks = attacks_bb<KNIGHT>(ksq) & attackedBy[Them][KNIGHT];
    if (knightChecks & safe)
    {
        int v = SafeCheck[KNIGHT][more_than_one(knightChecks & safe)];
        kingDanger += v;
        SF_TRACE_ADD_SUB(Eval::SUBT_KING_SAFE_CHECK_KNIGHT, Us, -make_score(v, v), ksq);
    }
    else
        unsafeChecks |= knightChecks;

    // Find the squares that opponent attacks in our king flank, the squares
    // which they attack twice in that flank, and the squares that we defend.
    b1 = attackedBy[Them][ALL_PIECES] & KingFlank[file_of(ksq)] & Camp;
    b2 = b1 & attackedBy2[Them];
    b3 = attackedBy[Us][ALL_PIECES] & KingFlank[file_of(ksq)] & Camp;

    int kingFlankAttack  = popcount(b1) + popcount(b2);
    int kingFlankDefense = popcount(b3);

    kingDanger +=        kingAttackersCount[Them] * kingAttackersWeight[Them] // (~10 Elo)
                 + 183 * popcount(kingRing[Us] & weak)                        // (~15 Elo)
                 + 148 * popcount(unsafeChecks)                               // (~4 Elo)
                 +  98 * popcount(pos.blockers_for_king(Us))                  // (~2 Elo)
                 +  69 * kingAttacksCount[Them]                               // (~0.5 Elo)
                 +   3 * kingFlankAttack * kingFlankAttack / 8                // (~0.5 Elo)
                 +       mg_value(mobility[Them] - mobility[Us])              // (~0.5 Elo)
                 - 873 * !pos.count<QUEEN>(Them)                              // (~24 Elo)
                 - 100 * bool(attackedBy[Us][KNIGHT] & attackedBy[Us][KING])  // (~5 Elo)
                 -   6 * mg_value(score) / 8                                  // (~8 Elo)
                 -   4 * kingFlankDefense                                     // (~5 Elo)
                 +  37;                                                       // (~0.5 Elo)

    // Transform the kingDanger units into a Score, and subtract it from the evaluation
    if (kingDanger > 100)
    {
        Score dangerScore = make_score(kingDanger * kingDanger / 4096, kingDanger / 16);
        score -= dangerScore;
        SF_TRACE_ADD_SUB(Eval::SUBT_KING_DANGER, Us, -dangerScore, ksq);
    }

    // Penalty when our king is on a pawnless flank
    if (!(pos.pieces(PAWN) & KingFlank[file_of(ksq)]))
    {
        score -= PawnlessFlank;
        SF_TRACE_ADD_SUB(Eval::SUBT_KING_PAWNLESS_FLANK, Us, -PawnlessFlank, ksq);
    }

    // Penalty if king flank is under attack, potentially moving toward the king
    Score flankAttacksPenalty = FlankAttacks * kingFlankAttack;
    score -= flankAttacksPenalty;
    SF_TRACE_ADD_SUB(Eval::SUBT_KING_FLANK_ATTACKS, Us, -flankAttacksPenalty, ksq);

    if constexpr (T)
        Trace::add(KING, Us, score);

    return score;
  }


  // Evaluation::threats() assigns bonuses according to the types of the
  // attacking and the attacked pieces.

  template<Tracing T> template<Color Us>
  Score Evaluation<T>::threats() const {

    constexpr Color     Them     = ~Us;
    constexpr Direction Up       = pawn_push(Us);
    constexpr Bitboard  TRank3BB = (Us == WHITE ? Rank3BB : Rank6BB);

    Bitboard b, weak, defended, nonPawnEnemies, stronglyProtected, safe;
    Score score = SCORE_ZERO;

    // Non-pawn enemies
    nonPawnEnemies = pos.pieces(Them) & ~pos.pieces(PAWN);

    // Squares strongly protected by the enemy, either because they defend the
    // square with a pawn, or because they defend the square twice and we don't.
    stronglyProtected =  attackedBy[Them][PAWN]
                       | (attackedBy2[Them] & ~attackedBy2[Us]);

    // Non-pawn enemies, strongly protected
    defended = nonPawnEnemies & stronglyProtected;

    // Enemies not strongly protected and under our attack
    weak = pos.pieces(Them) & ~stronglyProtected & attackedBy[Us][ALL_PIECES];

    // Bonus according to the kind of attacking pieces
    if (defended | weak)
    {
        b = (defended | weak) & (attackedBy[Us][KNIGHT] | attackedBy[Us][BISHOP]);
        while (b)
        {
            Square ts = pop_lsb(b);
            Score thrScore = ThreatByMinor[type_of(pos.piece_on(ts))];
            score += thrScore;
            SF_TRACE_ADD_SUB(Eval::SUBT_THREAT_BY_MINOR, Us, thrScore, ts);
        }

        b = weak & attackedBy[Us][ROOK];
        while (b)
        {
            Square ts = pop_lsb(b);
            Score thrScore = ThreatByRook[type_of(pos.piece_on(ts))];
            score += thrScore;
            SF_TRACE_ADD_SUB(Eval::SUBT_THREAT_BY_ROOK, Us, thrScore, ts);
        }

        if (weak & attackedBy[Us][KING])
        {
            score += ThreatByKing;
            SF_TRACE_ADD_SUB_NS(Eval::SUBT_THREAT_BY_KING, Us, ThreatByKing);
        }

        b =  ~attackedBy[Them][ALL_PIECES]
           | (nonPawnEnemies & attackedBy2[Us]);
        Score hangingScore = Hanging * popcount(weak & b);
        score += hangingScore;
        SF_TRACE_ADD_SUB_NS(Eval::SUBT_THREAT_HANGING, Us, hangingScore);

        // Additional bonus if weak piece is only protected by a queen
        Score weakQueenProtScore = WeakQueenProtection * popcount(weak & attackedBy[Them][QUEEN]);
        score += weakQueenProtScore;
        SF_TRACE_ADD_SUB_NS(Eval::SUBT_THREAT_WEAK_QUEEN_PROTECTION, Us, weakQueenProtScore);
    }

    // Bonus for restricting their piece moves
    b =   attackedBy[Them][ALL_PIECES]
       & ~stronglyProtected
       &  attackedBy[Us][ALL_PIECES];
    Score restrictedScore = RestrictedPiece * popcount(b);
    score += restrictedScore;
    SF_TRACE_ADD_SUB_NS(Eval::SUBT_THREAT_RESTRICTED_PIECE, Us, restrictedScore);

    // Protected or unattacked squares
    safe = ~attackedBy[Them][ALL_PIECES] | attackedBy[Us][ALL_PIECES];

    // Bonus for attacking enemy pieces with our relatively safe pawns
    b = pos.pieces(Us, PAWN) & safe;
    b = pawn_attacks_bb<Us>(b) & nonPawnEnemies;
    Score safePawnThreatScore = ThreatBySafePawn * popcount(b);
    score += safePawnThreatScore;
    SF_TRACE_ADD_SUB_NS(Eval::SUBT_THREAT_BY_SAFE_PAWN, Us, safePawnThreatScore);

    // Find squares where our pawns can push on the next move
    b  = shift<Up>(pos.pieces(Us, PAWN)) & ~pos.pieces();
    b |= shift<Up>(b & TRank3BB) & ~pos.pieces();

    // Keep only the squares which are relatively safe
    b &= ~attackedBy[Them][PAWN] & safe;

    // Bonus for safe pawn threats on the next move
    b = pawn_attacks_bb<Us>(b) & nonPawnEnemies;
    Score pawnPushThreatScore = ThreatByPawnPush * popcount(b);
    score += pawnPushThreatScore;
    SF_TRACE_ADD_SUB_NS(Eval::SUBT_THREAT_BY_PAWN_PUSH, Us, pawnPushThreatScore);

    // Bonus for threats on the next moves against enemy queen
    if (pos.count<QUEEN>(Them) == 1)
    {
        bool queenImbalance = pos.count<QUEEN>() == 1;

        Square s = pos.square<QUEEN>(Them);
        safe =   mobilityArea[Us]
              & ~pos.pieces(Us, PAWN)
              & ~stronglyProtected;

        b = attackedBy[Us][KNIGHT] & attacks_bb<KNIGHT>(s);

        Score knightOnQueenScore = KnightOnQueen * popcount(b & safe) * (1 + queenImbalance);
        score += knightOnQueenScore;
        SF_TRACE_ADD_SUB(Eval::SUBT_THREAT_KNIGHT_ON_QUEEN, Us, knightOnQueenScore, s);

        b =  (attackedBy[Us][BISHOP] & attacks_bb<BISHOP>(s, pos.pieces()))
           | (attackedBy[Us][ROOK  ] & attacks_bb<ROOK  >(s, pos.pieces()));

        Score sliderOnQueenScore = SliderOnQueen * popcount(b & safe & attackedBy2[Us]) * (1 + queenImbalance);
        score += sliderOnQueenScore;
        SF_TRACE_ADD_SUB(Eval::SUBT_THREAT_SLIDER_ON_QUEEN, Us, sliderOnQueenScore, s);
    }

    if constexpr (T)
        Trace::add(THREAT, Us, score);

    return score;
  }

  // Evaluation::passed() evaluates the passed pawns and candidate passed
  // pawns of the given color.

  template<Tracing T> template<Color Us>
  Score Evaluation<T>::passed() const {

    constexpr Color     Them = ~Us;
    constexpr Direction Up   = pawn_push(Us);
    constexpr Direction Down = -Up;

    auto king_proximity = [&](Color c, Square s) {
      return std::min(distance(pos.square<KING>(c), s), 5);
    };

    Bitboard b, bb, squaresToQueen, unsafeSquares, blockedPassers, helpers;
    Score score = SCORE_ZERO;

    b = pe->passed_pawns(Us);

    blockedPassers = b & shift<Down>(pos.pieces(Them, PAWN));
    if (blockedPassers)
    {
        helpers =  shift<Up>(pos.pieces(Us, PAWN))
                 & ~pos.pieces(Them)
                 & (~attackedBy2[Them] | attackedBy[Us][ALL_PIECES]);

        // Remove blocked candidate passers that don't have help to pass
        b &=  ~blockedPassers
            | shift<WEST>(helpers)
            | shift<EAST>(helpers);
    }

    while (b)
    {
        Square s = pop_lsb(b);

        assert(!(pos.pieces(Them, PAWN) & forward_file_bb(Us, s + Up)));

        int r = relative_rank(Us, s);

        Score rankBonus = PassedRank[r];
        Score bonus = rankBonus;
        SF_TRACE_ADD_SUB(Eval::SUBT_PASSED_RANK, Us, rankBonus, s);

        if (r > RANK_3)
        {
            int w = 5 * r - 13;
            Square blockSq = s + Up;

            // Adjust bonus based on the king's proximity
            Score kingProxScore = make_score(0, (  king_proximity(Them, blockSq) * 19 / 4
                                                 - king_proximity(Us,   blockSq) *  2) * w);
            bonus += kingProxScore;

            // If blockSq is not the queening square then consider also a second push
            if (r != RANK_7)
            {
                Score secondPushAdjust = make_score(0, king_proximity(Us, blockSq + Up) * w);
                bonus -= secondPushAdjust;
                kingProxScore -= secondPushAdjust;
            }
            SF_TRACE_ADD_SUB(Eval::SUBT_PASSED_KING_PROXIMITY, Us, kingProxScore, s);

            // If the pawn is free to advance, then increase the bonus
            if (pos.empty(blockSq))
            {
                squaresToQueen = forward_file_bb(Us, s);
                unsafeSquares = passed_pawn_span(Us, s);

                bb = forward_file_bb(Them, s) & pos.pieces(ROOK, QUEEN);

                if (!(pos.pieces(Them) & bb))
                    unsafeSquares &= attackedBy[Them][ALL_PIECES] | pos.pieces(Them);

                // If there are no enemy pieces or attacks on passed pawn span, assign a big bonus.
                // Or if there is some, but they are all attacked by our pawns, assign a bit smaller bonus.
                // Otherwise assign a smaller bonus if the path to queen is not attacked
                // and even smaller bonus if it is attacked but block square is not.
                int k = !unsafeSquares                    ? 36 :
                !(unsafeSquares & ~attackedBy[Us][PAWN])  ? 30 :
                        !(unsafeSquares & squaresToQueen) ? 17 :
                        !(unsafeSquares & blockSq)        ?  7 :
                                                             0 ;

                // Assign a larger bonus if the block square is defended
                if ((pos.pieces(Us) & bb) || (attackedBy[Us][ALL_PIECES] & blockSq))
                    k += 5;

                Score pathAdvanceScore = make_score(k * w, k * w);
                bonus += pathAdvanceScore;
                SF_TRACE_ADD_SUB(Eval::SUBT_PASSED_PATH_ADVANCE, Us, pathAdvanceScore, s);
            }
        } // r > RANK_3

        Score fileEdgePenalty = PassedFile * edge_distance(file_of(s));
        score += bonus - fileEdgePenalty;
        SF_TRACE_ADD_SUB(Eval::SUBT_PASSED_FILE_EDGE, Us, -fileEdgePenalty, s);
    }

    if constexpr (T)
        Trace::add(PASSED, Us, score);

    return score;
  }


  // Evaluation::space() computes a space evaluation for a given side, aiming to improve game
  // play in the opening. It is based on the number of safe squares on the four central files
  // on ranks 2 to 4. Completely safe squares behind a friendly pawn are counted twice.
  // Finally, the space bonus is multiplied by a weight which decreases according to occupancy.

  template<Tracing T> template<Color Us>
  Score Evaluation<T>::space() const {

    // Early exit if, for example, both queens or 6 minor pieces have been exchanged
    if (pos.non_pawn_material() < SpaceThreshold)
        return SCORE_ZERO;

    constexpr Color Them     = ~Us;
    constexpr Direction Down = -pawn_push(Us);
    constexpr Bitboard SpaceMask =
      Us == WHITE ? CenterFiles & (Rank2BB | Rank3BB | Rank4BB)
                  : CenterFiles & (Rank7BB | Rank6BB | Rank5BB);

    // Find the available squares for our pieces inside the area defined by SpaceMask
    Bitboard safe =   SpaceMask
                   & ~pos.pieces(Us, PAWN)
                   & ~attackedBy[Them][PAWN];

    // Find all squares which are at most three squares behind some friendly pawn
    Bitboard behind = pos.pieces(Us, PAWN);
    behind |= shift<Down>(behind);
    behind |= shift<Down+Down>(behind);

    // Compute space score based on the number of safe squares and number of our pieces
    // increased with number of total blocked pawns in position.
    int bonus = popcount(safe) + popcount(behind & safe & ~attackedBy[Them][ALL_PIECES]);
    int weight = pos.count<ALL_PIECES>(Us) - 3 + std::min(pe->blocked_count(), 9);
    Score score = make_score(bonus * weight * weight / 16, 0);

    if constexpr (T)
        Trace::add(SPACE, Us, score);

    // KS-3648 / ADR-107 rev 2 §3. Space-агрегат и subterm совпадают
    // (одна формула), эмитим то же значение.
    SF_TRACE_ADD_SUB_NS(Eval::SUBT_SPACE, Us, score);

    return score;
  }


  // Evaluation::winnable() adjusts the midgame and endgame score components, based on
  // the known attacking/defending status of the players. The final value is derived
  // by interpolation from the midgame and endgame values.

  template<Tracing T>
  Value Evaluation<T>::winnable(Score score) const {

    int outflanking =  distance<File>(pos.square<KING>(WHITE), pos.square<KING>(BLACK))
                    + int(rank_of(pos.square<KING>(WHITE)) - rank_of(pos.square<KING>(BLACK)));

    bool pawnsOnBothFlanks =   (pos.pieces(PAWN) & QueenSide)
                            && (pos.pieces(PAWN) & KingSide);

    bool almostUnwinnable =   outflanking < 0
                           && !pawnsOnBothFlanks;

    bool infiltration =   rank_of(pos.square<KING>(WHITE)) > RANK_4
                       || rank_of(pos.square<KING>(BLACK)) < RANK_5;

    // Compute the initiative bonus for the attacking side
    int complexity =   9 * pe->passed_count()
                    + 12 * pos.count<PAWN>()
                    +  9 * outflanking
                    + 21 * pawnsOnBothFlanks
                    + 24 * infiltration
                    + 51 * !pos.non_pawn_material()
                    - 43 * almostUnwinnable
                    -110 ;

    Value mg = mg_value(score);
    Value eg = eg_value(score);

    // Now apply the bonus: note that we find the attacking side by extracting the
    // sign of the midgame or endgame values, and that we carefully cap the bonus
    // so that the midgame and endgame scores do not change sign after the bonus.
    int u = ((mg > 0) - (mg < 0)) * std::clamp(complexity + 50, -abs(mg), 0);
    int v = ((eg > 0) - (eg < 0)) * std::max(complexity, -abs(eg));

    mg += u;
    eg += v;

    // Compute the scale factor for the winning side
    Color strongSide = eg > VALUE_DRAW ? WHITE : BLACK;
    int sf = me->scale_factor(pos, strongSide);

    // If scale factor is not already specific, scale up/down via general heuristics
    if (sf == SCALE_FACTOR_NORMAL)
    {
        if (pos.opposite_bishops())
        {
            // For pure opposite colored bishops endgames use scale factor
            // based on the number of passed pawns of the strong side.
            if (   pos.non_pawn_material(WHITE) == BishopValueMg
                && pos.non_pawn_material(BLACK) == BishopValueMg)
                sf = 18 + 4 * popcount(pe->passed_pawns(strongSide));
            // For every other opposite colored bishops endgames use scale factor
            // based on the number of all pieces of the strong side.
            else
                sf = 22 + 3 * pos.count<ALL_PIECES>(strongSide);
        }
        // For rook endgames with strong side not having overwhelming pawn number advantage
        // and its pawns being on one flank and weak side protecting its pieces with a king
        // use lower scale factor.
        else if (  pos.non_pawn_material(WHITE) == RookValueMg
                && pos.non_pawn_material(BLACK) == RookValueMg
                && pos.count<PAWN>(strongSide) - pos.count<PAWN>(~strongSide) <= 1
                && bool(KingSide & pos.pieces(strongSide, PAWN)) != bool(QueenSide & pos.pieces(strongSide, PAWN))
                && (attacks_bb<KING>(pos.square<KING>(~strongSide)) & pos.pieces(~strongSide, PAWN)))
            sf = 36;
        // For queen vs no queen endgames use scale factor
        // based on number of minors of side that doesn't have queen.
        else if (pos.count<QUEEN>() == 1)
            sf = 37 + 3 * (pos.count<QUEEN>(WHITE) == 1 ? pos.count<BISHOP>(BLACK) + pos.count<KNIGHT>(BLACK)
                                                        : pos.count<BISHOP>(WHITE) + pos.count<KNIGHT>(WHITE));
        // In every other case use scale factor based on
        // the number of pawns of the strong side reduced if pawns are on a single flank.
        else
            sf = std::min(sf, 36 + 7 * pos.count<PAWN>(strongSide)) - 4 * !pawnsOnBothFlanks;

        // Reduce scale factor in case of pawns being on a single flank
        sf -= 4 * !pawnsOnBothFlanks;
    }

    // Interpolate between the middlegame and (scaled by 'sf') endgame score
    v =  mg * int(me->game_phase())
       + eg * int(PHASE_MIDGAME - me->game_phase()) * ScaleFactor(sf) / SCALE_FACTOR_NORMAL;
    v /= PHASE_MIDGAME;

    if constexpr (T)
    {
        Trace::add(WINNABLE, make_score(u, eg * ScaleFactor(sf) / SCALE_FACTOR_NORMAL - eg_value(score)));
        Trace::add(TOTAL, make_score(mg, eg * ScaleFactor(sf) / SCALE_FACTOR_NORMAL));
    }

    return Value(v);
  }


  // Evaluation::value() is the main function of the class. It computes the various
  // parts of the evaluation and returns the value of the position from the point
  // of view of the side to move.

  template<Tracing T>
  Value Evaluation<T>::value() {

    assert(!pos.checkers());

    // Probe the material hash table
    me = Material::probe(pos);

    // If we have a specialized evaluation function for the current material
    // configuration, call it and return.
    if (me->specialized_eval_exists())
        return me->evaluate(pos);

    // Initialize score by reading the incrementally updated scores included in
    // the position object (material + piece square tables) and the material
    // imbalance. Score is computed internally from the white point of view.
    Score score = pos.psq_score() + me->imbalance();

    // Probe the pawn hash table
    pe = Pawns::probe(pos);
    score += pe->pawn_score(WHITE) - pe->pawn_score(BLACK);

    // Early exit if score is high
    auto lazy_skip = [&](Value lazyThreshold) {
        return abs(mg_value(score) + eg_value(score)) >   lazyThreshold
                                                        + std::abs(pos.this_thread()->bestValue) * 5 / 4
                                                        + pos.non_pawn_material() / 32;
    };

    if (lazy_skip(LazyThreshold1))
        goto make_v;

    // Main evaluation begins here
    initialize<WHITE>();
    initialize<BLACK>();

    // Pieces evaluated first (also populates attackedBy, attackedBy2).
    // Note that the order of evaluation of the terms is left unspecified.
    score +=  pieces<WHITE, KNIGHT>() - pieces<BLACK, KNIGHT>()
            + pieces<WHITE, BISHOP>() - pieces<BLACK, BISHOP>()
            + pieces<WHITE, ROOK  >() - pieces<BLACK, ROOK  >()
            + pieces<WHITE, QUEEN >() - pieces<BLACK, QUEEN >();

    score += mobility[WHITE] - mobility[BLACK];

    // More complex interactions that require fully populated attack bitboards
    score +=  king<   WHITE>() - king<   BLACK>()
            + passed< WHITE>() - passed< BLACK>();

    if (lazy_skip(LazyThreshold2))
        goto make_v;

    score +=  threats<WHITE>() - threats<BLACK>()
            + space<  WHITE>() - space<  BLACK>();

make_v:
    // Derive single value from mg and eg parts of score
    Value v = winnable(score);

    // In case of tracing add all remaining individual evaluation terms
    if constexpr (T)
    {
        Trace::add(MATERIAL, pos.psq_score());
        Trace::add(IMBALANCE, me->imbalance());
        Trace::add(PAWN, pe->pawn_score(WHITE), pe->pawn_score(BLACK));
        Trace::add(MOBILITY, mobility[WHITE], mobility[BLACK]);
    }

    // Evaluation grain
    v = (v / 16) * 16;

    // Side to move point of view
    v = (pos.side_to_move() == WHITE ? v : -v);

    return v;
  }

} // namespace Eval


/// evaluate() is the evaluator for the outer world. It returns a static
/// evaluation of the position from the point of view of the side to move.

Value Eval::evaluate(const Position& pos) {

  assert(!pos.checkers());

  Value v;
  Value psq = pos.psq_eg_stm();

  // We use the much less accurate but faster Classical eval when the NNUE
  // option is set to false. Otherwise we use the NNUE eval unless the
  // PSQ advantage is decisive. (~4 Elo at STC, 1 Elo at LTC)
  bool useClassical = !useNNUE || abs(psq) > 2048;

  if (useClassical)
      v = Evaluation<NO_TRACE>(pos).value();
  else
  {
      int nnueComplexity;
      int npm = pos.non_pawn_material() / 64;

      Color stm = pos.side_to_move();
      Value optimism = pos.this_thread()->optimism[stm];

      Value nnue = NNUE::evaluate(pos, true, &nnueComplexity);

      // Blend optimism with nnue complexity and (semi)classical complexity
      optimism += optimism * (nnueComplexity + abs(psq - nnue)) / 512;
      v = (nnue * (945 + npm) + optimism * (150 + npm)) / 1024;
  }

  // Damp down the evaluation linearly when shuffling
  v = v * (200 - pos.rule50_count()) / 214;

  // Guarantee evaluation does not hit the tablebase range
  v = std::clamp(v, VALUE_TB_LOSS_IN_MAX_PLY + 1, VALUE_TB_WIN_IN_MAX_PLY - 1);

  return v;
}

/// trace() is like evaluate(), but instead of returning a value, it returns
/// a string (suitable for outputting to stdout) that contains the detailed
/// descriptions and values of each evaluation term. Useful for debugging.
/// Trace scores are from white's point of view

std::string Eval::trace(Position& pos) {

  if (pos.checkers())
      return "Final evaluation: none (in check)";

  std::stringstream ss;
  ss << std::showpoint << std::noshowpos << std::fixed << std::setprecision(2);

  Value v;

  std::memset(scores, 0, sizeof(scores));

  // Reset any global variable used in eval
  pos.this_thread()->bestValue       = VALUE_ZERO;
  pos.this_thread()->optimism[WHITE] = VALUE_ZERO;
  pos.this_thread()->optimism[BLACK] = VALUE_ZERO;

  v = Evaluation<TRACE>(pos).value();

  ss << std::showpoint << std::noshowpos << std::fixed << std::setprecision(2)
     << " Contributing terms for the classical eval:\n"
     << "+------------+-------------+-------------+-------------+\n"
     << "|    Term    |    White    |    Black    |    Total    |\n"
     << "|            |   MG    EG  |   MG    EG  |   MG    EG  |\n"
     << "+------------+-------------+-------------+-------------+\n"
     << "|   Material | " << Term(MATERIAL)
     << "|  Imbalance | " << Term(IMBALANCE)
     << "|      Pawns | " << Term(PAWN)
     << "|    Knights | " << Term(KNIGHT)
     << "|    Bishops | " << Term(BISHOP)
     << "|      Rooks | " << Term(ROOK)
     << "|     Queens | " << Term(QUEEN)
     << "|   Mobility | " << Term(MOBILITY)
     << "|King safety | " << Term(KING)
     << "|    Threats | " << Term(THREAT)
     << "|     Passed | " << Term(PASSED)
     << "|      Space | " << Term(SPACE)
     << "|   Winnable | " << Term(WINNABLE)
     << "+------------+-------------+-------------+-------------+\n"
     << "|      Total | " << Term(TOTAL)
     << "+------------+-------------+-------------+-------------+\n";

  if (Eval::useNNUE)
      ss << '\n' << NNUE::trace(pos) << '\n';

  ss << std::showpoint << std::showpos << std::fixed << std::setprecision(2) << std::setw(15);

  v = pos.side_to_move() == WHITE ? v : -v;
  ss << "\nClassical evaluation   " << to_cp(v) << " (white side)\n";
  if (Eval::useNNUE)
  {
      v = NNUE::evaluate(pos, false);
      v = pos.side_to_move() == WHITE ? v : -v;
      ss << "NNUE evaluation        " << to_cp(v) << " (white side)\n";
  }

  v = evaluate(pos);
  v = pos.side_to_move() == WHITE ? v : -v;
  ss << "Final evaluation       " << to_cp(v) << " (white side)";
  if (Eval::useNNUE)
     ss << " [with scaled NNUE, hybrid, ...]";
  ss << "\n";

  return ss.str();
}


/// KS-3648 / ADR-107 rev 2 §3. Запись одной подкомпоненты в общий
/// накопитель `Trace::subterms`. Объявлена в evaluate.h, чтобы быть
/// доступной из pawns.cpp (тот вызывает её под `if constexpr (T ==
/// TRACE)`).
void Eval::add_subterm(Subterm id, Color c, Score s, Square sq) {
  subterms.push_back({id, c, sq, s});
}


/// KS-3648 / ADR-107 rev 2 §3.4. JSON-сериализация всех позиционных
/// подкомпонент classical-оценки. Доступно через UCI команду
/// `eval json`. Используется фронтом Kingside (apps/web) для
/// LLM-комментариев в разборе партии. Эта функция:
///
///  - принудительно делает один проход `Evaluation<TRACE>` (что
///    активирует все `TRACE_ADD_SUB(...)` вставки в pawns.cpp /
///    evaluate.cpp);
///  - формирует JSON-объект `{ position, subterms[], total }` с
///    `value_mg` / `value_eg` в пешечных-cp (как и таблица `eval`);
///  - НЕ ломает существующую `eval`-таблицу 13 терминов — это
///    отдельный вход.
///
/// При шахе позиции — возвращает корректный JSON с пустым массивом
/// (как `Eval::trace` возвращает «in check» текстом).
std::string Eval::trace_json(Position& pos) {

  std::stringstream ss;

  if (pos.checkers()) {
    ss << "{\"position\":{\"fen\":\"" << pos.fen() << "\","
       << "\"sideToMove\":\""
       << (pos.side_to_move() == WHITE ? "w" : "b")
       << "\",\"in_check\":true},"
       << "\"subterms\":[],\"total\":{\"mg\":0,\"eg\":0,\"v\":0}}";
    return ss.str();
  }

  std::memset(scores, 0, sizeof(scores));
  clear_sub();

  // Reset any global variable used in eval (как в Eval::trace).
  pos.this_thread()->bestValue       = VALUE_ZERO;
  pos.this_thread()->optimism[WHITE] = VALUE_ZERO;
  pos.this_thread()->optimism[BLACK] = VALUE_ZERO;

  // KS-3648 / ADR-107 rev 2 §3 + §2.4. Pawn-кэш в `Pawns::probe`
  // вызывает `evaluate<NO_TRACE>` — для trace нужно отдельным
  // проходом перебрать обе стороны с TRACE и эмитить 7 + 4
  // подкомпоненты пешек/щита. Делается ДО `Evaluation<TRACE>` чтобы
  // pawn-subterms лежали в накопителе раньше piece/king/threats
  // (для удобства чтения JSON, порядок результата не критичен).
  Pawns::trace_for<WHITE>(pos);
  Pawns::trace_for<BLACK>(pos);

  Value v = Evaluation<TRACE>(pos).value();
  v = pos.side_to_move() == WHITE ? v : -v;

  // KS-3648 Phase 10: PSQT-разметка. PSQT::psq[piece][square]
  // содержит mg/eg-таблицу позиционной премии за каждую фигуру на
  // каждом квадрате. SF использует это как часть pos.psq_score().
  // Цикл по всем 64 квадратам: для непустых клеток эмитим
  // SUBT_PSQT_<piece-type> с color=владельца, square=клетки.
  for (int sqIdx = 0; sqIdx < SQUARE_NB; ++sqIdx)
  {
      Square sq = Square(sqIdx);
      Piece pc = pos.piece_on(sq);
      if (pc == NO_PIECE) continue;
      Color pcColor = color_of(pc);
      PieceType pt = type_of(pc);
      Score psqtVal = PSQT::psq[pc][sq];
      Subterm id;
      switch (pt) {
          case PAWN:   id = Eval::SUBT_PSQT_PAWN;   break;
          case KNIGHT: id = Eval::SUBT_PSQT_KNIGHT; break;
          case BISHOP: id = Eval::SUBT_PSQT_BISHOP; break;
          case ROOK:   id = Eval::SUBT_PSQT_ROOK;   break;
          case QUEEN:  id = Eval::SUBT_PSQT_QUEEN;  break;
          case KING:   id = Eval::SUBT_PSQT_KING;   break;
          default: continue;
      }
      // PSQT::psq для чёрных фигур уже инвертирован (см.
      // psqt.cpp::init: psq[~pc][flip_rank(s)] = -psq[pc][s]).
      // Значит psqtVal уже POV pcColor с правильным знаком —
      // эмитим как есть.
      Eval::add_subterm(id, pcColor, psqtVal, sq);
  }

  ss << std::showpoint << std::noshowpos << std::fixed << std::setprecision(2);

  ss << "{\"position\":{\"fen\":\"" << pos.fen() << "\","
     << "\"sideToMove\":\""
     << (pos.side_to_move() == WHITE ? "w" : "b") << "\"},\n";

  ss << "  \"subterms\":[\n";
  for (size_t i = 0; i < subterms.size(); ++i) {
    ss << subterm_to_json(subterms[i]);
    if (i + 1 < subterms.size()) ss << ",";
    ss << "\n";
  }
  ss << "  ],\n";

  Score total = scores[TOTAL][WHITE];
  ss << "  \"total\":{"
     << "\"mg\":" << to_cp(mg_value(total))
     << ",\"eg\":" << to_cp(eg_value(total))
     << ",\"v\":" << to_cp(v)
     << "}\n";

  ss << "}";

  return ss.str();
}

} // namespace Stockfish
