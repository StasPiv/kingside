# ADR-107 — Извлечение детальных позиционных подкомпонент Stockfish через ответвление SF 16

Статус: предложен (KS-3644), редакция 2 (rev 1 ошибочно предлагала JS-эвристику вместо доступа к SF-подкомпонентам — отозвано).
Дата: 2026-06-03.
Связано: ADR-103 rev 3 (LLM-комментарии MVP-2: `positional_shifts` через WASM SF 16 — агрегат из 13 терминов), KS-3623 (`extractFacts.ts` — tactical_motifs).

## 1. Контекст

Stockfish внутри `evaluate.cpp` / `pawns.cpp` считает много отдельных позиционных подкомпонент. Через UCI команду `eval` в classical-режиме (`Use NNUE = false`) наружу выходят **только 13 агрегатов** (MATERIAL, IMBALANCE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, MOBILITY, KING, THREAT, PASSED, SPACE, WINNABLE; см. `evaluate.cpp:154` — `enum Term` в `namespace Trace`).

Пользователь хочет видеть в разборе партии **именно подкомпоненты** — изолированную пешку c4 с привязкой к квадрату, плохой слон h2 с количеством пешек на цвете, форпост на d5 со scaling-фактором, конкретный safe-check от ладьи и так далее. Запрос — доступ к настоящим cp-числам из SF, а не к нашей эвристике, аппроксимирующей похожие категории.

KS-3644 — анализ: что реально считается в SF, как это вытащить, во сколько обойдётся, лицензионные обязательства.

## 2. Что внутри SF 16: фактическая инвентаризация

Источник: `git clone --branch sf_16 https://github.com/official-stockfish/Stockfish` в `/tmp/stockfish-sf16`. Все ссылки ниже — на конкретные строки в этом дереве.

### 2.1. Текущий `Trace` API (evaluate.cpp:150–187)

```cpp
namespace Trace {
  enum Tracing { NO_TRACE, TRACE };
  enum Term {            // первые 8 — это PieceType (PAWN..KING)
    MATERIAL = 8, IMBALANCE, MOBILITY, THREAT, PASSED, SPACE, WINNABLE, TOTAL, TERM_NB
  };
  Score scores[TERM_NB][COLOR_NB];     // плоский массив 16×2
  static void add(int idx, Color c, Score s);
  static void add(int idx, Score w, Score b = SCORE_ZERO);
}
```

Вызовы `Trace::add` в коде (8 мест):
- `evaluate.cpp:523` — `Pt` (одна из KNIGHT/BISHOP/ROOK/QUEEN, всего 4 вызова на каждый цикл по фигурам).
- `evaluate.cpp:623` — KING (агрегат king safety).
- `evaluate.cpp:724` — THREAT (агрегат всех угроз).
- `evaluate.cpp:817` — PASSED (агрегат проходных).
- `evaluate.cpp:858` — SPACE.
- `evaluate.cpp:954–955` — WINNABLE, TOTAL.
- `evaluate.cpp:1028–1031` — MATERIAL, IMBALANCE, PAWN, MOBILITY (в функции `Eval::trace`).

Никаких других `Trace::add`-вызовов нет. То есть **наружу выходят ровно 13 терминов**, всё остальное складывается в эти агрегаты внутри функций.

### 2.2. Подкомпоненты, агрегируемые в каждый из 13 терминов

Точная инвентаризация по строкам кода (где `score += / -=` накапливается):

**Pawns** — `pawns.cpp:30–198`, локальная `evaluate<Color>`:

| Подкомпонента | Строка | Константа |
|---|---|---|
| `DoubledEarly` | :135 | `S(17, 7)` |
| `Connected[r] × phalanx/opposed factor + 22·support` | :168 | array[7] |
| `Doubled` (opposed, no neighbour) | :179 | `S(11, 51)` |
| `Isolated + WeakUnopposed · !opposed` | :181 | `S(1, 20) + S(15, 18)` |
| `Backward + WeakUnopposed · …` | :186 | `S(6, 19)` |
| `Doubled · doubled + WeakLever · multi-lever` | :190 | `S(11, 51) + S(2, 57)` |
| `BlockedPawn[r−5]` | :194 | `S(−19, −8)` / `S(−7, 3)` |

Плюс **shelter/storm** (`pawns.cpp:230–263`, `evaluate_shelter`):

| Подкомпонента | Строка | Константа |
|---|---|---|
| `ShelterStrength[edge][rank]` | :251 | matrix `4×8` |
| `BlockedStorm[rank]` (если своя пешка непосредственно перед чужой) | :254 | array[8] |
| `UnblockedStorm[edge][rank]` | :256 | matrix `4×8` |
| `KingOnFile[semi-open us][semi-open them]` | :260 | matrix `2×2` |

**Pieces** — `evaluate.cpp:384–526`, цикл по фигурам:

| Подкомпонента | Строка | Константа | Применима к |
|---|---|---|---|
| `RookOnKingRing` | :423 | `S(16, 0)` | ROOK |
| `BishopOnKingRing` | :426 | `S(24, 0)` | BISHOP |
| `UncontestedOutpost · pawn_count` | :443 | `S(0, 10)` | KNIGHT (side outpost) |
| `Outpost[N/B]` | :445 | `S(54, 34)` / `S(31, 25)` | KNIGHT / BISHOP |
| `ReachableOutpost` | :447 | `S(33, 19)` | KNIGHT |
| `MinorBehindPawn` | :451 | `S(18, 3)` | KNIGHT / BISHOP |
| `−KingProtector · distance(king, sq)` | :454 | `S(9, 9) / S(7, 9)` | KNIGHT / BISHOP |
| `−BishopPawns[edge_dist] · pawns_on_same_color · (1 + blocked_center)` | :463 | array[4] | BISHOP (плохой слон) |
| `−BishopXRayPawns · count` | :467 | `S(4, 5)` | BISHOP |
| `LongDiagonalBishop` | :471 | `S(45, 0)` | BISHOP |
| `−CorneredBishop` (Chess960) | :481 | `S(50, 50) × 3 или 4` | BISHOP |
| `RookOnOpenFile[their semi-open]` | :492 | `S(18, 8)` / `S(49, 26)` | ROOK |
| `−RookOnClosedFile` | :501 | `S(10, 5)` | ROOK |
| `−TrappedRook · (1 + !castling)` | :509 | (внутри) | ROOK |
| `−WeakQueen` (рентген на ферзя) | :519 | (внутри) | QUEEN |

**King** — `evaluate.cpp:531–626`:

| Подкомпонента | Строка | Описание |
|---|---|---|
| `pe->king_safety()` (shelter + storm) | :544 | агрегат из pawns.cpp |
| `kingDanger` composite | :598–609 | сумма из 10 слагаемых: `kingAttackersCount · weight`, `183·popcount(weak ring)`, `148·popcount(unsafe checks)`, `98·blockers`, `69·kingAttacksCount`, `flankAttack²/8 + 3·…`, `mg(mobility diff)`, `-873·!enemyQueen`, `-100·N+K coverage`, `-6·mg(score)/8`, `-4·flankDef`, `+37` |
| `−SafeCheck[ROOK][single/multi]` | :561 | `{805, 1292}` |
| `−SafeCheck[QUEEN][…]` | :570 | `{650, 984}` |
| `−SafeCheck[BISHOP][…]` | :577 | `{1071, 1886}` |
| `−SafeCheck[KNIGHT][…]` | :585 | `{730, 1128}` |
| `−PawnlessFlank` | :617 | `S(19, 97)` |
| `−FlankAttacks · kingFlankAttack` | :620 | `S(8, 0)` |

**Threats** — `evaluate.cpp:632–727`:

| Подкомпонента | Строка | Константа |
|---|---|---|
| `ThreatByMinor[piece type]` (loop) | :661 | array[6] |
| `ThreatByRook[piece type]` (loop) | :665 | array[6] |
| `ThreatByKing` (на слабую фигуру под атакой короля) | :668 | `S(24, 87)` |
| `Hanging · popcount(weak ∧ undefended)` | :672 | `S(72, 40)` |
| `WeakQueenProtection · popcount(weak ∧ defended only by queen)` | :675 | (внутри) |
| `RestrictedPiece · popcount(restricted moves)` | :682 | `S(6, 7)` |
| `ThreatBySafePawn · popcount` | :690 | `S(167, 99)` |
| `ThreatByPawnPush · popcount` | :701 | `S(48, 39)` |
| `KnightOnQueen · popcount · (1 + queenImbalance)` | :715 | `S(16, 11)` |
| `SliderOnQueen · popcount · (1 + queenImbalance)` | :720 | `S(62, 21)` |

**Passed** — `evaluate.cpp:732–820`:

| Подкомпонента | Строка | Константа |
|---|---|---|
| `PassedRank[r]` (база) | :769 | array[8] |
| King-proximity adjust | :777–782 | формула |
| Path-advance bonus (`k`) | :799–809 | k ∈ {0, 7, 17, 30, 36} плюс +5 если block-square защищён |
| `−PassedFile · edge_distance` | :813 | `S(13, 8)` |

**Space** — `evaluate.cpp:828–859`: один интегральный счёт `popcount(safe) + popcount(behind ∧ safe ∧ ~attackedByThem)`, умноженный на динамический `weight`.

**Итого подкомпонент: ~40–45**, многие с привязкой к конкретному квадрату/файлу (Outpost-square, BishopPawns по слону, RookOnOpenFile по файлу, Hanging по списку фигур, PassedRank по квадрату пешки).

### 2.3. Tracing-инфраструктура — что нужно дописать

Текущий `Trace::add` — плоская матрица `scores[16][2]`. Чтобы хранить per-square информацию (без неё подкомпоненты теряют 90% смысла — «плохой слон» без указания квадрата бесполезен), нужно:

- Расширить `enum Term` с 16 до ~60 идентификаторов.
- Заменить `Score scores[TERM_NB][COLOR_NB]` структурой `std::vector<TracedItem>` где `TracedItem = {term_id, color, square_or_file, score}`. Либо более компактный массив `vector<Score>` для каждого term с дополнительным `vector<Square>`.
- В каждом `score += / -=` в коде (37 точек в evaluate.cpp + 7 в pawns.cpp) добавить `if constexpr (T) Trace::add(SUB_TERM, Us, square, delta)`. Делается через макрос-обёртку, чтобы не плодить условные блоки.
- Расширить функцию `Eval::trace(Position&)` (evaluate.cpp:1092–1158) — вместо текущей таблицы 13×3 эмитить JSON-структуру со всеми подкомпонентами.
- Добавить UCI команду `eval json` (или `eval verbose`) в `uci.cpp:282`, чтобы machine-readable вывод не ломал текущий `eval`-формат.

### 2.4. Сложность с `Pawns::Entry` кэшем

Pawn-оценка кэшируется по `pawn_key` (pawns.cpp:210–224, `Pawns::probe`). Функция `evaluate<Color>` в `namespace { ... }` (анонимном) **не имеет `template<Tracing T>`** — она просто возвращает скалярный `score`. То есть в текущей архитектуре подкомпоненты пешек теряются до выхода из этой функции, и затем извлекаются только агрегатом `pe->pawn_score(WHITE/BLACK)`.

Чтобы вытащить per-square пешечные подкомпоненты, нужно одно из:
1. Вынести `evaluate<Color>` из anonymous namespace и параметризовать `template<Tracing T>`. В режиме TRACE — обходить кэш, эмитить per-square в Trace. Объём: ~80 LOC правки.
2. Завести `thread_local bool TraceMode` и в TRACE-режиме игнорировать кэш + эмитить per-square. Чуть короче, но добавляет глобал.

Оба варианта рабочие, выбор — на этапе реализации.

### 2.5. Альтернативные движки и форки

Я не лазил в их исходники сейчас; вывод по доступной литературе о проекте:

- **Ethereal** (GPL-3) — собственный classical eval с похожим объёмом подкомпонент. WASM-сборки в основной ветке нет. Если форкать его — те же C++-усилия плюс делать WASM с нуля. Не дешевле SF.
- **Komodo, Houdini, Stoofvlees** — closed source.
- **Lc0, Berserk, Koivisto** — NNUE only, classical decomposition отсутствует.
- **Crystal**, **Brainfish** и прочие SF-форки — те же 13 терминов в Trace (тот же базовый код).

Готовых движков, выводящих подкомпоненты прямо из коробки, нет.

## 3. Решение — ответвление SF 16 с расширением `Trace`

### 3.1. Why SF 16, not SF 15.1 (наш системный)

- SF 16 — последняя ветка с classical fallback (`Use NNUE = false`). SF 17/18 classical-evaluator удалён из исходников полностью.
- SF 16 — текущая база для `lichess-org/stockfish.wasm` (WASM-сборка для браузера), на которую мы и так смотрим в ADR-103 rev 3 для `positional_shifts`. Унификация версии.
- Между 15.1 и 16 differences в подкомпонентах минимальные — для нашей задачи безразлично.

### 3.2. План правки

1. **Расширить enum Term** с ~16 до ~60 идентификаторов (по таблицам §2.2).
2. **Заменить `Trace::scores[16][2]`** на структуру с per-square ёмкостью.
3. **Вставить `Trace::add(SUB_TERM, Us, sq, delta)`** в 37 точек evaluate.cpp и 7 точек pawns.cpp (через макрос-обёртку для уменьшения визуального шума).
4. **Параметризовать `pawns.cpp::evaluate<Color>`** через `template<Tracing T>`, обходить кэш в TRACE-режиме.
5. **Переписать `Eval::trace(Position&)`** — JSON-сериализация всех подкомпонент. Сохранить текущую табличную форму как `eval` для совместимости, новый формат — на `eval json`.
6. **Добавить UCI диспетчер `eval json`** в `uci.cpp:282`.
7. **Тесты**: сверка summы подкомпонент с агрегатом по каждому из 13 терминов (инварианты), плюс несколько тестовых FEN со снимком ожидаемого JSON.

### 3.3. WASM-сборка

База — `lichess-org/stockfish.wasm` (это публичный fork SF 16/16.1 под emscripten с `Makefile.emscripten`). Действия:
1. Форкнуть `lichess-org/stockfish.wasm` (а не основной SF), наложить наш патч поверх `src/`.
2. Собрать через docker emscripten (документировано у lichess) — получаем `stockfish-nnue-16.wasm` + JS-glue.
3. Положить в `apps/web/public/stockfish/stockfish-16-trace.{js,wasm}` (отдельно от существующего `stockfish-16-lite.{js,wasm}` из ADR-103, чтобы не ломать `positional_shifts`).
4. Размер: ~2–3 МБ (lazy-load по требованию «Разобрать партию»).

Время сборки и тестов: 1 рабочий день, включая локальную проверку через `node` + headless.

### 3.4. TS-парсер на фронте

Worker-обёртка `apps/web/src/lib/review/stockfishTrace.ts`:

```ts
interface TraceJson {
  position: { fen: string; sideToMove: 'w' | 'b' };
  terms: TraceTerm[];
  total: { mg: number; eg: number; v: number };
}
interface TraceTerm {
  id: string;                 // 'pawn_isolated' | 'bishop_pawns' | ...
  color: 'w' | 'b';
  square?: string;            // 'h2' для per-square (BishopPawns)
  file?: string;              // 'd' для RookOnOpenFile
  mg: number;
  eg: number;
  total: number;              // в pawn-units
}
```

Парсер JSON из UCI-вывода + типизированный API. Объём: ~150–200 LOC + тесты.

### 3.5. Интеграция в `FactsInput`

Расширить `FactsInput` (`packages/shared/src/types/api-contracts.ts`) новым полем:

```ts
positional_subterms: PositionalSubterm[]
```

где `PositionalSubterm = { id, color, square?, file?, cp_mg, cp_eg }`. Это **сырые числа из SF**, не наша эвристика. LLM-prompt получит их вместе с существующими `positional_shifts` (агрегатные дельты) — комбинация даёт и категорию (id+square), и численную силу (cp).

### 3.6. Соотнесение с человеческими ярлыками

Для prompt'а LLM каждый `PositionalSubterm.id` маппится на человеческое описание:
- `bishop_pawns h2` (cp_mg=−14, cp_eg=−21) → «слон h2 заперт пешками на белых полях».
- `pawn_isolated c4` (cp_mg=−1, cp_eg=−20) → «изолированная пешка c4».
- `rook_on_open_file d` (cp_mg=49, cp_eg=26) → «ладья на открытой линии d».
- `outpost_knight d5` (cp_mg=54, cp_eg=34) → «конь на форпосте d5».
- И так далее — отдельная константа-таблица `subterm-labels.ts` (RU + EN).

Few-shot пары prompt'а V2 расширяются 2–3 примерами с такими тегами.

## 4. Лицензия GPL-3

**Backend subprocess** (`/usr/games/stockfish`, наш subprocess через `apps/tactic-worker/src/stockfish/stockfish.service.ts`): SF и приложение — отдельные программы, общение по стандартному UCI-IPC. GPL не задевает наш код. Текущая практика проекта.

**WASM-бинарь** на фронте (`apps/web/public/stockfish/stockfish-16-trace.wasm`):

| Что | Требование |
|---|---|
| Сам WASM-бинарь | производное произведение от SF, **под GPL-3** |
| Наш fork исходников | публичный репозиторий под GPL-3 |
| Рядом с бинарём в публичной выдаче | файл `COPYING.txt` (текст GPL-3) + ссылка на репозиторий fork'а |
| Наш TS/JS-код, общающийся с WASM через postMessage | **отдельная программа** (aggregate), copyleft не задевает |
| `package.json` / Apache/MIT файлы остального проекта | без изменений |

Прецеденты: Lichess, chess.com раздают `stockfish.wasm` в проприетарных продуктах по этой схеме. Конкретно `lichess-org/stockfish.wasm` — публичный fork под GPL-3, остальной код Lichess — отдельная лицензия.

Действия по соблюдению лицензии:
1. Завести публичный репозиторий `kingside/stockfish-trace` (форк от `lichess-org/stockfish.wasm`).
2. В корне репозитория — текст GPL-3 (как уже есть в SF).
3. В `apps/web/public/stockfish/` рядом с бинарём положить `STOCKFISH_LICENSE.txt` со ссылкой на наш fork + копией GPL-3.
4. В README проекта Kingside — раздел «Third-party engine» с описанием.

## 5. Стоимость

Реальная оценка (после анализа кода, не догадки):

| Этап | Объём | Время |
|---|---|---|
| C++ патч SF 16 (enum, Trace struct, 44 точек вставки, pawns.cpp параметризация, JSON-вывод, UCI команда) | ~600–800 LOC дифф | 5–7 дней |
| WASM-сборка (форк lichess.wasm + наш патч + проверка) | сборочный конфиг | 1 день |
| TS-парсер `stockfishTrace.ts` + Worker-обёртка | ~200 LOC + тесты | 1 день |
| Расширение `FactsInput` + интеграция в `extractFacts.ts` + `useGameReview.ts` | ~150 LOC | 0.5–1 день |
| Few-shot prompt V2: 2–3 примера с новыми тегами + subterm-labels.ts | ~80 LOC + тесты | 0.5–1 день |
| Licensing: публичный fork + LICENSE-файлы + README | организационное | 0.25 дня |
| **Итого** | | **9–12 рабочих дней** |

Это **разовая** работа. После — поддержка ограничена: SF 17+ classical выпилен, ветка SF 16 не развивается, апстрим-патчи не приедут.

## 6. Декомпозиция

**C1 — C++/инфра, ~7 дней. Ответвление SF 16 + расширенный Trace.**
- Публичный fork `kingside/stockfish-trace` от `lichess-org/stockfish.wasm`.
- Патч `src/evaluate.cpp` + `src/pawns.cpp` + `src/uci.cpp` по плану §3.2.
- WASM-сборка через emscripten, артефакт `stockfish-16-trace.{js,wasm}` ~2–3 МБ.
- Тесты-инварианты (сумма подкомпонент = агрегат соответствующего из 13 терминов).
- Снимок JSON для 5 эталонных FEN.
- Метки: `analysis`, `infra`.
- Исполнитель: backend или специально приглашённый C++ engineer (в команде такого нет — нужно решение пользователя, кто).

**F1 — frontend, ~1 день. Worker + парсер + lazy-load.**
- `apps/web/src/lib/review/stockfishTrace.ts` — Worker, парсер JSON, типизированный API.
- Lazy-load бинаря из `apps/web/public/stockfish/stockfish-16-trace.{js,wasm}`.
- Юнит-тесты на парсер.
- Метки: `analysis`, `performance`.

**F2 — frontend, ~0.5 дня. `FactsInput` + интеграция.**
- В `packages/shared` тип `PositionalSubterm` + `positional_subterms: PositionalSubterm[]` в `FactsInput`.
- `extractFacts.ts` — вызов `stockfishTrace.evaluate(fen)` и запись subterms в факты.
- `useGameReview.ts` — прокидка.
- Метки: `analysis`.

**B1 — backend, ~1 день. Prompt V2 + subterm-labels.**
- `apps/web/src/lib/review/subterm-labels.ts` (RU + EN таблица для каждого `PositionalSubterm.id`).
- В `apps/api/src/analysis-review/review-comment.service.ts` (ветка `REVIEW_COMMENT_V2=on`) — 2–3 новых few-shot примера с subterm-тегами; обновление инструкций prompt'а («когда есть subterm с cp_mg ≤ −10 на конкретном квадрате — обязательно объясни причину»).
- Тесты на prompt и на labels.
- Метки: `analysis`, `chat`.

**D1 — devops/legal, ~0.25 дня. Лицензионная обвязка.**
- Подключить `STOCKFISH_LICENSE.txt` к раздаче `apps/web/public/stockfish/`.
- README — раздел «Third-party: Stockfish (GPL-3)» со ссылкой на наш fork.
- Метки: `infra`.

### Зависимости

```
C1 ──┬─> F1 ──> F2 ──> B1
     └─> D1
```

C1 — критический путь (5–7 дней), всё остальное параллельно/после. Полный срок ~7–9 рабочих дней с минимальным распараллеливанием.

## 7. Известные минусы и риски

- **Объём C++ работы значительный** (~7 дней). В команде нет специалиста по SF; либо делает backend (с погружением в чужой C++), либо приглашаем со стороны.
- **Тестирование** — инвариант «сумма подкомпонент = агрегат» нетривиален, потому что в SF есть `LazyThreshold1/2` (раннее завершение, evaluate.cpp:995, :1015) — в trace-режиме придётся принудительно отключить lazy-skip для воспроизводимости.
- **Размер WASM** — ещё +2–3 МБ к раздаче. Lazy-load по требованию «Разобрать партию» уменьшает влияние на initial bundle.
- **Поддержка форка** — bug-fix'ы upstream к SF 16 не приедут (ветка не развивается). Если найдётся баг в самом SF 16 — фиксим сами.
- **Lichess WASM-сборка** опирается на конкретную версию emscripten; апгрейд emscripten может потребовать корректировки Makefile.
- **Pawn cache** в TRACE-режиме отключается → trace-вызов в ~2 раза медленнее обычного `eval`. Для нашего use-case (один вызов на ply разбора партии) допустимо.

## 8. Откат

- При срыве C1 — временно вернуться к существующему `positional_shifts` (агрегатам из 13 терминов через `lichess-org/stockfish.wasm`, ADR-103 rev 3). LLM-prompt продолжит работать на менее детальных данных. Никакой части продукта не сломается.
- Поле `positional_subterms` в `FactsInput` — необязательное; если пустое — prompt просто не использует subterm-теги.

## 9. Что я **проверил по факту**, а не по памяти

- Прочитал `evaluate.cpp` (строки 140–270, 350–960, 980–1158 — все ключевые блоки) и `pawns.cpp` целиком в SF 16.
- Выписал все 8 точек `Trace::add` + 44 точки `score += / −=` с привязкой к строкам.
- Извлёк все константы штрафов/бонусов (BishopPawns, Outpost, RookOnOpenFile, ThreatByMinor/Rook, PassedRank, ShelterStrength, и так далее).
- Проверил UCI-диспетчер (`uci.cpp:282 token == "eval"` → `trace_eval` → `Eval::trace`).
- Подтвердил отсутствие альтернативных UCI-команд для подкомпонент.
- Подтвердил архитектурный блокер с pawn-кэшем (анонимный namespace, без template-параметра Tracing).

Я **не** проверял:
- Лицензионную совместимость с конкретным юристом — пользуюсь общеизвестной практикой Lichess/chess.com. Если есть требование формального юр-разбора — отдельный шаг до C1.
- Точную скорость emscripten-сборки на нашей сборочной среде — оценка «1 день» по документации `lichess-org/stockfish.wasm`.
- Время C++ разработчика в команде — это решение пользователя (нанимать / делать своими силами).

## 10. Резюме

Stockfish внутри считает ~40–45 позиционных подкомпонент с привязкой к квадратам/файлам, но через UCI отдаёт только 13 агрегатов. Чтобы вытащить — нужно расширение `Trace`-инфраструктуры в `evaluate.cpp` + `pawns.cpp` (объём ~600–800 LOC), сборка собственного WASM-бинаря через emscripten (на базе `lichess-org/stockfish.wasm`), парсер на TS и интеграция в `FactsInput`. Лицензия GPL-3 разрешает при публичном fork'е и ссылке рядом с бинарём; прецеденты — Lichess, chess.com.

Реальная стоимость — 9–12 рабочих дней, разово. Долгосрочная зависимость минимальна: SF 16 — финальная ветка classical eval, апстрим-патчи не приедут, поддерживаем сами.

Альтернатива «считать самим на JS» отвергается: пользователь явно запрашивает cp-числа SF, а не нашу эвристику; категориальный сигнал без точных cp-цифр не отвечает на исходный запрос KS-3644.

Декомпозиция: C1 (C++/WASM, ~7 дней) → F1 (Worker/парсер) → F2 (`FactsInput`) → B1 (prompt + labels). D1 (лицензионная обвязка) параллельно.
