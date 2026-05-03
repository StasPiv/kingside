# Tactical drills — методика (KS-2223)

**Дата:** 2026-05-03
**Статус:** Финальный (E0 ADR-035)
**Источник:** [ADR-035](../adr/035-tactical-pattern-drills.md), §2 (каталог), §10 R6/R8 (открытые вопросы)
**Экспертный контент:** chess-expert (KS-2223 issue comment)
**Блокирует:** KS-2224 (KS-DRILL-DESIGN — API contract), KS-2225 (KS-DRILL-DIFFICULTY — формула сложности)

---

## 1. Назначение документа

Single-source-of-truth для дизайна и реализации первой версии тактических drill'ов:

- финальный набор drill-типов (8 шт) с группировкой по навыковому слою,
- финальные RU/EN формулировки промптов (с правками относительно ADR-035 §2.3),
- порядок освоения,
- что **не** включаем в MVP и почему,
- threshold «решено» для shape=`squares[]` (значение и обоснование),
- локализация фигур.

Документ — основа для:
- backend (KS-DRILL-PREDICATES, KS-DRILL-API) — список типов и их answer-shape,
- frontend (KS-DRILL-LOBBY, KS-DRILL-PAGE, KS-DRILL-I18N) — порядок UI, тексты, локализация,
- chess-expert / content (KS-DRILL-CURATED, onboarding-объяснения) — что можно расширять.

---

## 2. Финальный список drill-типов

**Подтверждено: все 8 типов из ADR-035 §2.1, без урезаний.** Урезание ниже 8 разрушит навыковые слои — ниже описано почему.

### 2.1 Группировка по навыковому слою

| Слой | Drill | Что тренирует |
|---|---|---|
| **Обзор доски (статика)** | `count-attackers`, `find-loose-piece`, `find-hanging-piece` | Видеть атакующих и защитников, базовый счёт сил вокруг клетки |
| **Распознавание мотивов** | `find-all-checks`, `find-pin`, `find-fork` | Геометрия линий, готовые тактические паттерны |
| **Расчёт и планирование** | `find-mate-in-one-square`, `find-undefended-attack` | Симуляция хода, переход от распознавания к выбору хода |

Обоснование разделения:
- слой обзора — без счёта вариантов,
- слой мотивов — узнавание паттерна на статической позиции,
- слой расчёта — мысленная симуляция «после хода».

Учебная цепочка идёт снизу вверх: обзор → мотивы → расчёт. Drill-типы каждого слоя опираются на навыки нижнего.

### 2.2 Алгоритмы и answer-shape

Без изменений по сравнению с ADR-035 §2.1, кроме трёх редакторских правок (см. §8 ниже): «вилка» вместо «двойной удар» в `find-fork`, явное уточнение «абсолютные связки» в `find-pin`, строго `square` (без fallback на `move`) в `find-mate-in-one-square`.

---

## 3. Финальные RU/EN формулировки промптов

Изменения относительно ADR-035 §2.3 — в трёх типах (отмечено ✱).

| id | RU | EN |
|---|---|---|
| `find-hanging-piece` ✱ | Какая фигура противника висит? | Which enemy piece is hanging? |
| `find-loose-piece` | Какая фигура без защиты? | Which piece is undefended? |
| `find-pin` | Найдите связанную фигуру | Find the pinned piece |
| `find-fork` | Какая фигура делает вилку? | Which piece forks? |
| `find-mate-in-one-square` ✱ | Куда ставится мат в один ход? | Where is mate-in-one delivered? |
| `count-attackers` | Сколько фигур атакуют выделенную клетку? | How many pieces attack the highlighted square? |
| `find-all-checks` ✱ | Найдите все клетки, куда можно дать шах | Find all checking squares |
| `find-undefended-attack` | Какой ход нападает на незащищённую фигуру? | Which move attacks an undefended piece? |

Обоснование правок:
- **`find-hanging-piece`** — добавлено «противника» / «enemy»: своя фигура тоже может висеть, но в drill ищется фигура для взятия. Снимает двусмысленность для новичка.
- **`find-mate-in-one-square`** — «куда ставится» вместо «куда поставить»: drill — про распознавание матующей клетки, а не про действие игрока. Семантически ближе к «найди».
- **`find-all-checks` (EN)** — «Find every check» был неоднозначен (move? square?). «Find all checking squares» синхронен с RU «все клетки», явно указывает answer-shape.

### 3.1 Принципы стиля для расширения палитры (v2+)

При добавлении новых drill-типов следовать установленному формату:

- **RU:** вопрос («Какая…?» / «Сколько…?» / «Куда…?» / «Найдите…»).
- **EN:** вопрос или императив, без артикля только в формуле «Find every X / Find all Xs».
- **Длина:** ≤ 60 символов RU, ≤ 50 EN.
- **Без сленга:** «зевок», «вилка», «связка», «шах» — допустимы как термины. «Проворонил», «отдать», «зевать» — нет.
- **Side-to-move** указывается визуально (рамка вокруг доски, цвет хода-индикатор), **не** словесно в промпте.

### 3.2 i18n-ключи (для KS-DRILL-I18N)

```
review.drill.prompt.findHangingPiece     ru: "Какая фигура противника висит?"
                                         en: "Which enemy piece is hanging?"
review.drill.prompt.findLoosePiece       ru: "Какая фигура без защиты?"
                                         en: "Which piece is undefended?"
review.drill.prompt.findPin              ru: "Найдите связанную фигуру"
                                         en: "Find the pinned piece"
review.drill.prompt.findFork             ru: "Какая фигура делает вилку?"
                                         en: "Which piece forks?"
review.drill.prompt.findMateInOneSquare  ru: "Куда ставится мат в один ход?"
                                         en: "Where is mate-in-one delivered?"
review.drill.prompt.countAttackers       ru: "Сколько фигур атакуют выделенную клетку?"
                                         en: "How many pieces attack the highlighted square?"
review.drill.prompt.findAllChecks        ru: "Найдите все клетки, куда можно дать шах"
                                         en: "Find all checking squares"
review.drill.prompt.findUndefendedAttack ru: "Какой ход нападает на незащищённую фигуру?"
                                         en: "Which move attacks an undefended piece?"
```

(Ключи в реальном i18next будут flat — `review.drill.prompt.<id>` со значением в соответствующем JSON.)

---

## 4. Порядок освоения

Снизу вверх по сложности. По умолчанию пользователь проходит drill-типы в указанном порядке: новый тип не открывается до сдачи предыдущего (минимум по одному успешному прохождению на лёгкой сложности). После первого прохождения каждого типа — все 8 доступны для свободного выбора и повторения.

| # | Drill | Слой | Обоснование позиции |
|---|---|---|---|
| 1 | `count-attackers` | обзор | Базовый навык — счёт атакующих фигур. Используется во всех остальных drill'ах. Без него дальше идти не имеет смысла |
| 2 | `find-loose-piece` | обзор | Простейший статический фильтр: «нет защитников». Ровно один объект в позиции, side-to-move не важна |
| 3 | `find-hanging-piece` | обзор | Усложнение `loose`: добавляется второй критерий «есть атакующий». Side-to-move уже важна |
| 4 | `find-all-checks` | мотивы | Переход от поиска фигуры к поиску клетки. Шах — простейший форсированный ход, основа для расчёта |
| 5 | `find-pin` | мотивы | Геометрия линий (диагональ / вертикаль / горизонталь). Требует понимать «фигура за фигурой» |
| 6 | `find-fork` | мотивы | Комбинационный мотив, требует видеть «фигура атакует две». Опирается на счёт атакующих (drill #1) |
| 7 | `find-mate-in-one-square` | расчёт | Финал расчёта: шах + проверка матовости. Опирается на `find-all-checks` (drill #4) |
| 8 | `find-undefended-attack` | расчёт | Самый сложный: ученик ищет **ход** (не объект на доске), требует мысленной симуляции «после хода — что атаковано». Создание угрозы — переход от тактики к стратегии |

UX (для KS-DRILL-LOBBY):
- по умолчанию открыт только drill #1, остальные с замком (с tooltip «Откроется после прохождения предыдущего»),
- после сдачи — следующий разблокируется, появляется в lobby,
- после прохождения всех 8 — снимается режим строгого порядка, lobby показывает все типы как карточки с прогрессом.

---

## 5. Что НЕ включаем в MVP

| Паттерн | Описание | Почему отложен |
|---|---|---|
| Discovered attack | Открытое нападение: ход одной фигурой вскрывает атаку другой | Алгоритмически сложен (симуляция хода + проверка вскрытой линии). Дидактически близок к `find-undefended-attack`, добавим в v2 после стабилизации MVP |
| Skewer | Обратная связка: ценная фигура спереди, менее ценная сзади | Близок к `find-pin`, в MVP создаст путаницу. Включить вместе с relative pins в v2 |
| X-ray attack | Атака «через» фигуру (рентген) | Требует понимания «через фигуру», высокий когнитивный порог. v2 |
| Trapped piece | Запертая фигура (нет безопасных ходов) | Требует перебора всех ходов фигуры — это уже расчёт, а не обзор. v2 после `find-undefended-attack` |
| Mate-in-2 / Mate-in-N | Мат в 2 и более ходов | Выходит за scope «один ход на задачу» в drill. Покрывается Puzzle Rush с tag `mate-in-N` |
| Defensive drills | «Защити фигуру», «прикрой клетку» | Отдельный навыковый pillar (защита). Стартовый набор — атакующие drill, для роста до 1500 ELO. Защитный pillar — после, для рейтинга 1500+ |
| Zwischenzug | Промежуточный ход в форсированной серии | Не позиционный паттерн, а паттерн принятия решения в форсированной серии. Не помещается в формат «одна позиция = одна задача» |

Возврат к этому списку — после первой итерации v1 и анализа метрик (drop-off rate, accuracy distribution).

---

## 6. Threshold для shape=`squares[]`

**Финальное значение: `0.7`** (Jaccard / IoU = TP / (TP + FP + FN)).

Заменяет черновое `0.6` из ADR-035 §10 R8.

### 6.1 Поведение при разном числе правильных клеток N

| N | Минимум TP при FP=0 (нет лишних) | Допустимо FP при TP=N (все нашли + ошибки) |
|---|---|---|
| 2 | 2 (IoU=2/2=1.0; при TP=1 → 0.5 fail) | 0 (IoU=2/2=1.0; +1 → 0.67 fail) |
| 3 | 3 (TP=2 → 0.67 fail) | 1 (3/4=0.75 pass) |
| 4 | 3 (3/4=0.75 pass; 2/4=0.5 fail) | 1 (4/5=0.8 pass) |
| 5 | 4 (4/5=0.8 pass; 3/5=0.6 fail) | 2 (5/7=0.71 pass) |
| 6 | 5 (5/6=0.83 pass; 4/6=0.67 fail) | 2 (6/8=0.75 pass) |

### 6.2 Обоснование значения

**Почему 0.7, а не 0.6:**
- При N=2 и одной ошибке (TP=1, FP=0, FN=1) IoU=0.5 — должен быть fail (50% ошибок недопустимо в drill);
- При N=5 и двух пропущенных IoU=0.6 — на 0.6 пройдёт, на 0.7 нет; пропустить 40% задачи в drill — это не «решено».

**Почему не 0.8:**
- При N=3 и одной пропущенной IoU=0.67 — на 0.8 fail; для маленьких N жёстко (одна ошибка = провал, демотивация).

**Почему не 1.0 (всё или ничего):**
- Демотивация на ранних уровнях, drop-off rate растёт. IoU 0.7 дисциплинирует «почти решил, но мимо», оставляя пространство для незначительных ошибок.

### 6.3 Контроль сложности через размер ответа N

Размер N (число правильных клеток) — основной механизм управления сложностью drill, threshold константен:

| Уровень сложности drill | N (число правильных клеток) |
|---|---|
| 1–2 (новичок) | 2–3 |
| 3–4 (средний) | 3–5 |
| 5+ (продвинутый) | 5–7 |

Threshold 0.7 в комбинации с размером N даёт согласованную сложность по уровням. См. KS-DRILL-DIFFICULTY (KS-2225) для формулы scoring сложности.

### 6.4 Метрика для пересмотра threshold

После накопления первых **1000 drill-сессий** на shape=`squares[]`:
- **pass-rate > 90%** → ужесточить до 0.8;
- **pass-rate < 50%** → ослабить до 0.65;
- **drop-off на этом drill > 30%** → пересмотреть N-распределение, **не** threshold (проблема не в строгости, а в избыточном размере ответа).

Метрики собирает backend (KS-DRILL-API), пересмотр — chess-expert + architect совместно (открытие отдельного тикета по результатам).

---

## 7. Локализация фигур (R6)

**Primary способ обозначения фигур в текстах drill — Unicode-символы.**

### 7.1 Таблица символов

| Фигура | Белая | Чёрная | RU буква | EN буква | aria-label RU | aria-label EN |
|---|---|---|---|---|---|---|
| Король | ♔ | ♚ | Кр | K | король | king |
| Ферзь | ♕ | ♛ | Ф | Q | ферзь | queen |
| Ладья | ♖ | ♜ | Л | R | ладья | rook |
| Слон | ♗ | ♝ | С | B | слон | bishop |
| Конь | ♘ | ♞ | К | N | конь | knight |
| Пешка | ♙ | ♟ | п | P | пешка | pawn |

### 7.2 Почему Unicode, а не локализованные буквы

- Снимает RU-коллизию «К = Конь / Король» (без необходимости костыля «Кр»);
- Язык-нейтрально (одни символы для RU/EN, без переключения по локали);
- Цвет фигуры указывается самим символом (filled / outline), словесные пометки не нужны;
- Визуально ближе к шахматному тексту, к которому ученик идёт через книги/PGN.

### 7.3 Где фигуры реально упоминаются

В **промптах основных 8 drill-типов фигуры почти не упоминаются** (промпты описывают свойство — «висит», «связана», «делает вилку» — а не тип). Локализация фигур нужна в:
- onboarding-объяснениях (например, «♞ делает вилку, когда одновременно атакует ♛ и ♜»);
- блоке решения после ответа («Правильно: ♝c5 связан ладьёй на f8»);
- разборе ошибок («Пропущено: ♞e4 без защиты»).

### 7.4 Fallback-стратегия (обязательно реализовать в frontend)

1. **Шрифт.** `font-family: 'Noto Sans Symbols 2', 'Segoe UI Symbol', 'Apple Symbols', sans-serif`. На системах без подходящего Unicode-шрифта будет деградация — для надёжности сразу планируем SVG-fallback.
2. **SVG-спрайт фигур** из текущей доски (та же графика, что используется в `react-chessboard`, `BoardSettingsContext`). Через CSS-class `<span class="piece piece-bn">♞</span>` подменять символ на inline-SVG.
3. **A11y.** Каждый символ оборачивается в `<span aria-label="чёрный конь">♞</span>` (или `<span aria-label="black knight">`) — для скрин-ридеров.
4. **Локализованные буквы** (Кр / Ф / Л / С / К / п и K / Q / R / B / N / P) — **только в SAN-нотации внутри логов и PGN-экспорта**. В UI текстах не использовать — нарушит i18n-нейтральность.

### 7.5 Реализация — чек-лист для frontend (KS-DRILL-COMPONENTS / KS-DRILL-I18N)

- [ ] Component `<Piece color="black" type="knight" />` — рендерит Unicode-символ + aria-label по локали.
- [ ] CSS-class `.piece` с font-family fallback chain.
- [ ] SVG-спрайт fallback при `font-display` cannot match (опционально через `@supports` или JS-проверку).
- [ ] aria-label берётся из i18n-ключа `chess.piece.<color>.<type>` (8 ключей RU + 8 EN — генерится скриптом, не вручную).
- [ ] PGN-экспорт / админский логи — буквы (Кр/K, Ф/Q, ...), не символы. Уже работает в существующем коде (`chess.js` SAN), не трогаем.

---

## 8. Редакторские правки в ADR-035 §2.1

Три точечных правки. Внесены **в этом же коммите** (см. KS-2223), не блокируют E1.

### 8.1 `find-fork` — терминология

**Было** (ADR-035 §2.1, строка 4 таблицы):
> Двойной удар: один ход атакует ≥2 ценных фигур противника одновременно. Версия MVP — найти **готовую** вилку (фигура уже атакует двух)

**Стало:**
> **Вилка**: один ход (или существующая позиция) атакует ≥2 ценных фигур противника одновременно. Версия MVP — найти **готовую** вилку (фигура уже атакует двух)

Обоснование: «двойной удар» (double attack) в русской традиции шире вилки (включает открытые нападения, батареи). Алгоритм `attacks_from(F) ∩ enemy ≥ 2` описывает именно вилку. Термин «двойной удар» возвращается, если в v2 расширим тип до double-attack.

### 8.2 `find-pin` — уточнение про MVP

**Было:**
> По умолчанию — связки на короля (абсолютные). В v2 добавим относительные

**Стало:**
> По умолчанию — связки на короля (абсолютные). В v2 добавим относительные. **В MVP onboarding-объяснение даёт определение: «связанная фигура — та, которую нельзя сдвинуть, потому что за ней под боем король»** (chess-expert KS-2223 §2.2)

Обоснование: для drill-уровня нужно явно разграничить с relative pins, иначе ученик ожидает их и теряется.

### 8.3 `find-mate-in-one-square` — answer-shape

**Было:**
> `square` (to-клетка) либо `move` (если задача неоднозначна по фигуре)

**Стало:**
> `square` (to-клетка) **строго**. Генератор отбрасывает позиции, где две разные фигуры могут поставить мат на одну `to`-клетку (редкий случай в реальных партиях). Fallback на `move` отменён — упрощает UI и единообразит answer-shape

Обоснование: если в позиции одна `to`-клетка матования — answer-shape всегда `square`. Если две разные фигуры дают мат на разные клетки — это уже **не** «mate in one square», задача отбраковывается. Fallback на `move` создавал ненужное усложнение UI.

### 8.4 §10 R8 — threshold

В таблице рисков заменить:

**Было:**
> R8 | Что считать «решено» для shape=`squares[]`? Threshold 0.6 — произвольное число | chess-expert (E0) | Зафиксировать в methodology-doc, потом метрить на early users

**Стало:**
> R8 | Что считать «решено» для shape=`squares[]`? **Threshold 0.7 IoU** (зафиксировано в [`tactical-drills-methodology.md`](../architecture/tactical-drills-methodology.md) §6) | chess-expert (закрыто KS-2223) | Метрить на первых 1000 сессиях, пересмотр по правилам §6.4 methodology-doc

---

## 9. Difficulty: формула сложности 1–5

**Источник:** [chess-expert экспертный блок в KS-2223](https://kingside.local) (комментарий 7935, по запросу из KS-2225). Архитектурное оформление: разделение на минимальную версию v1 для cold-start и полную формулу как target-state.

### 9.1 Назначение

Каждой задаче `tactic_drills.difficulty` присваивается целое 1..5 на этапе индексации (`apps/api/scripts/index-tactic-drills.ts`). Используется:
- **Generator/indexer** — фильтрует позиции по target-distribution на bucket'ы.
- **API endpoint `GET /api/tactic-drill/next?difficulty=<n>`** — выбор задачи по сложности.
- **Statistics** — segment результатов для калибровки (см. §9.6).
- **UI lobby** — индикатор уровня под карточкой drill (заполненные «звёздочки» 1-5).

### 9.2 Универсальные факторы

Применяются ко всем 8 drill-типам.

| Фактор | Определение | Вес (см. §9.5) |
|---|---|---|
| `pieceCount` | Все некоролевские фигуры на доске. **Нелинейная** связь со сложностью: эндшпиль (≤8) — низкая по обзору, ранний middlegame (17–22) — пик, дебют (23+) — overload | medium |
| `attackerDensity` | `Σ (attackers(sq, white) + attackers(sq, black)) / occupiedSquares`. Меряет «тактическую плотность» позиции | high |
| `distractorCount` | Число «почти-решений» в позиции. Универсального definition нет — описывается в `typeSpecific` для каждого drill (см. §9.3) | high |
| `materialBalance` | `|whiteMaterial − blackMaterial|` в pawn units (Q=9, R=5, B=N=3, P=1). Равный материал → **сложнее** (нет «бей самое ценное» подсказки) | low (0.05) |
| `mobilityRatio` | `legalMoves(sideToMove) / legalMoves(opponent)`. Паритет (≈1) → **сложнее** (больше шумов) | low (0.05) |

**Узкие факторы — применяются только для отдельных drill-типов** (попадают в `typeSpecific`):

| Фактор | Drill |
|---|---|
| `geometryDepth` | `find-pin` (длина связочной линии 1..7) |
| `kingExposure` | `find-mate-in-one-square` (тип матовой сети) |
| `crowdedSquares` | `find-loose-piece`, `find-hanging-piece` (число занятых клеток в 3×3 окне вокруг ключевой) |
| `pieceTypeDiversity` | универсально, но эффект слабый — не отдельный фактор, входит в `typeSpecific` где релевантно |

**Отброшенные факторы** (см. §9.7 «Что НЕ в формулу»):
- `phaseHint` — дублирует `pieceCount` + `materialBalance`.

### 9.3 Per-drill `typeSpecific` фактор

Обязателен для всех 8 drill-типов. Возвращает значение в `[0..1]` после нормализации (§9.4).

| Drill | typeSpecific компоненты | Что усложняет |
|---|---|---|
| `count-attackers` | `answerValue` (1..4), `hasBattery` (Q-R / R-R на одной линии), `sliderDepth` (макс расстояние slider-атаки) | value=4 + battery + дальние slider'ы через всю доску |
| `find-loose-piece` | `crowdedSquares`, `nearLooseCount` (фигуры противника с защитниками=1, нападающими=0), `pieceValue` цели | low-value loose в плотном окружении среди near-loose distractors |
| `find-hanging-piece` | `nearHangingCount` (фигуры с равным обменом TP=1=defenders), `attackerType` (пешка → easy, конь по диагонали → hard), `pieceValue` цели | hanging низкой ценности рядом с равно-обменными целями высокой ценности |
| `find-all-checks` | `N` (число checking squares), `knightChecksRatio` (доля коневых шахов — конёвые сложнее видеть в плотных позициях), `discoveredCheckCount` | большое N (5+) с преобладанием коневых и наличием discovered |
| `find-pin` | `geometryDepth` (1..7), `pinnerType` (Q vs R vs B), `pinnedValue`, `cross-rays` (число фигур не относящихся к связке на той же линии) | длинная диагональ, ферзь связывает, на линии лежат другие фигуры |
| `find-fork` | `targetsValueSum` (Σ ценности атакуемых: Q+R=14 крупная, B+N=6 мелкая), `forkerType` (knight базовая, B/Q сложнее), `targetsDistance` для slider-вилок | мелкая вилка слоном/ферзём с разнесёнными целями |
| `find-mate-in-one-square` | `mateType` enum нормированный: `back-rank` (0.10) → `simple-queen-touch` (0.20) → `discovered-mate` (0.50) → `pawn-promote-mate` (0.60) → `double-check-mate` (0.70) → `sac-mate` (0.80) → `smothered-mate` (0.95) | smothered, sac-mate, double-check |
| `find-undefended-attack` | `attackerPieceType` (slider vs jumper), `attackDistance` (1..7), `attackingMoveType` (тихий / взятие / с темпом), `nearTargetCount` | дальняя slider-атака после тихого хода рядом с другими незащищёнными |

Точные веса компонент внутри `typeSpecific` — зона ответственности backend в KS-DRILL-INDEXER. Каждая компонента нормализуется в `[0..1]` независимо, итоговый `typeSpecific` = средневзвешенная сумма с локальными весами (например для `find-mate-in-one-square`: `0.7 · mateType + 0.3 · materialBalance`).

### 9.4 Нормализации в `[0..1]`

| Фактор | Mapping |
|---|---|
| `f_pieceCount` | ≤10 → 0.10 · 11–16 → 0.30 · 17–22 → 0.60 · 23–28 → 0.85 · ≥29 → 1.00 |
| `f_attackerDensity` (Σatks/occupied) | <0.4 → 0.10 · 0.4–0.8 → 0.30 · 0.8–1.3 → 0.60 · 1.3–1.8 → 0.85 · ≥1.8 → 1.00 |
| `f_distractorCount` | 0 → 0.00 · 1–2 → 0.30 · 3–4 → 0.60 · ≥5 → 0.90 |
| `f_materialBalance` (|diff| pawn units) | 0–1 → 1.00 · 1–3 → 0.60 · 3–6 → 0.30 · ≥6 → 0.10 |
| `f_mobilityRatio` | <0.5 → 0.20 · 0.5–1.5 → 1.00 · >1.5 → 0.40 |
| `f_typeSpecific` | per-drill-type — формулы из §9.3, нормировать в `[0..1]` |

Mapping использует step-function (не интерполяцию). Это упрощает unit-тесты на пограничных значениях и даёт стабильные bucket-границы.

### 9.5 Полная формула (target-state)

```
difficulty(drill_type, position) =
    w_pc · f_pieceCount(position)
  + w_ad · f_attackerDensity(position)
  + w_dc · f_distractorCount(drill_type, position)
  + w_ts · f_typeSpecific(drill_type, position)
  + 0.05 · f_materialBalance(position)
  + 0.05 · f_mobilityRatio(position)
```

Сумма основных весов: `w_pc + w_ad + w_dc + w_ts = 0.90`. Константные `0.05 + 0.05 = 0.10` для `materialBalance` и `mobilityRatio`. Итог `[0..1]`.

**Веса по drill-типу** (chess-expert KS-2223 #7935 §C):

| Drill | w_pc | w_ad | w_dc | w_ts |
|---|---|---|---|---|
| `count-attackers` | 0.15 | 0.30 | 0.05 | 0.40 |
| `find-loose-piece` | 0.25 | 0.15 | 0.40 | 0.10 |
| `find-hanging-piece` | 0.20 | 0.25 | 0.30 | 0.15 |
| `find-all-checks` | 0.15 | 0.20 | 0.10 | 0.45 |
| `find-pin` | 0.15 | 0.20 | 0.15 | 0.40 |
| `find-fork` | 0.15 | 0.30 | 0.15 | 0.30 |
| `find-mate-in-one-square` | 0.10 | 0.20 | 0.15 | 0.45 |
| `find-undefended-attack` | 0.25 | 0.20 | 0.20 | 0.25 |

Закономерности весов:
- `find-mate-in-one-square` / `find-all-checks` / `find-pin` / `count-attackers` имеют высокий `w_ts` (≥0.40) — сложность определяется типом паттерна, не только плотностью.
- `find-loose-piece` имеет высокий `w_dc` (0.40) — distractor (количество near-loose фигур) — главный фактор.
- `find-undefended-attack` сбалансирован (0.25 / 0.20 / 0.20 / 0.25) — самый «универсальный» drill, все факторы одинаково важны.

### 9.6 Bucket-cuts (cold start)

| Bucket | Total range | Целевая аудитория |
|---|---|---|
| 1 | `< 0.20` | Новичок (≤1000 ELO) |
| 2 | `0.20 ≤ x < 0.35` | Базовый (1000–1300) |
| 3 | `0.35 ≤ x < 0.55` | Средний (1300–1600) |
| 4 | `0.55 ≤ x < 0.75` | Продвинутый (1600–1900) |
| 5 | `≥ 0.75` | Мастер-кандидат (1900+) |

Cuts фиксированы при cold-start — **не пропорциональные 20%-бакеты**. Bucket 5 имеет право быть редким (5–10% от пула задач), bucket 1 — толстым (~25%). Это отражает реальное распределение сложности в TWIC-партиях, а не искусственное «равенство».

### 9.7 Минимальная версия для v1 (стартовая реализация в KS-DRILL-INDEXER)

Полная формула с `typeSpecific` для 8 drill требует значительной работы по предикатам (`hasBattery`, `mateType`, `cross-rays`, ...). Чтобы не блокировать v1 на эту работу — стартовая реализация:

```
difficulty_v1(drill_type, position) =
    0.30 · f_pieceCount(position)
  + 0.30 · f_attackerDensity(position)
  + 0.40 · f_typeSpecific_v1(drill_type, position)
```

`f_typeSpecific_v1` — упрощённая версия per-drill:

| Drill | typeSpecific_v1 |
|---|---|
| `count-attackers` | `f_answerValue` (1→0, 2→0.33, 3→0.66, 4→1.0) |
| `find-loose-piece` | `f_distractorCount` (только near-loose) |
| `find-hanging-piece` | `f_distractorCount` (только equal-exchange) |
| `find-all-checks` | `f_N` (N=2→0.2, N=3→0.4, N=4→0.6, N=5→0.8, N≥6→1.0) |
| `find-pin` | `f_geometryDepth` (depth/7 нормализация) |
| `find-fork` | `f_targetsValueSum` (≤6→0.3, 7-10→0.6, ≥11→1.0) |
| `find-mate-in-one-square` | `f_mateType` enum (см. §9.3) |
| `find-undefended-attack` | `f_attackDistance` (1→0.2, 2-3→0.5, ≥4→1.0) |

Bucket-cuts остаются те же (§9.6) — формула возвращает `[0..1]` и в обоих версиях.

**Триггер перехода на полную формулу:** ≥5000 решений per drill-type. До этого — v1.

### 9.8 Калибровка

После первых **5000 решений per drill-type** замеряем solve-rate by bucket:

| Bucket | Целевой solve-rate |
|---|---|
| 1 | ≥ 90% |
| 2 | 75–90% |
| 3 | 55–75% |
| 4 | 35–55% |
| 5 | ≤ 35% |

При отклонении > 10% от target — **двигаем bucket-cuts** (`0.20` / `0.35` / `0.55` / `0.75`), не веса.

Веса (`w_pc`/`w_ad`/`w_dc`/`w_ts`) трогаем **только** при системном перекосе на нескольких drill-типах одновременно — это сигнал что выбранные факторы не отражают сложность.

**НЕ калибровать через равномерное 20% на bucket** — это исказит сложность под распределение задач, а не под их трудность. Bucket 5 имеет право быть редким.

### 9.9 Что НЕ в формулу

| Фактор | Почему исключаем |
|---|---|
| **Stockfish eval** | Меряет качество позиции, не сложность drill-задачи. Drill с +5.0 eval может быть сложным `find-pin`. Eval иррелевантен для «насколько трудно увидеть паттерн» |
| **Open vs closed позиции** | Шахматная классификация типа позиции, не drill-сложности. Закрытая позиция не делает `find-loose-piece` сложнее |
| **Theme tags из puzzle-источника** | Используются для отбора (какие позиции подходят под drill-тип), не для сложности. Позиция с темой `mateIn1` может содержать тривиальный fork |
| **Ply из исходной партии** | Кандидат из ADR §3.3 — отбрасывается. Ply ничего не говорит о сложности drill: позиция на ply=10 может быть проще позиции на ply=40. Через `pieceCount` уже косвенно отражено |
| **Рейтинги игроков партии-источника** | Иррелевантно — drill вырван из контекста партии |
| **Время на решение пользователем** | Метрика результата, не входной параметр. Используется в калибровке (solve-rate by time), не в формуле |
| **User success-rate / cumulative skill** | User-side контекст для рекомендаций (что показывать), не позиционная сложность. Сложность позиции — статичный атрибут |

ADR-035 §3.3 содержал кандидатов «ply, pieceCount, distractor-count». Из них `pieceCount` остался, `distractor-count` мутировал в `distractorCount` per-type, `ply` отброшен.

### 9.10 Pseudocode для backend (KS-DRILL-INDEXER)

```ts
type DrillFactors = {
  pieceCount: number;        // [0..1]
  attackerDensity: number;   // [0..1]
  distractorCount: number;   // [0..1]
  materialBalance: number;   // [0..1]
  mobilityRatio: number;     // [0..1]
  typeSpecific: number;      // [0..1]
};

const WEIGHTS_FULL: Record<TacticDrillType, { pc: number; ad: number; dc: number; ts: number }> = {
  'count-attackers':         { pc: 0.15, ad: 0.30, dc: 0.05, ts: 0.40 },
  'find-loose-piece':        { pc: 0.25, ad: 0.15, dc: 0.40, ts: 0.10 },
  'find-hanging-piece':      { pc: 0.20, ad: 0.25, dc: 0.30, ts: 0.15 },
  'find-all-checks':         { pc: 0.15, ad: 0.20, dc: 0.10, ts: 0.45 },
  'find-pin':                { pc: 0.15, ad: 0.20, dc: 0.15, ts: 0.40 },
  'find-fork':               { pc: 0.15, ad: 0.30, dc: 0.15, ts: 0.30 },
  'find-mate-in-one-square': { pc: 0.10, ad: 0.20, dc: 0.15, ts: 0.45 },
  'find-undefended-attack':  { pc: 0.25, ad: 0.20, dc: 0.20, ts: 0.25 },
};

function computeDifficulty(
  drillType: TacticDrillType,
  factors: DrillFactors,
  version: 'v1' | 'full' = 'v1',
): number {
  let total: number;
  if (version === 'v1') {
    total =
      0.30 * factors.pieceCount +
      0.30 * factors.attackerDensity +
      0.40 * factors.typeSpecific;
  } else {
    const w = WEIGHTS_FULL[drillType];
    total =
      w.pc * factors.pieceCount +
      w.ad * factors.attackerDensity +
      w.dc * factors.distractorCount +
      w.ts * factors.typeSpecific +
      0.05 * factors.materialBalance +
      0.05 * factors.mobilityRatio;
  }
  // Bucket cuts (§9.6).
  if (total < 0.20) return 1;
  if (total < 0.35) return 2;
  if (total < 0.55) return 3;
  if (total < 0.75) return 4;
  return 5;
}
```

`computeDifficulty` запускается на этапе INSERT в `tactic_drills.difficulty`. Версия `v1` или `full` определяется флагом `process.env.TACTIC_DRILL_DIFFICULTY_VERSION` (default: `v1`).

При смене версии — **переиндексация всех существующих задач** (`UPDATE tactic_drills SET difficulty = ...`). Это разовое действие после калибровки на 5000 сессий.

### 9.11 Связь с другими разделами

- §6 (threshold IoU 0.7 для `squares[]`) — независимая ось. IoU решает «решено или нет», difficulty — «к какому уровню относится задача». Не путать.
- §6.3 (распределение N=2-3/3-5/5-7) — это упрощённая «сложность» для shape='squares' специально для UI lobby. После перехода на полную формулу — `f_typeSpecific` для `find-all-checks` инкорпорирует N как один из факторов, шкала N→difficulty восстанавливается через `f_N`.
- §4 (порядок прохождения) — drill-типы сортируются по слою и педагогической последовательности. Difficulty — внутри одного типа, сортирует **позиции**.

### 9.12 Acceptance для KS-DRILL-INDEXER

- [ ] Реализовать `computeDifficulty` с обоими режимами (`v1` / `full`).
- [ ] `f_pieceCount`, `f_attackerDensity`, `f_distractorCount`, `f_materialBalance`, `f_mobilityRatio` — общие, юнит-тесты на mapping (§9.4).
- [ ] `f_typeSpecific_v1` для всех 8 drill (§9.7).
- [ ] `f_typeSpecific_full` для всех 8 drill — отдельный тикет, не блокирующий v1.
- [ ] CLI-флаг `--difficulty-version=v1|full` для индексера, default `v1`.
- [ ] При indexing — записывать `difficulty` integer 1..5 в `tactic_drills.difficulty`.
- [ ] Юнит-тесты на bucket-cuts (boundary: 0.19999, 0.20000, 0.34999, ...).

---

## 10. Связанные документы и тикеты

### Документация
- [ADR-035](../adr/035-tactical-pattern-drills.md) — основной ADR (каталог, схема данных, UX, архитектура).
- (этот документ) — методика E0 (KS-2223) + формула сложности E1 (KS-2225, §9 выше).
- [tactical-drill-api-contract.md](./tactical-drill-api-contract.md) — детальный API-контракт + спецификация валидатора (KS-2224, E1).

### Тикеты, разблокированные этим документом
- **KS-2224** ✅ (KS-DRILL-DESIGN, architect) — детальный API-контракт. Закрыто, см. [tactical-drill-api-contract.md](./tactical-drill-api-contract.md).
- **KS-2225** ✅ (KS-DRILL-DIFFICULTY, architect + chess-expert) — формула сложности. Закрыто, §9 этого документа.
- **KS-DRILL-PREDICATES** (backend, E2) — реализация 8 предикатов на chess.js.
- **KS-DRILL-INDEXER** (backend, E2) — pipeline индексации архива + computeDifficulty (§9.10).
- **KS-DRILL-LOBBY** (frontend, E3) — порядок прохождения из §4 в UI.
- **KS-DRILL-I18N** (frontend, E3) — финальные RU/EN строки из §3 + локализация фигур из §7.

### Метрики для пересмотра
- pass-rate per drill-type (для §6.4 threshold review),
- drop-off rate per drill-type (для §6.4 N-distribution review),
- N-распределение в реальных позициях (для §6.3 уточнения уровней сложности),
- solve-rate by bucket (для §9.8 difficulty-калибровки после 5000 решений per drill-type).

Метрики собираются с первого релиза, первый review — после 1000 сессий на каждом drill-type для §6.4, после 5000 для §9.8 (отдельные тикеты, не блокирующие).
