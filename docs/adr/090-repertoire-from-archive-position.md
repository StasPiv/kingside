# ADR-090. Дебютный репертуар из партий 2400+ классика по позиции анализа

Статус: предложен (2026-05-30) — аналитический документ
Связано: KS-3462 (этот ADR), ADR-077 (RepertoireTree),
ADR-078 (multi-source репертуары / KS-3323), ADR-087
(AnalysisActionsMenu), KS-2475 (Stockfish WASM), ADR-066
(WDL move-classification).

## 1. Контекст

Цитата пользователя: «Формировать дебютный репертуар по последним
партиям сильных игроков в классическом контроле. Точка входа —
окно анализа. Ввожу позицию и нажимаю в контекстном меню "Создать
репертуар для тренировки". Из архива выбираются последние партии
игроков 2400+ в классику, объединяются в один PGN, формируем
тренировку. Важно — проверить все ходы локальным БРАУЗЕРНЫМ
стокфишем секунда на ход. Глубина не более 40 полуходов».

Уточнение координатора: Stockfish-валидация **на клиенте** через
WASM (как в `/analysis`). Backend собирает партии + склеивает
сырой PGN; frontend прогоняет через локальный движок.

## 2. Проверено по коду (без выдумок)

### 2.1 Archive-service — поиск по позиции уже есть

`/project/apps/archive-service/src/archive/archive.controller.ts`:
- **`GET /games/by-position?fen=&minElo=&bucket=&sort=&limit=`** —
  поиск партий, проходивших через FEN. Реализован через
  Zobrist-индекс таблицы `archive_game_positions` (NOT raw scan):
  поля `(positionKey, bucket, gameId)`, индекс `_recent_idx` для
  `sort=recent` (KS-2139).
- DTO `archive-games-by-position-query.dto.ts` параметры:
  `fen`, `bucket: 'master'|'user'`, `sort: 'recent'|'topElo'`,
  `minElo`, `limit ≤ 50`, `color`, `result`, `cursor`.
- **`timeControlCategory` в by-position DTO явно не упомянут** —
  открытый вопрос (§ Open Q1). `bucket='master'` уже даёт высокий
  рейтинг (по реализации), но фильтр classical может потребовать
  расширения DTO либо post-фильтра на стороне opening-trainer
  api после получения списка.
- Параллельный endpoint `GET /games?timeControlCategory=classical&minElo=2400`
  — для общего поиска без position-фильтра (есть).

`archive_games` поля: `pgn`, `whiteName/blackName/whiteElo/blackElo`,
`timeControl`, `timeControlCategory ('classical' и др.)`,
`isClassical`, `playedAt`.

### 2.2 Opening-trainer — multi-source готов (ADR-078)

`packages/db/prisma/schema.prisma`:
- `OpeningRepertoire` (id, userId, title, pgn, tree JSONB, side,
  nodeCount/edgeCount/maxDepth, deletedAt).
- `OpeningRepertoireSource` (repertoireId, name, pgn, **sourceKind**
  `'pgn-upload'|'workshop-analysis'|'legacy-import'`,
  sourceAnalysisId, createdAt) — multi-source поддержка из ADR-078.

`apps/api/src/opening-trainer/opening-trainer.controller.ts`:
- `POST /repertoires` — создание из 1+ источников.
- `POST /repertoires/from-analysis` (KS-3293, ADR-078 §4) — из
  Analysis. Опц. `repertoireId` → добавить как источник
  существующему.
- `POST /repertoires/:id/sources` — добавить источник в
  существующий.

`repertoire-builder.service.ts`:
- `buildTree(sources)` — массив PGN → `RepertoireTree` (FEN-keyed
  JSONB) с merge транспозиций по FEN.
- `splitPgnIntoGames(pgn)` — split multi-game PGN по результатам
  (KS-3325).
- Лимиты: `maxNodes=2000, maxEdges=5000, maxPgnBytes=500 KB,
  maxSourcesPerRepertoire=20`.

`RepertoireEdge` shape (shared, `opening-trainer.ts`): `moveUci,
moveSan, childFen, nag?, comment?, sourceIds?` — поле `nag` уже
есть, можно записывать аннотации со Stockfish.

### 2.3 AnalysisActionsMenu — точка входа готова

`apps/web/src/components/analysis/AnalysisActionsMenu.tsx`
(ADR-087): items-source с группой `'training'` уже включает
«Использовать как новый репертуар» / «Добавить в существующий
репертуар» (ADR-078). Добавляем новый item в ту же группу.

### 2.4 WASM Stockfish — готов, но опции `movetime` нет

`apps/web/src/hooks/useStockfish.ts` (585 строк):
- API: `evaluate(fen)`, `stop()`, `init()`, `cleanup()`.
- Опции: `depth?, multiPv?, infinite?, skillLevel?, prefetch?`.
- **Опции `movetime` НЕТ** — но Stockfish UCI её поддерживает
  (`go movetime 1000`). Для требования «1 сек/ход» нужно
  расширить хук (мелкое изменение, см. KS-(F4) в §10).
- WASM lite 7 МБ, COOP/COEP обязателен (crossOriginIsolated).
- MultiPV clamp к легальным ходам (KS-3041). Threads =
  hardwareConcurrency-1 (308).
- Очередь анализа: bestmove-callback запускает следующий
  evaluate. Можно последовательно прогонять сотни позиций.
- Прогресс: `loadProgress` для WASM-fetch, `lines` для info.

### 2.5 Async-инфра — НЕ требуется

В `apps/api/src` нет BullMQ/Redis Queue. Backend задача (сбор
партий + склейка PGN) — секунды, синхронно. Долгий клиентский
анализ — внутри браузера с прогресс-баром, никакой бэк-job не
нужен.

## 3. Архитектура — двухфазная (backend быстро + frontend долго)

### 3.1 Фаза 1 (backend, секунды) — сбор и сборка репертуара

```
Endpoint: POST /opening-trainer/repertoires/from-archive-position
Body: { fen, side? = auto, limit? = 20, maxHalfMoves? = 40 }
Auth:  JwtAuthGuard
```

Алгоритм:
1. `side = fen.split(' ')[1] === 'w' ? 'white' : 'black'` (если не
   override в body).
2. Запрос к archive-service:
   `GET /games/by-position?fen=<fen>&bucket=master&minElo=2400
   &sort=recent&limit=<limit>` (+ `timeControlCategory=classical`
   если расширим DTO — см. Open Q1).
3. Если получено 0 партий → 422 `no_games_for_position`.
4. Для каждой партии:
   - Парс PGN через chess.js#loadPgn.
   - Идём по `history()`, отслеживая FEN. Находим индекс ply, где
     `position_key(current_fen) === position_key(target_fen)`
     (сравниваем без halfmove-clock и fullmove-counter).
   - Если позиция не найдена в этой партии (mismatch индекса
     archive vs тут) → skip (логируем как метрику).
   - Вырезаем ходы с этого индекса до min(end_of_game, +40
     полуходов).
   - Формируем mini-PGN: заголовки [Event/White/Black/Date/Result/
     WhiteElo/BlackElo] + movetext вырезанных ходов. Стартовая
     позиция этого mini-PGN = `[FEN "<target_fen>"]` + `[SetUp
     "1"]` теги (стандарт PGN для не-стартовой позиции).
5. Создаём `OpeningRepertoire` через `RepertoireBuilderService.
   buildTree(sources=mini_pgns)` — merge по FEN происходит
   автоматически.
6. Каждый source: `name='<White> ({whiteElo}) vs <Black>
   ({blackElo}) — <Event> <Date>'`, `sourceKind='archive-position'`
   (новое значение whitelist), новое опц. поле `archiveGameId
   String?` (трассировка).
7. `OpeningRepertoire.title` = «Репертуар из <opening?> позиции»
   (или генерируется fallback'ом из FEN).
8. Опц. поле `OpeningRepertoire.sourcePositionFen String?` —
   трассировка + дедуп.
9. Возвращает `{ repertoireId, url: '/opening-trainer/' + id,
   sourceCount: N, fen, side }`.

**Время фазы 1:** секунды. Сетевой round-trip к archive-service
+ парсинг PGN'ов + сборка дерева. Без движка.

### 3.2 Фаза 2 (frontend, минуты) — Stockfish-валидация

На странице репертуара после создания (или сразу из toast'а
после фазы 1) — баннер с CTA **«Проверить ходы Stockfish'ом
(~N минут)»** + предварительная оценка времени.

Алгоритм:
1. Загрузка `repertoire.tree` (если не загружено).
2. Сбор уникальных позиций для анализа: проход по `tree.nodes`,
   для каждой ноды → все исходящие edges. **Уникальные FEN'ы**
   (дедуп через `tree.nodes` — структура уже хранит позиции по
   FEN-ключу, дубликатов нет).
3. Для каждой пары `(parentFen, edge)`:
   - `evaluate(parentFen, { movetime: 1000, multiPv: 2 })` →
     bestMove + eval_before (если parentFen уже анализирован для
     другого edge — переиспользуем кэш).
   - `evaluate(childFen, { movetime: 1000 })` → eval_after.
   - Конвертируем eval (cp/mate) в win-probability (через
     существующие `wdl.ts` утилиты).
   - Считаем `loss_E = max(0, eBefore - eAfter)` (с POV-инверсией
     по ходящей стороне).
   - NAG по порогам ADR-066:
     - `loss > 0.25` → `$4` (??)
     - `loss > 0.12` → `$2` (?)
     - `loss > 0.05` → `$6` (?!)
     - `≤ 0.05` → нет NAG
   - Опц. `comment = 'loss N%'`.
4. Прогресс UI: «Проанализировано 156 / 800 ходов (~7 мин
   осталось)».
5. После завершения — `POST /opening-trainer/repertoires/:id/annotate`
   с массивом `{ parentFen, moveUci, nag, comment? }`. Backend
   обновляет `tree.nodes[parentFen].edges[i].nag/comment`.
6. UI обновляется — пользователь видит дерево с NAG'ами и может
   тренироваться, понимая «где в репертуаре игроки 2400+ играли
   слабее».

**Оценка времени Stockfish'а:**
- 20 партий × 40 полуходов = 800 ходов теоретический максимум.
- Реально меньше из-за дедупа транспозиций (на дебютной стадии
  ~30-50% позиций повторяются). Эмпирически: ~400-600 уникальных
  парс позиций.
- Каждая пара (parent+child) = 2× movetime=1s. Если переиспользуем
  parent-eval для разных edges (multiPV сразу даёт PV1=best и
  eval) → один прогон на parent + один на child (worst case).
- Итого ~10-20 мин на репертуар из 20 партий.

**Это много.** Митигации:
- Лимит N=20 по умолчанию (пользователь видит «~15 минут» перед
  стартом).
- Анализировать только **уникальные** parent-FEN'ы (с multiPV=N
  получаем все основные продолжения за один прогон, не отдельный
  evaluate для каждого edge).
- Можно остановить (`stop()` + сохранить partial annotations).
- Background tab OK — Stockfish работает в Web Worker'е.

### 3.3 Фильтрация «плохих» линий — отдельный вопрос

Что значит «проверить»: (а) аннотировать NAG'ами по loss; (б)
обрезать линии после blunder'а (партия с зевком — нерелевантна
для дебютной теории); (в) фильтровать линии по среднему loss.

**Решение M1: (а) только аннотация NAG.** Не фильтруем — позволяем
пользователю видеть «вот тут игрок 2400 сделал зевок» в самом
дереве (это полезная информация). Фильтр (б)/(в) — Open Q3 для
пользователя, M2.

## 4. Точка входа в UI

В `AnalysisActionsMenu` группа `'training'` — новый item:

```
{
  id: 'createRepertoireFromArchive',
  group: 'training',
  label: t('analysis.actions.createRepertoireFromArchive',
           'Создать репертуар из мастер-партий 2400+'),
  onClick: () => createRepertoireFromArchive(currentFen),
  enabledFor: 'auth',  // гостю disabled с подсказкой «Войдите»
}
```

После клика — модалка подтверждения с предупреждением: «Будет
собрано до 20 партий и проанализировано Stockfish'ом локально
(~15 минут). Готов?». При «Да» → POST endpoint фазы 1 → toast
«Репертуар создан, открыть для анализа?» → navigate
`/opening-trainer/:id`, где автоматически стартует фаза 2 (или
кнопкой).

## 5. Сторона репертуара

`side = fen.activeColor`. Из FEN автоматически — это сторона
которая ходит из позиции (= кто будет тренироваться играть
дальше). Без явного выбора пользователя в M1. M2 — override.

## 6. Лимиты и фильтры

- N партий по умолчанию: **20** (Open Q2). Max 50 (archive
  limit).
- Глубина: **40 полуходов** (требование пользователя). Существующие
  `OpeningRepertoireSource.pgn` лимиты (500 КБ) с запасом.
- Tree-лимиты `maxNodes=2000, maxEdges=5000` — 20 партий × 40
  ходов = 800 ходов до merge → после merge сильно меньше →
  укладывается. Если превысит — 400 как сейчас.
- Фильтр `minElo ≥ 2400` обязательно. Применять к **обеим**
  сторонам (`whiteElo ≥ 2400 AND blackElo ≥ 2400`) — иначе
  попадут партии где сильный играет против слабого, теория
  размыта. Это Open Q (текущий archive-service фильтр работает
  как `whiteElo OR blackElo ≥ minElo`? Уточнение — см. Open Q4).
- `timeControlCategory='classical'` обязательно (Open Q1 — есть
  ли в by-position DTO или нужно расширить).
- Нет партий → 422 `no_games_for_position` + UI «По этой позиции
  нет партий 2400+ classical в архиве».

## 7. Дедуп репертуаров

Поле `OpeningRepertoire.sourcePositionFen String?` (новое в
миграции). При повторном создании на той же FEN — ищем
существующий `findFirst({ userId, sourcePositionFen: fen })`.
Если есть → UI вопрос «У вас уже есть репертуар по этой позиции,
открыть его или создать новый?». Не блокируем повторное создание
(пользователь может захотеть свежие партии).

## 8. Хранение результата

- `OpeningRepertoire` — обычная запись с `pgn` (concat
  source-PGN), `tree`, `side`, новое опц. поле
  `sourcePositionFen`.
- `OpeningRepertoireSource[]` — N источников (N партий из
  архива). `sourceKind='archive-position'` (новое значение
  whitelist), новое опц. поле `archiveGameId String?` (для
  обратной ссылки «открыть исходную партию»).

## 9. Что НЕ делаем (явно)

- НЕ запускаем Stockfish на бэке (уточнение пользователя —
  только клиент-WASM).
- НЕ создаём async-job-инфру (BullMQ etc) — фаза 1 синхронна
  (секунды), фаза 2 на клиенте.
- НЕ фильтруем «плохие» линии в M1 (только NAG-аннотации, Open
  Q3).
- НЕ объединяем с уже существующим репертуаром автоматически
  (повторный клик может создать новый с фильтром-предупреждением
  §7).
- НЕ поддерживаем гостей (требует Auth — как все opening-trainer
  endpoints).
- НЕ ставим NAG'и на edges, не прошедших Stockfish-анализ (если
  фаза 2 остановлена — partial annotations, ничего не ломаем).

## 10. Реализация — follow-up задачи

Зависимости: B0 → B1 → B2 → F1 → F2 (+ F4 параллельно F2). L1
после F1/F2.

### KS (B0) — миграция Prisma + расширение sourceKind whitelist

**Assignee:** backend (prisma). **Labels:** `puzzle`, `analysis`,
`prisma`.
- В `OpeningRepertoire`: поле `sourcePositionFen String?
  @map("source_position_fen")` + индекс `[userId, sourcePositionFen]`.
- В `OpeningRepertoireSource`: поле `archiveGameId String? @db.Uuid
  @map("archive_game_id")`.
- CHECK для `sourceKind` — добавить `'archive-position'` в
  whitelist.
- Acceptance: `prisma:migrate` чистый; existing-запись dedup
  работает.

### KS (B1) — расширение archive-service by-position DTO (если нужно)

**Assignee:** backend (archive-service). **Labels:** `analysis`,
`puzzle`.
**Зависит:** Open Q1.
- Если в `GET /games/by-position` нет `timeControlCategory` →
  добавить опц. параметр (массив или одно значение). Backend
  фильтрует через JOIN на `archive_games` по этому полю.
- Также проверить семантику `minElo` (whiteElo OR blackElo vs AND)
  — добавить параметр `minEloBothSides?: boolean` (default true для
  нашей фичи).
- Acceptance: фильтр работает, юнит-тесты.

### KS (B2) — endpoint `POST /repertoires/from-archive-position`

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B0, B1.
- `OpeningTrainerController.createFromArchivePosition(userId,
  { fen, side?, limit?, maxHalfMoves? })`.
- Вызов archive-service → split каждой партии → вырезание линии
  от target FEN (по position-key) → mini-PGN с `[FEN]`+`[SetUp "1"]`
  → `RepertoireBuilderService.buildTree(sources)` →
  персист `OpeningRepertoire` + sources с `sourceKind='archive-position'`,
  `archiveGameId`, `sourcePositionFen`.
- Dedup по `sourcePositionFen` (если есть — вернуть существующий
  с флагом `existing=true`, не блокировать создание нового
  через query `?force=true`).
- 422 `no_games_for_position`. 400 при превышении tree-лимитов.
- Acceptance: 5 тестов (happy-path, 0 партий, дедуп, force,
  лимиты).

### KS (F1) — пункт меню «Создать репертуар из мастер-партий»

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B2, ADR-087 AnalysisActionsMenu.
- Добавить item в группу `training` items-source
  `analysisActionsMenu.ts`. Auth-gating.
- Модалка подтверждения «~15 минут анализа Stockfish'ом» →
  POST → toast + navigate `/opening-trainer/:id`.
- Acceptance: пункт виден, гость — disabled+подсказка; happy-path
  создаёт репертуар; обработка 422 (нет партий) — toast.

### KS (F2) — Stockfish-валидация на клиенте (фаза 2)

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B2, F4 (для movetime).
- На странице `/opening-trainer/:id` — баннер «Проверить ходы
  Stockfish'ом (~N мин)» если репертуар создан из
  archive-position и ещё не аннотирован (флаг
  `stockfishValidatedAt?: DateTime` опц. в схеме или derived).
- Алгоритм §3.2: обход `tree.nodes`, evaluate parent с
  multiPv=N (получаем все edges за один прогон), сравниваем
  edges. Прогресс-bar (X/Y, время осталось).
- POST `/repertoires/:id/annotate` с массивом
  `{ parentFen, moveUci, nag, comment? }`. Backend обновляет
  `tree`.
- Кнопка «Остановить» (`stop()` + сохранить partial).
- Acceptance: на 20 партиях анализ идёт без зависаний; прогресс
  обновляется; остановка корректно сохраняет partial; после
  завершения tree-view показывает NAG'и.

### KS (B3) — endpoint `POST /repertoires/:id/annotate`

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B0.
- Body: `{ annotations: [{ parentFen, moveUci, nag?, comment? }] }`.
- Owner-check. Обновляет `tree.nodes[parentFen].edges` через
  in-memory patch + persist. Опц. флаг `stockfishValidatedAt`.
- Acceptance: tree корректно обновляется; повторный вызов
  идемпотентен (override прежних annotations).

### KS (F4) — расширение `useStockfish` опцией `movetime`

**Assignee:** frontend. **Labels:** `analysis`.
- В `UseStockfishOptions` добавить `movetime?: number` (миллисек).
  Если задан — отправлять `go movetime N` вместо `go depth M`.
  Совместимо с существующими опциями (приоритет: movetime >
  infinite > depth).
- Acceptance: при `movetime=1000` движок прерывается через ~1с,
  возвращает bestmove + lines. Тест регрессии — `depth=20`
  по-прежнему работает.

### KS (L1) — UI прогресса фазы 2 + баннера на странице репертуара

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F2.
- CSS прогресс-бара (X/Y, ETA), кнопки старт/стоп, баннера
  «Проверить ходы».
- На mobile — фиксированный bottom-card с прогрессом.
- Acceptance: viewport 360×844 — прогресс читается без скролла;
  обе темы.

## 11. Открытые вопросы (для пользователя)

Список — координатор спросит:

1. **`timeControlCategory='classical'` в by-position DTO.**
   Сейчас параметра нет в `GET /games/by-position`. Решения: (а)
   расширить DTO (рекомендую) — KS (B1); (б) фильтровать на
   backend api после получения списка (медленнее, может
   возвращать меньше N партий после фильтра); (в) полагаться на
   `bucket='master'` (если уже подразумевает classical — нужно
   проверить implementation в archive-service). Что делаем?

2. **N партий по умолчанию.** Я предлагаю **20** (~15 мин
   Stockfish-анализа на клиенте). Альтернативы: 10 (быстрее, но
   мало материала), 50 (богаче, но ~40 мин анализа). Что
   комфортно?

3. **«Проверить все ходы» = что именно делать?**
   - (а) **Аннотировать NAG'ами** по loss (моё M1-решение, см.
     §3.2).
   - (б) Дополнительно **обрезать линии** после blunder'а
     (партия с зевком нерелевантна теории).
   - (в) **Фильтровать** партии по среднему loss (не включать
     партии где обе стороны играли неточно).
   - Что включаем в M1?

4. **`minElo` к ОБЕИМ сторонам** (`whiteElo AND blackElo ≥ 2400`)
   vs одной (`OR`). Я рекомендую AND (иначе попадут партии
   сильный vs слабый, теория размыта). Подтвердить + проверить
   текущую семантику archive-service.

5. **Дедуп репертуаров.** Повторный клик на той же FEN — модалка
   «У вас уже есть репертуар по этой позиции, открыть или
   создать новый?» (моё решение). Альтернатива — всегда
   обновлять существующий новыми партиями. Что хотим?

6. **Stockfish-валидация — обязательная или опц. шаг.** Я сделал
   опц. (кнопкой на странице репертуара, можно пропустить и
   тренироваться без annotations). Альтернатива — модалка
   «нельзя продолжить пока не проанализировано». Что хотим?
   (~15 мин ожидания — много для обязательного шага.)

7. **«Сторона репертуара»** — из FEN автоматически (моё
   решение) vs явный выбор в модалке. Подтвердить.

8. **Опция override в фазе 2** — пользователь хочет менять
   movetime/depth для Stockfish-валидации (например,
   быстро=500ms, точно=2000ms)? M1 — фикс 1000ms.

## 12. Откат

- Endpoint additive — удаление не ломает existing.
- Поля `sourcePositionFen` / `archiveGameId` — additive.
- `sourceKind='archive-position'` — additive в whitelist.
- Frontend кнопка за feature-flag `repertoireFromArchiveEnabled`.
- Существующие созданные репертуары остаются обычными
  multi-source — без annotations или с partial annotations
  работают.
