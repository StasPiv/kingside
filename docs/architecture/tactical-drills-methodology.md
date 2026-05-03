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

### 2.3 Канонические инварианты предикатов (KS-2313, KS-2320)

Зафиксированы в ADR-035 §2.2.1 после пилота KS-2246 / KS-2312. Краткая сводка для chess-expert и backend (детали — в ADR):

- **Король = защитник** через `chess.attackers()` для `find-hanging-piece`, `find-loose-piece`, `find-undefended-attack`. Фигура рядом с королём противника — не считается hanging/loose. Сам король никогда не цель.
- **Пешки** — полноценные loose-кандидаты в `find-loose-piece` (без исключения по типу).
- **`find-all-checks` инварианты**: `2 ≤ |unique to| ≤ 7` + drop позиций с мат-в-1 (уходят в `find-mate-in-one-square`).
- **Canonical answer rule** для всех 8 предикатов: strict-uniqueness — позиция с > 1 валидным ответом **отбрасывается**, никакого выбора среди многих. Уровень сравнения зависит от answer-shape: для `move` — по полной паре `(from, to)` (см. ADR §2.2.1(d)).
- **`find-mate-in-one-square` — `move`, не `square`** (KS-2320, отмена KS-2223 §8.3). UX-аргумент: пользователь ожидает «сделать ход», не клик по клетке. Strict-uniqueness переносится с `to`-клетки на полную пару `(from, to)`. См. §8.3 (revised).

**Source of truth** для определений — код в `apps/api/src/tactic-drill/predicates/` (KS-2227). Любое изменение предиката требует синхронной правки ADR-035 §2.1 / §2.2.1 и этого раздела.

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

> ⚠️ **REVISED в KS-2320.** Решение «strictly `square`» отменено по фидбеку пользователя. Финальный формат — **`move` (from + to)**. См. §8.3-rev ниже и ADR-035 §2.2.1(e).

**Было (KS-2223 §8.3):**
> `square` (to-клетка) **строго**. Генератор отбрасывает позиции, где две разные фигуры могут поставить мат на одну `to`-клетку (редкий случай в реальных партиях). Fallback на `move` отменён — упрощает UI и единообразит answer-shape

**Стало (KS-2320):**
> **`move` (from + to).** Strict-uniqueness drop работает по полной паре `(from, to)`. Позиция, где две разные фигуры дают мат на одну `to`-клетку — drop. Frontend handler shape='move' (drag + click-click) уже доступен (KS-2318).

Обоснование revision'а: пользовательский фидбек после пилота KS-2246 показал, что клик по клетке-куда-ставится-мат **не интуитивен** — пользователь ожидает «сделать ход», как в обычных мат-пазлах. UX «нажми клетку без указания фигуры» воспринимается как неполный ввод. Аргумент KS-2223 §8.3 «упрощает UI и единообразит answer-shape» в реальном использовании оказался слабее, чем UX-ожидание ход = drag/click-click.

Цена перехода:
- сужение банка: позиции с >1 матующих ходов на одну `to`-клетку (раньше допустимы) теперь drop. На практике редко (несколько процентов pool'а).
- backend predicate уже технически хранит пары `(from, to)` — изменение пятистрочное (см. KS-2320 downstream).
- frontend без изменений (shape='move' handler через KS-2318 общий с `find-undefended-attack`).

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

## 10. Drill rating: формула пользовательского рейтинга

**Источник:** ADR-035 §3.4, R7 в §10. Этот раздел — финальный design в рамках KS-2248 (E6). Реализация — отдельный тикет на backend (KS-DRILL-RATING).

### 10.1 Назначение и решение по архитектуре

После накопления данных за E4 (sprint mode на проде, KS-2240) у нас есть распределение accuracy / time per drill-type. Можно ввести **drill rating** — единое число, показывающее силу юзера в drill'ах. Цели:

- **Мотивация** — игрок видит прогресс, не только raw-метрики (`accuracy=72%`).
- **Selection** — backend подбирает drill уровня sweet-spot (`drillRating ± 100`).
- **Leaderboard** — конкуренция по rating'у параллельно sprint-leaderboard'у (KS-2240).

Решение: **Glicko-1, по образцу puzzle**, с расширением outcome из binary в continuous для shape='squares'.

### 10.2 Анализ вариантов

| Вариант | Плюсы | Минусы | Решение |
|---|---|---|---|
| **A. Glicko-1 (как у Puzzle)** | Готовый сервис `GlickoRatingService`. Знаком backend. Корректно учитывает RD (новый юзер = большой RD = быстрый approach к реальной силе) | Binary outcome ≠ IoU для shape='squares' | **Принято с расширением** continuous-outcome (см. §10.5) |
| B. Glicko-2 | Точнее (volatility, system constant τ) | Лишний движок в проекте, gain маргинальный для drill | Отвергнуто |
| C. Elo на пары «юзер vs avg drill rating» | Простой; одна формула | Без RD не учитывает нестабильность нового юзера; сильное колебание у новичков | Отвергнуто — у Glicko есть RD «бесплатно» |
| D. Свой scheme (фиксированные награды по bucket'ам, +1..+12) | Совсем простой | Не зависит от текущего рейтинга юзера → стабильно фармится через лёгкие drill'ы. Анти-педагогично | Отвергнуто |

**Принято: Glicko-1 (вариант A) с continuous-outcome для shape='squares'.**

### 10.3 Drill rating — фиксированный по bucket

Каждой задаче `tactic_drills.rating` присваивается **фиксированный** рейтинг при INSERT, в зависимости от `difficulty` (KS-2225 §9):

| Bucket (difficulty) | Drill rating | Целевая аудитория (методика §9.6) |
|---|---|---|
| 1 | 1000 | Новичок (≤1000 ELO) |
| 2 | 1300 | Базовый (1000–1300) |
| 3 | 1500 | Средний (1300–1600) |
| 4 | 1700 | Продвинутый (1600–1900) |
| 5 | 2000 | Мастер-кандидат (1900+) |

Drill RD (rating deviation) фиксирован = **50** (стабильный «оппонент»). Это означает: рейтинг задачи **не обновляется** на основе попыток. Иначе:
- Лёгкие drill'и со временем «разносятся» (rating растёт с каждой сданной попыткой) → юзер не получает roughly-fixed challenge.
- В Puzzle drift'а нет благодаря двухсторонним updates (если задача fails → её rating растёт), но drill — массовая короткая практика; drift искажает шкалу за недели.

Преимущества фиксированного drill rating:
- предсказуемая шкала «новичок 1000 → мастер 2000»,
- легко калибровать пересмотром bucket→rating mapping (§10.10),
- backend не делает write на `tactic_drills.rating` после indexing.

### 10.4 User rating — Glicko-1 (по образцу puzzle)

Новые поля в `User`:
```
ratingDrill          Int @default(1500) @map("rating_drill")
ratingDrillDev       Int @default(350)  @map("rating_drill_dev")
```

Дефолты соответствуют Glicko-2 cold-start у Puzzle (1500 / 350). После 5–10 решений RD упадёт до ~80–120, рейтинг стабилизируется.

**Per-drill-type breakdown** — храним отдельно как `accuracy/avgTime` per type (уже есть в `tactic_drill_attempts` aggregations, см. KS-2224 §2 `TacticDrillStatsItem`). **Один общий drill-rating** (не 8 отдельных) — для:
- простоты UI («Drill rating: 1620», без 8 чисел),
- мотивационной consistency (один growth curve, не 8 параллельных),
- корректной шкалы Glicko (не нужно 8 наборов RD).

Юзер с уклоном (силён в `find-pin`, слаб в `find-fork`) видит это в **per-type accuracy breakdown**, не в rating.

### 10.5 Outcome для Glicko-1: binary + continuous (IoU)

Существующий `GlickoRatingService.updateUserRating(userR, userRD, drillR, drillRD, solved: boolean)` принимает binary. Для drill расширяем:

```ts
// Расширение существующего сервиса (backend, KS-DRILL-RATING):
updateUserRatingContinuous(
  userRating: number,
  userRD: number,
  opponentRating: number,
  opponentRD: number,
  score: number,           // [0..1] вместо boolean
): { newRating: number; newRD: number };
```

Реализация — копия `updateUserRating`, но `userScore = score` вместо `userScore = solved ? 1 : 0`. Glicko-1 формула одинаковая, score просто [0..1] вместо {0,1} — math работает (см. Glickman 1995, Appendix B).

**Mapping outcome по answer-shape** (см. KS-2224 §3 для shape definitions):

| shape | outcome | Источник |
|---|---|---|
| `square` | `1.0` если solved, `0.0` иначе | `attempt.solved` |
| `number` | `1.0` если solved, `0.0` иначе | `attempt.solved` |
| `move` | `1.0` если solved, `0.0` иначе | `attempt.solved` |
| `squares` | **IoU как continuous** (`metrics.iou` из §6) | `attempt.metrics.iou` |

Для `squares` IoU 0.7 = «решено» (порог из §6.2), но в Glicko-update идёт само значение IoU, а не binary. Это даёт частичную награду за «почти решил» (например IoU=0.65 → score=0.65 → small positive update против expected ≈0.5 — сегмент growth).

### 10.6 Drill mode vs Sprint mode

**Sprint mode НЕ влияет на `User.ratingDrill`.** Только drill mode.

Обоснование:
- Sprint = тренировка скорости + смешанные типы. 30+ задач за 3 минуты.
- Если каждая задача обновляет `ratingDrill` → за один sprint можно нагнать +50..+200 рейтинга → накачка через лёгкие задачи в sprint pool.
- Cooldown 30 дней не работает в sprint pool'е (там pool other than user's drill-mode pool).
- Sprint имеет **собственный** leaderboard через `tactic_drill_sprint_scores.score` (KS-2240) — отдельная метрика «лучший спринт-результат».

Итог:
- `ratingDrill` обновляется только при `attempt.mode === 'drill'`.
- `attempt.mode === 'sprint'` → попытка пишется в `tactic_drill_attempts` для статистики, но без rating-update.
- `attempt.mode === 'lessons-embed'` (v2.x) → пока без rating-update; пересмотрим когда подключим.

### 10.7 Anti-farming

Многоуровневая защита.

**1. Cooldown на повторение** (existing, methodology §3.2):
- per-user 30 дней — задача не выдаётся тому же юзеру повторно.
- Жёстко обеспечивается на этапе `GET /tactic-drill/next` (фильтр через `tactic_drill_attempts.created_at`).

**2. Daily cap на rating-change**:
- Максимум **+50** rating points в drill mode за 24 часа (UTC). После cap — clamp (`newRating - oldRating ≤ remainingCap`). Фактический update в Glicko-формуле проводится **полностью**, но запись в БД ограничивается cap'ом (отрицательные изменения не cap'аются — потеря рейтинга нормально, накачка ограничивается).

**3. Burst-detection**:
- Если юзер сделал >30 attempts одного drill-type за 1 час → K-factor (RD-effect) ослабляется в 3 раза на оставшийся час.
- Реализация: Redis counter `drill_burst:<userId>:<drillType>:<hourBucket>`. Backend перед вызовом `updateUserRatingContinuous` читает counter, при превышении — умножает результат на 0.33 (фактически ослабляет gain).

**4. Test-account / hidden юзеры**:
- `User.isHidden=true` или `User.isTestAccount=true` → **rating не обновляется**, юзер не виден в leaderboard.
- Это уже сделано в KS-2256 (фильтрация во всех публичных endpoints) — расширяется на drill-rating leaderboard в §10.9.

**5. Glicko RD-самозащита**:
- Когда юзер только начал, RD высокий (350). Изменения большие.
- После 5–10 попыток RD падает до ~100. Дальнейшие изменения медленнее.
- Нет нужды в дополнительном «delta-cap on per-attempt» — Glicko сам это делает.

### 10.8 Bootstrap (новый юзер)

Стандартные Glicko-1 параметры:
- `ratingDrill = 1500` (центр шкалы)
- `ratingDrillDev = 350` (high uncertainty)

После первых 5–10 попыток:
- `ratingDrillDev` падает до 100–150,
- `ratingDrill` сходится к зоне реальной силы.

Если юзер уже играет в puzzles и имеет `ratingPuzzle=1700`, можно ли «угадать» его drill-rating? **Нет, не делаем.** Drill — отдельный навык; начинаем с дефолтов. Это безопаснее: если puzzle-rating искусственно завышен через специфические паттерны, drill-rating не унаследует ошибку.

### 10.9 Leaderboard

Два **независимых** leaderboard'а:

| Leaderboard | Источник | Сортировка |
|---|---|---|
| **Drill rating leaderboard** *(новый, KS-DRILL-RATING)* | `User.ratingDrill` | DESC, фильтр `isHidden=false` |
| **Sprint score leaderboard** *(existing, KS-2240)* | `tactic_drill_sprint_scores.score` | DESC, по `mode` |

Endpoint:
```
GET /api/tactic-drill/rating/leaderboard?limit=100
Response 200: { entries: [{ userId, username, ratingDrill, ratingDrillDev }], myRank?, myEntry? }
```

Минимум попыток для попадания в leaderboard — **20** (provisional). До 20 попыток `ratingDrillDev > 150` → юзер не попадает в топ. Это снимает шумы первых попыток у новичков.

### 10.10 Калибровка

После **первых 5000 attempts per bucket** (один раз на каждом из 5 bucket'ов):

1. Для каждого bucket замерить **актуальный win-rate** юзеров с `ratingDrill ≈ bucketRating ± 50`. Если bucket-rating честный, win-rate должен быть ≈ 50%.
2. Если win-rate систематически > 60% или < 40% → пересмотреть `BUCKET_TO_RATING` mapping (§10.3) на ±100..200.

Калибровка **двигает bucket→rating mapping**, не Glicko-параметры. Glicko (Q, MIN_RD) — стандартные (Glickman 1995), не трогаем.

Сигналы для пересмотра:
- **bucket 1 win-rate < 70%** → 1000 завышено, понизить до 800.
- **bucket 5 win-rate > 30%** → 2000 занижено, поднять до 2200.

Калибровка — отдельный мониторинг-тикет (не блокирующий, после 5000 attempts/bucket).

### 10.11 Pseudocode

```ts
const BUCKET_TO_RATING: Record<1|2|3|4|5, number> = {
  1: 1000, 2: 1300, 3: 1500, 4: 1700, 5: 2000,
};
const DRILL_RD = 50;
const DAILY_CAP_DRILL = 50;
const BURST_LIMIT = 30; // per drill-type per hour
const BURST_PENALTY = 0.33;
const LEADERBOARD_MIN_ATTEMPTS = 20;

async function applyDrillRatingChange(
  userId: string,
  drillId: string,
  attempt: TacticDrillAttempt,
): Promise<{ before: number; after: number; capped: boolean } | null> {
  // §10.6: только drill mode влияет на rating.
  if (attempt.mode !== 'drill') return null;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { ratingDrill: true, ratingDrillDev: true, isHidden: true, isTestAccount: true },
  });

  // §10.7: hidden/test юзеры не накачивают rating.
  if (user.isHidden || user.isTestAccount) return null;

  const drill = await prisma.tacticDrill.findUniqueOrThrow({
    where: { id: drillId },
    select: { difficulty: true, drillType: true },
  });

  const drillRating = BUCKET_TO_RATING[drill.difficulty as 1|2|3|4|5];

  // §10.5: outcome — IoU для squares, binary для остальных.
  const score: number =
    attempt.userAnswer.shape === 'squares'
      ? attempt.metrics?.iou ?? 0
      : (attempt.solved ? 1.0 : 0.0);

  // §10.7 burst-detection.
  const burstKey = `drill_burst:${userId}:${drill.drillType}:${currentHourBucket()}`;
  const burstCount = await redis.incr(burstKey);
  if (burstCount === 1) await redis.expire(burstKey, 3600);
  const burstPenaltyMul = burstCount > BURST_LIMIT ? BURST_PENALTY : 1.0;

  // Glicko-1 update (continuous outcome).
  const update = glicko.updateUserRatingContinuous(
    user.ratingDrill, user.ratingDrillDev,
    drillRating, DRILL_RD,
    score,
  );
  let proposedDelta = update.newRating - user.ratingDrill;
  proposedDelta = Math.round(proposedDelta * burstPenaltyMul);

  // §10.7 daily cap (positive only — потеря рейтинга не cap'ается).
  let capped = false;
  if (proposedDelta > 0) {
    const dailyChange = await getUserDailyRatingChange(userId, 'drill');
    const remainingCap = DAILY_CAP_DRILL - dailyChange;
    if (remainingCap <= 0) {
      proposedDelta = 0;
      capped = true;
    } else if (proposedDelta > remainingCap) {
      proposedDelta = remainingCap;
      capped = true;
    }
  }

  const finalRating = user.ratingDrill + proposedDelta;
  const finalRD = update.newRD; // RD-update не cap'ается.

  await prisma.user.update({
    where: { id: userId },
    data: { ratingDrill: finalRating, ratingDrillDev: finalRD },
  });

  return { before: user.ratingDrill, after: finalRating, capped };
}
```

`getUserDailyRatingChange(userId, scope)` — sum of `ratingAfter - ratingBefore` за последние 24 часа из `tactic_drill_attempts` (если хранить delta) или вычислять через `tactic_drill_rating_snapshot` (отдельная таблица per-day, по аналогии с `puzzle_rating_snapshots`).

### 10.12 Schema-изменения для backend (KS-DRILL-RATING)

```prisma
model User {
  // ...existing...
  ratingDrill    Int @default(1500) @map("rating_drill")
  ratingDrillDev Int @default(350)  @map("rating_drill_dev")
}

model TacticDrill {
  // ...existing...
  rating Int @default(1500) // computed from difficulty at INSERT
  // ratingDev не нужно — фиксированный 50 в коде
}

model TacticDrillAttempt {
  // ...existing fields из KS-2224...
  ratingBefore Int? @map("rating_before")  // user rating до попытки
  ratingAfter  Int? @map("rating_after")   // после
  capped       Boolean @default(false)     // достигнут ли daily cap
}

// Опционально (по аналогии с puzzle_rating_snapshots):
model TacticDrillRatingSnapshot {
  userId  String   @map("user_id") @db.Uuid
  date    DateTime @db.Date
  rating  Int
  attempts Int @default(0)
  solved   Int @default(0)

  @@id([userId, date])
  @@map("tactic_drill_rating_snapshots")
}
```

Migration:
- `User.ratingDrill / ratingDrillDev` — добавить с дефолтами.
- `TacticDrill.rating` — добавить, BACKFILL: `UPDATE tactic_drills SET rating = bucket_to_rating(difficulty)` (single SQL).
- `TacticDrillAttempt.ratingBefore/ratingAfter/capped` — добавить (nullable; старые попытки без rating).
- `TacticDrillRatingSnapshot` — создать.

### 10.13 Acceptance для backend (KS-DRILL-RATING)

Acceptance — будущий тикет KS-DRILL-RATING. Чек-лист:

- [ ] Schema migration по §10.12.
- [ ] `BUCKET_TO_RATING` константа в `apps/api/src/tactic-drill/`.
- [ ] Расширить `GlickoRatingService` методом `updateUserRatingContinuous(userRating, userRD, opponentRating, opponentRD, score: number)`.
- [ ] `TacticDrillRatingService.applyRatingChange(userId, drillId, attempt)` по §10.11.
- [ ] Anti-farming: cooldown (existing), daily cap (§10.7-2), burst-detection через Redis (§10.7-3).
- [ ] Endpoint `GET /api/tactic-drill/rating/leaderboard?limit=100` (§10.9). Фильтр `isHidden=false`. Min-attempts 20.
- [ ] Sprint-флоу не вызывает `applyRatingChange` (§10.6).
- [ ] Snapshot per-day для history (опционально v2 — поле `TacticDrillRatingSnapshot`).
- [ ] Юнит-тесты:
  - Glicko continuous outcome (score=0.7 на новичке RD=350) даёт +X rating.
  - Daily cap: после +50 за день — следующая успешная попытка даёт 0.
  - Burst-detection: после 30 attempts/час одного типа — gain × 0.33.
  - Hidden юзер: rating не обновляется.
  - Sprint mode: rating не обновляется.

### 10.14 Связь с другими разделами

- §6 (IoU 0.7 threshold) — служит **бинарной метрикой «решено»** для UI feedback. Для Glicko используется **сырое IoU** (continuous), без threshold (см. §10.5).
- §9 (difficulty 1..5) — input для `BUCKET_TO_RATING`. Калибровка difficulty (§9.8) и калибровка drill-rating (§10.10) — **независимы**: §9.8 двигает bucket-cuts (что считать bucket=3), §10.10 двигает bucket→rating mapping (какому ELO соответствует bucket=3).

### 10.15 Что **не** входит в этот дизайн

- **Сезонность** (drill-rating reset раз в N месяцев) — выходит за scope. Если в v3 захотим — добавим `User.ratingDrillSeason` рядом с `ratingDrill`.
- **Анти-чит на уровне поведенческих сигналов** (мышь не двигается, paste-detection) — это generic anti-bot, не специфика drill rating'а.
- **Rating decay** (RD растёт со временем без активности) — Glicko-1 не делает этого автоматически. В v2 рассмотрим, если будет жалоба «inactive юзер с rating 2000 первый в leaderboard».
- **Pairwise duels** «решить ту же позицию что соперник» — это другой режим, не drill v1.
- **Per-type rating** (8 отдельных рейтингов) — отвергнуто в §10.4. Если backend по итогам v2 решит, что один rating плохо отражает skill — пересмотрим, но это другая story.

---

## 11. Связанные документы и тикеты

### Документация
- [ADR-035](../adr/035-tactical-pattern-drills.md) — основной ADR (каталог, схема данных, UX, архитектура).
- (этот документ) — методика E0 (KS-2223) + формула сложности E1 (KS-2225, §9) + рейтинговая формула E6 (KS-2248, §10).
- [tactical-drill-api-contract.md](./tactical-drill-api-contract.md) — детальный API-контракт + спецификация валидатора (KS-2224, E1).

### Тикеты, разблокированные этим документом
- **KS-2224** ✅ (KS-DRILL-DESIGN, architect) — детальный API-контракт. Закрыто, см. [tactical-drill-api-contract.md](./tactical-drill-api-contract.md).
- **KS-2225** ✅ (KS-DRILL-DIFFICULTY, architect + chess-expert) — формула сложности. Закрыто, §9 этого документа.
- **KS-2248** ✅ (этот раздел §10) — design рейтинговой формулы. После approval — backend KS-DRILL-RATING на реализацию.
- **KS-DRILL-PREDICATES** (backend, E2) — реализация 8 предикатов на chess.js.
- **KS-DRILL-INDEXER** (backend, E2) — pipeline индексации архива + computeDifficulty (§9.10).
- **KS-DRILL-RATING** (backend, E6) — реализация Glicko-update + daily cap + burst-detection + rating leaderboard. По §10.11–§10.13.
- **KS-DRILL-LOBBY** (frontend, E3) — порядок прохождения из §4 в UI.
- **KS-DRILL-I18N** (frontend, E3) — финальные RU/EN строки из §3 + локализация фигур из §7.

### Метрики для пересмотра
- pass-rate per drill-type (для §6.4 threshold review),
- drop-off rate per drill-type (для §6.4 N-distribution review),
- N-распределение в реальных позициях (для §6.3 уточнения уровней сложности),
- solve-rate by bucket (для §9.8 difficulty-калибровки после 5000 решений per drill-type),
- win-rate by bucket vs user-rating (для §10.10 rating-калибровки после 5000 attempts per bucket).

Метрики собираются с первого релиза, первый review — после 1000 сессий на каждом drill-type для §6.4, после 5000 для §9.8 и §10.10 (отдельные тикеты, не блокирующие).
