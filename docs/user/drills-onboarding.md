# Тексты онбординга для тренажёров

Короткие тексты на 2–3 предложения, которые показываются пользователю
при первом запуске каждого drill-типа (всплывающее окно или баннер
поверх доски). Цель — за пару секунд объяснить, что от него ждут,
не уходя в теорию. Frontend позже перенесёт их в i18n.

Идентификаторы (`find-fork`, `find-pin` и т. п.) — это технические
ключи драйв-типов из кода, по ним frontend подберёт нужный текст.
В сам текст они не попадают.

---

## find-hanging-piece

### RU
Сейчас будем тренироваться брать висящие фигуры. На доске — фигура
соперника без защитников: вы её атакуете, а защищать её некому.
Сделайте ход и заберите её.

### EN
Time to practise grabbing hanging pieces. There's an enemy piece on
the board you attack and nobody defends. Make the move and take it.

---

## find-loose-piece

### RU
Сейчас будем искать незащищённые фигуры. На доске одна фигура
соперника стоит без единого защитника — найдите её и кликните по ней.
Под боем она может и не быть, важно только отсутствие защиты.

### EN
Time to spot undefended pieces. One enemy piece on the board has
zero defenders — find it and click its square. It doesn't have to
be under attack right now; the absence of any defender is what counts.

---

## find-pin

### RU
Сейчас будем находить связки. Связанная фигура — та, которая не может
свободно сходить, потому что за ней по линии стоит более ценная своя
фигура или король. Кликните по связанной фигуре, она в середине
между атакующим и тем, кого закрывает.

### EN
Time to find pins. A pinned piece is one that can't move freely
because a more valuable piece — or the king — sits behind it on the
same line. Click on the pinned piece in the middle, between the
attacker and what it shields.

---

## find-fork

### RU
Сейчас будем создавать вилки. Вилка — это ход, после которого одна
ваша фигура одновременно нападает на две ценные фигуры соперника, и
обе он защитить не успеет. Найдите такой ход и сделайте его на доске.

### EN
Time to set up forks. A fork is a move after which one of your pieces
simultaneously attacks two valuable enemy pieces, and the opponent
can't save both. Find the move and play it on the board.

---

## count-attackers

### RU
Сейчас будем тренироваться считать атакующих. На доске будет
подсвечена клетка и указан цвет — сколько фигур этого цвета бьют по
этой клетке? Нажмите кнопку с числом от 1 до 4. Учитывайте «батареи»
по одной линии и связанные фигуры — они тоже атакуют.

### EN
Time to practise counting attackers. A square will be highlighted and
a colour shown — how many pieces of that colour attack this square?
Press the button for 1, 2, 3, or 4. Count batteries along a line and
pinned attackers too — they still attack the square.

---

## find-all-checks

### RU
Сейчас будем искать все шахи в позиции. Делайте ходы шахом по очереди
прямо на доске — каждый правильный шах будет засчитан и фигура
вернётся на место. Найдите их все: в позиции их от 2 до 7, не пропустите
открытые шахи и шахи через взятие.

### EN
Time to find every check in the position. Play checking moves on the
board one by one — each correct check is counted and the piece is
returned to its starting square. Find them all: positions have between
2 and 7 checks. Don't miss discovered checks and capture-checks.

---

## find-undefended-attack

### RU
Сейчас будем тренировать расчёт на один ход. Нужен ход, после которого
у соперника появится фигура под боем и без защитников — то есть вы её
атакуете, а помочь ей некому. Важно: атакующая фигура должна сама
остаться в безопасности — если после хода её бьют, ход не засчитается.

### EN
Time to practise one-move calculation. You need a move that leaves an
enemy piece attacked and undefended afterwards — your piece hits it
and no one can defend. Important: your attacking piece must stay safe
itself — if it ends up under attack after the move, the drill won't
count it.
