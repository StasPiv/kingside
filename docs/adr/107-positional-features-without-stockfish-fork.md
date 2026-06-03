# ADR-107 — Детальные позиционные признаки: расширение JS-детектора вместо fork'а Stockfish

Статус: предложен (KS-3644).
Дата: 2026-06-03.
Связано: ADR-103 rev 3 (LLM-комментарии MVP-2: `positional_shifts` через WASM SF 16), ADR-105 (NAG-постобработка), KS-3623 (`extractFacts.ts` — tactical_motifs).

## 1. Контекст

Stockfish внутри `evaluation.cpp` / `pawns.cpp` / `pieces.cpp` / `king.cpp` / `threats.cpp` / `passed.cpp` / `space.cpp` считает много отдельных позиционных подкомпонент (isolated/doubled/passed/backward pawns, outposts, weak squares, open/semi-open files, bishop pawn count, king shelter/storm, threat-by-minor/-by-rook/-by-pawn и так далее). На выходе `UCI eval` в classical-режиме они **схлопываются в 13 агрегатных терминов** (Material, Imbalance, Pawns, Knights, Bishops, Rooks, Queens, Mobility, King safety, Threats, Passed, Space, Winnable; см. ADR-103 §6 — фиксация).

Пользователь хочет в разборе партии видеть человеческие объяснения именно подкомпонент («плохой слон h2», «слабая клетка d5», «открытая линия e», «изолированная пешка c4»), а не агрегатов.

KS-3644 — анализ: можно ли вытащить подкомпоненты дёшево, или придётся ответвлять SF.

## 2. Что внутри SF 15/16 и доступно ли через UCI

### 2.1. Стандартный SF не выводит подкомпоненты

Проверено локально (`/usr/games/stockfish`, SF 15.1, `setoption name Use NNUE value false; position …; eval`): на выходе ровно те 13 терминов, что и описаны выше. Команд `trace`, `eval verbose`, `eval json`, `eval detail` нет (`Unknown command`).

В исходниках есть структура `Trace` (см. `evaluation.cpp` в SF 15/16, `namespace Trace`), но она:
- содержит ровно те же 13 терминов (MATERIAL, IMBALANCE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, MOBILITY, THREAT, PASSED, SPACE, KING, WINNABLE), плюс TOTAL;
- активна только при compile-time флаге `-DUSE_DEBUG_TRACE` (или эквивалент в конкретной версии), которого нет в стандартной сборке.

То есть **штатного способа** получить разложение Pawns на isolated/doubled/passed/backward или Bishops на trapped/long-diagonal/pawn-count **нет**.

### 2.2. Подкомпоненты как локальные переменные кода

Все эти подкомпоненты считаются как локальные накопители внутри `pawns.cpp` / `pieces.cpp` / `king.cpp` / `threats.cpp`. Примеры по SF 15.1:

| Файл | Подкомпоненты (фрагмент) |
|---|---|
| `pawns.cpp` | Isolated, Backward, Doubled, Connected[7][2], WeakUnopposed, WeakLever, BlockedPawn[2], passed-pawn маска для span |
| `pieces.cpp` | Outpost[knight/bishop], ReachableOutpost, MinorBehindPawn, BishopPawns (количество пешек на цвете слона), LongDiagonalBishop, TrappedBishopA8/H8/A7/H7, RookOnFile[open/semi-open], TrappedRookByKing, KingProtector |
| `king.cpp` | ShelterStrength, StormDanger, KingAttackersCount/Weight, KingAttacksCount, WeakSquares around king, SafeChecks[knight/bishop/rook/queen], UnsafeChecks |
| `threats.cpp` | ThreatByMinor[type], ThreatByRook[type], ThreatByKing, Hanging, WeakQueen, RestrictedPiece, ThreatByPawnPush, ThreatBySafePawn, KnightOnQueen, SliderOnQueen |
| `passed.cpp` | PassedRank[r], PassedBlock, PassedFile, KingProximity |
| `space.cpp` | Safe space (число «безопасных» клеток за пешками на 2-4 рядах) |

Получить их **только** через ответвление и патч.

## 3. Способ извлечения — fork Stockfish

### 3.1. Объём работ

1. Добавить enum-список подкомпонент в `Trace`.
2. В каждом блоке `pawns.cpp` / `pieces.cpp` / … — вставить `Trace::add(component, color, score)` вокруг локальных накоплений.
3. Расширить вывод `eval` сериализацией расширенного `Trace` в текстовом или JSON-виде.
4. Собрать собственный бинарь и WASM-сборку (через emscripten — используется в `lichess-org/stockfish.wasm`, `nmrugg/stockfish.wasm`).
5. Раздать WASM рядом с проектом, держать репозиторий fork'а публично.

Объём: ~300–500 строк C++ патча + поддержание WASM-сборки в актуальном состоянии. Время C++ разработчика — 3–5 рабочих дней разово, плюс поддержка.

### 3.2. Поддержка

SF 17+ classical-evaluator выпилен, развития ветки SF ≤ 16 не будет. То есть fork — это **навсегда зафиксированная** ветка от SF 16. Обновлений сверху не приедет, но и поддержка падает (нет диффов с upstream'а).

### 3.3. Лицензия GPL-3

SF — GPL-3. Применительно к нам:

| Сценарий | GPL-обязательства |
|---|---|
| Backend subprocess (вызов `/usr/games/stockfish`) | Нет linkage, наш код не GPL. |
| Распространение WASM-бинаря пользователям через `apps/web/public/` | Это distribution. WASM-бинарь — производное произведение, обязан быть под GPL-3. Наш репозиторий fork'а **публичен под GPL-3**, рядом с WASM-бинарём — ссылка на исходники и текст лицензии. Сам же остальной код приложения (TS/React/NestJS) — отдельная программа, общается с движком через postMessage-IPC; это «aggregate», не «combined work» (та же логика, по которой Lichess и chess.com раздают SF-WASM в проприетарных продуктах). |
| Linkage в одном бинаре (например, статическая компиляция SF-кода в Node-модуль и распространение этого модуля) | Полностью GPL-3, не подходит. |

Вывод по лицензии: **не блокер**. Достаточно публичного fork'а + ссылки рядом с WASM. Сам фронт остаётся под нашей лицензией.

### 3.4. Альтернативные движки

- **Ethereal** (GPL-3): classical eval похожего объёма, WASM-сборки нет, нужно собирать самим.
- **Komodo / Houdini / Stoofvlees**: закрытый исходник, без бесплатной лицензии для нашего сценария.
- **Berserk, Koivisto, Lc0**: только NNUE, classical нет.
- **Crystal**, **Brainfish**, прочие fork'и SF: используют ту же `Trace`-структуру, ничего не дают сверх.

Альтернативных движков, отдающих подкомпоненты **из коробки**, не существует.

## 4. Альтернатива дешевле — расширить наш JS-детектор

Большая часть полезных подкомпонент для разбора **категориальная** (есть/нет признака с указанием квадрата/фигуры), а не численная. Их можно вычислять самим на `chess.js` без SF.

### 4.1. Что уже есть

`apps/web/src/lib/review/extractFacts.ts` (1170 строк, KS-3623 / ADR-103) уже содержит детекторы:

- Tactical motifs: fork, double_attack, pin, skewer, discovered_attack, back_rank_weak (`detectMotifs`).
- Висячая фигура: `findHangingPiece` с `attackers[]`, `defenders[]`, `net_material_if_taken`.
- Threats created/missed: `buildThreatsCreated`, `buildThreatsMissed` через статический материальный подсчёт.
- Stockfish best line (3 хода): `buildSfBestLine`.

Шкала «силы» для позиционных сдвигов — `positional_shifts` (ADR-103 §6, реализовано в `positionalShifts.ts`) — численная, через дельту 13 терминов classical eval (получаем из WASM SF 16). То есть **численный сигнал у нас есть**, в позиционных тегах нужна только **типизация**.

### 4.2. Что добавить (новый модуль `positionalFeatures.ts`)

Категориальные признаки, вычисляемые из FEN через `chess.js` + bitboard-эвристики, без движка:

| Группа | Признак | Логика |
|---|---|---|
| **Пешечная структура** | `isolated_pawn[file]` | Нет своих пешек на соседних вертикалях. |
|  | `doubled_pawn[file]` | Две и более своих пешек на одной вертикали. |
|  | `passed_pawn[square]` | Нет пешек противника впереди (своя вертикаль + 2 соседние). |
|  | `backward_pawn[square]` | Нельзя продвинуть без потери, нет защиты пешками. |
|  | `pawn_chain[squares]` | Связь ≥ 3 пешек по диагонали. |
|  | `pawn_island_count[side]` | Число «островов» (групп пешек по соседним вертикалям). |
| **Слоны** | `bad_bishop[square]` | Bishop на цвете, где ≥ 4 своих пешек на том же цвете. |
|  | `fianchetto[g2/b2/g7/b7]` | Слон на длинной диагонали + пешка на g3/b3/g6/b6. |
|  | `bishop_pair[side]` | У стороны два слона. |
| **Кони** | `knight_outpost[square]` | Конь на 4-6 ряду, не атакуется пешкой противника, защищён своей пешкой. |
|  | `bad_knight_rim[square]` | Конь на a/h-вертикали. |
| **Ладьи** | `rook_on_open_file[file]` | Ладья на вертикали без пешек. |
|  | `rook_on_semi_open_file[file]` | Ладья на вертикали без своих пешек. |
|  | `rook_on_7th[side]` | Ладья на 7-й (или 2-й для чёрных) горизонтали. |
|  | `rook_battery[file]` | Две ладьи / ладья+ферзь по одной вертикали. |
| **Поля** | `weak_square[square, side]` | Квадрат, не контролируемый ни одной пешкой стороны, в её половине. |
|  | `hole[square, side]` | Слабая клетка + рядом своих пешек нет (нельзя прикрыть). |
| **Линии и диагонали** | `open_file[file]` | Нет пешек ни одной стороны. |
|  | `semi_open_file[file, side]` | Нет своих пешек у одной стороны. |
|  | `long_diagonal_clear[a1h8 / a8h1]` | Главная диагональ без блокировки. |
| **Король** | `king_in_corner[side]` | Король на одной из 4 угловых клеток. |
|  | `king_pawn_shield_weakened[side]` | Из трёх пешек перед королём ≤ 1 на исходной позиции. |
|  | `king_open_file_nearby[side]` | Открытая/полуоткрытая линия рядом с королём. |
|  | `king_uncastled[side]` | Сторона не рокировалась и потеряла оба права. |

Итого: **~25 новых тегов**, реализуемы за ~2–3 дня frontend-работы. Покрывают все типовые «человеческие» позиционные комментарии, которые перечислены в постановке KS-3644.

### 4.3. Сила признака

Каждый тег — категориальный (есть/нет с привязкой к квадрату/фигуре/вертикали). Численная сила («насколько этот плохой слон плохой») — берётся из существующего `positional_shifts` (дельта classical eval). Получаем «комбо»: категория + ярлык силы.

Например: тег `bad_bishop[h2]` + `positional_shifts: ["bishop_passive"]` (из дельты Bishops в classical eval) → LLM-prompt получает: «У белых плохой слон h2 (4 пешки на белых полях); по eval позиционный сдвиг — слон пассивен».

### 4.4. Что **нельзя** покрыть без fork'а

- Численный вклад каждой подкомпоненты SF в общую оценку (например, «эта изолированная пешка стоит -0.18 cp по pawn_table SF»). Для разбора партии этот уровень детализации **избыточен** — текстовый комментарий «слабость на изолированной пешке c4» не требует знания cp.
- Сложные подкомпоненты king-safety (safe checks, unsafe checks по фигурам). Часть из них покрывается через наши tactical motifs (`fork` / `discovered_attack` на короля). Полностью совпасть с SF king-safety без fork'а не получится — но и нужды нет.

## 5. Решение

**Не делать fork Stockfish.** Расширить JS-детектор на ~25 категориальных позиционных тегов в новом модуле `apps/web/src/lib/review/positionalFeatures.ts`. Использовать вместе с существующим `positional_shifts` для grade силы. LLM-prompt получает комбинацию «категориальные теги + численные сдвиги», что покрывает запрос пользователя «объяснять плохой/хороший слон, изолированные пешки, открытые линии и т.п. человеческим языком».

### 5.1. Аргументы

| Критерий | Fork SF | JS-детектор |
|---|---|---|
| Объём разовой работы | 3–5 дней C++ + WASM-сборка | 2–3 дня TS |
| Поддержка | Постоянная (свой fork, чужой код C++) | Низкая (наш код, наш стек) |
| Размер WASM | +2 МБ (другая сборка) | 0 (только JS) |
| Лицензия | GPL-3 fork публично, ссылка рядом с WASM | Без изменений |
| Покрытие запроса KS-3644 | 100% численно + 100% категорий (но категории мы и так умеем) | ~95% категорий (полезных для разбора); численная сила — из готового positional_shifts |
| Уязвимость к SF 17+ | Фиксация на SF 16 навсегда (engine не развивается) | Не зависит от SF |

JS-детектор покрывает запрос за меньшие деньги и без долгосрочной зависимости от C++ ветки. Численная разбивка по cp на уровне подкомпонент — теряется, но для разбора партии она не нужна.

### 5.2. Когда вернуться к fork'у

Только если на eval-фикстурах (`docs/quality/llm-comments-eval/`) обнаружится, что LLM регулярно ошибается без знания численной силы подкомпонент, и эта ошибка устраняется именно cp-цифрами. Такого кейса в текущем наборе фикстур нет; перепроверять после A1-прогона (KS-3626a) с реальными метриками §9.2.

## 6. Воздействие на код

| Файл | Изменение |
|---|---|
| `apps/web/src/lib/review/positionalFeatures.ts` | Новый. Детекторы по таблице §4.2. Pure-функции от `Chess`-инстанса и `fen`. |
| `apps/web/src/lib/review/extractFacts.ts` | Импорт `positionalFeatures` + дополнение `FactsInput` полем `positional_features: PositionalFeature[]`. |
| `packages/shared/src/types/api-contracts.ts` | Расширение `FactsInput`: `positional_features: { id: PositionalFeatureId; square?: string; file?: string; side: 'w'|'b' }[]`. ID — union строк. |
| `apps/api/src/analysis-review/review-comment.service.ts` | Few-shot пары prompt'а V2 (ADR-103 §7) — добавить 2–3 примера с использованием новых тегов («плохой слон», «слабая клетка», «открытая линия»). |
| `apps/web/src/lib/review/positionalFeatures.test.ts` | Юнит-тесты для каждого детектора. |

## 7. Декомпозиция

**F1 — frontend, ~2 дня. Модуль `positionalFeatures.ts` + интеграция в `extractFacts`.**
- Реализация 25 детекторов по таблице §4.2.
- Pure-функции, входы: `Chess`, `fen`, `side`. Выход: массив тегов.
- Юнит-тесты на каждый тег с эталонными FEN-позициями.
- Интеграция в `extractFacts.ts` — поле `positional_features` в `FactsInput`.
- Метки: `analysis`.

**F2 — shared, ~0.25 дня. Расширение типа `FactsInput` в `packages/shared`.**
- Union `PositionalFeatureId` (25 значений).
- Поле `positional_features` в `FactsInput`.
- Перегенерация `packages/shared/dist`.
- Метки: `analysis`.

**B1 — backend, ~0.5 дня. Обновление few-shot prompt'а V2.**
- В `review-comment.service.ts` ветка `REVIEW_COMMENT_V2=on` — добавить 2–3 few-shot пары, использующие новые теги.
- Тесты на наличие новых ключевых слов в prompt'е.
- Метки: `analysis`, `chat`.

**A1 (опционально, после прогона KS-3626a) — architect, ~0.25 дня. Решение о fork'е.**
- Если ручная оценка показала, что LLM регулярно теряет численную силу подкомпонент — открываем follow-up задачу на fork SF 16.
- Иначе — фиксируем JS-детектор как финальный ответ KS-3644.

Зависимости: F2 → F1 → B1. A1 — после прогона KS-3626a.

Срок: ~3 рабочих дня с минимальным распараллеливанием (F2 быстрый, F1 — основной).

## 8. Известные минусы и риски

- **Численная сила подкомпонент теряется** (§4.4). Для текстового разбора партии — некритично; если потребуется — отдельный follow-up на fork.
- **Расхождение с SF-эвристиками.** Наши пороги «4 пешки на цвете слона = bad bishop», «конь на 4-6 ряду, защищённый своей пешкой = outpost» близки к SF, но не 1:1. Калибровать тесты на типичных позициях; LLM в ответе всё равно работает с категориальным сигналом, не с cp.
- **Дубли с tactical motifs.** Некоторые признаки пересекаются (например, `discovered_attack` ↔ открытая линия). Дедупликация в `extractFacts` — приоритет tactical_motifs (как сильный сигнал), positional_features — фон. Зафиксировать правила в коде.

## 9. Откат

Если позже понадобятся cp-цифры подкомпонент — открываем follow-up задачу на fork SF 16:
1. Fork в публичный репозиторий, патч `Trace`.
2. WASM-сборка через emscripten (toolchain как у `lichess-org/stockfish.wasm`).
3. Замена `apps/web/public/stockfish/stockfish-16-lite.{js,wasm}` (ADR-103 §3.4) на свой бинарь.
4. JS-API — без изменений, добавляется парсер расширенного eval-вывода.

Текущее JS-решение не блокирует этот апгрейд: численные cp можно подмешать в `FactsInput` отдельным полем, не ломая категориальные теги.

## 10. Резюме

Stockfish не отдаёт подкомпоненты через UCI; чтобы получить — нужен fork с патчем `Trace`. Объём — 3–5 дней C++ + WASM, лицензия GPL-3 разрешает раздачу WASM при наличии публичного fork'а.

Дешевле и эффективнее — расширить наш JS-детектор `extractFacts.ts` модулем `positionalFeatures.ts` на ~25 категориальных тегов (изолированные/сдвоенные/проходные пешки, плохой/хороший слон, форпосты, открытые линии, слабые клетки, fianchetto, ладья на 7-й, и так далее). Численная сила — через готовый `positional_shifts` (ADR-103). Запрос пользователя «объяснять подкомпоненты человеческим языком» покрывается на ~95% за 2–3 дня frontend-работы, без долгосрочной зависимости от C++.

Декомпозиция: F1 (детектор), F2 (типы в shared), B1 (few-shot prompt'а). Срок ~3 рабочих дня. Откат к fork'у возможен без перестройки текущих данных, если eval-фикстуры покажут необходимость.
