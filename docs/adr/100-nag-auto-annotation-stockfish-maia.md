# ADR-100. Авторасставление NAG-знаков и вариантов через Stockfish + Maia

Статус: предложен (KS-3601).
Дата: 2026-06-02.
Связано: ADR-097 (Maia inline), ADR-098/099 (sort + searchmoves), KS-3577 (Maia client), `apps/web/src/lib/maia/workerEngine.ts` (`predictMovesBatch`), `apps/web/src/hooks/useStockfish.ts`.

## 1. Контекст

После ADR-097/098/099 на клиенте уже работают:
- Stockfish (WASM) — eval позиций, `multipv` + `searchmoves`.
- Maia (WASM-worker, `predictMovesBatch` — батч на одну позицию с массивом ELO).
- В PGN-модели проекта (`apps/web/src/hooks/useChessGame.ts`, `apps/web/src/review/utils/nagUtils.ts`) у каждого хода есть `nag: number[]` (стандартные коды 1-6 для quality, 10-19 для position eval) и поддержка вариантов через дерево.
- Уже есть похожий backend-flow в Guess (`apps/api/src/guess/guess.service.ts:200` — создание Analysis с annotated-PGN по `lossPlayer`/`verdict`).
- Палитра NAG'ов и `NagPalette` (`apps/web/src/review/components/NagPalette.tsx`) — для ручной разметки.

Задача — связать обе модели в auto-аннотатор: пройти партию, собрать пары `(SF eval, Maia probability)` для сыгранного хода и SF-best хода, выставить NAG-знаки и при ошибках добавить «как надо было» как variation.

Идея из arxiv 2406.11895 — Maia + engine для классификации brilliancy: «brilliant» = объективно лучший ход, который **большинство людей не нашли** (низкая `playedProb` у SF-best).

## 2. Цель и MVP-граница

### 2.1. Цель

После одной кнопки «Разобрать партию» — партия размечена NAG-ами (`!`, `!!`, `?`, `??`, `?!`, `!?`) и опциональными вариантами «как надо было / что часто играют». Пользователь сразу видит ошибки/находки без ручной работы.

### 2.2. MVP-граница (что входит)

1. Триггер — **postразбор**, нажатие кнопки. Не live.
2. NAG-коды только из quality-подсемейства: 1 (`!`), 2 (`?`), 3 (`!!`), 4 (`??`), 5 (`!?`), 6 (`?!`). Положительные коды (10, 13, 14 = `=`, `∞`, `⩲`) **в MVP не ставим автоматом** (требуют отдельной модели intuition; их пользователь ставит руками).
3. Варианты — добавляем для ходов с `?`/`??` (SF-best как «как надо было», глубина 3 полухода) и опционально для «Maia-trap» ходов (Maia top-1 ≠ SF top-1 и Maia top-1 — объективно слабый, 1 полуход).
4. Источник — клиентский Stockfish + Maia (без backend). Аннотации сохраняются в существующий `Analysis.pgn` через существующее API.
5. Прогресс-модалка «Анализируем партию… N из M» с возможностью отмены.

### 2.3. Не входит в MVP (follow-up)

- Авто-position-eval NAG (`=`, `±`, `⩲` и т.п.).
- Live-аннотация при переходе по дереву ходов.
- Бэкенд-кэш результатов (повторный анализ той же позиции пересчитывает заново).
- Tuning порогов пользователем (только захардкоженные дефолты).
- Класс «trap-blunder» подсветка в реальном времени (это другая фича).
- Multi-language комментарии («Maia favourite move», «Best move» автотекстом) — в MVP комментарии не пишем, только NAG-коды и сама variation; текстовые комменты — follow-up.
- Анализ только-форсированных позиций (mate-in-N) — пропускаем (cheap-skip).

## 3. Правила NAG (MVP-пороги)

### 3.0. Источник метрики — `classifyMove` из shared

**Корневое решение (KS-3607 уточнение):** не используем чистый cpLoss в сантипешках. Используем **уже существующую** логику классификации хода по **WDL / win-probability** из shared-модуля `packages/shared/src/utils/move-classification.ts` (функция `classifyMove`, ADR-066). Та же логика лежит в основе раздела «Точность» (precision/accuracy) и обеспечивает единый источник истины: что «Точность» считает blunder'ом, то и авто-NAG помечает `??`.

Почему: cp +9 → +7 — большая величина в сантипешках, но обе позиции = win-probability ~100% (выигрыш). Метрика «потеря шансов на победу/ничью» (`loss_E = E_before - E_after`, где `E = (w + d/2) / 1000` от Stockfish WDL) корректно даёт `0` для такого хода. Сантипешковые пороги дали бы ложный `??`.

### 3.1. Что собираем для каждого полухода

С помощью Stockfish с включённой опцией `UCI_ShowWDL`:

- `wdlBefore: { w, d, l }` — WDL позиции **перед** сыгранным ходом, POV ходящей стороны (per-mille).
- `wdlAfterPlayed: { w, d, l }` — WDL позиции **после** сыгранного хода, POV того же игрока (фронт делает POV-инверсию через `invertWdl` из `wdl.ts`, потому что после хода Stockfish считает с POV соперника).
- `wdlAfterBest: { w, d, l }` — WDL после SF-best, POV того же игрока (инвертировано). Если `playedUci === sfBestUci` — равно `wdlAfterPlayed`.
- `wdlAfterSecondBest: { w, d, l }` — WDL после SF top-2, POV того же игрока. Используется для `!!`-критерия.
- `wdlAfterMaiaTop: { w, d, l }` — WDL после Maia top-1, POV того же игрока. Для §4.2 Maia-trap.
- `sfBestUci`, `sfBestPv: string[]` — лучший ход и PV (для variation глубины 3).
- `playedProb`, `sfBestProb`, `maiaTopUci`, `maiaTopProb` — от Maia `policy` (под выбранным ELO).
- `forcedMove: boolean` — у позиции один легальный ход, либо все non-best ходы имеют classification = `'blunder'` (т.е. позиция «вынужденная»).

Helpers из `packages/shared/src/utils/wdl.ts`:
- `expectedScoreFromWdl(wdl) = (w + d/2) / 1000` → E ∈ [0..1].
- `wdlSigned(wdl) = (w − l) / 1000` → [-1..+1].
- `invertWdl({w,d,l}) = {w:l, d, l:w}` — POV-зеркало при смене стороны.
- `wdlOrMateFallback(wdl, score)` — заглушка `{w:1000,d:0,l:0}` для mate (когда WDL отсутствует).

Helpers из `packages/shared/src/utils/move-classification.ts`:
- `classifyMove({ wdlBefore, wdlAfter, cpBefore, cpAfter, isBestMove }) → 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'`.

### 3.2. Маппинг classification → NAG

Каждый полуход прогоняем через `classifyMove`. Полученный класс маппим на NAG (с дополнительным фильтром по Maia probability для `!`/`!!`/`!?`):

| NAG | Symbol | Условие |
|-----|--------|---------|
| 4 | `??` (blunder) | `classifyMove(played) === 'blunder'` (loss_E > 0.25 или `wdlAfterPlayed.l > 950`) |
| 2 | `?` (mistake) | `classifyMove(played) === 'mistake'` (0.12 < loss_E ≤ 0.25) |
| 6 | `?!` (dubious) | `classifyMove(played) === 'inaccuracy'` (0.05 < loss_E ≤ 0.12) |
| 5 | `!?` (interesting) | `classifyMove(played) === 'good'` **И** `playedUci ≠ sfBestUci` **И** `playedProb ≥ 0.30` |
| 1 | `!` (good move) | `classifyMove(played) === 'best'` **И** `playedUci === sfBestUci` **И** `playedProb < 0.20` |
| 3 | `!!` (brilliant) | `classifyMove(played) === 'best'` **И** `playedUci === sfBestUci` **И** `playedProb < 0.05` **И** **не** `forcedMove` **И** `classifyMove(secondBest) ∈ {'mistake','blunder'}` (второй вариант минимум до mistake — ход реально решал) |

Примечание: `classifyMove` для `secondBest` вызывается с `wdlBefore` той же позиции и `wdlAfter = wdlAfterSecondBest`. То есть «насколько хуже была бы вторая лучшая альтернатива».

### 3.3. Suppress-правила (никаких NAG)

- **Forced move** (`forcedMove === true`): no-NAG. Не «!» (выбора не было) и не «?» (иначе нельзя). Особый кейс: один легальный ход — тривиально skip.
- **Decided position**: если `|wdlSigned(wdlBefore)| > 0.95` (позиция фактически решена ≥95% в одну сторону) — quality-NAG не ставим. Точность хода в безнадёжной/выигранной позиции мало значит, NAG будут спамить.
- **Mate-line** обрабатывается самим `classifyMove`: `wdlAfter.l > 950` → blunder автоматически (для проигравшего мат); `wdlAfter.w > 950` → best (для удержавшего мат). Дополнительных правил не нужно.
- **Opening (первые N полуходов)**: в MVP **не пропускаем дебют** — даже первый ход может быть `!` если редкий и сильный. По обратной связи может оказаться шумно — добавим `skipOpeningPlies = 8` в follow-up.

### 3.4. Mate без WDL (legacy fallback)

Если Stockfish не отдал WDL (старые версии при mate), `wdlOrMateFallback(wdl, score)` подставляет per-mille заглушку (`{w:1000,d:0,l:0}` для mate-в-пользу). Дальше `classifyMove` работает с этой заглушкой штатно.

cp-фолбек в `classifyMove` тоже есть (через `winPctFromCp`), но в наших условиях (свежий WASM Stockfish с `UCI_ShowWDL=true`) практически не задействуется.

## 4. Логика добавления вариантов

Та же метрика — `classifyMove` из shared, без сантипешковых порогов.

### 4.1. «Как надо было» — для ошибок

Условие: `classifyMove(played) ∈ {'mistake', 'blunder'}` **И** `sfBestUci ≠ playedUci`.

Действие: добавить **side-variation**, начинающуюся с `sfBestUci`. Глубина = **3 полухода**:
1. `sfBestUci` (наш ход, правильный).
2. SF-best ответ соперника.
3. SF-best ответ нас.

Откуда брать ходы 2 и 3 — из PV первой линии SF (`pv[0]`, `pv[1]`, `pv[2]`).

### 4.2. «Что часто играют» — Maia-trap

Условие: `maiaTopUci ≠ sfBestUci` **И** `maiaTopProb ≥ 0.25` **И** `classifyMove(maiaTop) ∈ {'mistake', 'blunder'}` (Maia-top объективно ошибочен в WDL-смысле) **И** `playedUci ≠ maiaTopUci` (пользователь сам его не сыграл — иначе уже размечен через 4.1).

`classifyMove(maiaTop)` вызывается с `wdlBefore` той же позиции и `wdlAfter = wdlAfterMaiaTop` (требует доп. SF-вызова `searchmoves <maiaTopUci> multipv 1` на этой позиции для получения eval). Если получить `wdlAfterMaiaTop` невозможно (Maia top-1 совпал с одним из SF top-3 — берём из существующих линий; иначе skip variation, не делаем доп. SF-go в MVP).

Действие: добавить **отдельную side-variation** глубиной **1 полуход** с `maiaTopUci`. На этот ход вешаем NAG соответственно классификации (`?` для mistake, `??` для blunder). Без продолжения — это «человеческая ловушка», достаточно показать сам ход.

### 4.3. Лимиты

- Максимум **2 variations на полуход** (one «как надо было» + one «Maia-trap»).
- Variations добавляются в существующее дерево через текущее API (`onAddVariation` или эквивалент).
- Колор variation (KS-2286/2291 `[%cvc X]`): «как надо было» — `green`, «Maia-trap» — `red` (по аналогии с blunder).

## 5. Где работает (MVP)

**Только постразбор**. Триггер — кнопка «Разобрать партию» (i18n key `analysis.review.runCta`) в:
1. `apps/web/src/pages/AnalysisPage.tsx` — для текущей загруженной партии.
2. `apps/web/src/pages/ArchiveGamePage.tsx` — для архивной партии (открыта в analysis-mode).

Не делаем:
- Live-аннотацию при кликах по дереву ходов (это шум + N×inference на каждый прыжок).
- Авто-запуск при открытии страницы (пользователь сам решает, когда тратить ~20-30 с CPU).

После завершения — модалка закрывается, пользователь видит размеченную партию в основном UI. Никаких «отдельных режимов просмотра» — всё в той же `AnalysisSidebar`.

## 6. Настройки пользователю (MVP)

Минимум:
- **Кнопка «Разобрать партию»** — единственный пользовательский control.
- **ELO для Maia** — берётся из существующего `analysis.maia.elo` (он уже хранится в localStorage, выбирается в шапке engine-panel). Не плодим отдельный селектор.
- **SF depth** — берётся из текущего `useEngineConfig` (тот же `ec.depth`). Если пользователь повысил depth — анализ дольше.

Захардкожено:
- Все пороги из §3.2.
- Глубина variations (3 / 1).
- Лимит 2 variations на полуход.
- `skipOpeningPlies = 0` (могут быть NAG на ходах 1-8).

Future user-controls (не MVP): preset «строгий/мягкий», skip-opening toggle, disable variations.

## 7. Производительность

### 7.1. Бюджет на партию 80 полуходов

**Stockfish** (`useStockfish` или прямой worker):
- 1 inference на позицию × 80 = 80 SF-runs.
- На `depth 18` ≈ 200-400 мс/run на WASM (по сегодняшним замерам). Total: **16-32 с**.
- Запускаем `multipv 3` + `UCI_ShowWDL=true` чтобы сразу получить `wdlBefore`, `wdlAfterBest`, `wdlAfterSecondBest`, `sfBestPv` за один прогон. Для сыгранного хода (если не совпал с SF top-3) — отдельный `searchmoves <playedUci> multipv 1` на позиции для `wdlAfterPlayed` (фронт POV-инвертирует).

**Maia** (`predictMovesBatch`):
- 1 inference на позицию × 80 = 80 Maia-runs, **но** `predictMovesBatch` уже умеет батч по N позициям одной модели сразу.
- В реальности — батч по 1 позиции (model не умеет broadcasting tokens между разными FEN'ами, см. `workerEngine.ts:175-183`). То есть 80 отдельных runs ≈ 300-500 мс/run на WASM. Total: **24-40 с**.
- Можно ужать: запускать **параллельно** со Stockfish (Maia в своём воркере, SF в своём).

**Total**: `max(16-32 с SF, 24-40 с Maia)` параллельно = **~25-40 с p50** на партию 80 полуходов. Допустимо. Пользователь видит progress-modal «Анализирую партию… 23 из 80».

### 7.2. Оптимизации (MVP)

- **Параллельность** — SF и Maia в разных воркерах, оркестратор просто `Promise.all`.
- **Early-skip** для очевидно не-NAG позиций:
  - Если `|wdlSigned(wdlBefore)| > 0.95` → можно пропустить Maia (для этого хода NAG не ставится, см. §3.3 «Decided position»).
  - Если позиция mate-in-N и сыгран mate-move → skip Maia (classifyMove даст `best` через wdlAfter.w > 950).
- **Cancel** — пользователь нажал «Отмена» в модалке → оркестратор посылает `terminate()` обоим воркерам.

### 7.3. Оптимизации (follow-up)

- Кэш результатов по FEN в IndexedDB (повторный анализ позиции из transposition даёт мгновенный hit).
- Подкачка движка отдельного потока (только один SF-инстанс — поэтому SF — bottleneck).

## 8. Где живут аннотации

**Решение пользователя:** при авто-аннотации создаётся **новая копия анализа** (дубликат), оригинал остаётся нетронутым. В списке мастерской дубль отличается припиской «(автоаннотация)» в title.

### 8.1. Структура дубля

Дубль — это полноценная запись `Analysis` со всеми полями оригинала (`pgn`, `fen`, `headers`, `category`, `tags`, `opening`, `boardOrientation`, etc.) **за исключением**:
- `title` = `${original.title} (автоаннотация)` (i18n key + интерполяция).
- `pgn` = новый PGN с авто-NAG и variations (см. §3, §4).
- `originalAnalysisId` = `original.id` (новое поле, см. §8.3).
- `sourceHash` = `null` (не участвует в дедупе по партии — это другой инструмент).
- `isPublic` = `false` (приватный по умолчанию, даже если оригинал был публичным — пользователь сам решит).
- `guessSessionId` = `null` (не наследуем guess-привязку).

В авто-PGN дубля NAG'и и variations пишутся **поверх чистой партии** (как если бы поле было пустое) — без merge с ручными аннотациями оригинала, потому что оригинал в этой модели не трогается вообще. Дубль — самостоятельная запись.

### 8.2. Backend: новое поле + endpoint

**Миграция Prisma:**

```prisma
model Analysis {
  // существующие поля...
  /// KS-XXXX (ADR-100). Soft-ссылка на оригинал для авто-аннотированных
  /// дубликатов. NULL для оригиналов и независимо созданных анализов.
  /// Без FK — оригинал может быть удалён пользователем, дубль остаётся
  /// (фронт показывает «исходный анализ удалён»).
  originalAnalysisId String? @map("original_analysis_id") @db.Uuid

  @@index([userId, originalAnalysisId])
}
```

**Новый endpoint** (или расширение существующего `POST /analyses`):

`POST /analyses/:id/duplicate-annotated`

- Body: `{ pgn: string, titleSuffix?: string }` (`titleSuffix` дефолт `(автоаннотация)` — для будущей i18n с серверной стороны; в MVP суффикс приходит с фронта).
- Действие: загружает `original` (с проверкой `userId === req.user.id`), создаёт новый `Analysis` со скопированными полями + перезаписанным `pgn` + `originalAnalysisId = original.id` + `title = ${original.title} ${titleSuffix}`.
- Возврат: новая Analysis (тот же shape что `GET /analyses/:id`).
- Идемпотентность: см. §8.4.

Альтернатива — переиспользовать `POST /analyses` с новым полем `originalAnalysisId` в DTO. На усмотрение backend-задачи — оба варианта рабочие. Отдельный endpoint чище семантически (action не CRUD), общий — меньше кода.

### 8.3. UI: source-link и навигация

**В списке мастерской** (`/analyses` или эквивалент):
- Дубль рендерится отдельной карточкой со суффиксом `(автоаннотация)` в title.
- Маленькая иконка / pill «авто» рядом — опционально (договариваемся с layout).
- Сортировка — рядом с оригиналом (тот же `lastOpenedAt`-порядок) либо в группе под оригиналом — реализация при первом приближении: **простой плоский список** (та же сортировка что и сейчас). Группировка/коллапс — future.

**На странице дубля** (`/analysis/:duplicate-id`):
- В header (где сейчас title) — маленькая ссылка «← Исходный анализ» (i18n key `analysis.auto.backToOriginal`).
- Клик → переход на `/analysis/:original-id`.
- Если оригинал удалён (404) — показываем disabled-ссылку с tooltip «Исходный анализ удалён».

**На странице оригинала** — **ничего не добавляем** в MVP (минимум UI-шума). Future: маленький pill «есть авто-копия» с ссылкой.

### 8.4. Идемпотентность повторного запуска

При втором/третьем нажатии «Разобрать партию» на оригинале:

**Решение MVP: обновляем существующий дубль.**

- Backend ищет: `Analysis WHERE userId = X AND originalAnalysisId = original.id` (тот же uniq по `(userId, originalAnalysisId)` — не делаем @@unique, чтобы избежать жёсткой ошибки 409; просто берём `findFirst` и решаем в коде).
- Если найден — `UPDATE pgn = newPgn, lastOpenedAt = now()`, возврат updated.
- Если не найден — `CREATE` новый.
- Запрос с фронта тот же `POST /analyses/:id/duplicate-annotated` — backend сам выбирает create vs update.

Это значит: повторный анализ не плодит копии. Если пользователь правил дубль вручную — его правки **затрутся** новым авто-PGN. Это согласуется с моделью «дубль = всегда отражает текущий авто-результат, оригинал — ручная работа».

Альтернатива (history of revisions) — каждый прогон создаёт новый дубль с `(автоаннотация v2)`, `v3`. Не делаем в MVP (загромождает список). Если по фидбэку понадобится — добавим версионирование как follow-up.

### 8.5. Если запускают авто на дубле (рекурсия)

Если пользователь открыл дубль (у которого `originalAnalysisId ≠ null`) и снова нажал «Разобрать» — что делаем?

**Решение MVP:** трактуем как запуск на `original`. То есть:
- Берём `targetForDuplication = analysis.originalAnalysisId ?? analysis.id`.
- Backend получает родителя, обновляет/создаёт дубль связанный с тем же original.
- Пользователь не получит «дубль дубля». Это безопасно и предсказуемо.

UI-альтернатива — disable кнопки «Разобрать» на дубле (только на оригинале). Тоже разумно. Реализация — что проще на этапе B (frontend), либо сразу disable.

### 8.6. Хранение в существующем PGN-движке

Внутри `pgn` дубля используется **существующая** модель аннотаций (без изменений):
- `nag: number[]` на каждом ходе (`useChessGame` уже это поддерживает).
- `variations` — стандартная PGN-вложенность.
- Цвет variation — через `[%cvc X]` PGN-макрос (KS-2286).

Никаких новых полей в PGN. Auto-аннотатор просто кладёт чистый PGN с NAG'ами и variations в `Analysis.pgn` дубля.

## 9. Декомпозиция

### Этап A — research/calibration (architect, 0.5 дня)

**KS-XXXX: Smoke авто-NAG на 5-10 реальных партиях.**

1. Локально (в виде ad-hoc скрипта или прямо в `/dev/post-game-review`-странице) прогнать SF+Maia по 5-10 партиям с известной разметкой (можно из chess.com / lichess game reports).
2. Применить пороги §3.2.
3. Зафиксировать в комментарии:
   - Сколько NAG'ов поставлено всего.
   - Сколько `!!` / `!` — выглядят ли «brilliant» (не false positive).
   - Сколько `?` / `??` — не пропустили ли очевидное.
   - Что с дебютом (шумит / нет).

Если пороги дают явный мусор (например, `!!` на каждом втором ходе) — скорректировать в этом ADR (новый коммит) до запуска B.

**Acceptance:** комментарий с результатами + либо подтверждение порогов §3.2, либо обновлённые пороги.

**Опционально** — если уверены в порогах, A можно пропустить и начать B. Решает координатор.

### Этап B — core (frontend, 2-3 дня)

**KS-XXXX: Auto-аннотатор Stockfish + Maia на странице анализа.**

1. **Worker-оркестратор** `apps/web/src/lib/review/reviewWorker.ts` (или композиция в JS-thread, если Worker для оркестрации overkill — оба варианта обсуждаемы):
   - Input: `Array<{ fen, playedUci }>` (все полуходы партии).
   - Внутри — пул из 2 источников (`useStockfish`-обёртка и `MaiaWorkerEngine`).
   - SF опции: включить `UCI_ShowWDL=true` (если не включено), запросить `multipv 3`. Для playedUci вне top-3 — отдельный `searchmoves` (см. §7.1).
   - POV-инверсия `wdlAfter*` через `invertWdl` из `packages/shared/src/utils/wdl.ts` ДО передачи в `buildAnnotation` (на фронте, не в классификаторе — это правило ADR-066).
   - Yield progress: `{ done: N, total: M }`.
   - Output: `Array<{ ply, nag: number[], variations: Array<{ uci: string, color: 'green'|'red', subline?: string[], nag?: number[] }> }>`.
2. **Алгоритм** `apps/web/src/lib/review/buildAnnotations.ts`:
   - Чистая функция: на вход — собранные WDL/probability данные (`wdlBefore`, `wdlAfterPlayed`, `wdlAfterBest`, `wdlAfterSecondBest`, `wdlAfterMaiaTop?`, `playedUci`, `sfBestUci`, `sfBestPv`, `playedProb`, `sfBestProb`, `maiaTopUci`, `maiaTopProb`, `forcedMove`).
   - **Метрика классификации — ТОЛЬКО `classifyMove` из `packages/shared/src/utils/move-classification.ts`.** Самописная cp-логика **запрещена** (единый источник истины с precision-модулем).
   - На выход — `{ nag: number[], variations: Variation[] }` для одного полухода.
   - Полное покрытие unit-тестами таблицы §3.2 + §3.3 suppress + §4.1/4.2 variations.
3. **Hook** `apps/web/src/hooks/useGameReview.ts`:
   - Public API: `{ run(), progress, status: 'idle'|'running'|'done'|'cancelled'|'error', result }`.
   - `run()` — запускает оркестратор, собирает FEN'ы из текущей `useChessGame.history`, по завершении вызывает `onApply` callback с аннотациями.
4. **UI**:
   - Кнопка «Разобрать партию» (i18n `analysis.review.runCta`) рядом с MultiPV/ELO/⚙ в шапке engine-panel ИЛИ в `AnalysisActionsMenu` (зависит от места). Оценить по плотности шапки.
   - Modal с прогрессом: «Анализирую партию… N из M» + кнопка «Отмена» + кнопка «×».
   - На завершении: модалка автозакрывается, аннотации применяются к `useChessGame` (через существующий `onSetNag` + `onAddVariation`-эквивалент).
5. **Merge с ручными аннотациями** (§8.2): перед записью NAG проверяем — если у хода уже есть quality-NAG (1-6), не перезаписываем.
6. **Идемпотентность** variations (§8.1): перед добавлением variation проверяем дубликат по первому ходу.
7. **i18n**: `analysis.review.runCta`, `analysis.review.progress` («Анализирую партию… {{done}} из {{total}}»), `analysis.review.cancel`, `analysis.review.done`, `analysis.review.error`.
8. **Тесты (Vitest)**:
   - `buildAnnotations` — каждая строка таблицы §3.2 (positive + negative), suppress-правила §3.3, variations §4.1/4.2.
   - `useGameReview` — mock воркеры, прогресс эмитится, отмена работает.
   - Integration: merge не затирает ручные NAG.

**Acceptance:**
- Кнопка «Разобрать партию» доступна на странице анализа.
- На партии ~40 ходов (80 полуходов) при `depth 18` анализ занимает ≤ 40 с p95.
- Модалка показывает прогресс, отмена работает.
- После завершения NAG'и и варианты появляются в дереве ходов.
- Ручные NAG не затираются.
- Повторный запуск не дублирует варианты.
- Vitest зелёный.

### Этап C — layout (0.5 дня)

**KS-XXXX: Стили прогресс-модалки + проверка визуализации NAG в дереве.**

1. Модалка прогресс-анализа: backdrop, центрирование, прогресс-бар, кнопки. По стилю — как существующие модалки проекта (`EngineSettingsModal`, `ArchiveRepertoireMovetimeModal` — взять как образец).
2. Проверить что NAG-символы (`?!`, `!!`, etc.) в `ReviewMoveList` отображаются для авто-проставленных так же как для ручных. Должны — рендер общий через `nagToSymbol`. Если есть визуальная регрессия — починить.
3. Variations с цветом `green`/`red` уже работают (KS-2291). Не трогаем.

**Acceptance:** модалка адекватна в обеих темах. NAG-знаки в дереве ходов читаются после авто-разметки.

### Этап D — follow-up (не MVP)

- IndexedDB-кэш по FEN.
- User-tuning порогов (preset «строгий/мягкий», skip-opening).
- Position-eval NAG (10-19) — отдельный алгоритм.
- Auto-комменты текстом («Maia favourite», «Best move») — i18n + UI.

## 10. Backend

**Не требуется** в MVP. Всё клиентское:
- Stockfish WASM уже в `apps/web/public/stockfish/`.
- Maia WASM уже в `apps/web/public/maia3/`.
- Аннотации сохраняются в существующий `Analysis.pgn` через текущий `PUT /analysis/:id` (или эквивалент — фронт сам вызовет существующий save-flow).

Если в future понадобится server-side cache результатов или партий — отдельный ADR.

## 11. Открытые вопросы

Решено пользователем (модель «дубликат», см. §8):
- ✅ Коллизия auto/ручных NAG не возникает — оригинал не трогается.
- ✅ Source-link: одностороннее «← Исходный анализ» на странице дубля. На оригинале в MVP ничего не показываем.
- ✅ Идемпотентность повторного запуска: **обновляем существующий дубль**, не плодим копии.
- ✅ Авто на дубле (рекурсия): редиректим на оригинал, дубль не «дублируем».
- ✅ Backend нужен — новое поле `Analysis.originalAnalysisId` + миграция + endpoint `POST /analyses/:id/duplicate-annotated`.

Остаточные вопросы — **не критичны для MVP**, корректируем по фидбэку:
- Группировка/коллапс «оригинал + дубль» в списке мастерской (MVP — плоский список).
- Pill «авто-копия» на странице оригинала (MVP — не показываем).
- History of revisions (auto v2, v3 — MVP не делаем, обновляем единственный дубль).
- Точное место кнопки «Разобрать партию» — шапка engine-panel или AnalysisActionsMenu (решает frontend на этапе B).

## 12. Резюме

MVP — кнопка «Разобрать партию» → ~25-40 с прогресс-модалка → **новый авто-аннотированный дубль** в мастерской с припиской «(автоаннотация)» в title. Оригинал не трогается. Источник — клиентский Stockfish (depth 18, multipv 3, `UCI_ShowWDL=true`) + Maia (батч по полуходам) в параллельных воркерах.

Классификация ходов — через **уже существующую** `classifyMove` из `packages/shared/src/utils/move-classification.ts` (та же, что использует precision-модуль). Метрика — WDL / win-probability (`loss_E = E_before - E_after`), а не сантипешки. NAG-таблица — простой маппинг `classification` → NAG-код (§3.2).

Backend: новое поле `Analysis.originalAnalysisId` + миграция + endpoint `POST /analyses/:id/duplicate-annotated` (create-or-update по `(userId, originalAnalysisId)` — идемпотентность). Дубль наследует все поля оригинала кроме `pgn`/`title`/`isPublic`/`sourceHash`/`guessSessionId`. На странице дубля — ссылка «← Исходный анализ».

Декомпозиция:
- D (backend, 0.5-1 день) — миграция + endpoint duplicate-annotated.
- B (frontend, 2-3 дня) — оркестратор + алгоритм + hook + UI (кнопка + модалка + source-link) + i18n + тесты.
- C (layout, 0.5 дня) — стиль модалки + проверка source-link UI.

A-этап (smoke порогов) — пропускаем по решению координатора, тюним по фидбэку после первого запуска.

Открытых критичных вопросов нет.
