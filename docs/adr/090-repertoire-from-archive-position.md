# ADR-090. Дебютный репертуар из партий 2400+ классика по позиции анализа

Статус: принят (2026-05-30, ревизия 2)
Связано: KS-3462 (V1), KS-3463 (V2 этот ADR), ADR-077 (RepertoireTree),
ADR-078 (multi-source репертуары / KS-3323), ADR-087
(AnalysisActionsMenu), KS-2475 (Stockfish WASM), ADR-066 (WDL
move-classification).

> **Ревизия 2 (2026-05-30).** Пересмотр по 8 ответам пользователя.
> Главные изменения от V1:
> 1. classical-фильтр на фронте УЖЕ есть для архива (`/games?
>    timeControlCategory=classical`), но в `/games/by-position` его
>    нет — расширяем DTO.
> 2. Сортировка партий = по среднему рейтингу. В `by-position`
>    `sort=topElo` УЖЕ означает `ORDER BY avg_elo DESC` (по
>    `archive_game_positions.avg_elo`) — то что нужно.
> 3. Stockfish-валидация — **обязательный шаг**, монолитный поток
>    клик→загрузка→валидация→готово (не опц. кнопка).
> 4. При blunder в партии — **выкидываем партию целиком**, берём
>    следующую. Итеративный сбор до набора N валидных.
> 5. Фильтр `minAvgElo ≥ 2400` (не minElo обеих сторон). В
>    `by-position` `minElo` УЖЕ означает avgElo (`p.avg_elo >=
>    minElo`) — то что нужно.
> 6. **Дедуп НЕ нужен.** Каждый клик = новый репертуар.
>    `sourcePositionFen` в миграции лишний.
> 7. Сторона репертуара — за **СОПЕРНИКА** ходящей стороны (если
>    в FEN ход белых → репертуар за чёрных). Контринтуитивно
>    относительно V1.
> 8. Movetime — UI-выбор 500/1000/2000ms, дефолт 1000.

## 1. Контекст

Цитата пользователя: «Формировать дебютный репертуар по последним
партиям сильных игроков в классическом контроле. Точка входа —
окно анализа. Ввожу позицию и нажимаю в контекстном меню "Создать
репертуар для тренировки". Из архива выбираются последние партии
игроков 2400+ в классику, объединяются в один PGN. Важно —
проверить все ходы локальным БРАУЗЕРНЫМ стокфишем секунда на ход.
Глубина не более 40 полуходов».

## 2. Проверено по коду (ревизия 2)

### 2.1 archive-service `/games/by-position` — уточнено

`apps/archive-service/src/archive/dto/archive-games-by-position-query.dto.ts`:
- `sort: 'recent' | 'topElo'` — **`avgRating`-сортировки как
  отдельной нет**, но `sort=topElo` в реализации (`archive-stats.
  repository.ts`) = `ORDER BY p.avg_elo DESC` (поле
  `archive_game_positions.avg_elo`). **Это и есть «по среднему
  рейтингу»** — V1 неверно интерпретировал.
- `minElo: 0..4000` — в реализации `p.avg_elo >= ${minElo}`.
  **Это и есть avgRating-фильтр** (не AND обеих сторон). V1
  ошибался.
- `timeControlCategory`: **НЕТ в DTO** — нужно расширить (JOIN с
  `archive_games`).
- `bucket: 'master'|'user'` — **не фильтр Elo**, просто
  техническая группа; в MVP `master` = все позиции.

### 2.2 Фронт-фильтр classical — на странице архива

`apps/web/src/components/archive/ArchiveTimeControlChips.tsx`:
chips-селектор для `timeControlCategory` (Bullet/Blitz/Rapid/
Classical). Фронт `ArchiveGamesPage` отправляет
`?timeControlCategory=classical` в **`GET /games`** (НЕ
`/games/by-position` — там этого параметра ещё нет).

### 2.3 opening-trainer multi-source — готов (ADR-078)

Без изменений от V1. `RepertoireBuilderService.buildTree(sources)`
с merge по FEN, лимиты 20 sources / 2000 nodes / 5000 edges / 500
KB pgn. `OpeningRepertoireSource.sourceKind` whitelist —
расширяем `'archive-position'`.

### 2.4 AnalysisActionsMenu — готов (ADR-087)

Группа `'training'` уже имеет «Использовать как новый репертуар» /
«Добавить в существующий». Добавляем новый item.

### 2.5 `useStockfish` — `movetime` отсутствует

`apps/web/src/hooks/useStockfish.ts` — опция `movetime?: number` не
реализована (только `depth`/`infinite`). Расширяем (отдельная
мелкая задача, F4).

### 2.6 Async-инфра — НЕ требуется

Без изменений. Backend синхронный (тонкая proxy-обёртка к
archive-service); долгий Stockfish — на клиенте в Web Worker'е.

## 3. Архитектура — монолитный поток на клиенте

### 3.1 Поток (после клика)

```
1. Клик в AnalysisActionsMenu → модалка:
   - Подтверждение
   - Select: Быстро 500ms / Стандарт 1000ms / Точно 2000ms (default 1000)
   - CTA «Создать»

2. Progress-modal (блокирующий, нельзя закрыть случайно):
   Шаг 1: «Загружаю партии…»
   Шаг 2: «Анализирую Stockfish'ом… 3/20 валидных, проверка 12/40»
   Шаг 3: «Создаю репертуар…»
   Кнопка «Отмена» (останавливает с partial — см. §3.5).

3. Алгоритм:
   validGames = []; cursor = null; checkedCount = 0
   while validGames.length < limit (=20):
     batch = await GET /opening-trainer/archive-position/games?
                fen=&limit=10&cursor=
     if batch.empty: break
     for game in batch:
       lineMoves = extractLineFromFen(game.pgn, targetFen, ≤40 ply)
       if lineMoves.empty: continue          // партия не доходит до FEN
       allClean = true
       for ply in lineMoves:                  // итерация по полуходам
         eBefore = stockfish.evaluate(ply.fenBefore, movetime=user)
         eAfter  = stockfish.evaluate(ply.fenAfter,  movetime=user)
         loss    = lossE(eBefore, eAfter, povSide)
         if loss > 0.25:                      // blunder → выкид
           allClean = false
           break                              // экономим Stockfish-время
       if allClean:
         validGames.push(buildMiniPgn(game, lineMoves))
         if validGames.length >= limit: break
     cursor = batch.nextCursor
     if checkedCount > maxChecked (=100): break  // safety cap
   if validGames.length < limit:
     showAlert(f"Найдено N валидных из {limit}, продолжить?") → yes/no
   POST /opening-trainer/repertoires { sources: validGames, side,
                                       title: 'Репертуар из позиции' }
   → navigate /opening-trainer/{id}
```

### 3.2 Сторона репертуара — ИНВЕРСИЯ ходящей

`side = fen.activeColor === 'w' ? 'black' : 'white'`.

Объяснение: пользователь подаёт позицию ПЕРЕД ходом соперника.
Если в FEN ход белых — это позиция, в которой сейчас сходят
белые, а **пользователь готовится отвечать чёрными**. Репертуар
тренирует ответы пользователя. Контринтуитивно относительно
«ходящий = ученик»; обязательно комментарий в коде + i18n-
подсказка в UI («Готовим репертуар за <чёрных/белых>»).

### 3.3 Выкидывание партий с blunder'ом (П4)

Порог: `loss > 0.25` (= blunder ADR-066). Любой полуход в линии
с loss > 0.25 → партия выкидывается ЦЕЛИКОМ, не идёт в репертуар.
Berём следующую из cursor'а.

**Почему выкидываем целиком, а не обрезаем до blunder'а:**
методически — линия с зевком теряет статус «теория сильных
игроков», нерелевантна. Обрезание дало бы партиальную линию, что
размывает источник.

Экономия Stockfish-времени: при первом же blunder'е прерываем
анализ оставшихся полуходов в этой партии. Среднее время на
выкинутую партию — порядка ~5-10 ходов × movetime, не полные 40.

### 3.4 Итеративная подкачка + safety cap

`maxChecked = 100` (опц. константа): если проверили 100 партий и
не набрали 20 валидных — стоп, спрашиваем «продолжить с N
валидными?». Защита от зависания на «грязных» позициях.

Эмпирическая оценка процента валидных: на мастер-партиях 2400+
classical в дебютной фазе blunder'ы редки. Ожидаем 60-80%
валидных, то есть для 20 валидных подкачаем ~25-35 партий.

### 3.5 Отмена

Кнопка «Отмена» в progress-modal:
- Если набрано ≥ 1 валидной партии — показать «Создать репертуар
  из N валидных?» с CTA Yes/No.
- Если 0 — закрыть, ничего не сохранять.

### 3.6 Что НЕ делаем (M1)

- **НЕ ставим NAG-аннотации** в M1 (V1 предполагал). При
  mistake/inaccuracy (loss ∈ (0.05, 0.25]) — игнорируем, партия
  идёт в репертуар без NAG. M2 — опц. NAG для разметки внутри
  валидных партий.
- **НЕ делаем дедуп** по FEN — каждый клик = новый репертуар
  (П6).
- **НЕ серверный Stockfish** (уточнено пользователем — клиент
  WASM).
- **НЕ async-job-инфра** — backend синхронный, frontend в
  браузере.
- **НЕ обрезаем линии** до blunder'а (выкидываем целиком, §3.3).

## 4. API

### 4.1 archive-service — расширение `/games/by-position`

Добавить в DTO опц. `timeControlCategory: ArchiveTimeControlCategory[]`
(массив, по образцу `/games`). Реализация — JOIN с `archive_games`
по `game_id`, фильтр `time_control_category IN (...)`.

Уже существующее семантическое соответствие требованиям:
- `minElo` = avgElo фильтр ✓ (П5).
- `sort=topElo` = ORDER BY avg_elo DESC ✓ (П2).
- `bucket='master'` = все позиции (используем).

### 4.2 opening-trainer api — новый GET-proxy

```
GET /opening-trainer/archive-position/games
  ?fen=&limit=10&cursor=
Auth: JwtAuthGuard
```

Тонкая прокси-обёртка над archive-service:
- Внутренне вызывает `archive-service /games/by-position` с
  фиксированными default-параметрами: `minElo=2400, sort=topElo,
  bucket=master, timeControlCategory=classical, color=any` +
  `limit, cursor, fen` из request.
- Owner-check (auth user — гость 401).
- Без дополнительной логики (валидация, вырезание линии, Stockfish
  — на клиенте).

Это **единственный новый backend-endpoint**. V1-эндпоинт `POST
/repertoires/from-archive-position` НЕ нужен — фронт собирает PGN
сам и шлёт в существующий `POST /opening-trainer/repertoires` с
sources (multi-source ADR-078).

### 4.3 Создание репертуара — существующий `POST /repertoires`

Фронт собирает `OpeningRepertoireSource[]` (по образцу ADR-078):
- `pgn` — mini-PGN с `[FEN]+[SetUp "1"]` тегами, вырезанная линия
  + заголовки исходной партии (White/Black/Elo/Event/Date).
- `name` — «<White> ({whiteElo}) — <Black> ({blackElo})» (
  локализованный label).
- `sourceKind = 'archive-position'` (новое значение whitelist).
- Опц. `archiveGameId` — для трассировки «открыть исходную
  партию».

POST body:
```
{ title: 'Репертуар: ' + opening | fen-fallback,
  side: 'white'|'black',  // см. §3.2
  sources: [ { pgn, name, sourceKind: 'archive-position',
               archiveGameId } × N ] }
```

Уже существующий endpoint работает, нужна только расширение
whitelist `sourceKind`.

## 5. Frontend — `useStockfish` расширение

`apps/web/src/hooks/useStockfish.ts`:
- Опция `movetime?: number` (ms). Если задана — отправляется `go
  movetime N` вместо `go depth M`. Приоритет:
  `movetime > infinite > depth`.
- Совместимо с существующими: при не-заданном `movetime`
  поведение прежнее.
- В реальной фиче — `movetime` из UI-select'а (500/1000/2000) +
  сохранение выбора в localStorage.

## 6. Точка входа

В `AnalysisActionsMenu` группа `'training'`:

```
{
  id: 'createRepertoireFromArchive',
  group: 'training',
  label: t('analysis.actions.createRepertoireFromArchive',
           'Создать репертуар из мастер-партий 2400+'),
  onClick: () => openCreateRepertoireFromArchiveModal(currentFen),
  enabledFor: 'auth',  // гостю disabled + подсказка «Войдите»,
}
```

Модалка → progress → создание → navigate.

## 7. Лимиты и параметры

- `limit = 20` валидных партий (default, после P2 ответ).
- `maxChecked = 100` партий (safety cap).
- `maxHalfMoves = 40` (требование пользователя).
- `blunderThreshold = 0.25` (loss_E, по ADR-066).
- `movetime` ∈ {500, 1000, 2000} ms (UI-выбор, default 1000).
- Существующие tree-лимиты (2000 nodes / 5000 edges / 500 KB pgn)
  — должно укладываться: 20 партий × 40 ходов = 800 ходов до
  merge, после merge меньше.

## 8. Хранение результата

- `OpeningRepertoire` — обычная запись. **Поле
  `sourcePositionFen` НЕ добавляем** (П6 — дедуп не нужен).
- `OpeningRepertoireSource[]`:
  - `sourceKind = 'archive-position'` (новое значение whitelist).
  - Новое опц. поле `archiveGameId String?` для трассировки.
  - `name`: «<White> ({Elo}) — <Black> ({Elo}), <Event> <Date>».

## 9. Что изменилось vs V1

| Аспект | V1 (отменён) | V2 (актуально) |
|---|---|---|
| Поток | 2 фазы (sync backend + опц. кнопка анализа) | Монолит на клиенте |
| Stockfish | Опц. шаг | Обязательный, при создании |
| Blunder-обработка | NAG-аннотация | Выкидывание партии целиком |
| Дедуп | По `sourcePositionFen` | НЕТ |
| Side | Из FEN activeColor (ходящий) | Из FEN, **инверсия** (соперник) |
| Movetime | Фикс 1000ms | UI-выбор 500/1000/2000, default 1000 |
| Backend endpoints | POST /from-archive-position + POST /annotate | Только GET proxy /archive-position/games |
| Сбор партий | Один запрос на 20 | Итеративный (cursor + safety cap 100) |
| classical filter | Open Q (расширить DTO) | Подтверждено — расширить |
| minElo семантика | Open Q (AND/OR/avg) | Подтверждено — avgElo (уже работает) |
| Sort | Open Q (recent vs topElo) | topElo = avg_elo DESC (то что нужно) |

## 10. Реализация — follow-up задачи (пересмотр)

Зависимости: B0 → B1 → B2 → F4 → F1/F2 → L1.

### KS (B0) — миграция (упрощённая)

**Assignee:** backend (prisma). **Labels:** `puzzle`, `analysis`,
`prisma`.
- `OpeningRepertoireSource.archiveGameId String?` — для трассировки.
- `sourceKind` whitelist += `'archive-position'`.
- **БЕЗ `sourcePositionFen`** (V2 убрал, П6).
- Acceptance: миграция чистая.

### KS (B1) — archive-service: расширить `/games/by-position` DTO

**Assignee:** backend (archive-service). **Labels:** `analysis`,
`puzzle`.
- Опц. параметр `timeControlCategory: ArchiveTimeControlCategory[]`.
- Реализация: JOIN с `archive_games`, фильтр
  `time_control_category IN (...)`. По умолчанию пусто (без фильтра).
- НЕ добавляем `minAvgElo` / `sort=avgRating` — уже есть как
  `minElo` / `sort=topElo` (V1 ошибочно требовал).
- Acceptance: фильтр работает; юнит-тесты.

### KS (B2) — opening-trainer api: GET-proxy

**Assignee:** backend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B1.
- `GET /opening-trainer/archive-position/games?fen=&limit=&cursor=`
  с `@UseGuards(JwtAuthGuard)`.
- Внутри: вызов archive-service `/games/by-position` с фиксированными
  default'ами: `minElo=2400, sort=topElo, bucket=master,
  timeControlCategory=classical`.
- Прозрачно возвращает batch + nextCursor (формат как
  archive-service).
- Acceptance: gосто доступа гостем — 401; batch + cursor работают;
  filter classical применён.

### KS (F4) — расширение `useStockfish` опцией `movetime`

**Assignee:** frontend. **Labels:** `analysis`.
- В `UseStockfishOptions` добавить `movetime?: number` (мс).
  Если задан — `go movetime N`. Приоритет: movetime > infinite >
  depth.
- Совместимо с существующим.
- Acceptance: `movetime=1000` → bestmove через ~1с; `depth=20`
  по-прежнему работает.

### KS (F1) — пункт меню «Создать репертуар из мастер-партий 2400+»

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** ADR-087 AnalysisActionsMenu.
- Item в группу `'training'`. Auth-gating (disabled+подсказка
  для гостя).
- Acceptance: пункт виден, гость — disabled; клик открывает
  модалку (см. F2).

### KS (F2) — монолитный поток: модалка + сбор + Stockfish + создание

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B2, F4, F1.
- Модалка-старт: подтверждение + select movetime (500/1000/2000)
  + CTA «Создать». LocalStorage запоминает выбор.
- Progress-modal (блокирующий, кнопка «Отмена»):
  - Этап 1: GET /opening-trainer/archive-position/games (cursor).
  - Этап 2: для каждой партии — вырезание линии (chess.js
    parsePgn + проход истории + поиск target FEN по position-key),
    итерация Stockfish-анализом (movetime), early-exit на
    blunder.
  - Этап 3: POST /opening-trainer/repertoires с
    sources=validGames.
- Итеративная подкачка cursor'ом до набора `limit=20` валидных
  или `maxChecked=100` или конца cursor'а.
- При partial-результате (< 20 валидных и пустой cursor / cap) —
  диалог «Найдено N, продолжить?».
- side по правилу §3.2 (инверсия activeColor).
- После create — navigate `/opening-trainer/:id`.
- Acceptance: монолитный поток работает; blunder выкидывает
  партию; итеративная подкачка; partial-диалог; cancel
  очищает; navigate в репертуар.

### KS (L1) — CSS progress-modal + select movetime

**Assignee:** layout. **Labels:** `puzzle`, `analysis`, `mobile`.
**Зависит:** F2.
- Progress-modal: блокирующий overlay, прогресс-bar (валидных/
  проверено/лимит), текущая партия и текущий ход, кнопка
  «Отмена».
- Movetime select: pill-toggle или select.
- Mobile-адаптив (читается на 360×844).
- Acceptance: на mobile прогресс виден, кнопка «Отмена»
  доступна.

**Из V1 убраны:**
- B0 поле `sourcePositionFen` (V2 — дедуп не нужен).
- B2 V1 (`POST /from-archive-position`) — V2 использует
  существующий `POST /opening-trainer/repertoires`.
- B3 (`POST /annotate`) — V2 без NAG в M1.

## 11. Открытые вопросы (V2 — что осталось)

1. **При mistake/inaccuracy (loss ∈ (0.05, 0.25])** — игнорировать
   (моё M1) или ставить NAG в варианте? Рекомендую игнорировать;
   NAG — отдельной M2-задачей.
2. **Partial-результат** (< 20 валидных + конец cursor'а):
   диалог «Создать с N?» (моё) vs автоматически создать без
   вопроса?
3. **`maxChecked=100`** — приемлемо как safety cap? Если на
   практике на популярных позициях окажется недостаточно (мало
   валидных) — поднять до 200.
4. **Owner-check на GET-proxy** или открытый endpoint (archive-
   service уже без auth)? Я оставил `JwtAuthGuard` (consistency
   с остальным opening-trainer + предохранитель от спама).
5. **POV-нормализация loss** — для POV выбранной стороны (= side
   репертуара, не activeColor исходной позиции). Реализация —
   `lossE(eBefore, eAfter, side)` с инверсией eAfter.
   Архитектурно зафиксировано, в реализации уточнить.

## 12. Откат

- B0/B1/B2/F4/F1/F2/L1 — все additive. Feature-flag
  `repertoireFromArchiveEnabled` для фронт-кнопки.
- Существующие созданные репертуары остаются обычными
  multi-source — без изменений после отката.
