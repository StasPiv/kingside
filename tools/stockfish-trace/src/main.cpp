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

#include <iostream>

#include "bitboard.h"
#include "endgame.h"
#include "position.h"
#include "psqt.h"
#include "search.h"
#include "syzygy/tbprobe.h"
#include "thread.h"
#include "tt.h"
#include "uci.h"

#ifdef __EMSCRIPTEN__
  #include <emscripten/emscripten.h>
#endif

using namespace Stockfish;

int main(int argc, char* argv[]) {
#ifdef __EMSCRIPTEN__
  // KS-3676 / ADR-107 rev 2. По данным diag2 (прямое чтение
  // `PopCnt16[1] [3] [7] [255]`, `SquareDistance[A1][H8]/[A1][B2]`,
  // `LineBB[A1][H8]`, `BetweenBB[A1][C3]`, `PSQT::psq[W_KNIGHT][D4]`):
  // все 9 значений в основном потоке worker'а ≡ 0. Изоляция памяти
  // между `_main_thread` pthread (где исполняется `main()` под
  // `PROXY_TO_PTHREAD=1`) и основным потоком worker'а (где работает
  // `ccall('uci_command', ...)`) подтверждена. Глобальные статические
  // таблицы Stockfish, заполненные в pthread main через `Bitboards::init`/
  // `PSQT::init` и т.п., не видны в потоке ccall.
  //
  // Решение — НЕ выполнять init-цепочку в pthread main; перенести её
  // в обёртку `uci_command` (см. uci.cpp), которая исполняется ИМЕННО
  // в основном потоке worker'а. main() здесь только держит pthread
  // живым через `emscripten_exit_with_live_runtime()`:
  //   - не возвращается из main() → не дёргается proxy-цепочка
  //     `exitJS → withStackSave`, которая давала `remainder by zero`
  //     (закрывает devops follow-up #2);
  //   - runtime остаётся живым, последующие ccall работают;
  //   - pthread main продолжает спать, не потребляет CPU.
  //
  // Параметры argc/argv нам не нужны (CommandLine::binaryDirectory
  // используется только в NNUE-file-probe, у нас принудительно
  // classical-mode).
  (void)argc; (void)argv;
  emscripten_exit_with_live_runtime();
  return 0; // not reached
#else
  std::cout << engine_info() << std::endl;

  CommandLine::init(argc, argv);
  UCI::init(Options);
  Tune::init();
  PSQT::init();
  Bitboards::init();
  Position::init();
  Bitbases::init();
  Endgames::init();
  Threads.set(size_t(Options["Threads"]));
  Search::clear(); // After threads are up
  Eval::NNUE::init();

  UCI::loop(argc, argv);

  Threads.set(0);
  return 0;
#endif
}
