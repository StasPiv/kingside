# @kingside/board-image-to-fen

CLI и программный API для распознавания шахматной диаграммы → FEN. Два
кода-пути под одной обёрткой:

- **Растровый** (KS-2028) — стиль учебника Майзелиса (PNG/JPG); template
  matching по морф-открытым силуэтам фигур.
- **PDF** (KS-2030) — диаграммы на шрифте `Chess-Merida-Regular`
  (учебники Калиниченко); детерминированный разбор через PyMuPDF без
  растрового пайплайна.

## Назначение

Архитектор при подготовке YAML-уроков (KS-2023, KS-2024 и др.) несколько раз
ошибался в FEN при ручном восстановлении позиции по картинке диаграммы. Цель
утилиты — дать инструмент, который читает картинку/PDF и выдаёт FEN-board
без ручного ввода, чтобы исключить такие ошибки.

Подтверждённые ошибки в существующих YAML, которые автоматический разбор
легко находит: `01-ch1-game-pieces-moves-goal.lesson.yml` диаграмма 10
(`1R4nk` вместо `1R3nk1`), диаграмма 11 (`5n2` вместо `3p1n2`), диаграмма 15
(`3nbppp` вместо `p2nbppp`) — и ещё ряд аналогичных.

## Установка

Пакет — npm-workspace внутри монорепы Kingside, отдельной публикации нет.
Зависимости — `commander`, `picocolors`, плюс системные требования:

- **Python 3.x** в PATH (или явно через `--python <path>` / опцию
  `pythonPath` в API);
- **OpenCV** (`pip install opencv-python` или системный пакет) —
  только для растрового пути;
- **NumPy** (`pip install numpy`) — только для растрового пути;
- **Pillow** (`pip install Pillow`) — только для растрового пути;
- **PyMuPDF** (`pip install pymupdf` или `apt-get install python3-fitz`) —
  только для PDF-пути.

Для сборки JS-обёртки:

```sh
npx --prefix /project tsc --build packages/board-image-to-fen
```

## Использование (CLI)

```sh
# Растровый режим: только FEN-board в stdout, диагностика — в stderr.
board-image-to-fen /path/to/diagram.jpg

# С ориентацией (если чёрные внизу).
board-image-to-fen /path/to/diagram.jpg --orientation black

# Подробный JSON-результат (включает confidence по каждой клетке).
board-image-to-fen /path/to/diagram.jpg --json

# Профиль шрифта диаграмм (KS-2132): maizelis (default) | dvoretsky.
board-image-to-fen /path/to/dvoretsky_diagram.png --profile dvoretsky

# Сканировать страницу книги — найти все диаграммы (bbox-ы) на ней.
# Полезно когда на странице 2–4 диаграммы с текстом вокруг — потом каждый
# bbox можно вырезать (Pillow/OpenCV) и подать в обычный recognize.
board-image-to-fen /tmp/page17.png --scan-page

# PDF: одна страница (1-indexed) — печатает FEN(ы), найденные на ней.
board-image-to-fen /path/to/book.pdf --page 21

# PDF: все страницы (поведение по умолчанию для .pdf, если флаги не заданы).
board-image-to-fen /path/to/book.pdf --all-pages
```

Exit-code: `0` — успех (FEN распознан), `1` — ошибка распознавания (не
найдена рамка доски, не открылась картинка/PDF и т. п.).

## Использование (Node API)

```ts
import {
  recognizeBoardImage,
  recognizeBoardFen,
  recognizePdfBoards,
  findDiagramsOnPage,
} from '@kingside/board-image-to-fen';

// Растровый: полный результат.
const result = await recognizeBoardImage('/path/to/diagram.jpg');
console.log(result.fen);                 // 'r2qk2r/.../R1B2RK1 w - - 0 1'
console.log(result.fen_board);           // 'r2qk2r/.../R1B2RK1'
console.log(result.low_confidence_cells); // клетки, которые стоит проверить вручную

// Растровый: только FEN-board.
const fenBoard = await recognizeBoardFen('/path/to/diagram.jpg');

// Растровый с профилем Дворецкого (KS-2132).
const dvor = await recognizeBoardImage('/tmp/dvoretsky_1_3.png', {
  profile: 'dvoretsky',
});

// Найти все доски на странице книги (KS-2132 мульти-диаграммный pre-step).
const { diagrams } = await findDiagramsOnPage('/tmp/page17.png');
for (const d of diagrams) {
  console.log(`#${d.index}: bbox=${d.bbox.join(',')}`);
}

// PDF: все диаграммы со всех страниц.
const boards = await recognizePdfBoards('/path/to/book.pdf');
for (const b of boards) {
  console.log(`p${b.page}#${b.diagram}: ${b.fen_board}`);
}

// PDF: одна страница.
const pageBoards = await recognizePdfBoards('/path/to/book.pdf', { page: 21 });

// Универсальный (KS-2362): любой piece-style + photo. Под капотом
// board_detect.py → ONNX MobileNetV3-Small → FEN + sanity.
// Требует ONNX-модель (KS-2361); путь — через modelPath или env
// BOARD_RECOG_MODEL_PATH.
import { recognizeUniversal } from '@kingside/board-image-to-fen';
const uni = await recognizeUniversal('/tmp/lichess_screenshot.png', {
  profile: 'auto',                       // 'auto' (default) | 'generic' | 'maizelis' | 'dvoretsky'
  modelPath: process.env.BOARD_RECOG_MODEL_PATH,
});
if (uni.usedProfile === 'generic') {
  console.log(uni.fen, uni.sanity.issues, uni.low_confidence_cells);
}
```

Опции (растр):

- `orientation: 'white' | 'black'` — кто внизу доски.
- `pythonPath: string` — путь к интерпретатору Python (по умолчанию `python3`).
- `templatesImage: string` — переопределить встроенный набор шаблонов
  одной размеченной картинкой начальной позиции.
- `profile: 'maizelis' | 'dvoretsky'` — профиль шрифта диаграмм (KS-2132).
  По умолчанию `'maizelis'`.

Опции (`recognizeUniversal`, KS-2362):

- `profile: 'auto' | 'generic' | 'maizelis' | 'dvoretsky'` — стратегия.
  `auto` (default) запускает generic-пайплайн и при ошибке/невалидном
  sanity-чеке откатывается на `maizelis`.
- `orientation: 'auto' | 'white' | 'black'` — `auto` определяет по
  положению королей.
- `modelPath: string` — путь к ONNX-модели MobileNetV3-Small (KS-2361).
  Иначе берётся из env `BOARD_RECOG_MODEL_PATH`.
- `unetModelPath: string` — опциональная UNet для board_detect fallback.
- `lowConfidenceThreshold: number` — порог top-1 prob (default 0.85).
- `pythonPath`, `templatesImage` — как у `recognizeBoardImage`.

Опции (PDF):

- `page: number` — распознать только эту страницу (1-indexed).
- `allPages: boolean` — обойти все страницы (по умолчанию `true`, если `page` не задан).
- `orientation: 'white' | 'black'`, `pythonPath: string` — как у растра.

## Алгоритм

Целевые диаграммы — единый стиль из книги Майзелиса (PDF-парсинг Капабланки):
доска с двойной рамкой, чёрно-белыми контурами фигур, диагональной
штриховкой тёмных клеток, без подписей файлов/рангов на самой доске. Это
позволяет обходиться template matching, без обучаемой модели:

1. **Детекция рамки.** Otsu-threshold → проекция тёмных пикселей по
   столбцам выявляет вертикальные линии рамки (>60% высоты). Между ними
   ищем горизонтальные линии (>80% ширины полосы между вертикалями). Так
   избегаем влияния буквенных/числовых меток вне доски (диаграмма 16).

2. **Сегментация.** Внутренняя зона рамки делится на 8×8 клеток; каждая
   нормализуется до 50×50 пикселей (cv2.INTER_AREA).

3. **Признаки клетки.**
   - `cm5` — масса после морф-открытия 5×5 в центре (отделяет чёрные
     фигуры с заливным силуэтом от белых/пустых: тонкие линии 5×5 не
     переживают);
   - `cm3` — масса после морф-открытия 3×3 (применяется в NCC);
   - `sw` — площадь «белых островков» в центре после морф-открытия 3×3
     прямого порога (различает пустую тёмную клетку и белую фигуру на
     тёмной — у белой видна светлая внутренняя часть).

4. **Решение пусто/цвет.**
   - `bg=light, sw ≥ 800` → пусто;
   - `bg=dark, sw > 150` → белая фигура;
   - `bg=dark, sw ≤ 150, cm5 < 350` → пусто;
   - `cm5 ≥ 350` → чёрная фигура;
   - иначе → белая фигура.

5. **Тип фигуры — NCC.** Шаблоны фигур извлекаются из 3 размеченных
   диаграмм (`templates/maizelis_start.jpg`, `templates/maizelis_mate_ch1.jpg`,
   `templates/maizelis_mate_ch2.jpg`) и хранятся как список масок per
   `(piece, bg)`. Для каждой кандидатной фигуры берётся `max(NCC)` по её
   шаблонам — это компенсирует расхождения шрифта между главами книги
   (король главы 2 нарисован с короной, не как простой крест).

6. **Эвристика k↔q (только при близких NCC).** Если top-1 — чёрный король,
   top-2 — чёрный ферзь и разница NCC < 0.10, разрешаем по числу «зубцов»
   верхушки силуэта: 1–2 → король, ≥ 3 → ферзь.

## Калибровка порогов

Все эмпирические пороги (`COLOR_MASS5_THRESHOLD`, `SOLID_WHITE_DARK_PIECE`,
`SOLID_WHITE_LIGHT_EMPTY`, `LOW_CONFIDENCE_THRESHOLD` в
`src/python/recognizer.py`) подобраны на 21 размеченной диаграмме и
обеспечивают разделение классов с запасом. Если стиль рисунков
изменится (другая книга), потребуется перекалибровка — наберите новые
эталонные диаграммы и пересоберите шаблоны.

## Тесты

```sh
# vitest на 21 фикстуре. Картинки берутся из /tmp/courses/parsed/primer/images.
npm --prefix /project/packages/board-image-to-fen run test
```

Acceptance: `Точность по фигурам ≥ 95%` (см. KS-2028). Текущая реализация
на тестовом наборе даёт **100%** (1344/1344 клеток, 21/21 FEN exact).

Также можно прогнать Python-скрипт напрямую без TS-обёртки:

```sh
python3 packages/board-image-to-fen/src/python/recognizer.py /tmp/courses/parsed/primer/images/Autogen_eBook_id0.jpg
# rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1
```

## Поддержка PDF (Chess-Merida)

В книгах Калиниченко (изд. «Шахматы. Классики», 2016) диаграммы набраны
не растром, а шрифтом `Chess-Merida-Regular` (PUA `U+F021..U+F077`). Для
таких файлов растровый пайплайн не нужен и не используется.

**Алгоритм PDF-пути** (`src/python/pdf_recognizer.py`):

1. PyMuPDF читает страницу как `dict` (`page.get_text('dict')`).
2. На странице ищется блок текста размером 10×10 глифов в шрифте
   `Chess-Merida-Regular` (одна диаграмма):
   - строка 0 — верхняя рамка `F021 F022×8 F023`;
   - строки 1..8 — ряды доски, сверху вниз (`F024 <8 клеток> F025`);
   - строка 9 — нижняя рамка `F02F F028×8 F029`.
3. Каждый глиф клетки переводится в FEN-символ по `PIECE_MAP`. У одной и
   той же фигуры два глифа (для светлой и тёмной клетки) — оба сводятся
   к одному FEN-символу. Заглавные буквы P/R/N/B/Q/K — белые,
   нестандартные O/T/M/V/W/L (и их строчные пары) — чёрные.
4. На странице может быть несколько диаграмм — выводятся в порядке
   чтения (сверху вниз, слева направо).

Этот путь детерминированный: ни OpenCV, ни шаблонов не требует.
На главе 1 PDF Калиниченко 2016 (страницы 14–22, 19 диаграмм) утилита
даёт FEN, совпадающий с верифицированными эталонами KS-2028 (там же,
где они пересекаются).

Если шрифт диаграмм в новой книге другой — нужно будет расширить
`PIECE_MAP` (новые кодпойнты) и/или паттерн рамки.

## Профиль Дворецкого (KS-2132)

Книги издательства Russian Chess House («Учебник эндшпиля» Дворецкого и др.)
используют собственный шрифт фигур и более плотную диагональную штриховку
тёмных клеток. Для такого источника:

- Источник DjVu (без текстового слоя), извлекается в PNG через `ddjvu`
  (`apt install djvulibre-bin`):

  ```sh
  ddjvu -format=ppm -page=11 dvoretsky.djvu /tmp/page11.ppm
  python3 -c "from PIL import Image; Image.open('/tmp/page11.ppm').save('/tmp/page11.png')"
  ```

- На странице книги обычно несколько диаграмм; найди их через
  `--scan-page`, вырежи каждый bbox в отдельный PNG (`Pillow.crop`), затем
  для каждой запусти `recognizeBoardImage(path, { profile: 'dvoretsky' })`.

- **Кроп должен совпадать с inner-board без расширения** — профиль
  Дворецкого работает в режиме `frame_detection='frameless'` (весь кадр
  принимается за inner-bbox). bbox от `--scan-page` уже включает padding
  ±4 пикселя — этого достаточно, дополнительно расширять не надо. Если
  кроп содержит лишний текст или метки вокруг доски, разметка 8×8
  уедет на пиксели и фигуры в углах потеряются.

- На странице 9 (диаграмма 1.1 «Учебника эндшпиля») внешняя рамка доски
  отсутствует, на 1.2/1.7 рамка прерывается звёздочками-пометками.
  `--scan-page` для них bbox не находит — нужен ручной кроп точно по
  доске (например, через GIMP или Pillow с известными координатами).
  Эти три диаграммы исключены из автоматических тестов KS-2132.

- Дворецкий часто помечает ключевые поля внутри клеток звёздочками,
  кружочками и стрелками. Эти пометки не часть позиции, но
  template-матчинг может ошибочно подобрать им «фигуру» с очень низким
  confidence (попадают в `low_confidence_cells`). После распознавания
  такие клетки нужно вычитать вручную или сравнить с верифицированным
  FEN. Полностью игнорировать пометки можно будет только после
  тренировки отдельного «не-фигурного» классификатора — вне MVP.

### Алгоритм dvoretsky-профиля

В отличие от Maizelis (sw/cm5 пороги + NCC по фигурам) у Дворецкого:

1. **Frameless разметка.** Bbox = весь кадр; клетки = `cell_w × cell_h`
   с `cell_w = w/8`, `cell_h = h/8`. Никакого автоматического поиска
   рамки.
2. **Otsu-бинаризация cell + IoU.** Шаблоны 12 фигур + явный шаблон
   пустой клетки на каждом фоне, бинаризованы Otsu (тёмные пиксели
   = 1). Cell бинаризуется так же; argmax по IoU между cell-маской и
   шаблонами того же фона.
3. **Шаблоны из мульти-растеризаций.** 13 источников (`DVORETSKY_TEMPLATE_SOURCES`):
   7 моих (главы 1, 2, 4, 8, 12) + 6 content (глава 1, другая
   ddjvu-растеризация). Otsu+IoU обобщается между разными DPI лучше
   чем L2 на morph-open масках, но запас по разнообразию шрифта
   сохраняется.

Историческая справка для контекста:

- **L2 на morph-open масках** (фаза 1, KS-2132 коммит a58aadf6 +
  калибровка): работал на моих 7 фикстурах 100%, но на content
  растеризации (другой DPI) выдавал мусор — попиксельный L2
  чувствителен к антиалиасингу шрифта.
- **L2 + расширение шаблонов на 2 растеризации** (фаза 2): помогло
  локально, но на batch2 от content (новые позиции той же
  растеризации) снова выдавал мусор `q` повсеместно. Корень — пешки
  в разных диаграммах нарисованы с разным размером и центрированием
  внутри клетки; L2 их не обобщает.
- **Otsu+IoU** (фаза 3): IoU считает площадь пересечения, не
  попиксельное соответствие — устойчив к субпиксельным сдвигам и
  разнице антиалиасинга. На batch2 мусор `q` исчез, классы видны
  корректно (точная exact-FEN сверка ждёт верифицированных эталонов
  от content).

Параметры (`Profile`):

- `frame_detection='frameless'` — игнорировать поиск рамки;
- `classifier_mode='iou'` — IoU вместо L2;
- `use_empty_templates=True` — собирать шаблоны empty-клеток;
- `empty_distance_bias=1.15` — для L2-режима, в IoU не используется;
- `mask_open_kernel=2` — для L2-режима, в IoU не используется.

### Результат

13 эталонных диаграмм из двух разных растеризаций одного DjVu
(`test/fixtures/dvoretsky/`):

- Set 1 — backend's растеризация, 7 фикстур, главы 1, 2, 4, 8, 12
  (`dvoretsky_*.png`, 441×449 для гл.1 / 510×510 для остальных). Покрывает
  king/queen/rook/bishop/knight/pawn × white/black, светлая и тёмная клетки.
- Set 2 — content's растеризация того же DjVu, 6 фикстур только из главы 1
  (`diag_1.{1..7}.png` без 1.6, 356×363). KS-2132 фаза 2: при первой
  итерации профиль работал на Set 1, но на Set 2 (другой DPI/антиалиасинг
  ddjvu) выдавал мусор. Фикс — загружать шаблоны из обеих растеризаций;
  L2-distance находит ближайшую.

На объединённом наборе:
- **100%** per-piece accuracy (832/832 клеток);
- **13/13** exact-FEN сверка.

Spec: `test/dvoretsky.spec.ts` (skip-by-default если в среде нет cv2).

**Если recognizer выдаёт мусор на твоём кропе:** скорее всего у тебя
третья растеризация (другой ddjvu / Pillow / DPI), не покрытая текущими
шаблонами. Решение — добавь свой кроп в `src/templates/dvoretsky/` и
строку в `DVORETSKY_TEMPLATE_SOURCES` (Python). Шаблоны мульти-растеризации
объединяются автоматически.

## Известные ограничения

- Растровый путь заточен под стиль Майзелиса. Универсальный
  распознаватель шахматных диаграмм (lichess, chess.com, других
  учебников) — не цель MVP.
- PDF-путь требует шрифт `Chess-Merida-Regular`. Диаграммы, набранные
  другим chess-шрифтом (например, `ISChess` — он встречается в той же
  книге Калиниченко для inline-нотации), не распознаются — только
  диаграммы основных позиций.
- Не пытаемся определять side-to-move, права рокировки, en-passant —
  утилита распознаёт только расстановку фигур; вторая часть FEN
  фиксированная: `w - - 0 1`.
- Если штриховка тёмных клеток заметно отличается по плотности от
  калиброванных диаграмм, могут «протекать» false-positive фигуры —
  тогда увеличить морф-ядро в `_open_mask` или повысить
  `SOLID_WHITE_DARK_PIECE`.

---

## Универсальный YOLO-pipeline (KS-3091 v4 / KS-3110)

С мая 2026 в проекте есть отдельный путь распознавания через YOLO
object detection — он работает на ЛЮБОМ стиле досок (lichess, chess.com,
наш UI, скриншоты UI с обвязкой, книги со штриховкой, частично — фото
реальных досок). Это замена per-cell ONNX-классификатора предыдущей
итерации (v1.0.0, ADR-040), который был чувствителен к фону клетки.

Два этапа inference:

1. **find-boards** (Stage 0, KS-3110, модель `findboards_v1.0.0`).
   Один класс — `board`. На исходном скриншоте находит **все** доски,
   возвращает массив bbox. Снимает три класса проблем:
   - страницы с несколькими досками (учебник, страница пазлов);
   - доски с UI/текстом вокруг;
   - крупные шахматные графики вне доски (рекламы, логотипы) больше не
     ловятся как доска.

2. **find-pieces** (Stage 1, KS-3091 v4, модель `v2.0.0`). YOLOv8n с 12
   классами фигур (`wK..bP`). Для каждой найденной доски делает crop +
   resize в 512×512 + один прогон ONNX → список bbox фигур →
   маппинг центров на сетку 8×8 → FEN.

Этап Stage 0 опционален: без него pipeline деградирует к одиночной
доске через эвристический corner-detector.

### CLI

```sh
# Двухэтапный режим (find-boards включён).
python3 src/python/board_recognize_yolo.py путь/к/картинке.png \
    --model путь/к/find-pieces.onnx \
    --find-boards-model путь/к/find-boards.onnx \
    --json

# Одиночный режим (corner-detector + find-pieces).
python3 src/python/board_recognize_yolo.py путь/к/картинке.png \
    --model путь/к/find-pieces.onnx \
    --json

# Только FEN-строка первой доски в stdout, без диагностики.
python3 src/python/board_recognize_yolo.py путь/к/картинке.png \
    --model путь/к/find-pieces.onnx \
    --find-boards-model путь/к/find-boards.onnx
```

Скачать модели с прод-S3:

```sh
aws s3 cp s3://kingside-ml/models/board-recog/v2.0.0/model.onnx \
          find-pieces.onnx --region eu-central-1
aws s3 cp s3://kingside-ml/models/board-recog/findboards_v1.0.0/model.onnx \
          find-boards.onnx --region eu-central-1
```

Зависимости Python для YOLO-пути: `onnxruntime`, `numpy`, `opencv-python`,
`Pillow`. ultralytics в проде не нужен (используется только для
тренировки/экспорта).

### API (`@kingside/board-image-to-fen`)

```ts
import { recognizeUniversal } from '@kingside/board-image-to-fen';

const result = await recognizeUniversal('image.png', {
  profile: 'generic',
  modelPath: '/path/to/find-pieces.onnx',
  findBoardsModelPath: '/path/to/find-boards.onnx',  // опц., KS-3110
});

console.log(result.fen);            // FEN первой доски
console.log(result.boards?.length); // массив, если найдено > 1 доски
```

### Контракт ответа

Single-board (одна доска на скриншоте ИЛИ find-boards отключён):

```jsonc
{
  "success": true,
  "fen": "5rk1/.../R5K1 w - - 0 1",
  "fen_board": "5rk1/.../R5K1",
  "orientation": "white",
  "bbox": [x0, y0, x1, y1],
  "cells": [/* 64 ячейки */],
  "low_confidence_cells": [/* < threshold */],
  "sanity": { "valid": true, "issues": [] }
}
```

Multi-board (≥ 2 досок на скриншоте):

```jsonc
{
  "success": true,
  "boards": [{ /* single-board result для доски 1 */ }, { /*  для доски 2  */ }, ...],
  "n_boards_found": N,
  // корневые поля дублируют первую success-доску для back-compat:
  "fen": "...", "fen_board": "...", "orientation": "...", "bbox": [...],
  "cells": [...], "low_confidence_cells": [...], "sanity": {...}
}
```

REST-контракт API (POST `/api/board-recognition`) идентичен, только
ключи в camelCase: `fenBoard`, `lowConfidenceCells`, опциональное
`boards?: BoardRecognitionResponse[]`.

### Деплой / переключение на проде

ENV-переменные у `apps/api`:

- `BOARD_RECOG_PIPELINE=yolo` — переключатель на YOLO-pipeline. Без него
  работает старый per-cell классификатор (v1.0.0, back-compat).
- `BOARD_RECOG_MODEL_VERSION=2.0.0` — find-pieces. `docker-entrypoint.sh`
  скачивает с `s3://kingside-ml/models/board-recog/v2.0.0/model.onnx` в
  `/var/cache/board-recog/model.onnx`.
- `BOARD_FINDBOARDS_MODEL_VERSION=1.0.0` — find-boards (опционально).
  Качается с `findboards_v1.0.0/model.onnx`. Без переменной — graceful
  degrade к single-board через corner-detector.

Откат на v1: снять `BOARD_RECOG_PIPELINE`, вернуть
`BOARD_RECOG_MODEL_VERSION=0.9.5`, redeploy. Никаких миграций.

### Известные ограничения

- **Реальные физические 3D-доски (фото)** — out-of-distribution для
  текущего train. Bbox-ы находятся, но классы фигур путаются. Лечится
  добавлением открытых датасетов (ChessReD CC-BY-4.0, Chess Cog MIT)
  в train — отдельный тикет.
- **Книжные учебники с outlined-фигурами** (Майзелис, Калиниченко) —
  модель путает цвет: белая фигура с прозрачной заливкой и чёрным
  контуром читается как чёрная. Лечится добавлением outlined-стилей в
  train.
- **Multi-board на странице пазлов** — find-boards находит ВСЕ доски,
  но качество find-pieces на маленьких досках (≤200px) деградирует
  (sanity OK у ~50% досок). Лечится более крупным imgsz при тренировке
  find-pieces или подачей crop'ов upscale до 512.

### Документация по тренировке

См. `docs/operations/ml-training-board-recog-runbook.md` (общий runbook)
+ ADR-040-v2 (`docs/adr/040-v2-board-recognition-retraining.md`) — там
описаны принципы train/val разделения по piece-set'ам и acceptance-gate.
Конкретные параметры YOLO-итерации в commit'ах KS-3091 v4 и KS-3110.

### Файлы

- `src/python/board_recognize_yolo.py` — YOLO inference pipeline (Stage 1+2).
  Функции `recognize()` (single), `recognize_multi()` (с find-boards),
  `find_boards()` (только Stage 0), `_recognize_from_warped()` (core).
- `src/python/board_dataset_gen.py` — генератор синтетического датасета
  для find-pieces (KS-3091 v4).
- `src/python/find_boards_dataset_gen.py` — генератор для find-boards
  (KS-3110): сцены 1024..1920 px с 1..8 досками и контекстным шумом.
- `src/python/background.py` — процедурные фоны клеток (штриховка,
  градиенты, шумы) для bg-invariance.
- `src/python/training/train_foundation.py` — finetune ResNet18 ImageNet
  для предыдущей итерации (per-cell). Сейчас не используется.
