# ADR-102. Словесные комментарии к ходам через LLM + факт-экстракторы (MVP-1)

Статус: предложен (KS-3612).
Дата: 2026-06-02.
Связано: ADR-100/101 (NAG-аннотации), ADR-063 (AI-ассистент через webhook), KS-3321 (зависимость от ноутбука), arxiv 2410.20811 (concept-guided commentary).

## 1. Контекст

ADR-100/101 дают «механический» разбор партии: NAG-знаки (`?`, `??`, `!`, `!!`) + variations с продолжениями. Этого мало для обучения — пользователь видит «здесь ошибка», но не **почему** это ошибка и что **именно** изменилось.

Цель MVP-1 — добавить **словесные комментарии** к ходам, генерируемые LLM на основе извлечённых фактов. Не шаблонные («Этот ход теряет 1.5 пешки»), а пересказ позиции естественным языком.

Anti-pattern, который не повторяем — Chess.com Game Review с узнаваемыми шаблонами «You played a great move!» / «This is a blunder» — одинаковыми во всех партиях.

## 2. MVP-1 граница

### Что входит

1. **Rule-based facts extractor** — минимальный набор фактов (см. §3.2 «MVP» приоритет).
2. **Готовая LLM** с жёстким промптом (см. §6).
3. **Комментарий только на ходы с NAG** (включая Maia-trap variations) — не на каждый из 80 полуходов. Снижает стоимость LLM-вызовов в 4-5 раз и устраняет «шумовые» комменты на тривиальных ходах.
4. Адаптация под уровень — через **существующий `analysis.maia.elo`** из localStorage (уже выбирается пользователем в шапке engine-panel, ADR-097). Никаких новых селекторов.
5. Комментарий пишется в стандартное PGN-поле `{...}` после SAN. Сохраняется как часть `Analysis.pgn` дубля (ADR-100 §8).

### Что НЕ входит (follow-up MVP-2)

- Сложные тактические мотивы (вилка, связка, открытое нападение, перегруженная фигура, отвлечение/завлечение, промежуточный ход, снятие защитника, запертая фигура) — требуют отдельных шахматных алгоритмов, каждый — отдельная задача. В MVP-1 ограничиваемся базовыми фактами от SF/Maia/chess.js.
- Comments на каждом ходе — только на размеченные NAG (см. §4 open question).
- Дообучение LLM на корпусе мастеров.
- Конвейер «книга → PGN» (PGN масштабного датасета для fine-tuning).
- Имитация стиля конкретного автора.
- Many-language коментарии — MVP English+Russian, выбор по i18n языку пользователя.
- Audio TTS, voice-over — отдельная фича.

## 3. Список фактов

### 3.1. Источники

- **Stockfish (из ADR-101 уже собирается)**: `wdlBefore`, `wdlAfterPlayed`, `wdlAfterBest`, `secondBestCp`, `sfBestUci`, `sfBestPv` (до 8 полуходов через `buildStabilizedLine`), `mate?: number` (если есть).
- **Maia (из ADR-097/101 уже собирается)**: `playedProb`, `sfBestProb`, `maiaTopUci`, `maiaTopProb`, `policy` (top-5 ходов с probability).
- **classifyMove (KS-3607)**: `classification ∈ {best, good, inaccuracy, mistake, blunder}` — единый источник истины.
- **chess.js (новое для MVP)**: SAN, флаги хода (capture, check, mate, en-passant, castling, promotion), material count, pawn structure (doubled/isolated/passed — простые проверки по битмаскам).
- **Analysis context**: `Analysis.opening` (текстовая строка, уже есть в БД), `whitePlayer`/`blackPlayer` names.

### 3.2. Список фактов с приоритетом

#### MVP-1 (обязательно)

| Факт | Источник | Тип |
|---|---|---|
| Сторона на ходу | chess.js | `'white' \| 'black'` |
| SAN сыгранного хода | chess.js | string |
| Захват фигуры | chess.js flag `x` | boolean + захваченная фигура |
| Шах | chess.js flag `+` | boolean |
| Мат / mate-in-N | chess.js flag `#` + SF `mate` | `null \| number` |
| Рокировка (короткая/длинная) | chess.js flag | `null \| 'O-O' \| 'O-O-O'` |
| Превращение пешки | chess.js promotion | `null \| 'Q' \| 'R' \| 'B' \| 'N'` |
| En passant | chess.js flag | boolean |
| classification от classifyMove | KS-3607 | `MoveClass` |
| ΔE (`E_before - E_after`) | wdl.ts | number ∈ [-1..+1] |
| Stockfish best ход (если ≠ сыграно) | SF | string \| null |
| Maia top-1 ход (если ≠ сыграно и ≠ SF best) | Maia | string \| null + prob |
| Stage партии | derived (см. §3.3) | `'opening' \| 'middlegame' \| 'endgame'` |
| Opening name (если в дебюте) | `Analysis.opening` | string \| null |
| Material balance после хода | chess.js + count | number (Δ в пешках) |
| Material change (если был обмен в этом полуходе) | derived diff | `null \| { piece: string, side: 'white'\|'black' }` |
| Висящая фигура после хода | derived attack-count | `null \| { square, piece, side }` (только если очевидно — не защищена и атакована меньшей фигурой) |
| Угроза мата в N после хода | SF mate-in-N в pv-line | `null \| number` |

#### Follow-up MVP-2

| Факт | Сложность |
|---|---|
| Вилка / связка / сквозная / открытое нападение | высокая (отдельные алгоритмы детекции) |
| Перегруженная фигура | средняя |
| Снятие защитника / отвлечение / завлечение | высокая |
| Промежуточный ход | средняя |
| Открытые линии (вертикали/диагонали) | низкая, но не критично для MVP |
| Форпосты | средняя |
| Два слона | низкая |
| Безопасность короля (атакующий потенциал) | средняя |
| Слабые поля | средняя |
| Активность фигур (мобильность count) | низкая |
| Изменение пешечной структуры (отсталые/сдвоенные/изолированные/проходные) | низкая (битмаски), но не критично |
| Endgame tablebase (Syzygy) | требует серверной интеграции |

В MVP-1 не делаем — иначе тикет растягивается на месяцы. LLM получит грубые факты и базовую классификацию, на основе этого даст «осмысленный пересказ» (например, «Ты пожертвовал ферзя за ладью — это ошибка по оценке движка»).

### 3.3. Stage партии (простой алгоритм)

```ts
function getStage(fen: string, ply: number): 'opening' | 'middlegame' | 'endgame' {
  if (ply <= 16 /* 8 ходов каждой стороны */) return 'opening';
  const piecesCount = countNonPawnPieces(fen);
  if (piecesCount <= 6 /* 3 фигуры с каждой стороны или меньше */) return 'endgame';
  return 'middlegame';
}
```

Грубо, но достаточно для адаптации стиля комментариев.

### 3.4. JSON-форма фактов (вход в LLM)

```ts
type FactsInput = {
  ply: number;
  fen: string;
  side: 'white' | 'black';
  move: { san: string; uci: string; capture: string | null; check: boolean; mate: number | null; castling: 'O-O' | 'O-O-O' | null; promotion: string | null };
  classification: MoveClass;
  delta_e: number;                   // [-1..+1]
  sf_best: { uci: string; san: string } | null;        // null если playedUci === sfBestUci
  maia_alternative: { uci: string; san: string; probability: number; classification: MoveClass } | null;
  stage: 'opening' | 'middlegame' | 'endgame';
  opening_name: string | null;
  material_balance: number;          // pawns, + значит у side преимущество
  material_change: { piece: string; side: 'white' | 'black' } | null;
  hanging_piece: { square: string; piece: string; side: 'white' | 'black' } | null;
  mate_threat_after: number | null;
  user_elo: number;                  // из analysis.maia.elo
  user_language: 'en' | 'ru';        // из i18n
};
```

## 4. Решение по LLM и месту запуска

### 4.1. Варианты

| | A. Внешний API (Groq Llama 3.3 70B / Mistral / Together) | B. Локальная LLM в браузере (WebLLM, Qwen 2.5 1.5B-3B) | C. Существующий webhook (через Anthropic Claude по OAuth ноутбука) |
|---|---|---|---|
| Стоимость | $0.01-0.03 за партию | 0 | 0 (Pro/Max subscription) |
| Latency на ход (MVP, ~80 input + 80 output tokens) | 200-500 мс | 5-30 с | 1-3 с |
| Latency на партию (15-20 ходов с NAG) | 3-8 с | 1-10 мин | 15-60 с |
| Качество шахматных комментариев | высокое (Llama 70B / Mistral Large) | низкое-среднее (3B параметров) | высокое (Claude Sonnet/Haiku) |
| Зависимость от ноутбука | нет | нет | да (тот же блокер KS-3321) |
| Shared rate-limit с другими | API tier (наш) | нет | да (с агентами и AI Assistant) |
| Требует backend-инфры | API key в secrets + HTTP-клиент | нет (всё в браузере) | уже работает через `webhook-server.py` |
| Зависимость от внешнего сервиса (uptime) | да | нет | частично |
| Готовность к MVP | высокая | средняя (~1 неделя интеграции WebLLM) | **высочайшая** (готово сегодня) |
| Privacy | данные уходят на внешний API | данные не покидают браузер | данные идут на ноутбук пользователя + Anthropic |

### 4.2. Решение: C — через существующий webhook (Anthropic Claude)

В MVP-1 используем **тот же путь что у AI-ассистента** (ADR-063, `ChatAssistantService`): api → fetch `AI_CHAT_WEBHOOK_URL` → `webhook-server.py` на ноутбуке пользователя → `claude` CLI с Pro/Max OAuth.

**Обоснование:**
- Готовая инфра — ноль новой backend-работы (тот же endpoint, тот же auth-flow, тот же error-handling).
- Высокое качество комментариев (Claude — сильная модель для естественного языка).
- Без денежных затрат пользователя (его Pro/Max подписка). Главный приоритет в проекте (см. KS-3572).
- Опыт shared rate-limit с агентами и AI Assistant уже понятен (см. KS-3321 диагностика).

**Цена** — те же ограничения что AI Assistant: shared 5-hour limit Pro/Max, зависимость от uptime ноутбука. Если ноутбук недоступен — auto-аннотация без LLM-комментариев (graceful degradation, см. §7.4).

**Future migration** (если решим выйти из зависимости от ноутбука):
- При появлении бюджета на API tier — переключить на Groq Llama 3.3 70B / Mistral. Один ENV-флаг в backend, фронт без изменений.
- WebLLM (B) — отдельный future-тикет если хочется 100% offline.

### 4.3. Endpoint flow

```
Frontend (useGameReview hook)
  → POST /api/analysis-review/comments { facts: FactsInput[] }
  → Backend (NestJS controller)
  → ChatAssistantService.callWebhookBatch(facts, systemPrompt)
  → fetch AI_CHAT_WEBHOOK_URL { messages: [...], system: ... }
  → webhook-server.py → claude CLI → Anthropic
  → response { comments: string[] }
  → Backend response { comments: string[] }
  → Frontend применяет к buildAnnotations output
```

**Batching** — отправлять все N фактов одним запросом (массив в system-prompt'е и messages), Claude возвращает массив комментариев. Снижает overhead на overheadами авторизации, MCP-init и т.п.

Backend-метод — переиспользует существующий `ChatAssistantService.getResponse` либо создаём близкий `ReviewCommentService.batchComment(facts[])` (зависит от backend на этапе реализации; ADR не предписывает).

## 5. Промпт-каркас

### 5.1. Структура

```
SYSTEM PROMPT (фиксированный):

You are a chess coach commenting moves for a learning player.
Your input is a JSON array of facts about specific moves in a chess game.
For each move, write ONE short sentence (max 20 words) that:
- describes WHAT happened (not WHY in general, just facts)
- mentions the engine's verdict (mistake/blunder/best/etc.) ONCE per move only
- uses chess terms appropriate to the user_elo: simple for elo<1500, technical for elo>2000
- writes in user_language ('en' or 'ru')

CRITICAL RULES:
- DO NOT invent tactical motifs (forks, pins, skewers) unless explicitly listed in facts.
- DO NOT make subjective evaluations beyond classification field.
- DO NOT add explanations or "you should" advice.
- DO NOT mention engine evaluations in centipawns.
- If facts contain hanging_piece — say which piece is hanging and on which square.
- If facts contain maia_alternative — optionally mention "humans often play X" in 1 of 5 cases (variety).
- Stick to plain facts. The user already sees the move and the NAG mark.

OUTPUT FORMAT:
JSON array of strings, one per input fact, in the same order.
Example: ["You captured the knight, losing your bishop.", "Sharp move winning the queen."]

USER PROMPT:
facts = <JSON array of FactsInput>
```

### 5.2. Параметры

- `temperature: 0.4` — низкая, против отсебятины и галлюцинаций.
- `max_tokens` per message: 80 × N (где N — количество фактов в батче).
- Stop tokens: `]\n` или `]\n\n` (закрытие JSON-массива).

### 5.3. Адаптация под уровень

- `user_elo < 1500` — простые термины: «потерял», «выиграл», «не лучший ход».
- `1500 ≤ user_elo < 2000` — может упоминать «инициативу», «структуру», «компенсацию».
- `user_elo ≥ 2000` — допустимы термины «изолированная пешка», «висячая пешка», «слабый комплекс».

Адаптация — в промпте через переменную `user_elo`, не отдельные prompt'ы.

### 5.4. Анти-галлюцинации (мероприятия)

1. **Жёсткий список разрешённых терминов** в промпте: «If a fact is not in input JSON, do not mention it».
2. **Low temperature** + явные «do not» в системе.
3. **Schema-driven output** (JSON array) — нельзя «сочинить за пределами» одной строки на факт.
4. **Post-hoc validator** на бэкенде: проверяем что response — валидный JSON и длина массива совпадает. При невалидном response — fallback на пустой комментарий (NAG остаётся, текста нет).
5. **Sample-based eval** (после MVP): отобрать 20 партий, проверить какие комментарии содержат не упомянутые в facts мотивы. Если >10% — ужесточить промпт.

## 6. Производительность и стоимость

### 6.1. Количество LLM-вызовов

- На партию ~80 полуходов: ~15-20 с NAG-метками (по статистике precision-модуля для среднего пользователя 30-50% полуходов содержат отклонения от best, но `?!`-метка `inaccuracy` идёт только на 20-30%, `?`/`??` ещё реже).
- Плюс комментарии на root-ход variations (по §4 ADR-101 — ~10-15 variations на партию). Они нужны? Дефолт: **НЕТ** в MVP-1 (комментируем только основную линию, не variations). Это снижает overhead.

**Итого: 15-25 комментариев на партию.**

### 6.2. Бюджет на партию

С батчингом — 1 LLM-call на партию (все факты в одном prompt'е):
- Input: 15-25 фактов × ~150 tokens/факт = 2-4k tokens.
- Output: 15-25 × ~30 tokens = 450-750 tokens.
- Total: ~3-5k tokens.
- Latency: 5-15 с через Claude Haiku, 10-30 с через Sonnet.

С учётом ADR-101 (60-100 с на анализ) — total «Разобрать партию» = **~70-130 с p50** (вместо 60-100 с в ADR-101).

### 6.3. Прогресс-модалка

Существующая модалка (ADR-100 §6 / KS-3604) показывает `done/total`. Добавляем стадии:
- Stockfish: 0-60 %
- Maia: 0-60 % (параллельно)
- LLM comments: 60-100 %
- Save duplicate: 100 %

Frontend сам определяет процент стадии. Модалка-DOM не меняется.

### 6.4. Cancel

Если пользователь нажал «Отмена» во время LLM-фазы — текущий webhook-call abortable через `AbortController`. Дубль не создаётся (как и при cancel в фазе Stockfish/Maia).

### 6.5. Graceful degradation

Если LLM-вызов провалился (webhook 502, timeout, невалидный JSON):
- NAG-аннотации и variations сохраняются как есть (без комментариев).
- В UI — toast «Комментарии не сгенерированы, попробуйте позже» (i18n).
- Дубль создаётся успешно.

Не блокируем основной flow на LLM.

## 7. Интеграция

### 7.1. Где живут комментарии

В стандартном PGN-поле `{...}` после SAN:
```
1. e4 {Хорошее начало в открытом стиле.} e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5? {Это ошибка — теряется пешка после Bxd5 Qxd5 Nxf7.} ...
```

Стандартное chess.js-PGN-форматирование уже это поддерживает (через `add comment`). Frontend сериализатор PGN в проекте (см. `useChessGame`) использует стандартный pgn-формат — комментарии писать рядом с node's `comment: string`.

### 7.2. Как взаимодействует с NAG и variations

- На каждом ходе с NAG-меткой (1-6 коды) — комментарий с описанием от LLM.
- В variations — комментарии НЕ пишем в MVP-1 (variation сама достаточно описывает «как надо было»). Если по фидбэку понадобится — отдельный follow-up.
- Конфликтов с уже расставленными NAG/variations нет — это разные PGN-поля.

### 7.3. Когда запускается

Часть единого flow «Разобрать партию» (ADR-100 §5):
- Stockfish + Maia анализ → собрать факты.
- Применить `buildAnnotations` (NAG + variations).
- Для каждого ply с NAG — собрать `FactsInput`, отправить батчем в LLM.
- Применить полученные comments к PGN-дереву.
- Сохранить дубль через `POST /analyses/:id/duplicate-annotated`.

### 7.4. Fallback при недоступном webhook

Если `AI_CHAT_WEBHOOK_URL` пуст / webhook 502 — `ReviewCommentService` сразу возвращает пустые комментарии без вызова. Frontend получает `comments: []` и создаёт дубль без текстовых комментариев. NAG-аннотации не страдают.

UI-toast информирует «Комментарии недоступны (LLM выключена)». Это не блокирует функциональность Разобрать партию.

## 8. Декомпозиция

### Этап A — feature extractor (frontend, 1-2 дня)

**KS-XXXX: Rule-based facts extractor для PGN-комментариев.**

1. `apps/web/src/lib/review/extractFacts.ts`:
   - Input: `{ fen, playedUci, sfData, maiaData, classification, opening }`.
   - Output: `FactsInput` (см. §3.4).
   - Использует `chess.js` для базовых флагов, простой attack-count через chess.js board scan для `hanging_piece`.
2. Unit-тесты:
   - Каждый поле в `FactsInput` тестируется отдельно (capture, check, mate, castling, promotion, stage, material).
   - `hanging_piece` для типичных позиций.

**Acceptance:** для типовой партии extractor возвращает корректные facts для всех ходов. Vitest зелёный.

### Этап B — LLM client + промпт (backend, 1-1.5 дня)

**KS-XXXX: ReviewCommentService — batch LLM call через webhook.**

1. Backend модуль `apps/api/src/analysis-review/`:
   - `review-comment.service.ts` — `batchComment(facts: FactsInput[]): Promise<string[]>`.
   - Внутри: composer system+user prompt'а, fetch к `AI_CHAT_WEBHOOK_URL` (тот же endpoint что AI Assistant), парсинг JSON-массива в response, валидация.
   - Graceful degradation: webhook down → `[]`.
2. Контроллер `POST /api/analysis-review/comments`:
   - DTO: `{ facts: FactsInput[], userElo: number, language: 'en'|'ru' }`.
   - Auth: JwtAuthGuard (тот же что Analysis).
   - Rate limit: 5 запросов/мин на user (Redis), 50 в день (повторить паттерн `ChatAssistantService`).
3. Unit-тесты сервиса (mock fetch).

**Acceptance:** локально dev-сервер принимает запрос с 5 facts, возвращает 5 комментариев (мок webhook). Тесты зелёные.

### Этап C — интеграция в useGameReview (frontend, 0.5-1 день)

**KS-XXXX: Подключение LLM-комментариев к flow «Разобрать партию».**

1. В `useGameReview` после `buildAnnotations`:
   - Собрать `FactsInput[]` для всех ходов с NAG.
   - Вызвать `POST /api/analysis-review/comments`.
   - Применить полученные comments к PGN-дереву (через существующий `applyAnnotationsToPgn`, расширить чтобы принимать `commentByPly: Record<number, string>`).
2. Progress-модалка — добавить стадию «Comments 60-100%».
3. Toast при graceful degradation.

**Acceptance:** клик «Разобрать партию» на 80-полуходной партии → дубль содержит комментарии на всех ходах с NAG-меткой. p50 ~70-130 с.

### Этап D — eval (architect, 0.5 дня) — опционально

**KS-XXXX: Sample-based eval анти-галлюцинаций.**

1. Прогнать 5-10 реальных партий через flow.
2. Проверить вручную: содержат ли комментарии мотивы (вилка/связка), которых нет во входных facts? Если >10% — ужесточить промпт §5.4.
3. Отчёт в комментарии тикета.

Можно пропустить если уверены в промпте — корректировать по фидбэку первого реального пользователя.

## 9. Открытый вопрос (один критичный)

**Комментировать каждый ход или только ходы с NAG?**

Дефолт ADR — **только NAG-метки** (15-25 комментариев на партию, см. §6.1).

Альтернатива — все 80 полуходов (даже good/best с classification ≈ best). Pro: непрерывное повествование, как у живого комментатора. Con: 4-5× больше LLM-токенов и времени; шумные комменты на тривиальных ходах («Ты сыграл лучший ход. Очевидное продолжение.» × 60 ходов).

**Подтвердить дефолт.** При выборе «все ходы» — перепрошиваем оценку §6.2 (10-20k tokens на партию, ~30-60 с латентности).

Остальные вопросы (например, комментировать ли variations; включать ли opening name; адаптировать ли длину комментария по сложности) — захардкоженные дефолты, корректируем по фидбэку.

## 10. Что НЕ входит

- Сложные тактические детекторы (вилка/связка/...) — MVP-2.
- Дообучение LLM на корпусе.
- Endgame tablebase facts.
- Voice / TTS.
- Real-time live комментарии (только постразбор).
- Перевод между языками — генерируем сразу на нужном языке (en/ru).
- Streaming SSE для комментариев (батч-режим достаточно для MVP).
- Кэш комментариев в БД (повторный «Разобрать» обновляет дубль, ADR-100 §8.4 — комментарии тоже перезапишутся).

## 11. Резюме

MVP-1: feature-extractor собирает базовые факты (chess.js + SF/Maia outputs + classifyMove), батч из 15-25 фактов отправляется через **существующий webhook** (Anthropic Claude по Pro/Max OAuth — тот же путь что AI Assistant), Claude возвращает массив комментариев, они применяются к PGN-дереву и сохраняются в дубль.

Latency на партию +5-30 с поверх ADR-101 (total 70-130 с p50). Стоимость для пользователя $0 (его подписка). Качество — высокое (Claude — сильная модель). Зависимость от ноутбука сохраняется (как у AI Assistant) — fallback при недоступности: дубль без комментариев, NAG/variations не страдают.

Декомпозиция: A (frontend extractor 1-2 дня), B (backend ReviewCommentService 1-1.5 дня), C (frontend интеграция 0.5-1 день), D (eval опционально). Backend нужен (новый endpoint), но малый объём — переиспользует webhook-flow AI Assistant.

Один открытый вопрос — «комментарии на все ходы или только на NAG-метки» (дефолт: только NAG).
