# ADR-090. Дебютный репертуар из партий 2400+ классика по позиции анализа

Статус: принят (2026-05-30, ревизия 3)
Связано: KS-3462 (V1), KS-3463 (V2), KS-3465 (V3 этот ADR),
ADR-077 (RepertoireTree), ADR-078 (multi-source репертуары /
KS-3323), ADR-087 (AnalysisActionsMenu), KS-2475 (Stockfish WASM),
ADR-066 (WDL move-classification).

> **Ревизия 3 (2026-05-30).** 5 уточнений пользователя поверх V2:
> 1. **Порог = 50 сантипешек** (не 0.25 WDL как V2). Mate-scores
>    кодируются через большой sentinel (~20000cp), естественно
>    попадают под порог 50.
> 2. **ОБРЕЗКА ЛИНИИ** до проблемного хода — не выкидывание
>    партии целиком. Партия всегда попадает в репертуар (может
>    быть короткой 1-2 хода). Это ключевое изменение V2.
> 3. **Без partial-диалога**: если набралось < 20 валидных —
>    создаём с тем что есть, автоматически.
> 4. **Без лимита `maxChecked`**: идём пока не наберём 20 или не
>    исчерпаем cursor. UI показывает прогресс «проверено N,
>    валидных M» + кнопка «Отмена» (= завершить с тем что есть).
> 5. GET-proxy под `JwtAuthGuard` (моё V2-предложение
>    подтверждено).

> **Ревизия 2 (2026-05-30).** Пересмотр по 8 ответам пользователя
> от V1. Главные точки (всё ещё актуально кроме V3-override'ов):
> - classical-фильтр в `/games/by-position` отсутствует — расширяем DTO.
> - `minElo` в `by-position` УЖЕ = avgElo (не minElo обеих сторон).
> - `sort=topElo` УЖЕ = ORDER BY avg_elo DESC.
> - Monolithic поток на клиенте.
> - Без дедупа (без `sourcePositionFen`).
> - Side = ИНВЕРСИЯ activeColor.
> - Movetime UI-select 500/1000/2000, default 1000.

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

3. Алгоритм (V3 — обрезка вместо выкидывания):
   validGames = []; cursor = null; userCancelled = false
   while validGames.length < limit (=20) and not userCancelled:
     batch = await GET /opening-trainer/archive-position/games?
                fen=&limit=10&cursor=
     if batch.empty: break                    // cursor исчерпан
     for game in batch:
       lineMoves = extractLineFromFen(game.pgn, targetFen, ≤40 ply)
       if lineMoves.empty: continue           // партия не доходит до FEN
       goodPlies = []
       for ply in lineMoves:                  // итерация по полуходам
         eBefore_cp = stockfish.evaluate(ply.fenBefore, movetime=user).cp
         eAfter_cp  = stockfish.evaluate(ply.fenAfter,  movetime=user).cp
         // POV-нормализация: eAfter — POV stm в fenAfter (= соперник
         // stm в fenBefore), инверсия знака для одного POV.
         loss_cp = max(0, eBefore_cp - (-eAfter_cp))
         // = max(0, eBefore_cp + eAfter_cp)
         // mate-scores закодированы как ±20000cp (sentinel) — порог
         // 50cp естественно сработает на любом mate-flip.
         if loss_cp > 50:                     // blunder → ОБРЕЗАЕМ
           break                              // ход НЕ включается
         goodPlies.push(ply)
       if goodPlies.length === 0:
         continue                             // первый ход = blunder, пропускаем
       validGames.push(buildMiniPgn(game, goodPlies))
       updateProgress(checked++, validGames.length)
     cursor = batch.nextCursor
     // НЕТ maxChecked safety cap — идём пока cursor не исчерпан
     // или пользователь не нажал «Отмена»
   // Если набрано < 20 — создаём с тем что есть, БЕЗ диалога
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

### 3.3 Обрезка линии до проблемного хода (V3)

Порог: `loss_cp > 50` сантипешек (~½ пешки). Жёстче чем blunder в
ADR-066 (loss_E > 0.25). Cp напрямую, не через WDL.

При обнаружении хода с loss_cp > 50 **линия обрезается**: ходы
ДО проблемного включаются в репертуар, проблемный и все после —
НЕТ. Партия попадает в репертуар (если есть хотя бы 1 чистый
ход).

**Почему обрезка лучше выкидывания (V2 → V3):**
- Партия даёт хотя бы что-то (10 чистых ходов теории > 0).
- Меньше требуется подкачивать (каждый game = валидный).
- Естественно для дебютной теории: «нас интересует начало партии
  до момента когда сыгран нестандартный/слабый ход».

**Mate-scores:** при mate-кодировании через большой sentinel
(±20000cp) любой mate-flip (одна сторона → другая) даёт
loss_cp ≫ 50 → естественно обрезается. Отдельная mate-логика
не нужна.

**Pathological case — первый ход = blunder:** партия пропускается
(continue), продолжаем подкачку (моё предложение, обсуждено в
KS-3465 open question).

### 3.4 Без `maxChecked` safety cap (V3)

V2 имел safety cap = 100 проверенных партий. **V3 убирает** —
идём пока не наберём 20 валидных или cursor archive-service не
исчерпан. На редких позициях процесс может быть долгим (минуты),
UI обязан показывать прогресс «проверено N, валидных M» + ETA.

Отмена пользователя — единственный способ остановить досрочно
(§3.5).

### 3.5 Отмена (V3 — без partial-диалога)

Кнопка «Отмена» в progress-modal: завершает анализ немедленно
с тем что собрано:
- Если набрано ≥ 1 валидной — POST `/repertoires` с N source'ов,
  navigate. **Без диалога подтверждения** (V3 — пользователь
  явно нажал «Отмена» = «хочу завершить»).
- Если 0 валидных — закрыть модалку, ничего не сохранять, toast
  «Ничего не собрано».

Аналогично если cursor исчерпался до 20 валидных и набрано N:
автоматически создаём с N, без диалога.

### 3.6 Что НЕ делаем (M1)

- **НЕ ставим NAG-аннотации** в M1. При loss_cp ∈ (0, 50] —
  игнорируем, ход идёт в репертуар без NAG. M2 — опц. NAG.
- **НЕ делаем дедуп** по FEN — каждый клик = новый репертуар
  (П6 V2).
- **НЕ серверный Stockfish** (уточнено V2 — клиент WASM).
- **НЕ async-job-инфра** — backend синхронный, frontend в
  браузере.
- **НЕ выкидываем партию целиком** при blunder (V3) — обрезаем
  линию до проблемного хода (§3.3).
- **НЕ ограничиваем число проверенных партий** (V3 — без
  `maxChecked`). Только cursor archive-service или ручная
  отмена.
- **НЕ показываем partial-диалог** (V3) — автоматическое
  создание с тем что набрано.

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

## 7. Лимиты и параметры (V3)

- `limit = 20` валидных партий (target). Если cursor исчерпан или
  отмена — берём сколько есть.
- ~~`maxChecked = 100`~~ **убрано в V3** — без safety cap.
- `maxHalfMoves = 40` (требование пользователя).
- **`blunderThresholdCp = 50`** сантипешек (V3 — заменил
  `blunderThreshold = 0.25` WDL из V2).
- Mate-кодирование через ±20000cp sentinel → автоматически > 50.
- `movetime` ∈ {500, 1000, 2000} ms (UI-выбор, default 1000).
- Существующие tree-лимиты (2000 nodes / 5000 edges / 500 KB pgn)
  — должно укладываться: 20 партий × 40 ходов = 800 ходов до
  merge, после merge меньше. При обрезке линий — ещё меньше.

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

### KS (F2) — монолитный поток: модалка + сбор + Stockfish + создание (V3 — обрезка)

**Assignee:** frontend. **Labels:** `puzzle`, `analysis`.
**Зависит:** B2, F4, F1.
- Модалка-старт: подтверждение + select movetime (500/1000/2000)
  + CTA «Создать». LocalStorage запоминает выбор.
- Progress-modal (блокирующий, кнопка «Отмена»):
  - Этап 1: GET /opening-trainer/archive-position/games (cursor).
  - Этап 2: для каждой партии — вырезание линии (chess.js
    parsePgn + проход истории + поиск target FEN по
    position-key), итерация Stockfish-анализом (movetime).
    **V3:** на каждом ходу считать `loss_cp = max(0, eBefore_cp
    + eAfter_cp_raw)` (POV-нормализация инверсией знака
    eAfter). При `loss_cp > 50` — **обрезать линию** (ход не
    включается, остановить анализ оставшихся ходов этой партии,
    добавить goodPlies в репертуар). Если goodPlies.length === 0
    — пропустить партию (continue).
  - Этап 3: POST /opening-trainer/repertoires с
    sources=validGames.
- Итеративная подкачка cursor'ом до набора `limit=20` валидных
  ИЛИ конца cursor'а ИЛИ ручной отмены. **Без `maxChecked`
  cap.**
- UI progress: «Проверено N партий, валидных M», ETA по
  средней скорости.
- **V3 — без partial-диалога**: при cursor-исчерпании или
  отмене → если есть ≥ 1 валидной партии, автоматически
  POST `/repertoires` с тем что есть → navigate. Если 0 — toast
  «Ничего не собрано», закрыть.
- side по правилу §3.2 (инверсия activeColor).
- После create — navigate `/opening-trainer/:id`.
- Acceptance: монолитный поток работает; blunder ОБРЕЗАЕТ линию
  (не выкидывает партию); first-ply-blunder — пропуск партии;
  partial-результат → автосоздание без диалога; cancel → завершить
  с тем что есть; navigate в репертуар.

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

## 11. Открытые вопросы (V3 — что осталось после ответов)

**Закрыто пользователем (V3):**
- ✓ Партия с blunder → обрезка линии (не выкидывание).
- ✓ Partial-результат → автоматическое создание (без диалога).
- ✓ `maxChecked` cap → убран.
- ✓ GET-proxy под `JwtAuthGuard` (моё V2-предложение).
- ✓ Порог 50 cp (не WDL).

**Осталось/новое:**

1. **Pathological: первый ход линии = blunder** (loss_cp > 50 на
   ply 1). Партия с 0 ходов бессмысленна → **пропускаем партию,
   продолжаем подкачку cursor'ом** (моё предложение V3,
   зафиксировано в §3.3). Альтернатива — включить пустой
   источник, отвергнуто.
2. **При loss_cp ∈ (0, 50]** — ход идёт в репертуар как есть, без
   NAG (V3 M1). NAG-аннотации для inacc/mistake — M2.
3. **POV-нормализация loss** — POV = side хода (= white или black
   на fenBefore, зависит от ply). loss_cp = max(0, eBefore_cp +
   eAfter_cp_raw) где eAfter в POV stm-in-fenAfter (= соперник
   stm-fenBefore), отсюда сложение знаков. Реализация — точная
   формула в коде, юнит-тесты.
4. **Mate-кодирование** — sentinel ±20000cp (в проекте может быть
   другой; backend и frontend должны использовать ОДИН и тот же).
   Если sentinel ≠ ±20000 — параметризовать через shared-константу.
5. **На «Отмена» при 0 валидных** — toast «Ничего не собрано» и
   закрыть (моё). Альтернатива — оставить пользователя в модалке
   с retry-кнопкой. Не критично, UX-выбор frontend'а.

@coordinator (по 1 — подтвердить моё решение; 3-4 — уточнить при
реализации; 2/5 — UX-вопросы для frontend'а).

## 12. Откат

- B0/B1/B2/F4/F1/F2/L1 — все additive. Feature-flag
  `repertoireFromArchiveEnabled` для фронт-кнопки.
- Существующие созданные репертуары остаются обычными
  multi-source — без изменений после отката.
