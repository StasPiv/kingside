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
#ifndef __EMSCRIPTEN__
  // KS-3676 / ADR-107 rev 2. Под emscripten пропускаем endgame-таблицы.
  // Devops отладочный след стека (`-g3 -s ASSERTIONS=1`):
  //   dlmalloc → operator new → unordered_map::__do_rehash →
  //     Endgames::add → Endgames::init → main
  // Падение на повреждении кучи (по гипотезе — раздельные heap arenas
  // между `_main_thread` под `PROXY_TO_PTHREAD=1` и основным потоком
  // ccall). Для нашего единственного сценария `eval json`
  // endgame-таблицы не нужны: `Material::probe` через
  // `Endgames::probe<Value>(key)` получит nullptr из пустого
  // `endgameFunctions` — это штатное «нет специальной функции для
  // этого материала», EVALUATE идёт по обычной классической оценке.
  Endgames::init();
#endif
  Threads.set(size_t(Options["Threads"]));
#ifndef __EMSCRIPTEN__
  // KS-3676. Search::clear дёргает Threads.main()->wait_for_search_finished
  // (в WASM возвращается мгновенно, ОК), TT.clear (heap-heavy при
  // повреждённой куче) и Tablebases::init (file-probe — не работает
  // при FILESYSTEM=0). Для eval json ни одно из трёх не нужно.
  Search::clear(); // After threads are up
#endif
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
