# Тренажёры (drills) — пользовательская документация

> Источник: KS-2412. Источник истины по семантике каждого drill — код в
> `apps/api/src/tactic-drill/predicates/*.ts` и контракты в
> `packages/shared/src/types/tactic-drill.ts` (а не описания из ADR-035 —
> там могут быть устаревшие формулировки). Если на UI текст разойдётся
> с этим документом — приоритет за predicate'ом.

Документ предназначен для:
- in-app help / tooltip / страница «Как работают тренажёры»;
- лендинг и SEO;
- i18n: длинные описания → `drills.typeDescriptions.<type>`, краткие
  названия → `drills.types.<type>`, формулировка задачи → `drills.instructions.<type>`.

Тексты идут в двух языках (RU + EN) подряд внутри каждой карточки.

---

## Что такое тренажёр (drill)

**RU.** Тренажёр — это короткое упражнение на одну позицию. Доска
показывается статично, никто не ходит за вас и за соперника. Ваша
задача — увидеть на ней один конкретный паттерн и ответить — кликом
по клетке, ходом фигуры, числом или набором клеток. Через долю
секунды после ответа доска сменяется на следующую: drill — упражнение
на скорость распознавания, а не на расчёт.

Сейчас в проде живут **7 типов тренажёров**, разделённых по слоям
навыка:

| Слой | Типы | Что развивает |
|---|---|---|
| Обзор доски (overview) | Сосчитать атакующих, Незащищённая фигура, Висящая фигура | Видеть, кто кого атакует и защищает |
| Распознавание паттернов (pattern) | Все шахи, Связка, Создать вилку | Узнавать тактические мотивы по форме |
| Расчёт (calculation) | Создать висящую фигуру | Считать на 1 ход вперёд |

Дополнительно есть **спринт** — микс drill'ов на 3 или 5 минут с
лидербордом, а также **ежедневный drill** в Telegram-боте.

**EN.** A drill is a short single-position exercise. The board is
static — neither you nor the opponent makes any moves of their own. Your
job is to spot one specific pattern and respond: click a square, make a
move, pick a number, or select a set of squares. The board switches to
the next position a fraction of a second after your answer — drills
train pattern recognition speed, not calculation depth.

Seven drill types currently live in production, grouped by skill layer:

| Layer | Types | What it trains |
|---|---|---|
| Board overview | Count attackers, Loose piece, Hanging piece | See who attacks and who defends what |
| Pattern recognition | All checks, Pin, Create a fork | Recognise tactical motifs by shape |
| Calculation | Create a hanging piece | Count one move ahead |

There's also a **sprint** mode — a mix of drills against a 3- or 5-minute
clock with leaderboards — and a **daily drill** delivered via Telegram bot.

---

## Как отвечать (общие форматы)

В коде это поле `answerShape` у задачи. От него зависит, как именно
вводится ответ в интерфейсе.

| `shape` | Используется в | UX ввода |
|---|---|---|
| `square` | Связка, Незащищённая фигура | Один клик по клетке-ответу. Submit идёт сразу. |
| `move` | Висящая фигура, Создать вилку, Создать висящую фигуру | Либо два клика (откуда → куда), либо drag фигуры мышью/пальцем. Submit после второго клика / отпускания. |
| `number` | Сосчитать атакующих | Кнопки «1», «2», «3», «4». |
| `squares` | Все шахи | Делайте на доске реальные ходы по очереди — каждый шах засчитывается, после него фигура автоматически возвращается на место. |

После ответа всплывает feedback-overlay: «Верно» / «Неверно». При
правильном ответе следующая позиция загружается мгновенно (drill на
скорость), при неверном — через ~1.5 секунды, чтобы успеть посмотреть
правильное решение, подсвеченное на доске зелёным. Если в системе включена
системная настройка «уменьшить движение» (`prefers-reduced-motion: reduce`),
переход всегда мгновенный — пользователь сам контролирует темп.

Кнопки «Назад» / «Вперёд» позволяют пройтись по последним 10 позициям
текущей сессии и пересмотреть свой ответ.

---

## Карточки drill-типов

### 1. Висящая фигура / Hanging piece

`find-hanging-piece`, shape: `move`, слой: overview.

#### RU

- **Название (UI):** Висящая фигура.
- **Одна фраза:** Возьмите незащищённую фигуру противника одним ходом.
- **Развёрнутое описание:** На доске стоит ровно одна фигура противника
  (не король), которую ваши фигуры атакуют, и при этом ни одна фигура
  её защитника не прикрывает. Такая фигура называется *висящей*. Ваша
  задача — найти её и взять одним ходом, причём так, чтобы взявшая
  фигура **не оказалась под боем** после взятия (иначе это размен,
  а не подарок).
- **Как отвечать:** сделайте ход на доске — двумя кликами «откуда → куда»
  или перетащив свою фигуру на висящую.
- **Что засчитывается правильным:** ход-взятие, после которого:
  1. ваша фигура встала на клетку висящей;
  2. на этой клетке после взятия её **никто из противника** не атакует
     (включая батарею через линию, открывшуюся после взятия).
  Если несколько ваших фигур могут законно взять цель, drill-индексер
  такую позицию отсевает — на показ попадают только однозначные.
- **Пример позиции:** `4k3/4p3/8/3n4/8/2N5/4P3/4K3 w - - 0 1`
  (ход белых). Чёрный конь d5 атакован конём c3, защитников у него нет.
  Правильный ответ — **Nc3xd5**. После взятия конь на d5 никем не
  атакован: чёрная пешка e7 бьёт по диагонали на d6/f6, чёрный король
  с e8 не дотягивается. Если бы пешка стояла на e6, взятие было бы
  разменом, и эта позиция в drill не попала бы.
- **Типичные ошибки:**
  - Кликнуть на висящую фигуру без хода — сейчас drill принимает только
    *ход*, а не клик. Нужно нажать на свою фигуру и потом на цель.
  - Взять висящую той фигурой, которая после взятия попадёт под бой
    защитника, появившегося из-за линии (X-ray). Drill такие позиции
    отсевает заранее, но в реальной партии этот мотив встречается часто.

#### EN

- **Title (UI):** Hanging piece.
- **One-liner:** Capture the undefended enemy piece in a single move.
- **Detailed:** Exactly one of the opponent's non-king pieces is
  attacked by you and has zero defenders. Such a piece is *hanging*.
  Find it and take it in one move — but only if the capturing piece
  itself is **not under attack** after the capture (otherwise it's a
  trade, not a gift).
- **How to answer:** make a move on the board — either click "from →
  to" or drag your piece onto the hanging one.
- **What counts as correct:** a capture move where, after the capture,
  no enemy piece attacks your piece on the target square (including
  X-ray batteries that may open up).
- **Example FEN:** `4k3/4p3/8/3n4/8/2N5/4P3/4K3 w - - 0 1` (White
  to move). The Black knight on d5 is attacked by the c3 knight and has
  no defenders. Correct answer: **Nc3xd5**. After the capture nothing
  attacks the new knight on d5 — the Black pawn on e7 only covers d6/f6,
  the king on e8 is too far. If a pawn stood on e6, this would be a
  trade and the position would have been filtered out.
- **Common mistakes:**
  - Clicking the hanging piece without making a move — only moves are
    accepted. Click your piece first, then the target.
  - Capturing with a piece that gets attacked after the capture by a
    defender unmasked through an X-ray. Such positions are filtered out
    by the indexer, but the motif itself is very common in real games.

---

### 2. Незащищённая фигура / Loose piece

`find-loose-piece`, shape: `square`, слой: overview.

#### RU

- **Название (UI):** Незащищённая фигура.
- **Одна фраза:** Какая фигура противника не имеет ни одного защитника?
- **Развёрнутое описание:** На доске есть ровно одна фигура противника
  (не король), у которой нет ни одного защитника. Под боем она быть
  не обязана — этот drill про «слабые места», которые могут стать
  целью атаки в ближайшие ходы. Это первый шаг к тактике: прежде чем
  считать комбинацию, надо увидеть слабую цель.
- **Как отвечать:** один клик по клетке этой фигуры.
- **Что засчитывается правильным:** клик ровно по клетке единственной
  фигуры противника без защитников. «Защитник» — фигура того же цвета,
  атакующая клетку напрямую (без X-ray-эффектов).
- **Пример позиции:** `6k1/5pp1/5n1p/8/2bP4/2N1B3/PPP2PPP/4K3 w - - 0 1`
  (ход белых, ищем слабую чёрную фигуру). Все чёрные пешки и конь
  прикрыты соседями: f7 и g7 защищены королём g8, конь f6 и пешка h6 —
  пешкой g7. У чёрного слона c4 защитников нет. Правильный ответ —
  **c4**. Слон не под боем (никто из белых на него не нападает прямо
  сейчас), но достаточно белой фигуре прийти на c4 — и он висит.
- **Типичные ошибки:**
  - Искать только «вражескую фигуру под боем». Loose piece — про
    отсутствие защитника, а не про атаку.
  - Считать защитником короля противника, когда тот не дотягивается
    до клетки (короля считаем как обычного защитника по геометрии:
    король защищает все 8 соседних клеток).

#### EN

- **Title (UI):** Loose piece.
- **One-liner:** Which opponent piece has no defenders at all?
- **Detailed:** Exactly one non-king enemy piece on the board has zero
  defenders. It does **not** need to be under attack — this drill is
  about weak spots that could become targets soon. Spotting loose
  pieces is the first step in tactics: before calculating, you have to
  see the weak target.
- **How to answer:** one click on the piece's square.
- **What counts as correct:** clicking the square of the only
  undefended enemy piece. A "defender" is a same-coloured piece that
  attacks the square directly (no X-ray).
- **Example FEN:**
  `6k1/5pp1/5n1p/8/2bP4/2N1B3/PPP2PPP/4K3 w - - 0 1` (White to move,
  hunting a Black loose piece). All Black pawns and the knight are
  covered: f7 and g7 by the king on g8, the f6 knight and h6 pawn by
  the g7 pawn. The Black bishop on c4 has no defender. Correct answer:
  **c4**. The bishop is not currently under attack, but as soon as a
  White piece reaches c4 it hangs.
- **Common mistakes:**
  - Looking only for an enemy piece *under attack*. Loose = no
    defender, not "attacked".
  - Forgetting that the king itself counts as a defender for any
    adjacent square.

---

### 3. Связка / Pin

`find-pin`, shape: `square`, слой: pattern.

#### RU

- **Название (UI):** Связка.
- **Одна фраза:** Найдите связанную фигуру.
- **Развёрнутое описание:** Фигура называется *связанной*, если её
  атакует дальнобойная фигура противника (ферзь, ладья или слон по
  своим линиям), а сразу за ней по той же линии стоит более ценная
  своя фигура — или король. Если за связанной — король, это
  *абсолютная* связка: уйти нельзя по правилам. Если ферзь, ладья,
  слон или конь большей ценности — *относительная*: уйти можно, но
  потеряешь больше, чем получишь.
- **Как отвечать:** один клик по клетке связанной фигуры.
- **Что засчитывается правильным:** клик по единственной связанной
  фигуре в позиции. Условие связки — два пункта одновременно:
  1. за фигурой по линии «атакующий → анкер» стоит фигура того же
     цвета, ценность которой строго больше ценности связанной (король —
     бесконечно ценен);
  2. у связанной фигуры геометрически есть хотя бы один ход вне
     линии связки (то есть фигура физически могла бы сойти, если бы
     не связка).
- **Пример позиции:** `3qk3/8/8/3n4/8/3R4/8/4K3 b - - 0 1`
  (ход чёрных). Белая ладья d3 атакует чёрного коня d5 по d-линии. За
  конём по той же линии — чёрный ферзь d8 (ценнее коня). Любой ход
  коня уходит с d-линии, поэтому условие «может сойти» выполнено.
  Правильный ответ — **d5**. Это относительная связка: уйти конём
  технически можно, но тогда чёрные теряют ферзя.
- **Типичные ошибки:**
  - Кликать по связывающей фигуре (ладье d3) или по анкеру (ферзю d8).
    Drill спрашивает именно связанную фигуру — ту, что в середине.
  - Засчитывать связкой ситуацию, где обе фигуры одинаковой ценности.
    Связки коня за конём в drill нет — менять одну за другую обычно
    бессмысленно.

#### EN

- **Title (UI):** Pin.
- **One-liner:** Find the pinned piece.
- **Detailed:** A piece is *pinned* if it's attacked by an enemy
  long-range piece (queen, rook, or bishop along its line) and a more
  valuable piece of its own colour — or the king — sits directly behind
  it on the same line. If the king is behind, the pin is *absolute*
  (moving is illegal). If a queen, rook, bishop, or higher-valued knight
  is behind, it's *relative* (you can move, but you'll lose more than
  you gain).
- **How to answer:** one click on the pinned piece's square.
- **What counts as correct:** clicking the only pinned piece in the
  position. Two conditions must hold:
  1. behind the piece on the attacker→anchor line stands a same-colour
     piece strictly more valuable than the pinned one (or the king,
     which is treated as infinitely valuable);
  2. the pinned piece has at least one geometric move off the pin line
     (i.e. it could physically step off the line if not for the pin).
- **Example FEN:** `3qk3/8/8/3n4/8/3R4/8/4K3 b - - 0 1` (Black to
  move). The White rook on d3 attacks the Black knight on d5 along the
  d-file. Behind the knight on the same file sits the Black queen
  on d8 — more valuable. Any knight move steps off the file, so "can
  move off the line" is satisfied. Correct answer: **d5**. This is a
  relative pin: technically the knight could move, but Black would lose
  the queen.
- **Common mistakes:**
  - Clicking the pinning rook (d3) or the anchor (d8). The drill asks
    for the piece in the middle.
  - Treating equal-value pins (e.g. knight behind knight) as pins —
    they're not collected by the drill, since trading like for like
    has no point.

---

### 4. Создать вилку / Create a fork

`find-fork`, shape: `move`, слой: pattern.

#### RU

- **Название (UI):** Создать вилку.
- **Одна фраза:** Какой ход создаёт у противника новую вилку?
- **Развёрнутое описание:** Вилка — это ход, после которого одна ваша
  фигура одновременно атакует две (или больше) ценные фигуры
  противника. «Ценные» в drill — конь, слон, ладья, ферзь и король
  (пешки не считаются, выгода «пешка + конь» обычно не вилка). Drill
  требует именно **создания новой** вилки: оба объекта вилки до хода
  не были под боем именно этой фигуры. Ход «продолжаю атаковать ту же
  цель и заодно вторую» вилкой не считается. Также форкер после хода
  должен быть в безопасности — если на его клетку у противника есть
  атакующий, drill отбрасывает ход (взятие форкера всё разрушает).
- **Как отвечать:** ход на доске — два клика «откуда → куда» или drag.
- **Что засчитывается правильным:** ход, после которого:
  1. одна ваша фигура атакует ≥2 ценных фигур противника;
  2. ни одна из этих целей **не была** под атакой *этой же* фигуры
     до хода (intersection до/после = пусто);
  3. на клетку, куда фигура встала (или с которой бьёт через линию,
     если это «вскрытая» вилка), у противника нет ни одного атакующего.
  В drill попадают только позиции с ровно одним таким ходом.
- **Пример позиции:** `6k1/8/8/8/5Q2/2n5/8/2K5 b - - 0 1`
  (ход чёрных). Чёрный конь c3 пока не атакует ни короля c1, ни ферзя
  f4. Правильный ответ — **c3-e2**. После Nxe2 (взятия нет — клетка
  e2 пустая) конь атакует и короля c1, и ферзя f4. До хода ни короля,
  ни ферзя конь не атаковал — это «чистая» новая вилка. Самого коня
  на e2 ничто не атакует.
- **Типичные ошибки:**
  - Считать вилкой ход, при котором фигура продолжает бить ту же цель
    и добавляет вторую. Это «дополнительная атака», для drill — нет.
  - Игнорировать безопасность форкера. Если конь после хода вилки
    подвешен, противник просто заберёт его, и комбинации не будет.

#### EN

- **Title (UI):** Create a fork.
- **One-liner:** Which move creates a new fork?
- **Detailed:** A fork is a move after which a single piece of yours
  attacks two (or more) valuable enemy pieces simultaneously.
  "Valuable" in this drill means knight, bishop, rook, queen, or king
  (pawns don't count — pawn + minor isn't a textbook fork). The drill
  requires a **new** fork: both targets must not have been under
  attack by this same piece before the move. "I keep attacking the
  same target and add a second" doesn't count. The forking piece must
  also be safe on its destination — if any opponent piece attacks the
  destination square, the move is dropped (the fork doesn't survive).
- **How to answer:** make a move — two clicks "from → to" or drag.
- **What counts as correct:** a move where, after the move:
  1. one of your pieces attacks ≥2 valuable enemy pieces;
  2. neither of those targets was attacked by **this same** piece
     before the move (the before/after intersection is empty);
  3. no enemy piece attacks the square the forker now stands on
     (including discovered forks, where the forker didn't move).
  Only positions with exactly one such move are shown.
- **Example FEN:** `6k1/8/8/8/5Q2/2n5/8/2K5 b - - 0 1` (Black to
  move). The Black knight on c3 currently attacks neither the king on
  c1 nor the queen on f4. Correct answer: **c3-e2**. After Nxe2
  (e2 is empty, no capture) the knight attacks both c1 and f4. Before
  the move the knight attacked neither — a clean new fork. Nothing
  attacks the knight on e2.
- **Common mistakes:**
  - Counting a move that keeps attacking the original target and adds
    a second target. That's "double attack continuation", not a fork
    in this drill.
  - Ignoring forker safety. If the knight is hanging after the fork,
    the opponent simply takes it.

---

### 5. Сосчитать атакующих / Count attackers

`count-attackers`, shape: `number`, слой: overview.

#### RU

- **Название (UI):** Счёт атакующих.
- **Одна фраза:** Сколько фигур заданного цвета атакуют выделенную клетку?
- **Развёрнутое описание:** Этот drill учит видеть, сколько фигур
  одного цвета бьют на конкретную клетку — самый базовый «мускул»
  расчёта разменов. На доске подсвечена жёлтым одна клетка и указан
  цвет атакующих (белые / чёрные). Нужно сосчитать всех — включая
  «батареи»: если две ладьи стоят на одной вертикали и обе атакуют
  ту же клетку, обе считаются.
- **Как отвечать:** нажмите кнопку с числом (1, 2, 3 или 4).
- **Что засчитывается правильным:** число, равное `chess.attackers(square,
  color).length` — то есть количество фигур указанного цвета, бьющих
  по подсвеченной клетке в текущей позиции (с учётом блокировок: если
  ладья за пешкой не достаёт — она не считается). Допустимый диапазон —
  от 1 до 4 (если 0 или ≥5, позиция в drill не попадает).
- **Пример позиции:** `8/8/8/8/4p3/3P1P2/8/8 w - - 0 1`,
  выделенная клетка `e4`, цвет атакующих — белые. Атакуют пешка d3 и
  пешка f3 — обе бьют по диагонали. Правильный ответ — **2**.
- **Типичные ошибки:**
  - Забыть про батарею (две фигуры по одной линии — обе считаются,
    даже если одна стоит за другой).
  - Считать связанные фигуры. Связанная фигура всё равно атакует
    клетку, даже если двинуть её нельзя.
  - Считать собственного короля как защитника, а не как атакующего —
    король атакует все 8 соседних клеток, и если цвет короля
    совпадает с цветом атакующих, его надо учитывать.

#### EN

- **Title (UI):** Count attackers.
- **One-liner:** How many pieces of the given colour attack the
  highlighted square?
- **Detailed:** This drill builds the most basic muscle of trade
  calculation: see how many same-coloured pieces hit a specific
  square. One square is highlighted in yellow and the attacker colour
  is shown (White / Black). Count all of them, including batteries:
  if two rooks stand on the same file and both reach the square, both
  count.
- **How to answer:** press a button — 1, 2, 3, or 4.
- **What counts as correct:** the value of `chess.attackers(square,
  color).length` — how many pieces of the given colour attack the
  highlighted square in the current position, respecting blockers (a
  rook behind its own pawn doesn't count). Allowed range: 1 to 4. If
  the count is 0 or ≥5, the position doesn't make it into the drill.
- **Example FEN:** `8/8/8/8/4p3/3P1P2/8/8 w - - 0 1`, highlighted
  square `e4`, attackers — White. The d3 and f3 pawns both cover e4
  diagonally. Correct answer: **2**.
- **Common mistakes:**
  - Forgetting batteries (two pieces on a line — both count, even if
    one stands behind the other).
  - Skipping pinned attackers. A pinned piece still attacks the square
    even if it can't legally move there.
  - Skipping your own king. The king attacks all 8 adjacent squares
    and if its colour matches the attacker colour, count it.

---

### 6. Все шахи / All checks

`find-all-checks`, shape: `squares` (специальный multi-step ввод), слой: pattern.

#### RU

- **Название (UI):** Все шахи.
- **Одна фраза:** Сделайте на доске все ходы, которые объявляют шах.
- **Развёрнутое описание:** В позиции есть от 2 до 7 разных ходов,
  объявляющих шах королю противника (включая открытые шахи и шахи
  через взятие). Ваша задача — найти их **все**. Тип ввода у этого
  тренажёра отличается от остальных: вы делаете ходы прямо на доске
  по одному, и после каждого валидного хода фигура автоматически
  возвращается на исходную клетку. Цель — пройти всё множество, не
  пропустив ни одного шаха.
- **Как отвечать:** делайте ходы на доске обычным способом (клик-клик
  или drag). После каждого хода:
  - если это новый шах — вспышка зелёным (~600мс), счётчик «N / M
    шахов» прибавляется на 1, ход откатывается;
  - если этот шах вы уже находили — вспышка жёлтым (~400мс), без штрафа,
    ход откатывается;
  - если ход не даёт шах — вспышка красным (~600мс), попытка считается
    использованной, ход откатывается.
  Когда найдены все — drill завершается автоматически. Кнопка
  «Готово» позволяет завершить досрочно (засчитываются только
  найденные).
- **Что засчитывается правильным:** покрытие полного множества `to`-клеток,
  ходы на которые дают шах. Дубликаты не учитываются (порядок и
  выбор фигуры не важны — важна целевая клетка). Позиции, в которых
  есть мат в один ход, в этот drill не попадают: иначе пользователь
  ждёт мат, а от него требуют список клеток.
- **Пример позиции:** `8/8/3k4/8/8/2N5/8/3R3K w - - 0 1`
  (ход белых). Ходы с шахом: ладья по d-линии — Rd2+, Rd3+, Rd4+,
  Rd5+; конь — Nb5+ и Ne4+. Шесть уникальных целевых клеток: **d2, d3,
  d4, d5, b5, e4**. Правильный ответ — пройти их все.
- **Типичные ошибки:**
  - Пропустить открытый шах (фигура уходит, открывая линию атаки за ней).
  - Пропустить шах через взятие, если рядом висит чужая фигура.
  - Делать одну и ту же клетку разными фигурами — это засчитывается
    только раз (по `to`-клетке).

#### EN

- **Title (UI):** All checks.
- **One-liner:** Play every move that delivers check.
- **Detailed:** The position contains between 2 and 7 distinct moves
  that give check to the opponent's king (including discovered checks
  and capture-checks). Your goal is to find them **all**. The input
  format here is different from other drills: you make moves on the
  board one by one, and after each valid attempt the piece is
  automatically returned to its starting square. Aim — cover the
  entire set without missing a check.
- **How to answer:** make moves on the board normally (click-click or
  drag). After each move:
  - new check — green flash (~600ms), the "N / M checks" counter
    increments, move is undone;
  - check you've already found — yellow flash (~400ms), no penalty,
    undone;
  - not a check — red flash (~600ms), attempt counted, undone.
  When all checks are found, the drill auto-completes. A "Done"
  button lets you finish early (only the checks found so far count).
- **What counts as correct:** covering the full set of `to`-squares
  where a move gives check. Duplicates don't count (order and the
  choice of piece don't matter — only the target square). Positions
  containing mate in one are filtered out: otherwise the user expects
  mate but is asked for a list of squares.
- **Example FEN:** `8/8/3k4/8/8/2N5/8/3R3K w - - 0 1` (White to
  move). Checking moves: rook along the d-file — Rd2+, Rd3+, Rd4+,
  Rd5+; knight — Nb5+ and Ne4+. Six unique target squares: **d2, d3,
  d4, d5, b5, e4**. Correct answer — play them all.
- **Common mistakes:**
  - Missing a discovered check (a piece moving out of the way of a
    long-range attacker).
  - Missing a capture-check.
  - Replaying the same target square with a different piece — counts
    only once (by `to`-square).

---

### 7. Создать висящую фигуру / Create a hanging piece

`find-undefended-attack`, shape: `move`, слой: calculation.

#### RU

- **Название (UI):** Создать висящую фигуру.
- **Одна фраза:** Какой ход создаёт у противника новую висящую фигуру?
- **Развёрнутое описание:** «Висящая фигура» здесь — фигура противника,
  которую вы атакуете и у которой нет защитников. Drill требует именно
  **создать новую** такую угрозу: фигура, которая после вашего хода
  оказалась под боем без защиты, **до хода** под этой угрозой не была
  (могла быть защищена, могла стоять вне атаки — не важно). Это самый
  простой расчёт на 1 ход: «если я сейчас сюда — что зависнет у соперника?».
- **Как отвечать:** ход на доске — клик «откуда → куда» или drag.
- **Что засчитывается правильным:** ход, после которого:
  1. множество висящих фигур противника после хода содержит хотя бы
     одну клетку, которой не было в этом множестве до хода (новая
     цель появилась);
  2. в позиции есть ровно один такой ход (если несколько — drill
     отсевает и не показывает).
- **Пример позиции:** `6k1/8/3p4/8/4P3/8/8/4K3 w - - 0 1`
  (ход белых). Чёрная пешка d6 не атакована: e4 бьёт по диагонали на
  d5/f5, а не на d6. Правильный ответ — **e4-e5**. После 1.e4-e5 пешка
  e5 атакует d6 по диагонали, а защитников у d6 нет. Никакой другой
  ход белых не создаёт новой угрозы такого же типа.
- **Типичные ошибки:**
  - Указать ход, после которого фигура противника попадает под бой,
    но **остаётся защищённой**. Drill ждёт именно «без защиты» — это
    висящая, а не просто атакованная.
  - Указать ход, после которого фигура противника всё ещё под той
    же угрозой, что и до хода (не «новая»).
  - Не учесть, что после нашего хода защитник цели мог уйти. Открытые
    атаки и вскрытия в этот drill попадают тоже.

#### EN

- **Title (UI):** Create a hanging piece.
- **One-liner:** Which move creates a new hanging piece for the
  opponent?
- **Detailed:** A "hanging piece" here is an enemy piece you attack
  that has no defenders. The drill requires you to **create a new**
  such threat: a piece that ends up attacked-and-undefended after
  your move and was **not** in that state before the move (it could
  have been defended, or simply not under attack — either is fine).
  This is the simplest one-move calculation: "if I move here, what
  hangs for the opponent?".
- **How to answer:** make a move — click "from → to" or drag.
- **What counts as correct:** a move where:
  1. the set of hanging enemy pieces after the move contains at
     least one square that wasn't there before;
  2. exactly one such move exists in the position (otherwise the
     drill filters the position out).
- **Example FEN:** `6k1/8/3p4/8/4P3/8/8/4K3 w - - 0 1` (White to
  move). The Black pawn on d6 isn't attacked: e4 hits d5/f5, not d6.
  Correct answer: **e4-e5**. After 1.e4-e5 the pawn on e5 attacks d6
  diagonally, and d6 has no defenders. No other White move creates
  this kind of new threat.
- **Common mistakes:**
  - Picking a move that attacks an enemy piece which **still has
    defenders** afterwards. The drill expects "undefended" —
    hanging, not merely attacked.
  - Picking a move that keeps the opponent's piece in the same
    threat state it was already in (not "new").
  - Forgetting that the defender of the target piece may move away
    on your move. Discovered threats and unmaskings count too.

---

## Расхождения и заметки

Этот раздел нужен координатору и backend-команде, не пользователю.
Сюда выносим всё, где описание из задачи / ADR / i18n не сходится с
кодом predicate'ов на момент написания.

1. **Тиков `find-defended-piece` / `find-attacked-piece` /
   `find-mate-in-one-square` в проде нет.** В описании KS-2412 они
   упомянуты как «возможно ещё». В `TacticDrillType` (см.
   `packages/shared/src/types/tactic-drill.ts:25-32`) ровно 7 типов:
   `find-hanging-piece`, `find-loose-piece`, `find-pin`, `find-fork`,
   `count-attackers`, `find-all-checks`, `find-undefended-attack`.
   В `predicates/index.ts` нет ни `defended-piece`, ни `attacked-piece`,
   ни `mate-in-one-square`. Если планируется ввод — нужен отдельный
   тикет с predicate'ом и контентом.

2. **`mate-in-1 (deprecated)` удалён в KS-2393.** Тип, predicate и
   записи в БД убраны, но в i18n остался текст
   `drills.sprint.leaderboard.set.mixed = "Все 8 типов" / "Mixed (all 8)"`
   — реальное число drill-типов сейчас 7, не 8. Расхождение
   косметическое, требует правки на frontend (apps/web/src/i18n/locales/
   ru/translation.json:806 и en/translation.json:804). Завести
   отдельный тикет.

3. **`find-loose-piece.sideToMove === null` в DTO**
   (`shared/src/types/tactic-drill.ts:167`), но семантика side-sensitive:
   `enemy = oppColor(chess.turn())`. Frontend (KS-2333) делает fallback
   через `sideFromFen`. Для пользователя это означает: индикатор «ход
   чей-то» не показывается, но какой цвет искать — берётся из FEN.
   Вне рамок этой задачи — но имеет смысл либо проставить sideToMove
   у `find-loose-piece` в backend-resolver'е, либо явно убрать
   side-sensitive логику. Завести отдельный тикет, если решим
   привести в порядок.

4. **ADR-035 §2.1** содержит формулировки, отстающие от текущих
   predicate'ов (см. KS-2400 / KS-2406 / KS-2408 для `find-fork`,
   KS-2335 / KS-2349 / KS-2371 для `find-hanging-piece`, KS-2372 для
   `find-undefended-attack`). Этот документ опирается на код, а не на
   ADR. Если ADR будем синхронизировать — отдельный тикет.

5. **`find-fork` использует `attacksBefore` snapshot — overlap-фильтр
   через intersection.** В описании задачи KS-2412 формулировка
   совпадает («ни одна из этих целей не была уже под атакой этим же
   форкером»), это актуальная семантика после KS-2408. Зафиксировано
   в карточке; если backend изменит правила — обновить карточку первой,
   до релиза.

---

## Источники истины

- `apps/api/src/tactic-drill/predicates/find-fork.ts`
- `apps/api/src/tactic-drill/predicates/find-hanging-piece.ts`
- `apps/api/src/tactic-drill/predicates/find-loose-piece.ts`
- `apps/api/src/tactic-drill/predicates/find-pin.ts`
- `apps/api/src/tactic-drill/predicates/find-undefended-attack.ts`
- `apps/api/src/tactic-drill/predicates/find-all-checks.ts`
- `apps/api/src/tactic-drill/predicates/count-attackers.ts`
- `packages/shared/src/types/tactic-drill.ts`
- `apps/web/src/components/drills/DrillRunner.tsx`
- `apps/web/src/components/drills/FindAllChecksRunner.tsx`
- `apps/web/src/i18n/locales/{ru,en}/translation.json` (ключи `drills.*`)
