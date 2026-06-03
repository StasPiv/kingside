# ADR-103. Качество LLM-комментариев к ходам (MVP-2)

Статус: предложен (KS-3620, ревизия 3).
Дата: 2026-06-03.
Связано: ADR-102 (MVP-1), KS-3614 / KS-3615 / KS-3616 (реализация MVP-1).

## История ревизий

- **rev 1** — детекторы мотивов на frontend как единственный источник позиционных фактов; chess-expert делает eval-набор с эталонными комментариями.
- **rev 2** — позиционные факты берутся из системного Stockfish `eval` (classical breakdown по 13 терминам) на backend; собственные детекторы оставлены только для тактических мотивов; chess-expert убран.
- **rev 3** (текущая) — **движок только на клиенте** (правило проекта). Позиционные ярлыки считаем на frontend через ВТОРУЮ WASM-сборку Stockfish — SF 16 (Lichess fork, последняя версия с classical eval). Backend больше не запускает SF subprocess. StockfishEvalService отменён. Объём B1 сокращён: prompt V2 + post-валидация + DTO.

## 1. Контекст

ADR-102 / KS-3614+3615+3616 — MVP-1. На живой партии три проблемы:

1. **Тавтология NAG.** `?!`→«неточность», `?`→«ошибка», `!`→«сильный ход» — пересказ `classification`.
2. **«Фигура висит» без причины.** Нет attackers/defenders/исхода размена.
3. **Молчание о позиционных мотивах и тактике.** Prompt запрещает выдумывать, фактов недостаточно.

Причины: бедные факты, жёсткий prompt, нет post-валидации.

## 2. Граница MVP-2

### Входит

1. **Positional facts** — frontend через **WASM SF 16** (Lichess fork с classical eval, отдельная сборка рядом с SF 18). Парсим breakdown по 13 терминам, дельта на ход, top-N ярлыков.
2. **Tactical motifs** — frontend (chess.js), 6 дёшевых детекторов: fork, double_attack, pin, skewer, discovered_attack, back_rank_weak.
3. **Расширение `hanging_piece`** — attackers, defenders, net_material_if_taken (frontend).
4. **`threats_created` / `threats_missed`** — frontend, статический подсчёт + sf_best.line (2–3 хода SAN).
5. **Переписать prompt** — запрет NAG-тавтологии, требование причины, лимит 30–60 слов, 6–8 few-shot пар.
6. **Post-валидация** — backend: NAG-blacklist + min-length.
7. **Eval-фикстуры** — 12 PGN-партий в `docs/quality/llm-comments-eval/` (готово, KS-3626).
8. **Feature-flag rollout** — ENV `REVIEW_COMMENT_V2=on|off`.

### НЕ входит

- Запуск движка на backend (правило проекта: engine только на клиенте).
- Сложные тактические мотивы (overloaded defender, deflection, decoy, interference, zwischenzug).
- Дообучение LLM на корпусе мастеров.
- Streaming SSE, TTS, кэш комментариев в БД.
- Эталонные комментарии от chess-expert.

## 3. Источники фактов

### 3.1. Карта источников

| Группа фактов | Источник | Сторона | Метод |
|---|---|---|---|
| Mechanical (san, uci, capture, check, mate, castling, promotion, en_passant) | chess.js | frontend | как в MVP-1 |
| `classification`, `delta_e`, `sf_best`, `maia_alternative`, `mate_threat_after` | SF 18 + Maia + classifyMove | frontend | как в MVP-1 |
| `stage`, `opening_name`, `material_balance`, `material_change` | chess.js + Analysis | frontend | как в MVP-1 |
| **`hanging_piece` расширенное** (attackers / defenders / net) | chess.js | frontend | сделано в F1 (KS-3623) |
| **`tactical_motifs[]`** (6 мотивов) | chess.js + детекторы | frontend | сделано в F1 (KS-3623) |
| **`threats_created` / `threats_missed`** | chess.js + sf_best.line | frontend | сделано в F1 (KS-3623) |
| **`sf_best.line`** (2–3 хода SAN) | sfBestPv | frontend | сделано в F1 (KS-3623) |
| **`positional_shifts[]`** (ярлыки из classical eval) | **WASM SF 16** (Lichess fork) | **frontend** | новый F1.5 |

### 3.2. Почему WASM SF 16 на frontend

Stockfish `eval` в classical-режиме даёт breakdown по терминам:

```
Term: Material, Imbalance, Pawns, Knights, Bishops, Rooks, Queens,
      Mobility, King safety, Threats, Passed, Space, Winnable.
Columns: MG (midgame), EG (endgame), Total (white-perspective).
```

Это даёт позиционные ярлыки без переизобретения evaluator'а.

**Где этот breakdown доступен:**
- Системный SF 15.1 на api-контейнере: есть. **Запрещено** правилом проекта (engine только на клиенте).
- WASM SF 18 (`apps/web/public/stockfish/stockfish-18-*`): classical evaluator выпилен в SF 17 и 18 полностью. `eval` отдаёт NNUE accumulator, не 13 терминов.
- **WASM SF 16** (Lichess fork `lichess-org/stockfish.wasm`, или nmrugg `stockfish.js` v15/v16): classical fallback есть, `setoption name Use NNUE value false` → `eval` отдаёт 13-term breakdown как у системного SF 15.1.

SF 16 — последняя ветка с classical evaluator в WASM. SF 17 и 18 — без него. Поэтому в качестве positional-engine кладём именно SF 16 lite.

### 3.3. Тактические мотивы остаются на chess.js

SF eval даёт численную дельту по `Threats` (например, `+0.30` в MG). Это полезно для общего фона, но не различает мотив по типу (вилка vs связка vs скрытое нападение) и не показывает атакованные фигуры. Дешёвые детекторы (6 мотивов) дают конкретные ярлыки + targets. Это дополняющие источники.

6 мотивов реализованы в F1 (KS-3623, коммит ea447240): fork, double_attack, pin, skewer, discovered_attack, back_rank_weak.

### 3.4. Сложные мотивы вне MVP-2

`overloaded_defender`, `deflection`, `decoy`, `interference`, `zwischenzug` — требуют мини-поиска. Включаем позже, если eval-фикстуры покажут, что критично.

## 4. Расширенная схема `FactsInput`

Сделано в F2 (KS-3624). Полная схема — в `packages/shared/src/types/api-contracts.ts`. Ключевое:

```ts
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

type FactsInput = {
  // ... (см. реализацию F2)
  positional_shifts: PositionalShiftId[];   // фронт заполняет до отправки батча
};
```

В rev 2 `positional_shifts` подразумевалось заполнить на backend. В rev 3 — заполнение целиком на frontend (через F1.5), backend получает уже готовый массив. Контракт типа не меняется.

## 5. Frontend: positional eval через WASM SF 16

### 5.1. Состав

- WASM-сборка SF 16 lite (~2 МБ) — кладём в `apps/web/public/stockfish/` рядом с существующим SF 18. Источник: `lichess-org/stockfish.wasm` (maintained Lichess fork) или `nmrugg/stockfish.js` v16. Точный выбор за frontend на этапе F1.5 (важно: версия должна поддерживать `eval` в classical-режиме с `Use NNUE false`).
- `apps/web/src/lib/review/positionalEval.ts` — обёртка над Web Worker:
  - инициализирует SF 16 в Worker;
  - `setoption name Use NNUE value false` после `uci`;
  - публичный метод `evalPosition(fen: string): Promise<ClassicalEvalBreakdown>` — парсит таблицу `eval`-output и отдаёт структуру.
- `apps/web/src/lib/review/positionalShifts.ts` — pure-функция: дельта между двумя `ClassicalEvalBreakdown`, выбор top-N ярлыков, дедупликация. Без зависимостей.

### 5.2. Жизненный цикл worker'а

- Worker лениво поднимается при первом обращении в рамках «Разобрать партию» (внутри `useGameReview`, после готовности SF 18 + Maia анализа, перед сборкой батча фактов).
- Один worker на весь прогон партии. Завершается после отправки батча (или по таймауту неактивности 60 с).
- Очередь команд внутри worker'а — sequential `position + eval`.

### 5.3. Парсинг eval-output

```
 Contributing terms for the classical eval:
+------------+-------------+-------------+-------------+
|    Term    |    White    |    Black    |    Total    |
|            |   MG    EG  |   MG    EG  |   MG    EG  |
+------------+-------------+-------------+-------------+
|   Material |  ----  ---- |  ----  ---- |  0.14 -0.29 |
|  Imbalance |  ----  ---- |  ----  ---- |  0.00  0.00 |
|      Pawns |  0.12 -0.02 |  0.18 -0.02 | -0.06 -0.00 |
... (13 terms total)
|      Total |  ----  ---- |  ----  ---- | -0.30 -0.96 |
+------------+-------------+-------------+-------------+
Classical evaluation   -0.27 (white side)
Final evaluation       -0.24 (white side)
```

Regex на строки таблицы: `^\|\s*(\w[\w\s]*?)\s*\|.*?\|\s*(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*\|$` — имя термина, total MG, total EG.

```ts
type ClassicalEvalBreakdown = {
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

### 5.4. Дельта и стадия

На каждый ply с NAG:
1. `before = evalPosition(facts.fen)`, `after = evalPosition(facts.fen_after)`.
2. Дельта по термину = `after.term - before.term`. POV ходящей стороны: для чёрных инвертируем.
3. По стадии: `opening`/`middlegame` → MG, `endgame` → EG.

### 5.5. Перевод в ярлыки

```ts
const SHIFT_THRESHOLD = 0.10;   // pawn units
const TOP_N = 2;

const SHIFT_MAP = {
  material:    ['material_gained',         'material_lost'],
  pawns:       ['pawn_structure_improved', 'pawn_structure_weakened'],
  knights:     ['knight_more_active',       null],
  bishops:     ['bishop_more_active',       'bishop_passive'],
  rooks:       ['rook_on_open_file',        null],
  queens:      ['queen_more_active',        null],
  mobility:    ['mobility_increased',       'mobility_decreased'],
  king_safety: ['king_safer',               'king_exposed'],
  threats:     ['threats_grew',             'threats_weakened'],
  passed:      ['passed_pawn_strong',       null],
  space:       ['space_gained',             null],
  winnable:    ['position_more_winnable',   'position_less_winnable'],
};
```

Алгоритм:
1. Берём 13 дельт по терминам, POV стороны.
2. Фильтр: `abs(delta) >= 0.10`, для знака есть ID в карте.
3. Сортировка по `abs(delta)`, топ-2.
4. **Дедупликация с явными фактами**:
   - `material_gained`/`material_lost` подавляется если уже есть `material_change` (capture был известен).
   - `threats_grew` подавляется если уже есть `threats_created.wins_material` (явная угроза описывает лучше).
5. Возврат `PositionalShiftId[]`.

### 5.6. Latency

- 1 eval в WASM SF 16 lite: ~5–30 мс (зависит от устройства).
- На батч 25 фактов × 2 позиции = 50 evals.
- Worker последовательно: ~250–1500 мс на батч.
- На фоне SF 18 анализа (15–30 с per партия) и LLM-вебхука (~10–25 с) — незаметно.

### 5.7. Graceful degradation

- WASM не загрузился → ловим promise reject, `positional_shifts: []` на всём батче. Комментарии всё равно генерируются (на тактических мотивах + hanging_piece + threats).
- Один eval не распарсился → этот факт получает `[]`, остальные обрабатываются.
- Прогон отвалился по таймауту → весь батч получает `[]`.

В UI ничего не показываем — graceful fallback, пользователь не видит разницы кроме отсутствия позиционных деталей в комментариях.

### 5.8. Бандл и lazy-load

- SF 16 lite WASM (~2 МБ) и JS-loader (~30 КБ) лежат в `apps/web/public/stockfish/stockfish-16-lite.{js,wasm}`.
- Загрузка — динамическим `import()` или `new Worker('/stockfish/stockfish-16-lite.js')` внутри `positionalEval.ts`.
- Не попадает в основной бандл Vite — не влияет на initial-page-load.
- Грузится только при «Разобрать партию» (как и SF 18).

## 6. Backend: только prompt + post-валидация (никакого engine)

### 6.1. Состав

`apps/api/src/analysis-review/`:
- `review-comment.service.ts` (обновляется):
  - `buildSystemPrompt` — ветка V2 (§7.1) с few-shot;
  - `postValidate(comments[])` — NAG-blacklist + min-length (§8);
  - ENV-флаг `REVIEW_COMMENT_V2`.
- `dto/batch-comment.dto.ts` (обновляется): новые поля (`positional_shifts`, расширенный `hanging_piece`, `tactical_motifs`, `threats_*`, `sf_best.line`, `fen_after`) с class-validator.
- `review-comment.service.spec.ts` (обновляется): тесты на blacklist, min-length, prompt V2.

`StockfishEvalService` и `positional-shifts.ts` на backend — **не создаём** (отменено rev 3).

### 6.2. Поток

`POST /api/analyses/review/comments` принимает батч с уже заполненными фронтом `positional_shifts[]`. Backend не делает eval, не запускает subprocess. Сразу строит prompt и шлёт в `AI_CHAT_WEBHOOK_URL`, парсит ответ, прогоняет через post-валидацию, возвращает.

### 6.3. Объём B1 (после rev 3)

Сокращён с ~2 дней до ~1 дня. Меньше кода (нет subprocess, нет парсера таблицы), меньше зависимостей (нет child_process), нет рисков с версией SF на бэке.

## 7. Новый prompt

Без изменений vs rev 2. Текст системного prompt'а — §5.1 rev 2 (8 few-shot пар, 30–60 слов, лимит max_tokens 160 на факт, temperature 0.4, упоминание PositionalShiftId-ярлыков в правилах).

## 8. Post-валидация

Без изменений vs rev 2.

- NAG-blacklist (RU + EN), нормализация: trim, lowercase, без `.!?,:;`. Точное совпадение → `""`.
- Минимум 4 слова или 25 символов → иначе `""`.
- Фронт уже умеет показывать дубль с пустыми комментариями (KS-3616).

## 9. Eval-фикстуры

Сделано в A1 (KS-3626): 12 PGN-партий в `docs/quality/llm-comments-eval/` (см. README там). Покрытие — тактика, hanging_piece расширенный, 8 типов positional_shifts ярлыков, ловушки на NAG-тавтологию.

Все 12 валидируются `chess.js@1.4`.

Метрики прогона — §9.2 rev 2:
- % отсева post-валидацией ≤ 5 %,
- % с глаголом-причиной ≥ 80 %,
- % галлюцинаций ≤ 5 %,
- subjective ≥ 3.5/5 на 5 партиях.

## 10. Rollout

### 10.1. ENV-флаг

```
REVIEW_COMMENT_V2=on     # default off в .env.example
REVIEW_COMMENT_MIN_WORDS=4
REVIEW_COMMENT_MIN_CHARS=25
```

Никаких ENV для Stockfish на бэке — нет subprocess, нет конфигурации.

### 10.2. Поведение при rollback (V2=off)

- Frontend всегда отдаёт расширенный shape, включая `positional_shifts[]` (или `[]` если SF 16 worker недоступен).
- Backend при `V2=off` строит prompt MVP-1 (без few-shot, игнорирует positional_shifts/motifs/threats/расширенный hanging_piece).
- Post-валидация всегда включена.

### 10.3. Включение

После A1-прогона (eval-фикстуры зелёные) → D1 (devops): `REVIEW_COMMENT_V2=on` на проде, 24 часа мониторинг `ReviewCommentService` (5xx, latency).

DevOps в rev 3 НЕ трогает Docker-образ — серверный SF не используется. Только переменная окружения.

## 11. Декомпозиция rev 3

### Готово

- **F1 (KS-3623)** — frontend extractFacts расширение (tactical_motifs, threats, hanging_piece расширенный, sf_best.line, fen_after). Коммит `ea447240`.
- **F2 (KS-3624)** — shared/api-contracts.ts `FactsInput` с `positional_shifts: PositionalShiftId[]`. Типы менять не нужно.
- **A1 фикстуры (часть KS-3626)** — 12 PGN-партий + README в `docs/quality/llm-comments-eval/`.

### Новые / переписанные тикеты

**F1.5 (новый, frontend, ~2 дня) — WASM SF 16 для positional_shifts.**

- Подобрать и положить WASM-сборку SF 16 lite в `apps/web/public/stockfish/stockfish-16-lite.{js,wasm}`. Источник: Lichess fork или nmrugg. Главное — поддержка `eval` в classical-режиме с `Use NNUE value false`.
- `apps/web/src/lib/review/positionalEval.ts` — Web Worker обёртка, `evalPosition(fen): Promise<ClassicalEvalBreakdown>`, парсер eval-output (§5.3).
- `apps/web/src/lib/review/positionalShifts.ts` — pure-функция (§5.5): дельта + top-2 ярлыка + дедупликация.
- Интеграция в `useGameReview`: после готовности SF 18 + Maia, перед `POST /api/analyses/review/comments` — поднять SF 16 worker, прогнать `fen` + `fen_after` для каждого NAG-ply, заполнить `positional_shifts`. Один worker на весь прогон, lazy-load.
- Graceful degradation: worker fail → `positional_shifts: []`, без блокировки flow.
- Unit-тесты:
  - `positionalShifts.ts` на синтетических `ClassicalEvalBreakdown` парах (top-N, threshold, дедупликация);
  - `positionalEval.ts` smoke (worker грузится, парсится таблица для startpos).
- Метки: `analysis`, `chat`, `performance`.

**B1' (KS-3625, переписать from rollback) — backend prompt V2 + post-валидация + DTO.**

- Убрать из плана: `StockfishEvalService`, `positional-shifts.ts` на backend, ENV для STOCKFISH_BIN / SF_POOL_SIZE / SF_TIMEOUT.
- Оставить:
  - `dto/batch-comment.dto.ts` — добавить новые поля (`positional_shifts`, расширенный `hanging_piece`, `tactical_motifs`, `threats_*`, `sf_best.line`, `fen_after`) с class-validator;
  - `review-comment.service.ts`:
    - `buildSystemPrompt` — ветка V2 (см. §5.1 rev 2) с 6–8 few-shot пар, 30–60 слов;
    - `postValidate(comments[])` — NAG-blacklist regex + min-length;
    - ENV: `REVIEW_COMMENT_V2`, `REVIEW_COMMENT_MIN_WORDS`, `REVIEW_COMMENT_MIN_CHARS`;
  - Тесты: blacklist срезает «Сильный ход.»/«Mistake.», min-length, prompt V2 содержит запрет и few-shot, V2=off → старый prompt.
- Срок ~1 день (вместо 2 в rev 2).
- Метки: `analysis`, `chat`.

**A1 прогон (часть KS-3626, после F1.5 + B1') — eval-фикстуры → метрики → отчёт.**

- 12 PGN уже готовы.
- Прогон pipeline локально на каждом, сбор метрик §9.2.
- Отчёт в KS-3620.
- При недостаточных метриках — итерация prompt / детекторов / ярлыков.

**D1 (KS-3627) — включение V2 на проде.**

- `REVIEW_COMMENT_V2=on` на проде, 24 часа мониторинг.
- НИКАКОГО Stockfish на api-контейнере. НИКАКИХ изменений Docker-образа.
- Метки: `analysis`.

### Опциональный F1.6 (factor-out, не блокер MVP-2)

Мини-детектор пешечной типизации на chess.js — `isolated_pawn`, `doubled_pawn`, `passed_pawn` как явные ярлыки (SF eval даёт агрегированный `Pawns` без типизации). Добавляет 100–200 строк кода + тесты. Можно сделать в F1.5 если хватит времени, либо отдельный тикет после A1, если на фикстурах окажется, что модель плохо различает типы пешечных слабостей.

### Зависимости

```
F1 (done) ──┐
F1.5 (new) ─┼─> A1 прогон ──> D1
B1' ────────┘
A1 фикстуры (done)
```

F1.5 и B1' идут параллельно. A1 прогон стартует после обоих.

### Прогноз

- F1.5 ~2 дня, B1' ~1 день (параллельно) → 2 рабочих дня до A1.
- A1 прогон + отчёт — 0.5 дня.
- D1 — 0.1 дня.
- **Итого до прода: ~3 рабочих дня** от старта F1.5/B1'.

## 12. Риски rev 3

| Риск | Митигация |
|---|---|
| WASM SF 16 сборка не найдётся в готовом виде | Lichess fork (`lichess-org/stockfish.wasm`) — Maintained, есть в npm. nmrugg/stockfish.js v15/v16 — альтернатива. F1.5 на этапе подбора фиксирует точный source. |
| Bundle +2–10 МБ к /public | Lazy-load по запросу «Разобрать партию», не в initial-page-load. На фоне SF 18 single (108 МБ) — незаметно. |
| Latency eval-прогона на слабых клиентах | 50 evals × 5–30 мс = 0.5–1.5 с на батч. На фоне 70–130 с общего разбора — терпимо. Graceful degradation если worker не отвечает. |
| `Use NNUE false` в SF 16 WASM не поддерживается (хотя ожидаем что поддерживается) | На F1.5 первым делом проверить `uci → setoption Use NNUE value false → eval startpos`. Если нет — fallback на SF 11 ASMJS (последняя точно classical-only сборка), или Вариант 2 (свой детектор). |
| Memory leak в long-lived worker | Завершать worker по `timeout 60s` после батча или после `useGameReview.cleanup()`. |

## 13. Открытые вопросы

Нет. Все развилки закрыты:
- Engine на клиенте — правило проекта соблюдено.
- WASM SF 16 — известная стабильная сборка (Lichess fork).
- F1.5 — добавляется как новый тикет, объём ~2 дня.
- B1 переписывается с сокращением, СF subprocess отменён.
- F2 уже закрыт типами, менять не нужно.
- Бюджет токенов снят с радара.

## 14. Резюме

MVP-2 закрывает три проблемы MVP-1 ортогональными источниками фактов, **все на клиенте**:

1. **Positional shifts** — frontend через WASM SF 16 (Lichess fork с classical eval), парсим breakdown по 13 терминам, переводим топ-2 в ярлыки.
2. **Tactical motifs + threats + расширенный hanging_piece** — frontend (chess.js), сделано в F1.
3. **Переписан prompt** — backend, без вызовов engine; few-shot, запрет тавтологии, 30–60 слов.
4. **Post-валидация** — backend, режет NAG-тавтологию и слишком короткие ответы.

Engine только на клиенте: SF 18 как сейчас (для анализа и classification) + SF 16 (для positional eval, новый F1.5). Backend остаётся stateless с точки зрения engine. StockfishEvalService отменён вместе с subprocess и Docker-зависимостями.

Eval-фикстуры (12 PGN) уже лежат в `docs/quality/llm-comments-eval/`.

Декомпозиция:
- Готово: F1 (KS-3623), F2 (KS-3624), фикстуры (часть KS-3626).
- Новое: F1.5 (frontend positional eval ~2 дня).
- Переписать: B1' (KS-3625, ~1 день, без StockfishEvalService).
- Без изменений: A1 прогон (KS-3626, ~0.5 дня), D1 (KS-3627, без правок Docker).
- Срок до прода: ~3 рабочих дня от старта F1.5/B1'.
