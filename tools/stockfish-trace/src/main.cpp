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

  // KS-3676 / ADR-107 rev 2. В WASM-сборке нужно НЕ применять флаг
  // emcc `-s PROXY_TO_PTHREAD=1`. С ним `main()` запускается в
  // отдельном `_main_thread` pthread, ccall — в основном потоке
  // исполнителя; static-таблицы Stockfish получают изоляцию между
  // этими потоками (подтверждено командой `diag2`: все 9 пробных
  // значений PopCnt16/SquareDistance/LineBB/BetweenBB/PSQT::psq в
  // ccall-потоке == 0, в pthread main — корректные). Без
  // PROXY_TO_PTHREAD `main()` выполняется в том же основном потоке
  // исполнителя, где затем работает ccall, изоляции нет.
  //
  // `return 0` при `-s EXIT_RUNTIME=0` (см. 0004 EMFLAGS) оставляет
  // runtime живым: pthread-стек/heap/static не очищаются, последующие
  // ccall'ы обращаются к тем же таблицам, что заполнила init-цепочка
  // ниже. `Threads.set(0)` в WASM не вызываем — нет stdin-EOF, нет
  // «конца сессии», воркер завершают сверху через `worker.terminate()`.
  //
  // Предыдущая попытка `emscripten_exit_with_live_runtime()` (коммит
  // a41ee7ff) под сохранённым `-s PROXY_TO_PTHREAD=1` давала
  // взаимоблокировку: pthread main спит, ccall-proxy ждёт обработки
  // в его очереди (никто не обрабатывает) → ccall зависает. Эта
  // правка убирает оба условия (init возвращается в main(), ccall
  // больше не нуждается в проксировании).
  std::cout << engine_info() << std::endl;

  CommandLine::init(argc, argv);
  UCI::init(Options);
  Tune::init();
  PSQT::init();
  Bitboards::init();
  Position::init();
  Bitbases::init();
#ifndef __EMSCRIPTEN__
  // Endgames::init пропущен в WASM: ранее давал падение в
  // `unordered_map::__do_rehash` (по гипотезе изоляции кучи между
  // pthread main и основным потоком исполнителя). Сейчас, без
  // PROXY_TO_PTHREAD, изоляции быть не должно — но смысла включать
  // endgame-таблицы для `eval json` всё равно нет, оставляем
  // пропуск как способ уменьшить рабочую копию памяти.
  // `Material::probe` через `Endgames::probe<Value>(key)` получит
  // nullptr из пустого `endgameFunctions` — штатный путь classical-
  // оценки.
  Endgames::init();
#endif
  Threads.set(size_t(Options["Threads"]));
#ifndef __EMSCRIPTEN__
  // Search::clear дёргает TT.clear и Tablebases::init — для
  // `eval json` ни то, ни другое не нужно.
  Search::clear();
#endif
  Eval::NNUE::init();

#ifndef __EMSCRIPTEN__
  UCI::loop(argc, argv);
  Threads.set(0);
#endif
  return 0;
}
