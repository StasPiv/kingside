/*
  Stockfish, a UCI chess playing engine derived from Glaurung 2.1
  Copyright (C) 2004-2023 The Stockfish developers (see AUTHORS file)
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
#ifdef __EMSCRIPTEN__
  // KS-3676: main() в WASM-сборке только возвращает 0. Вся
  // цепочка инициализации Stockfish перенесена в `uci_command`
  // init-once (см. uci.cpp): диагностика показала, что в ccall-
  // контексте Bitboards::init/PSQT::init из main() не оставляют
  // данных в видимых ccall глобалах (`diag2` → все нули даже без
  // -pthread/PROXY_TO_PTHREAD). Инициализация в init-once
  // гарантирует, что таблицы заполнены ровно в том module image,
  // где работает ccall.
  (void)argc; (void)argv;
  return 0;
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
  Search::clear();
  Eval::NNUE::init();

  UCI::loop(argc, argv);
  Threads.set(0);
  return 0;
#endif
}
