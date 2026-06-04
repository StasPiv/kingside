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

using namespace Stockfish;

int main(int argc, char* argv[]) {

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

  // KS-3676 / ADR-107 rev 2. В WASM-сборке UCI работает не через stdin,
  // а через JS → `ccall('uci_command', ...)` (см. `extern "C" uci_command`
  // в uci.cpp). `UCI::loop` пытался бы блокировать на `getline(cin, ...)`,
  // что в Web Worker без ASYNCIFY вешает рантайм. В WASM main() отрабаты-
  // вает только init-цепочку и возвращается; worker остаётся живым
  // благодаря `-s EXIT_RUNTIME=0` в EMFLAGS (см. 0004 patch), последу-
  // ющие команды идут через uci_command. `Threads.set(0)` тоже не вызы-
  // ваем — нет stdin-EOF, нет «конца сессии», worker завершают сверху
  // через `worker.terminate()`.
#ifndef __EMSCRIPTEN__
  UCI::loop(argc, argv);

  Threads.set(0);
#endif
  return 0;
}
