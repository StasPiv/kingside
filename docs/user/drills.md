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
- **Пример позиции:** `8/8/8/5p2/4kP2/8/4K3/8 b - - 8 68`
  (ход чёрных, drill из прод-БД). Белая пешка f4 атакована чёрным
  королём e4, защитников у неё нет: соседний белый король e2 не
  дотягивается до f4, других белых нет. Правильный ответ — **Ke4xf4**
  (король берёт пешку). После взятия король на f4 никем не атакован:
  чёрная пешка f5 бьёт по диагонали на e4/g4, не на f4; белый король
  e2 на f4 не дотягивается. Чистый «подарок» — пешку забирают без
  размена.
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
- **Example FEN:** `8/8/8/5p2/4kP2/8/4K3/8 b - - 8 68` (Black to
  move, drill from production DB). The White pawn on f4 is attacked
  by the Black king on e4 and has no defenders: the adjacent White
  king on e2 doesn't reach f4 and there are no other White pieces.
  Correct answer: **Ke4xf4** (the king takes the pawn). After the
  capture nothing attacks the king on f4 — the Black pawn on f5
  covers e4/g4, not f4; the White king on e2 is too far. A clean
  pawn grab, no trade.
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
- **Пример позиции:** `8/8/8/8/2p3K1/2P5/1k6/8 w - - 0 59`
  (ход белых, drill из прод-БД). На доске четыре фигуры: белый король
  g4, белая пешка c3, чёрный король b2 и чёрная пешка c4. Чёрный
  король b2 никого не защищает на c4: он атакует только соседние
  клетки a1/a2/a3/b1/b3/c1/c2/c3 — на c4 не дотягивается. Других
  чёрных фигур нет. Правильный ответ — **c4**: чёрная пешка без
  единого защитника. Под боем она тоже не находится (белая пешка c3
  бьёт по диагонали на b4/d4), но достаточно подвести любую фигуру —
  и пешка падает.
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
- **Example FEN:** `8/8/8/8/2p3K1/2P5/1k6/8 w - - 0 59` (White to
  move, drill from production DB). Just four pieces: White king on g4,
  White pawn on c3, Black king on b2, Black pawn on c4. The Black king
  on b2 doesn't defend c4 — it only covers a1/a2/a3/b1/b3/c1/c2/c3,
  not c4. No other Black pieces. Correct answer: **c4** — a Black pawn
  with zero defenders. It isn't under attack right now (the White pawn
  on c3 covers b4/d4), but bringing any piece up will drop it.
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
- **Пример позиции:** `5k2/4n3/7P/p5p1/P2q4/6P1/2Q2P2/6K1 b - - 1 41`
  (ход чёрных, drill из прод-БД). Чёрный ферзь d4 атакует белую пешку
  f2 по диагонали (d4-e3-f2). За пешкой по той же диагонали стоит
  белый король g1 — анкер бесконечной ценности. Пешка f2 теоретически
  могла бы пойти на f3 или f4, и оба этих хода уходят с диагонали
  d4-g1, то есть условие «может сойти» выполнено. Но из-за связки
  пешка двигаться не вправе — иначе шах королю g1. Правильный ответ —
  **f2**. Это абсолютная связка: связана белая фигура на чёрного
  ферзя, привязка к королю.
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
- **Example FEN:** `5k2/4n3/7P/p5p1/P2q4/6P1/2Q2P2/6K1 b - - 1 41`
  (Black to move, drill from production DB). The Black queen on d4
  attacks the White pawn on f2 along the diagonal (d4-e3-f2). Behind
  the pawn on the same diagonal stands the White king on g1 — an
  infinitely valuable anchor. The pawn could in principle move to f3
  or f4, and both squares step off the d4-g1 diagonal, so the "can
  move off the line" condition holds. But because of the pin the pawn
  must not move — that would expose the king. Correct answer: **f2**.
  An absolute pin: a White piece pinned by a Black queen, anchored on
  the king.
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
- **Пример позиции:** `8/8/8/6P1/8/pr6/3Q4/k5K1 w - - 3 56`
  (ход белых, drill из прод-БД). Чёрные: король a1, ладья b3, пешка
  a3. Белые: ферзь d2, пешка g5, король g1. До хода белый ферзь d2
  не атакует ни чёрного короля a1, ни ладью b3 (d2-a1: не диагональ,
  d2-b3: не линия и не диагональ). Правильный ответ — **Qd2-d1+**.
  После хода ферзь на d1 даёт шах королю по 1-линии (b1, c1 пусто) и
  одновременно атакует ладью b3 по диагонали d1-c2-b3 (c2 пусто). Две
  ценные цели одним ходом, до хода ни одна из них этим ферзём не
  атаковалась. Сам ферзь на d1 в безопасности — никто из чёрных не
  бьёт d1.
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
- **Example FEN:** `8/8/8/6P1/8/pr6/3Q4/k5K1 w - - 3 56` (White to
  move, drill from production DB). Black: king on a1, rook on b3,
  pawn on a3. White: queen on d2, pawn on g5, king on g1. Before the
  move the White queen on d2 attacks neither the Black king on a1
  nor the rook on b3. Correct answer: **Qd2-d1+**. After the move the
  queen on d1 gives check along the 1st rank (b1, c1 empty) and also
  attacks the rook on b3 along the d1-c2-b3 diagonal (c2 empty) — two
  valuable targets in one move, neither attacked by this queen
  before. The queen on d1 is itself safe: nothing Black hits d1.
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
- **Пример позиции:** `8/3n3k/p4p1p/1p3N1P/6P1/1P6/P7/2K5 b - - 0 35`
  (drill из прод-БД), выделенная клетка `h6`, цвет атакующих — **белые**.
  На h6 — чёрная пешка. Кто из белых бьёт h6? Пешка h5 бьёт g6 (не h6:
  пешка идёт диагонально вперёд, прямо вверх не бьёт). Пешка g4 — атакует
  f5/h5, не h6. Конь f5 — атакует d4, e3, e7, d6, g7, h4, h6, g3 — да,
  попадает на h6. Других белых атакующих h6 нет. Правильный ответ — **1**.
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
- **Example FEN:**
  `8/3n3k/p4p1p/1p3N1P/6P1/1P6/P7/2K5 b - - 0 35` (drill from
  production DB), highlighted square `h6`, attackers — **White**.
  On h6 stands a Black pawn. Which White piece hits h6? The h5 pawn
  attacks g6, not h6 (pawns capture diagonally forward, not straight
  up). The g4 pawn covers f5/h5, not h6. The f5 knight covers d4, e3,
  e7, d6, g7, h4, h6, g3 — yes, h6 is on its list. No other White
  piece reaches h6. Correct answer: **1**.
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
- **Пример позиции:** `1K6/7r/3k4/8/1n6/8/2R5/8 w - - 84 104`
  (ход белых, drill из прод-БД). На доске: белые — король b8 и ладья
  c2; чёрные — король d6, конь b4, ладья h7. Ходы белых, дающие шах
  чёрному королю d6: ладья **Rc2-c6+** (атакует d6 по 6-линии — c6
  рядом с d6) и ладья **Rc2-d2+** (атакует d6 по d-линии, между d2
  и d6 пусто). Двух уникальных целевых клеток достаточно для drill —
  это минимум диапазона `[2, 7]`. Правильный ответ — пройти оба хода:
  целевые клетки **c6** и **d2**.
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
- **Example FEN:** `1K6/7r/3k4/8/1n6/8/2R5/8 w - - 84 104` (White to
  move, drill from production DB). On the board: White — king on b8,
  rook on c2; Black — king on d6, knight on b4, rook on h7. White
  moves that check the Black king on d6: rook **Rc2-c6+** (attacks d6
  along the 6th rank — c6 is adjacent to d6) and rook **Rc2-d2+**
  (attacks d6 along the d-file, the squares between d2 and d6 are
  empty). Two unique target squares — the minimum of the `[2, 7]`
  range. Correct answer — play both moves: target squares are **c6**
  and **d2**.
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
  (могла быть защищена, могла стоять вне атаки — не важно). После KS-2419
  добавлен **safety-check атакующей фигуры**: на клетке `m.to` после
  хода у противника не должно быть ни одного прямого attacker'а — иначе
  это зевок, а не создание угрозы. До патча predicate возвращал и Qxh7,
  где ферзь после взятия пешки попадает под атаку короля, — теперь такие
  ходы отсевает.
- **Как отвечать:** ход на доске — клик «откуда → куда» или drag.
- **Что засчитывается правильным:** ход, после которого:
  1. множество висящих фигур противника после хода содержит хотя бы
     одну клетку, которой не было в этом множестве до хода (новая
     цель появилась);
  2. на клетке `m.to` после хода у противника нет ни одного прямого
     attacker'а (KS-2419, симметрично safety-check'у форкера в KS-2406
     для `find-fork`); SEE не используется, защита равной фигурой не
     спасает кандидата;
  3. в позиции есть ровно один такой ход (если несколько — drill
     отсевает и не показывает).
- **Пример позиции:** `1R6/2p5/2k5/8/2K1r3/P7/8/8 w - - 7 65`
  (ход белых, drill из прод-БД). Белые: ладья b8, король c4, пешка
  a3. Чёрные: король c6, ладья e4, пешка c7. Чёрная ладья e4 не
  атакована до хода (ладья b8 не на 4-линии, пешка a3 нет, король
  c4 не дотягивается до e4). Правильный ответ — **Kc4-d3**: белый
  король идёт на d3 и оттуда атакует ладью e4 по диагонали. Защитники
  e4 = 0 (король c6 не достаёт, пешка c7 бьёт b6/d6). До хода e4
  не было в `threatsBefore` — новая угроза появилась. Safety: на d3
  после хода attackers(d3, black) = 0 (ладья e4 атакует e-line и
  4-line, не d3; король c6 не дотягивается; пешка c7 нет) — атакующая
  фигура (король) в безопасности. Strict-uniqueness — единственный
  такой ход в позиции (chess.js не пускает короля на d4/d5 под
  бой ладьи/короля, остальные ходы белых не создают новой висящей).
- **Типичные ошибки:**
  - Указать ход, после которого фигура противника попадает под бой,
    но **остаётся защищённой**. Drill ждёт именно «без защиты» — это
    висящая, а не просто атакованная.
  - Указать ход, после которого фигура противника всё ещё под той
    же угрозой, что и до хода (не «новая»).
  - Указать ход, после которого **сама** атакующая фигура попадает
    под бой. После KS-2419 такой ход не засчитывается — это зевок,
    а не создание угрозы.
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
  hangs for the opponent?". After KS-2419 the predicate also
  enforces a **safety-check on the attacking piece**: square `m.to`
  must have zero direct enemy attackers after the move — otherwise
  it's a blunder, not a threat creation. Before the patch the
  predicate accepted moves like Qxh7 where the queen got captured by
  the king right after — those are now filtered out.
- **How to answer:** make a move — click "from → to" or drag.
- **What counts as correct:** a move where:
  1. the set of hanging enemy pieces after the move contains at
     least one square that wasn't there before;
  2. on `m.to` after the move there are zero direct enemy attackers
     (KS-2419, mirroring the forker safety-check from KS-2406 in
     `find-fork`); no SEE, "attacked but defended by an equal piece"
     still drops the candidate;
  3. exactly one such move exists in the position (otherwise the
     drill filters the position out).
- **Example FEN:** `1R6/2p5/2k5/8/2K1r3/P7/8/8 w - - 7 65` (White to
  move, drill from production DB). White: rook on b8, king on c4,
  pawn on a3. Black: king on c6, rook on e4, pawn on c7. The Black
  rook on e4 isn't attacked before the move (the b8 rook isn't on the
  4th rank, the a3 pawn doesn't reach, the king on c4 doesn't either).
  Correct answer: **Kc4-d3** — the White king steps to d3 and from
  there attacks the rook on e4 diagonally. Defenders of e4: zero (the
  king on c6 doesn't reach, the c7 pawn covers b6/d6). The square e4
  was not in `threatsBefore` — a new threat appeared. Safety: on d3
  after the move, `attackers(d3, black) = 0` (the e4 rook hits the
  e-file and 4th rank, not d3; the king on c6 doesn't reach; the c7
  pawn doesn't either) — the attacking piece (the king) is safe.
  Strict-uniqueness: this is the only such move (chess.js won't let
  the king walk to d4/d5 into the rook's or king's attack, and the
  other White moves don't create a new hanging).
- **Common mistakes:**
  - Picking a move that attacks an enemy piece which **still has
    defenders** afterwards. The drill expects "undefended" —
    hanging, not merely attacked.
  - Picking a move that keeps the opponent's piece in the same
    threat state it was already in (not "new").
  - Picking a move that puts **your own** attacking piece under
    attack. After KS-2419 such moves don't count — that's a blunder,
    not a threat creation.
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
   KS-2335 / KS-2349 / KS-2371 для `find-hanging-piece`, KS-2372 /
   KS-2419 для `find-undefended-attack`). Этот документ опирается на
   код, а не на ADR. Если ADR будем синхронизировать — отдельный тикет.

5. **`find-fork` использует `attacksBefore` snapshot — overlap-фильтр
   через intersection.** В описании задачи KS-2412 формулировка
   совпадает («ни одна из этих целей не была уже под атакой этим же
   форкером»), это актуальная семантика после KS-2408. Зафиксировано
   в карточке; если backend изменит правила — обновить карточку первой,
   до релиза.

6. **FEN-примеры — реальные drill из prod (KS-2416).** По одному
   примеру на тип взято из выгрузки devops `/tmp/KS-2416/drill-examples.json`
   (по 5 простых записей на тип, отбор `difficulty ASC LIMIT 5`).
   Все 7 примеров прошли соответствующий predicate в продакшен-индексере
   и реально показываются пользователям, поэтому замена строки FEN на
   что-то «учебнее» без проверки приведёт к расхождению с реальным
   контентом drill'ов. Для будущих обновлений — брать из БД или
   повторять выгрузку.

7. **KS-2421: пример `find-undefended-attack` заменён.** Старый пример
   `1R6/r4K1k/5P2/7P/8/8/8/8 w - - 1 70` (Rb8-b7) был валиден до
   KS-2419, но новое safety-правило его отсевает: ладья на b7 после
   хода атакована чёрной ладьёй a7. Для документации взят другой
   реальный drill из той же выгрузки KS-2416 —
   `1R6/2p5/2k5/8/2K1r3/P7/8/8 w - - 7 65` (Kc4-d3), который
   проходит и старую новизну угрозы, и новую safety-проверку. При
   reindex'е prod-БД старая запись Rb8-b7 должна отпасть; если этого
   не произошло — повод проверить миграцию KS-2419.

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
