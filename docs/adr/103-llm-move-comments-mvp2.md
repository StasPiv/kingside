# ADR-103. Качество LLM-комментариев к ходам (MVP-2)

Статус: предложен (KS-3620, ревизия 2).
Дата: 2026-06-03.
Связано: ADR-102 (MVP-1), KS-3614 / KS-3615 / KS-3616 (реализация MVP-1).

## История ревизий

- **rev 1** (8:11 UTC) — детекторы мотивов на frontend как единственный источник позиционных фактов; chess-expert делает eval-набор с эталонными комментариями.
- **rev 2** (текущая) — позиционные факты берутся из Stockfish `eval` (classical breakdown по 13 терминам) на backend; собственные детекторы на frontend оставлены только для тактических мотивов, которые `eval` не различает по типам; chess-expert из плана убран, eval-набор делает architect сам без эталонных комментариев.

## 1. Контекст

ADR-102 / KS-3614+3615+3616 завели MVP-1: фронт собирает 15–25 фактов о ходах с NAG-метками (`extractFacts.ts`), бэк (`ReviewCommentService.batchComment`) шлёт батч в `AI_CHAT_WEBHOOK_URL`, ответ применяется к PGN-дублю.

На живой партии видно три проблемы:

1. **Тавтология NAG.** На `?!` — «неточность», на `?` — «ошибка», на `!` — «сильный ход». Это пересказ `classification`, содержания нет.
2. **«Фигура висит» без причины.** «Конь висит на f6» — без атакующего, защитника, исхода размена.
3. **Молчание о позиционных мотивах и тактике.** Prompt запрещает выдумывать, фактов недостаточно — модель молчит даже там, где мотив очевиден (вилка, ослабление короля, потерянная мобильность).

Причины:
- **Бедные факты.** `FactsInput` (ADR-102 §3.4) содержит `classification`, `delta_e`, `sf_best`, плоский `hanging_piece`. Нет ни позиционных дельт (king safety, mobility, pawn structure), ни тактических мотивов, ни деталей размена.
- **Жёсткие ограничения prompt'а.** «ONE short sentence (max 20 words)», `CRITICAL RULES` запрещают любую оценку сверх `classification`. Few-shot нет.
- **Нет post-валидации.** Бессодержательные ответы пропускаются как есть.

## 2. Граница MVP-2

### Входит

1. **Positional facts** — backend дёргает `eval` у Stockfish для каждой позиции из батча (fenBefore + fenAfter), считает дельты по 13 классическим терминам, переводит топ-N в текстовые ярлыки.
2. **Tactical motifs** — frontend (chess.js), 6 дёшевых детекторов для конкретных названий: fork, double_attack, pin, skewer, discovered_attack, back_rank_weak.
3. **Расширение `hanging_piece`** — attackers, defenders, net_material_if_taken (frontend, chess.js).
4. **`threats_created` / `threats_missed`** — frontend, статический подсчёт + sf_best.line (2–3 хода SAN).
5. **Переписать prompt** — запрет NAG-тавтологии, требование причины, лимит 30–60 слов, 6–8 few-shot пар, расширенная калибровка по ELO.
6. **Post-валидация** — backend: NAG-blacklist + min-length.
7. **Eval-фикстуры (architect)** — 10–15 партий PGN с разнотипными ошибками (позиционные/тактические), без эталонных комментариев. Прогон pipeline, ручная оценка содержательности.
8. **Feature-flag rollout** — ENV `REVIEW_COMMENT_V2=on|off`.

### НЕ входит

- Сложные тактические мотивы (overloaded defender, deflection, decoy, interference, zwischenzug) — требуют мини-поискового движка.
- Дообучение LLM на корпусе мастеров.
- Streaming SSE, TTS, кэш комментариев в БД.
- Эталонные комментарии от chess-expert (пользователь убрал эту роль из плана).
- Бюджет токенов как ограничение (пользователь сказал: расход не критичен, оптимизируем под качество).

## 3. Источники фактов

### 3.1. Карта источников

| Группа фактов | Источник | Сторона | Метод |
|---|---|---|---|
| Mechanical (san, uci, capture, check, mate, castling, promotion, en_passant) | chess.js | frontend | как в MVP-1 |
| `classification`, `delta_e`, `sf_best`, `maia_alternative`, `mate_threat_after` | SF/Maia + classifyMove | frontend | как в MVP-1 |
| `stage`, `opening_name`, `material_balance`, `material_change` | chess.js + Analysis | frontend | как в MVP-1 |
| **`hanging_piece` расширенное** (attackers / defenders / net) | chess.js | frontend | новое в MVP-2 |
| **`tactical_motifs[]`** (6 мотивов) | chess.js + детекторы | frontend | новое в MVP-2 |
| **`threats_created` / `threats_missed`** | chess.js + sf_best.line | frontend | новое в MVP-2 |
| **`sf_best.line`** (2–3 хода SAN) | sfBestPv | frontend | новое в MVP-2 |
| **`positional_shifts[]`** (ярлыки из classical eval) | Stockfish `eval` (SF 15.1) | **backend** | новое в MVP-2 |

### 3.2. Почему positional_shifts — на backend

Stockfish `eval` в classical-режиме отдаёт breakdown по терминам:

```
Term: Material, Imbalance, Pawns, Knights, Bishops, Rooks, Queens,
      Mobility, King safety, Threats, Passed, Space, Winnable.
Columns: MG (midgame), EG (endgame), Total (white-perspective).
```

Это закрывает позиционные ходы лучше, чем любые собственные эвристики на chess.js, без переизобретения evaluator'а.

Проверено фактическим запуском:

```
$ /usr/games/stockfish
> uci → id name Stockfish 15.1, option name Use NNUE
> setoption name Use NNUE value false
> position startpos moves e2e4 e7e5 ... (Ruy Lopez)
> eval
  info string classical evaluation enabled
  Contributing terms for the classical eval:
  +------------+ Material / Imbalance / Pawns / Knights / Bishops /
                 Rooks / Queens / Mobility / King safety / Threats /
                 Passed / Space / Winnable
  Classical evaluation -0.27 (white side)
```

**Почему не на frontend (WASM):**
- В `apps/web/public/stockfish/` лежит `stockfish-18-*.js/.wasm` (Stockfish.js 18, Chess.com fork). SF 17 и SF 18 classical evaluator выпилен полностью — нет ни HCE-кода, ни команды `eval` в classical-формате. `eval` отдаёт NNUE accumulator/PSQT, не 13 терминов.
- Системный SF 15.1 — последняя версия в нашем образе, у которой classical breakdown работает. SF 16 ещё работает, SF 17+ — нет.
- Перенос classical-evaluator в WASM-сборку → нужен другой WASM-binary, замена не оправдана для одной фичи.

Решение: classical eval только через системный SF на backend.

### 3.3. Риск: апгрейд системного Stockfish

Если devops обновит `/usr/games/stockfish` до SF 17+, classical eval перестанет работать. Меры:

- В Docker-образе фиксируем версию SF при сборке (ровно 15.1 или 16-final).
- В `StockfishEvalService` после запуска парсим `id name` — если major ≥ 17, в лог WARN и `positional_shifts: []` graceful (комментарии не сломаются, просто не будут содержать позиционных ярлыков).
- В `.env.example` явный комментарий: «STOCKFISH_BIN должен указывать на SF ≤16 для classical eval».

## 4. Тактические мотивы (frontend, chess.js)

### 4.1. Зачем оставлены, раз есть Threats из eval

SF eval даёт численную дельту по `Threats` (например, `+0.30` в MG). Это полезно для общего фона, но не различает мотив по типу. Модель не сможет сказать «вилка на короля и ферзя» по числу — нужны конкретные ярлыки и атакованные фигуры.

Дёшевые детекторы на chess.js дают то, что eval не различает:
- название мотива (`fork` / `pin` / `skewer` / `discovered_attack` / `double_attack` / `back_rank_weak`);
- список атакованных фигур (`targets`).

### 4.2. 6 мотивов

| Мотив | Алгоритм | Стоимость |
|---|---|---|
| `fork` | После played-хода: ходившая фигура атакует ≥2 фигуры противника, net > 0. | O(1) |
| `double_attack` | Любые 2 атакованных объекта (фигуры или поле рядом с королём). | O(1) |
| `pin` | Ray-scan от нашего слона/ладьи/ферзя к королю противника: один фигура между. | O(линий × 7) |
| `skewer` | Ray-scan; впереди ценнее, сзади дешевле. | O(линий × 7) |
| `discovered_attack` | Сравнить attackers после played-хода: появился новый, который не двигался. | O(scan board) |
| `back_rank_weak` | Король на 1/8 горизонтали, перед ним только свои пешки, ладья/ферзь противника на этой линии. | O(8) |

### 4.3. Сложные мотивы вне MVP-2

`overloaded_defender`, `deflection`, `decoy`, `interference`, `zwischenzug` требуют мини-поиска. Включаем позже, если eval-фикстуры покажут, что их отсутствие критично.

## 5. Расширенная схема `FactsInput`

```ts
type TacticalMotif =
  | 'fork' | 'pin' | 'skewer'
  | 'discovered_attack' | 'double_attack' | 'back_rank_weak';

type PositionalShiftId =
  | 'material_gained' | 'material_lost'
  | 'pawn_structure_improved' | 'pawn_structure_weakened'
  | 'knight_more_active' | 'bishop_more_active' | 'bishop_passive'
  | 'rook_on_open_file' | 'queen_more_active'
  | 'mobility_increased' | 'mobility_decreased'
  | 'king_safer' | 'king_exposed'
  | 'threats_grew' | 'threats_weakened'
  | 'passed_pawn_strong' | 'space_gained'
  | 'position_more_winnable' | 'position_less_winnable';

type ThreatTarget = {
  piece: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  square: string;
};

type FactsInput = {
  // ── из MVP-1 (без изменений) ─────────────────────────────────────
  ply: number;
  fen: string;        // fenBefore — нужен бэку для eval позиции ДО хода
  side: 'white' | 'black';
  move: { san; uci; capture; check; mate; castling; promotion; en_passant };
  classification: MoveClass;
  delta_e: number;
  maia_alternative: { uci; san; probability; classification } | null;
  stage: 'opening' | 'middlegame' | 'endgame';
  opening_name: string | null;
  material_balance: number;
  material_change: { piece; side } | null;
  mate_threat_after: number | null;
  user_elo: number;
  user_language: 'en' | 'ru';

  // ── расширения MVP-2 (frontend) ──────────────────────────────────

  /** FEN позиции ПОСЛЕ played-хода. Нужен бэку для eval. */
  fen_after: string;

  /** sf_best дополнен 2–3 ходами SAN продолжения. */
  sf_best: {
    uci: string;
    san: string;
    line: string[];
  } | null;

  /** Висящая фигура с атакующими, защитниками и итогом размена. */
  hanging_piece: {
    square: string;
    piece: 'p' | 'n' | 'b' | 'r' | 'q';
    side: 'white' | 'black';
    attackers: Array<{ piece; square }>;
    defenders: Array<{ piece; square }>;
    net_material_if_taken: number;
  } | null;

  /** Что создаёт played-ход. */
  threats_created: {
    mate_in?: number;
    wins_material?: ThreatTarget & { net: number };
    targets?: ThreatTarget[];
  } | null;

  /** Что упустил слабый ход (по сравнению с sf_best). */
  threats_missed: {
    mate_in?: number;
    wins_material?: ThreatTarget & { net: number };
    counter_threat?: { mate_in?: number; wins_material?: ThreatTarget & { net: number } };
  } | null;

  /** Тактические мотивы. */
  tactical_motifs: TacticalMotif[];

  // ── расширения MVP-2 (backend) ───────────────────────────────────

  /**
   * Заполняется бэком после получения батча от фронта, ПЕРЕД prompt-builder'ом.
   * Фронт всегда шлёт `[]`. Сервер вычисляет дельту classical eval
   * (fen → fen_after), берёт топ-N значимых терминов (см. §6.3),
   * переводит в ярлыки, кладёт сюда.
   */
  positional_shifts: PositionalShiftId[];
};
```

`packages/shared/api-contracts.ts` отражает shape 1:1. `positional_shifts` объявлено в shared как frontend-входящее `[]`, бэк не нарушает контракт — он мутирует поле на своей стороне до prompt'а.

## 6. Backend: StockfishEvalService

### 6.1. Назначение

Новый компонент в `apps/api/src/analysis-review/`:

```
stockfish-eval.service.ts          — spawn /usr/games/stockfish, пул процессов
stockfish-eval.service.spec.ts     — мок subprocess
positional-shifts.ts               — pure-функция: парсинг + дельта + ярлыки
positional-shifts.spec.ts          — unit-тесты ярлыков
```

### 6.2. Жизненный цикл и пул

- Один или два долгоживущих subprocess SF (`/usr/games/stockfish`), запущенных при старте модуля. После старта — `uci` → `setoption name Use NNUE value false` → готов.
- Каждый запрос `evalPosition(fen)`: `position fen <fen>` → `eval` → читать до строки `Final evaluation` (или эквивалентной для classical) → парсить таблицу.
- Очередь: запросы сериализуются на одном процессе через простую `Promise`-цепочку.
- Таймаут одной операции — 500 мс (eval — синхронный, обычно <10 мс; защита от зависания).
- ENV:
  - `STOCKFISH_BIN=/usr/games/stockfish` (дефолт),
  - `REVIEW_COMMENT_SF_POOL_SIZE=2` (количество процессов),
  - `REVIEW_COMMENT_SF_TIMEOUT_MS=500`.

### 6.3. Парсинг eval-output

После команды `eval` SF выдаёт:

```
 Contributing terms for the classical eval:
+------------+-------------+-------------+-------------+
|    Term    |    White    |    Black    |    Total    |
|            |   MG    EG  |   MG    EG  |   MG    EG  |
+------------+-------------+-------------+-------------+
|   Material |  ----  ---- |  ----  ---- |  0.14 -0.29 |
|  Imbalance |  ----  ---- |  ----  ---- |  0.00  0.00 |
|      Pawns |  0.12 -0.02 |  0.18 -0.02 | -0.06 -0.00 |
...
|      Total |  ----  ---- |  ----  ---- | -0.30 -0.96 |
+------------+-------------+-------------+-------------+
Classical evaluation   -0.27 (white side)
Final evaluation       -0.24 (white side)
```

Регексп на строки таблицы: `^\|\s*(\w[\w\s]*?)\s*\|.*?\|\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\|$` — берём имя термина, total MG, total EG.

Структура:

```ts
type ClassicalEvalBreakdown = {
  // Все значения в pawn units, белая сторона.
  material:    { mg: number; eg: number };
  imbalance:   { mg: number; eg: number };
  pawns:       { mg: number; eg: number };
  knights:     { mg: number; eg: number };
  bishops:     { mg: number; eg: number };
  rooks:       { mg: number; eg: number };
  queens:      { mg: number; eg: number };
  mobility:    { mg: number; eg: number };
  king_safety: { mg: number; eg: number };
  threats:     { mg: number; eg: number };
  passed:      { mg: number; eg: number };
  space:       { mg: number; eg: number };
  winnable:    { mg: number; eg: number };
  total_classical: number;
};
```

### 6.4. Дельты и стадия

На каждый `FactsInput`:

1. `before = evalPosition(facts.fen)`, `after = evalPosition(facts.fen_after)`.
2. Дельта по каждому термину: `delta = after.term - before.term`. Знак — с белой стороны; если `facts.side === 'black'`, инвертируем (`delta = -delta`).
3. По стадии (`facts.stage`):
   - `opening` / `middlegame` → используем MG-компоненту.
   - `endgame` → EG-компоненту.
4. Получаем 13 чисел в pawn units, POV ходящей стороны.

### 6.5. Перевод в ярлыки

```ts
const SHIFT_THRESHOLD = 0.10;   // pawn units
const TOP_N = 2;                 // топ-2 ярлыка на ход

// Карта: term → (positive_id, negative_id, special?)
// Если ID отсутствует — direction не интересен (например, +Material и -Material маппим в material_gained/lost, а +Imbalance ярлыка не имеет, бросаем).
const SHIFT_MAP = {
  material:    ['material_gained',          'material_lost'],
  pawns:       ['pawn_structure_improved',  'pawn_structure_weakened'],
  knights:     ['knight_more_active',        null],
  bishops:     ['bishop_more_active',        'bishop_passive'],
  rooks:       ['rook_on_open_file',         null],         // спец: рост Rooks с открытыми линиями
  queens:      ['queen_more_active',         null],
  mobility:    ['mobility_increased',        'mobility_decreased'],
  king_safety: ['king_safer',                'king_exposed'],
  threats:     ['threats_grew',              'threats_weakened'],
  passed:      ['passed_pawn_strong',        null],
  space:       ['space_gained',              null],
  winnable:    ['position_more_winnable',    'position_less_winnable'],
};
```

Алгоритм:
- На вход — массив 13 дельт по терминам.
- Отфильтровать: `abs(delta) >= SHIFT_THRESHOLD` и для данного знака есть ID в карте.
- Отсортировать по `abs(delta)` убыванию.
- Взять первые `TOP_N`, вернуть массив `PositionalShiftId`.
- Если ничего не прошло порог — пустой массив.

`Imbalance` и `Material` оба отражают материал. Чтобы не дублировать («material_gained» + ничего), берём их сумму как одну «material»-метрику; ярлык `material_gained` ставится только если `material_change` уже не отражает то же самое (capture был — мы знаем кого, ярлык избыточен).

Защита от двойного покрытия:
- Если `facts.material_change` != null И ярлык кандидат — `material_gained`/`material_lost` — пропускаем (`material_change` уже описывает).
- Если `facts.threats_created.wins_material` != null И кандидат — `threats_grew` — пропускаем (явная угроза описывает лучше).

### 6.6. Latency

- 1 eval на SF 15.1: ~5–10 мс.
- На батч 25 фактов × 2 позиции (fen + fen_after) = 50 evals.
- Сериализованно на 1 процессе: ~250–500 мс.
- На пуле из 2 процессов: ~150–300 мс.
- Webhook-вызов LLM остаётся в ~10–25 с — eval-добавка незаметна.

### 6.7. Graceful degradation

- SF не запустился → лог ERROR при старте, `evalPosition()` всегда возвращает `null`, `positional_shifts: []` на каждом факте. Комментарии всё равно генерируются (на тактических мотивах и hanging_piece).
- eval-таймаут на одной позиции → этот факт получает `positional_shifts: []`, остальные обрабатываются.
- SF major ≥ 17 (нет classical eval) → `positional_shifts: []` graceful, лог WARN при старте.

## 7. Новый prompt

### 7.1. Системный prompt (RU, EN зеркальный)

```
Ты — шахматный тренер. Комментируешь ходы конкретного учащегося.
Язык ответа: {language}. ELO ученика: {userElo}.

ВХОД: JSON-массив фактов о ходах. Каждый факт — один полуход.

ВЫХОД: JSON-массив строк той же длины, в том же порядке. Каждая строка — один комментарий.

ТРЕБОВАНИЯ К КАЖДОМУ КОММЕНТАРИЮ:
- 1–2 предложения, 15–60 слов.
- Объясни ПРИЧИНУ: что выигрывает / что теряет / какую угрозу создаёт / какой мотив реализован.
- positional_shifts — список текстовых ярлыков, отражающих сдвиг позиционной оценки движка:
    * material_gained/lost, pawn_structure_improved/weakened,
    * knight_more_active, bishop_more_active/passive,
    * rook_on_open_file, queen_more_active,
    * mobility_increased/decreased, king_safer/exposed,
    * threats_grew/weakened, passed_pawn_strong, space_gained,
    * position_more_winnable/less_winnable.
  Если массив непуст — упомяни ярлык(и) человеческим языком, без жаргона про «оценку движка».
- Если есть hanging_piece — назови атакующую фигуру и есть ли защита; если защищена — короткая оценка размена через `net_material_if_taken`.
- Если есть tactical_motifs — назови мотив (вилка / связка / вскрытое нападение / задняя горизонталь / двойное нападение / связка по линии) и какие фигуры он атакует.
- Если есть threats_created — опиши угрозу.
- Если есть threats_missed.wins_material — покажи правильный план через `sf_best.line`.

ЧТО ЗАПРЕЩЕНО:
- Не дублировать NAG словами без объяснения: фразы «сильный ход», «отличный ход», «лучший ход», «хороший ход», «слабый ход», «неточность», «ошибка», «грубая ошибка», «зевок» САМИ ПО СЕБЕ ЗАПРЕЩЕНЫ. Если не из чего собрать причину — верни пустую строку "".
- Не выдумывать тактические мотивы, которых нет в `tactical_motifs`.
- Не упоминать численные оценки движка, сантипешки, ELO.
- Не давать общих советов («играй активнее», «развивай фигуры»).

КАЛИБРОВКА ПО ELO:
- userElo < 1500: простые слова — «теряет ферзя», «вилка на короля и ладью», «король под боем», «защищён конём, можно брать».
- 1500 ≤ userElo < 2000: «инициатива», «темп», «упускает компенсацию», «связка», «открытая линия для ладьи».
- userElo ≥ 2000: «изолированная пешка», «слабый комплекс», «активность фигур», «жертва качества», «структурная перевеса».

ПРИМЕРЫ (few-shot):

Факты:
{ "move": { "san": "Nxe5", "capture": "p" }, "classification": "best",
  "tactical_motifs": ["fork"],
  "threats_created": { "targets": [{"piece":"q","square":"d7"},{"piece":"r","square":"f7"}] },
  "positional_shifts": ["threats_grew"] }
ПЛОХО: "Сильный ход."
ХОРОШО: "Конь забирает пешку и одновременно атакует ферзя и ладью — вилка с двойным выигрышем материала."

Факты:
{ "move": { "san": "Qd5" }, "classification": "blunder", "delta_e": -0.6,
  "hanging_piece": { "square":"d5","piece":"q","side":"white","attackers":[{"piece":"n","square":"f6"}],"defenders":[],"net_material_if_taken": -8 },
  "sf_best": { "san":"Qe2", "line":["Qe2","O-O","Nf3"] },
  "positional_shifts": ["material_lost"] }
ПЛОХО: "Грубая ошибка."
ХОРОШО: "Ферзь становится под удар коня f6 без защиты — теряется фигура. Спокойнее Qe2 с рокировкой."

Факты:
{ "move": { "san": "Bxf7+", "capture": "p", "check": true }, "classification": "good",
  "tactical_motifs": ["discovered_attack"],
  "threats_created": { "wins_material": {"piece":"q","square":"d8","net": 6} },
  "positional_shifts": ["threats_grew","king_exposed"] }
ПЛОХО: "Хороший ход."
ХОРОШО: "Жертва слона со вскрытым шахом — после взятия открывается ферзь и теряется на следующем ходу, король противника обнажён."

Факты:
{ "move": { "san": "h6" }, "classification": "inaccuracy", "delta_e": 0.15,
  "threats_missed": { "wins_material": {"piece":"p","square":"e4","net":1} },
  "sf_best": { "san":"Nxe4", "line":["Nxe4","Bxe4","d5"] },
  "positional_shifts": ["king_safer"] }
ПЛОХО: "Неточность."
ХОРОШО: "Профилактика короля, но пропущен Nxe4 с выигрышем центральной пешки."

Факты:
{ "move": { "san": "Rxd1" }, "classification": "good", "material_change": {"piece":"r","side":"white"},
  "tactical_motifs": [], "positional_shifts": ["mobility_decreased"] }
ПЛОХО: "Хорошо."
ХОРОШО: "Размен ладей упрощает позицию, но снижает подвижность фигур в эндшпиле."

Факты:
{ "move": { "san": "Kg1" }, "classification": "best",
  "tactical_motifs": ["back_rank_weak"], "positional_shifts": ["king_safer"] }
ПЛОХО: "Лучший ход."
ХОРОШО: "Король уходит с задней линии — иначе мат ладьёй после размена на e1."

Факты:
{ "move": { "san": "Bb5" }, "classification": "good",
  "tactical_motifs": ["pin"],
  "positional_shifts": ["bishop_more_active","mobility_increased"] }
ПЛОХО: "Хорошо."
ХОРОШО: "Слон связывает коня c6 с ферзём d8, заодно даёт белым активную фигуру и большую подвижность."

Факты:
{ "move": { "san": "Re1" }, "classification": "best",
  "tactical_motifs": [],
  "positional_shifts": ["rook_on_open_file","space_gained"] }
ПЛОХО: "Лучший ход."
ХОРОШО: "Ладья встаёт на открытую вертикаль e, белые забирают пространство в центре."

[аналогичный блок EN из 7–8 пар]
```

### 7.2. Параметры запроса

- `temperature: 0.4`.
- `max_tokens` per fact: 160 (запас под 60 слов).
- Few-shot прибавит ~2000 input-tokens, один раз на батч. Бюджет неограничен — оптимизация под качество.

### 7.3. Калибровка по ELO

Параметры остались как в rev 1 (см. §5.3 ниже):
- <1500 — один мотив на ход простыми словами;
- 1500–2000 — короткая цепочка причина → следствие;
- ≥2000 — позиционные термины (изолированная, плохой слон, компенсация).

## 8. Post-валидация

В `ReviewCommentService.parseAndValidate` после успешного парсинга — пройти по массиву.

### 8.1. Чёрный список NAG-тавтологий

Нормализация: trim, lowercase, убрать пунктуацию `.!?,:;`. Точное совпадение — заменить пустой строкой.

RU: «сильный ход», «отличный ход», «лучший ход», «хороший ход», «слабый ход», «плохой ход», «ошибка», «грубая ошибка», «зевок», «неточность».

EN: «strong move», «excellent move», «best move», «good move», «weak move», «poor move», «mistake», «big mistake», «blunder», «inaccuracy».

Regexp (ru):
```ts
const NAG_TAUTOLOGY_RU = /^(сильный|отличный|лучший|хороший|слабый|плохой)\s+ход[.!?]*$/i;
const NAG_SHORT_RU = /^(ошибка|грубая\s+ошибка|зевок|неточность)[.!?]*$/i;
```

### 8.2. Минимальная содержательность

После очистки: минимум **4 слова** или **25 символов**. Иначе → `""`.

Игнорируем `""` (валидно — модель сама вернула пустоту).

### 8.3. Поведение фронта

KS-3616 уже умеет дубль с пустыми комментариями — пустая строка просто опускает подпись под NAG-знаком. Изменений на фронте не нужно.

## 9. Eval-фикстуры (architect, без chess-expert)

### 9.1. Состав

- 10–15 партий PGN разного типа:
  - 3–4 партии с позиционными ошибками (плохой слон, проигранный темп, ослабление пешечной структуры);
  - 3–4 партии с явной тактикой (вилки, связки, скрытые нападения, мат-угрозы);
  - 3–4 партии смешанного типа;
  - 2 партии с back-rank-проблемами.
- Без эталонных комментариев — задача не сравнивать «слово в слово», а оценить читаемость на глаз.

Положить в `docs/quality/llm-comments-eval/` как `.pgn`-файлы. Метаданные (что хотим проверить на каждой) — в `README.md` рядом.

### 9.2. Метрики

| Метрика | Цель | Метод сбора |
|---|---|---|
| Доля комментариев, отсеянных post-валидацией | ≤ 5 % на партию | автомат, по логу |
| Доля с глаголом-причиной («выигрывает», «теряет», «атакует», «угрожает», «защищает», «улучшает», «ослабляет», «открывает», «связывает», «уходит», «возникает») | ≥ 80 % | автомат, regexp по комментариям |
| Доля с упоминанием мотива/ярлыка, которого нет в фактах (галлюцинация) | ≤ 5 % | вручную, выборочная сверка на 5 партиях |
| Subjective: 5-bal на 5 партиях, 1 ревьюер (architect) | ≥ 3.5/5 | вручную |

### 9.3. Процесс

1. После реализации F1+F2+B1 — architect берёт фикстуры, прогоняет pipeline локально (`POST /api/analyses/review/comments` с подготовленными батчами фактов).
2. Снимает метрики.
3. Если ниже целей — итерация: правка prompt'а, докрутка детекторов, корректировка ярлыков.
4. Отчёт в KS-3620 как комментарий.

## 10. Rollout

### 10.1. ENV-флаг

```
REVIEW_COMMENT_V2=on
STOCKFISH_BIN=/usr/games/stockfish
REVIEW_COMMENT_SF_POOL_SIZE=2
REVIEW_COMMENT_SF_TIMEOUT_MS=500
REVIEW_COMMENT_MIN_WORDS=4
REVIEW_COMMENT_MIN_CHARS=25
```

`REVIEW_COMMENT_V2=off` — поведение MVP-1: prompt без few-shot, без positional_shifts, без расширенного hanging_piece (бэк игнорирует новые поля), post-валидация всё равно включена.

`REVIEW_COMMENT_V2=on` — полный пайплайн MVP-2.

### 10.2. Поведение фронта при rollback

`extractFacts.ts` всегда отдаёт расширенный shape. При `V2=off` бэк игнорирует новые поля и шлёт старый prompt. Фронт не различает режимы, дубль создаётся одинаково.

### 10.3. Включение

После прохождения eval-фикстур (architect A1):
- devops ставит `REVIEW_COMMENT_V2=on` на проде;
- 24 часа мониторинг `ReviewCommentService` и `StockfishEvalService` (5xx, latency, eval-таймауты).

## 11. Декомпозиция

### F1 (frontend, ~2 дня) — расширение `extractFacts.ts`

- Расширить `FactsInput` (см. §5): `fen_after`, расширенный `hanging_piece`, `tactical_motifs`, `threats_created`, `threats_missed`, `sf_best.line`, заглушка `positional_shifts: []`.
- 6 детекторов мотивов: fork, double_attack, pin, skewer, discovered_attack, back_rank_weak.
- `threats_created` / `threats_missed` — статический подсчёт после played-хода / после sf_best.
- Расширить `findHangingPiece` (attackers/defenders/net).
- Добавить `sf_best.line` (срез из `sfBestPv` на 2–3 хода).
- Unit-тесты на каждый мотив и расширенный hanging_piece.
- Метки: `analysis`, `chat`.

### F2 (frontend, ~0.5 дня) — `packages/shared/api-contracts.ts`

- `FactsInput` с новыми полями 1:1 с фронтом (включая `positional_shifts: PositionalShiftId[]`, на фронте всегда `[]`).
- Перегенерация `dist`.
- Метки: `analysis`.

### B1 (backend, ~2 дня) — SF eval + DTO + prompt + post-валидация

- Новый `StockfishEvalService` (spawn `/usr/games/stockfish`, пул, `evalPosition(fen)` с парсером classical breakdown).
- `positional-shifts.ts` — pure-функция: дельта, top-N ярлыков (см. §6.5).
- Обновить DTO (`batch-comment.dto.ts`) под новые поля + class-validator.
- `ReviewCommentService`:
  - перед prompt-builder'ом — для каждого факта вызвать SF eval на fenBefore/fenAfter, заполнить `positional_shifts`;
  - `buildSystemPrompt` — ветка V2 (§7.1) с few-shot;
  - `postValidate(comments[])` — NAG-blacklist + min-length (§8);
  - ENV-флаги (§10.1).
- Unit-тесты: парсер eval-output на снимках реальных табличек, ярлыки top-N, blacklist срезает «Сильный ход.» / «Mistake.», min-length, prompt V2 содержит запрет и few-shot.
- Метки: `analysis`, `chat`.

### A1 (architect, ~0.5 дня) — eval-фикстуры + прогон

- Подобрать 10–15 партий PGN (см. §9.1).
- Положить в `docs/quality/llm-comments-eval/`.
- Прогнать pipeline на каждой, снять метрики §9.2.
- Отчёт в комментарий KS-3620.
- При необходимости — короткая итерация по prompt'у / детекторам / ярлыкам.

### D1 (devops, ~0.1 дня) — включение V2 на проде

- После A1 «зелёного» — `REVIEW_COMMENT_V2=on` на проде, 24 часа мониторинг.
- Зафиксировать в Docker-образе версию SF (15.1 или 16-final). При следующей пересборке образа devops проверяет, что classical eval живой.
- Метки: `analysis`, `infra`.

### Зависимости

```
F1 ──┬─> F2 ──> B1 ──> A1 ──> D1
     │                  ▲
     └──────────────────┘  (A1 нужны фронт-факты + бэк-pipeline)
```

Параллелизация ограничена: B1 ждёт F2 (новые типы в shared). F1 и подготовка фикстур A1 (выбор партий, без прогона) могут идти параллельно.

## 12. Открытые вопросы

Нет. Все развилки закрыты:
- Источник позиционных фактов — SF classical eval (backend, SF 15.1).
- Источник тактических мотивов — собственные детекторы на frontend (6 мотивов), потому что Threats из eval не различает мотив по типу.
- Версия SF — зафиксирована в образе ≤16 (риск §3.3 закрыт через guard в `StockfishEvalService` + ENV-комментарий).
- Chess-expert — вне scope MVP-2; eval-фикстуры собирает architect (10–15 партий PGN без эталонов).
- Бюджет токенов — не ограничен (пользователь снял вопрос, оптимизируем под качество).

## 13. Резюме

MVP-2 закрывает три проблемы MVP-1 (NAG-тавтология, висит без причины, молчание о тактике/позиции) тремя ортогональными источниками фактов:

1. **Positional shifts** — backend парсит classical eval breakdown системного Stockfish (SF 15.1), переводит дельту по 13 терминам в человеко-читаемые ярлыки (top-2 на ход).
2. **Tactical motifs + threats + расширенный hanging_piece** — frontend (chess.js), 6 детекторов даёт конкретные названия мотивов и атакованные фигуры; eval Threats эту специфику не различает.
3. **Переписан prompt** — запрет NAG-тавтологии, требование причины, 6–8 few-shot пар, 30–60 слов, расширенная калибровка.
4. **Post-валидация** — backend режет тавтологичные и слишком короткие ответы.

Источник eval разнесён по сторонам сознательно: классический evaluator есть только в системном SF ≤16, WASM-сборка SF 18 на фронте его не предоставляет.

Eval-фикстуры (10–15 партий без эталонных комментариев) делает architect — chess-expert убран из scope. Rollout через `REVIEW_COMMENT_V2` ENV, откат одним переключателем.

Decompose: F1 (frontend extractor 2 д) → F2 (shared 0.5 д) → B1 (backend SF eval + prompt + post-validate 2 д) → A1 (architect фикстуры + прогон 0.5 д) → D1 (devops rollout). Суммарно ~5 рабочих дней.
