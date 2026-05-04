# ADR-040 — Универсальное распознавание шахматной диаграммы

## Статус

Proposed (KS-2358). Реализация — в backlog'е после раскладки тикетов.

## Контекст

### Проблема

Пользователь хочет «как в chessify»: скинул скриншот доски — получил FEN.
Должно работать на:

- скриншоты lichess (стили `cburnett`, `merida`, `alpha`, `wikipedia`,
  `staunty`, `pirouetti` и др.; разные расцветки доски);
- скриншоты chess.com (`classic`, `modern`, `neo`, `wood`,
  `ice-sea`, `light` и т. п.);
- скриншоты нашего UI Kingside (react-chessboard, тема по умолчанию + темы из
  `BoardSettingsContext`);
- фото реальной доски (произвольный ракурс, освещение, кадрирование);
- диаграммы из учебников разных шрифтов и стилей штриховки.

Существующий `packages/board-image-to-fen` (KS-2028, KS-2030, KS-2132) решает
**другую задачу**: распознавание узких книжных стилей (Майзелис, Калиниченко,
Дворецкий) через template matching и PDF-парсинг. Универсальным распознавателем
он не является и не масштабируется на десятки стилей — пороги и шаблоны
калибруются под конкретный шрифт фигур.

### Внешние ограничения

- Команда — один разработчик; решения, которые требуют дорогой инфраструктуры
  (T4-инстанс под inference) — не подходят. Нужно укладываться в текущий
  backend-процесс или отдельный лёгкий сервис.
- ML-стек должен переноситься между dev (Mac/Linux) и prod (Linux) без
  пересборки от каждой версии CUDA.
- Запрет привязки к коммерческим API (chessify, Roboflow inference, AWS
  Rekognition) — собственный код end-to-end.

### Что уже есть

- `packages/board-image-to-fen` — Python-скрипты вызываются через
  `child_process.spawn` из TS-обёртки. CLI и Node API. Возвращает
  `RecognizeResult` с FEN, bbox, confidence по 64 клеткам. Эта схема
  «TS-обёртка над Python» — переносится и в новый код-путь.
- Backend api на NestJS уже использует `@aws-sdk/client-ecs` (для управления
  ECS Run-task'ами индексатора). AWS-доступ сконфигурирован.
- В Docker-образе backend'а Python и OpenCV уже установлены (необходимы для
  существующего пакета).

## Решение (общая архитектура)

Трёхступенчатый пайплайн с обучаемым классификатором клеток и эвристической
сборкой FEN'а. Реализация — в новом коде-пути внутри `packages/board-image-to-fen`,
не заменяет, а расширяет существующие.

```
┌────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────┐
│ Image (PNG/JPG)│→│ Stage 1: Board det. │→│ Stage 2: Cell classif│→│ Stage 3: FEN   │
│ ≤ 8MB          │  │ corners → warp 512² │  │ 64 cells × CNN→13 cl│  │ + ориентация   │
└────────────────┘  └─────────────────────┘  └─────────────────────┘  └────────────────┘
```

### 1. Стек

| Компонент | Выбор | Альтернатива | Почему |
|---|---|---|---|
| Тренировка | **PyTorch 2.x** | TensorFlow/Keras | Меньшая ceremony, прямая экспорт в ONNX, существующий Python в репо. |
| Inference | **onnxruntime (Python биндинг)** | TF Lite, PyTorch JIT | Один формат модели работает в Python (наш runtime), браузере, мобайле. CPU достаточен для 64-клеточного батча. |
| CV | **OpenCV (Python)** | Pillow + scikit-image | Уже в зависимостях. Hough/contour/perspective warp — стандартные функции. |
| Аугментация | **albumentations** | torchvision.transforms | Богатый набор тренировочных аугментаций, поддерживает bbox-aware. |
| Рендер датасета | **node + react-chessboard** для нашего стиля; **CDN-копии** lichess/chess.com SVG-фигур; **Python+Pillow** склеивает | — | Доска — простая 8×8 сетка, не нужен real browser. SVG-фигуры доступны в open-source репозиториях. |

GPU **не требуется**: модель целевая 200–500 KB параметров, inference на CPU
для 64 клеток ≤ 100 мс. На обучении — 1 GPU арендуем за час–два через любого
провайдера (Google Colab, Lambda Labs); это разовая операция per release
модели.

### 2. Структура пайплайна

#### Stage 1 — Board detection и perspective warp

Цель: на произвольном входе найти 4 угла квадратной доски и привести её к
квадрату 512×512 px (без полей, без рамки).

Алгоритм (в порядке fallback'а):

1. **Detection-only model.** Маленькая сегментация (UNet 256×256, ~200 KB) даёт
   маску «доска». Из маски — контур, `cv2.minAreaRect` → 4 угла.
2. **Heuristics fallback.** Если маска пустая или confidence низкий —
   `cv2.findContours` на бинаризации, фильтр по площади/aspect ≈ 1, поиск
   четырёхугольника через `cv2.approxPolyDP`.
3. **Manual.** Если и тот, и другой не нашли — endpoint возвращает `400` с
   причиной «board not detected, please crop manually» + frontend показывает
   ручной кадратор.

После нахождения углов — `cv2.getPerspectiveTransform` → `cv2.warpPerspective`
в 512×512.

Дополнительно: предсказание ориентации (кто внизу — белые/чёрные). MVP —
эвристика по подписям файлов/рангов (детект латинских букв `a..h` и цифр
`1..8` по краю warped изображения через простой template/OCR на одну букву);
fallback — пользователь подтверждает на frontend'е.

#### Stage 2 — Cell classification (CNN)

Доска 512×512 → 64 клетки по 64×64 px (overlap 0 px).

**Классификация:** 13 классов:

```
0: empty
1: P  2: N  3: B  4: R  5: Q  6: K   (white)
7: p  8: n  9: b  10: r  11: q  12: k (black)
```

Архитектура (выбор для MVP):

- **MobileNetV3-Small (отрезанный)** — backbone до stage_4, вход 64×64×3, выход
  логиты 13. Параметров ~600 KB, FLOPs ≤ 30 M на клетку. Хорошее обобщение по
  стилям, проверенное в литературе.
- **Альтернатива (если MNV3 даст лишний оверхед)** — собственный 5-слойный
  CNN: `Conv32-MaxPool → Conv64-MaxPool → Conv96 → GAP → FC13`. Параметров
  ~150 KB. Тренировать быстрее, но обобщает чуть хуже на нестандартных стилях.

**Решение:** старт на MobileNetV3-Small. Если бенчмарк после E5 покажет, что
custom-CNN даёт ту же accuracy, — заменим (легко, формат входа/выхода тот же).

**Loss:** `CrossEntropyLoss` с class-balanced sampling (пустых клеток в датасете
~50%, фигур — равномерно). Альтернатива — focal loss; пробуем при дисбалансе ≥
3:1.

**Dual-head вариант (отложенный):** `head_color` (3 кл: empty/white/black) +
`head_type` (7 кл: empty/p/n/b/r/q/k). Меньше путаницы между фигурами одного
типа разного цвета. **MVP — single head 13 кл**, dual вводим только если
single даёт ошибки цвета на тёмных клетках.

#### Stage 3 — Сборка FEN и эвристики

1. **64 предсказания → board-row.** Стандартная FEN-нотация по 8 рядов
   сверху вниз.
2. **Side-to-move.** В MVP — не определяем, ставим `w` (как сейчас в
   board-image-to-fen). Frontend показывает пользователю выбор (`белые/чёрные`).
   Roadmap: Stockfish-санити-чек: если позиция-кандидат с `w to move` имеет
   `eval > +20` или `mate in 1` для слабой стороны — вероятно `b to move`.
   Пока вне MVP.
3. **Рокировки и en-passant** — невозможно надёжно определить из одной
   позиции; ставим `KQkq` по умолчанию (с frontend-confirmation, если
   ладья/король сдвинуты — пользователь снимает права). En-passant: `-`.
4. **Sanity-чеки:**
   - 1 белый король и 1 чёрный король (иначе — flag «ambiguous»).
   - Пешек на 1-й и 8-й горизонтали быть не может.
   - Сумма фигур ≤ 32 (с пешками промоушен — допустимо несколько ферзей).
5. **Ориентация:** если детект файлов/рангов нашёл `a` снизу-слева — `white
   bottom`; иначе — `black bottom` (надо `flip` board перед отдачей FEN).
   Эвристика рисует серый фон под `confidence: 'low'` если не уверена —
   frontend позволяет flip-кнопкой.

### 3. Датасет

#### 3.1. Программная генерация

Цель — иметь **100 000+ размеченных клеток на каждый стиль**, без ручной разметки.

Процесс per стиль `S`:

1. Загрузить асет-набор стиля: 12 PNG-фигур + 2 цвета клеток (light/dark).
   Источники:
   - lichess: `lila/public/piece/{cburnett,merida,alpha,...}` — open-source
     SVG, конвертим в PNG через rsvg-convert.
   - chess.com: их public CDN раздаёт PNG-спрайты для бесплатных стилей
     (`classic`, `wood`, `light`); закрытые премиум-стили **не используем**
     (privacy: легально использовать публичные ассеты, но премиум — серая зона).
   - Kingside: `react-chessboard` v5 ассеты (cburnett по умолчанию + наши
     темы из `BoardSettingsContext`).
   - Учебники: уже размеченные шаблоны из `packages/board-image-to-fen/src/templates/`
     (Maizelis, Dvoretsky, Chess-Merida).
2. Сгенерировать 1000–5000 случайных правдоподобных FEN'ов:
   - 30 % из реальных партий (`archive_games.pgn` → случайный middle-game ply).
   - 30 % из puzzle-database (`Puzzle.fen`).
   - 20 % старт-позиция и эндшпили из `packages/board-image-to-fen/test/fixtures/`.
   - 20 % синтетических с K + 0–10 случайных фигур (для покрытия редких
     случаев — голый король, под-промоушен и т. п.).
3. Для каждого FEN'а отрендерить доску 512×512 в стиле `S`:
   - Composite: фон-доска 512×512 + 64 клетки 64×64 с фигурами/пустыми.
   - Файл сохранить как `dataset/<S>/<fen-hash>.png` + JSON с
     `{ "fen": "...", "orientation": "white" }`.
4. Нарезать на клетки → `dataset_cells/<S>/<fen-hash>_<row><col>.png` +
   метка класса.

#### 3.2. Аугментация

`albumentations.Compose([...])` per training batch:

- `RandomScale(scale_limit=0.1)` — небольшие изменения масштаба клетки.
- `Rotate(limit=3)` — поправка на скриншоты с ±3° наклона.
- `RandomBrightnessContrast(p=0.5)` — фото с разным освещением.
- `GaussNoise(var_limit=(10, 50), p=0.3)` — шум камеры.
- `MotionBlur(blur_limit=3, p=0.2)` — фото из движения.
- `RandomShadow`, `RandomGamma` — освещение фото-доски.
- `JpegCompression(quality_lower=70, p=0.5)` — реалистичные скриншоты часто
  пережаты.

Augmentation **только для тренировки**, validation — оригинальные клетки.

#### 3.3. Реальные фото

Отдельный мини-сет (~500 фото) реальных досок — снимаем сами в офисе/дома или
берём публичные датасеты (например, `jovial/chess-boards-dataset` на Kaggle —
лицензия CC-BY-4.0, проверить). Эти фото **только в test/eval-сете**, не в
тренировочном — иначе модель «выучит» именно эти доски.

#### 3.4. Размер датасета и stratification

- ~10 стилей × 2000 уникальных позиций × 64 клетки = **~1.28 M клеток**.
- Из них ~50 % empty → балансируем по классам в DataLoader (WeightedRandomSampler).
- Train/val/test = 80/10/10 по позициям (не по клеткам — иначе утечка).
- Test-set extra: 500 реальных фото (из 3.3) — не пересекается со train/val.

#### 3.5. Хранение датасета

- В git **не храним** — слишком большой.
- На S3-бакете `kingside-ml/datasets/board-recog/v<N>/` (devops создаёт бакет).
- В репо лежит только `dataset_manifest.yml` со списком стилей, версий
  ассетов, FEN-источников и SHA256 итоговых архивов.

### 4. Модель: тренировка и оценка

#### 4.1. Тренировка

- Скрипт `packages/board-image-to-fen/src/python/training/train.py`:
  - аргументы: `--data-dir`, `--epochs`, `--batch-size`, `--lr`, `--output`.
  - PyTorch Lightning или чистый train-loop (выбор автора).
  - Adam, lr=1e-3, cosine schedule, 20 эпох на старте.
  - Early-stop по val loss (patience=3).
- Запуск — на арендованном GPU-инстансе или Colab. **Не на проде.** Артефакт —
  `model.pth`.

#### 4.2. Экспорт в ONNX

- `torch.onnx.export` с input shape `(B, 3, 64, 64)` где B = 64 (размер
  батча — все клетки одной доски). opset 17.
- Валидация: `onnx.checker.check_model` + `onnxruntime.InferenceSession`-прогон
  на 100 случайных батчах из val-сета, сверка outputs с PyTorch (atol=1e-4).

#### 4.3. Метрики

- **Per-class accuracy** (13 значений) — выявить, где модель путает (типичный
  кейс: `b` vs `n` на тёмной клетке).
- **Per-style accuracy** — отдельная цифра на каждый из 10 стилей. Цель:
  ≥ 99 % per-cell на любом из топ-3 стилей (lichess cburnett, chess.com
  classic, наш Kingside default), ≥ 95 % на остальных синтетических, ≥ 90 %
  на real-photo тесте.
- **End-to-end FEN match rate** — сколько процентов позиций распознано
  **полностью без ошибок** (64/64 клетки). Цель: ≥ 90 % на синтетике, ≥ 70 % на
  real-photo. Эта метрика жёстче, чем per-cell, — одной ошибки достаточно для
  «нет матча».
- **Latency budget** — 95-й перцентиль end-to-end (image upload → FEN response)
  ≤ 2 сек на 1080p входе.

Метрики сохраняются в `evaluation_report.json` и кладутся рядом с моделью в
S3.

#### 4.4. Версионирование модели

- Каждый train-run производит артефакт с тегом `model_v<MAJOR>.<MINOR>.onnx`,
  где MAJOR — несовместимое изменение (новый input shape, новый набор
  классов), MINOR — новая итерация на новом датасете.
- В backend в env-переменной `BOARD_RECOG_MODEL_VERSION` — какой тег качать.
- Качается при старте контейнера, кэшируется в `/var/cache/board-recog/`.

### 5. Интеграция

#### 5.1. Backend

Новый модуль `apps/api/src/board-recognition/`:

```
board-recognition.module.ts
board-recognition.controller.ts   POST /api/board-recognition (auth, multipart)
board-recognition.service.ts      orchestration: download → child_process → response
dto/recognize-request.dto.ts      multipart, max 8MB, mime-фильтр
dto/recognize-response.dto.ts     fen, bbox, perCellConfidence[64], orientationGuess
```

API-контракт:

```http
POST /api/board-recognition
Content-Type: multipart/form-data

image: <binary>
hintOrientation?: 'white' | 'black'   # если frontend знает (например, скрин нашего UI)
```

Response:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "fenBoard": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
  "orientation": "white",
  "orientationConfidence": 0.92,
  "bbox": [42, 17, 558, 533],
  "modelVersion": "1.0.3",
  "lowConfidenceCells": [
    { "row": 3, "col": 4, "square": "e5", "predicted": "n", "confidence": 0.62 }
  ],
  "warnings": ["two black queens — promotion likely"]
}
```

Errors:

- `400 board_not_detected` — Stage 1 не нашёл доску, frontend предлагает
  ручной кроп.
- `400 image_too_large` / `image_unsupported` — на multipart-уровне.
- `500 model_load_failed` — модель не скачалась/недоступна; backend на старте
  health-checks модель и при недоступности /health-чек выдаёт unhealthy.

Под капотом — `child_process.spawn` Python-скрипта `board_recognize.py` (как
в существующем `recognizer.py`), который читает картинку из stdin (или
временного файла), прогоняет pipeline, возвращает JSON. Параллелизм — за счёт
очереди в backend (1 процесс Python на запрос; concurrency на уровне Nest =
кол-во подов × 4).

Существующий `recognizeBoardImage` (Maizelis/Dvoretsky) **остаётся**: для
учебников он точнее любой generic-модели (и быстрее — без CNN). Endpoint
выбирает алгоритм:

- `?profile=auto` (default) — пытается generic, при низкой confidence —
  fallback на template-matching профили.
- `?profile=maizelis|dvoretsky|generic` — явный выбор.

#### 5.2. Frontend

- Компонент `<BoardImageDropzone>` (новый), в `apps/web/src/components/`.
- Drag&drop / clipboard paste / file picker. Превью загруженной картинки.
- POST на `/api/board-recognition`, индикатор загрузки.
- После ответа — превью распознанного FEN на `<DrillBoard>` рядом с оригиналом.
- Кнопки:
  - «Перевернуть доску» (flip orientation, обновляет FEN).
  - «Это сторона на ходу» — toggle white/black (правит first FEN-поле).
  - «Править» — переход в position-editor (`/editor?fen=...`), там ручная
    правка отдельных клеток.
- Точки появления:
  - Workshop: «Загрузить позицию из картинки» (была в KS-2028 для редактора).
  - Lesson editor (chess-expert/marketing flow): импорт диаграммы.
  - Drill / position-finder (поиск позиции в архиве): «найти позицию по
    скрину».

#### 5.3. DevOps

- S3-бакет `kingside-ml`:
  - `datasets/board-recog/v<N>/` — train data tar-gz.
  - `models/board-recog/v<MAJOR>.<MINOR>/model.onnx + evaluation_report.json`.
  - IAM: backend ECS task имеет `s3:GetObject` на `models/board-recog/*`.
- Dockerfile backend'а:
  - добавить `pip install onnxruntime albumentations`.
  - в entry-point: при старте подтянуть текущую `BOARD_RECOG_MODEL_VERSION`
    в `/var/cache/board-recog/`.
- Health-check: добавить проверку «модель загружена» в существующий
  `health.controller.ts`.

#### 5.4. Где живёт код

Расширяем существующий пакет `packages/board-image-to-fen`:

```
packages/board-image-to-fen/
  src/
    index.ts                 # API: recognizeBoardImage (Maizelis), recognizeUniversal (NEW)
    cli.ts
    python/
      recognizer.py          # Maizelis (legacy)
      pdf_recognizer.py      # Chess-Merida (legacy)
      board_recognize.py     # NEW: универсальный pipeline
      training/              # NEW: вне runtime, для тренировки
        train.py
        dataset_gen.py
        evaluate.py
      models/                # gitignore — кэш скачанной ONNX
    templates/               # legacy maizelis/dvoretsky
```

`recognizeUniversal(imagePath, options)` — новая публичная функция, отдельный
named export. `recognizeBoardImage` (Maizelis) **не удаляем** — продолжает
обслуживать book-specific use-case без CNN.

### 6. Точки интеграции с существующим кодом

| Что | Действие |
|---|---|
| `recognizeBoardImage` (Maizelis) | Остаётся. Используется как fallback при `profile=maizelis` или auto-detect низкой confidence на template-matching path'е. |
| `recognizePdfBoards` (Chess-Merida) | Остаётся. PDF-путь дешевле и точнее CNN — оставляем для книги Калиниченко. |
| `findDiagramsOnPage` | Остаётся. Используется как pre-step для multi-diagram pages. |
| Новые публичные экспорты | `recognizeUniversal(imagePath, opts) → UniversalRecognizeResult`. |

API существующих функций не меняем — обратная совместимость для CLI и
консьюмеров.

### 7. План внедрения

#### Этап 0 — Этот ADR

Готов после этого commit'а.

#### Этап 1 — Board detection (Stage 1)

- Прототип heuristics (OpenCV-only) на ~50 ручных скриншотах разных стилей.
- Решение: достаточен ли heuristics или нужна сегментационная модель.
- Артефакт: `board_detect.py` + bench-метрики.

#### Этап 2 — Dataset generation

- Скрипт `dataset_gen.py`: входит список стилей и FEN-источников, на выходе
  `dataset/<S>/...` + manifest.
- Артефакт: первый зальётся в S3 `datasets/board-recog/v1/`.

#### Этап 3 — Cell classifier (Stage 2)

- Скрипт `train.py` + `evaluate.py`.
- Тренировка на синтетике, оценка на test-сете + real-photo.
- Артефакт: `model_v1.0.0.onnx` + `evaluation_report.json`.

#### Этап 4 — Pipeline + FEN assembly (Stage 3)

- `board_recognize.py` склеивает Stage 1 + Stage 2 + эвристики Stage 3.
- Возвращает JSON. CLI-тест на 50 ручных скриншотах.

#### Этап 5 — Backend integration

- NestJS-модуль `board-recognition`, multipart endpoint, тесты.
- Загрузка модели с S3 на старте, health-check.

#### Этап 6 — Frontend

- `<BoardImageDropzone>`, превью, flip/side-to-move.
- Интеграция в Workshop и lesson editor.

#### Этап 7 — Iteration по слабым стилям

- На основе телеметрии (`lowConfidenceCells`, ошибки пользователя — кнопка
  «модель ошиблась») — добавляем стили, переобучаем.

## Открытые вопросы

1. **Лицензии ассетов.** Lichess piece sets — все open-source (GPL-3 / CC).
   Chess.com бесплатные стили — публичны через CDN, но условия использования
   их ассетов в собственной модели нужно ещё проверить. Если выяснится
   ограничение — генерируем датасет только из safe-list (lichess + наш +
   open clipart) и не показываем chess.com'овский результат как «работает на
   chess.com», а как «работает на типовых веб-стилях».
2. **Side-to-move определение.** В MVP — пользователь подтверждает. После
   выкатки — оценить долю случаев, где Stockfish-санити-чек надёжно
   определяет.
3. **Real-photo датасет.** 500 фото — достижимо silами одного разработчика
   за неделю. Если поднять до 5000 — нужна разметка через chess-expert или
   crowdsourcing.
4. **Доска без рамки внутри картинки** (наш UI без border, плотный фон) — может
   путать board-detection. План — добавить такие случаи в синтетический датасет
   для UNet stage 1 и обучить отдельно.

## Декомпозиция на тикеты

После этого ADR координатор создаёт следующие тикеты в backlog (To Do, без
старта реализации до сигнала пользователя). Для каждого — owner role, scope и
acceptance.

### KS-XXXX-1 [architect → backend] Board detection (Stage 1)

**Scope:**
- `packages/board-image-to-fen/src/python/board_detect.py` —
  heuristics-only вариант (Otsu + contours + perspective warp).
- Если accuracy < 80 % на ручном тесте — задача расширяется на UNet-вариант,
  отдельный mini-dataset (~2000 пар image+mask).
- CLI: `python board_detect.py <image>` → JSON с углами и warped-bbox.
- Тесты: 50 ручных скриншотов разных стилей (10 lichess, 10 chess.com, 10
  Kingside, 10 учебников, 10 фото) — accuracy ≥ 80 % на heuristics; если
  меньше — создаётся подзадача на UNet.

**Acceptance:**
- Скрипт работает в isolation. CLI печатает 4 угла и сохраняет warped 512².
- README обновлён: «Stage 1 — board detection».

### KS-XXXX-2 [chess-expert → backend] Dataset generation (Stage 2-prep)

**Scope:**
- `packages/board-image-to-fen/src/python/training/dataset_gen.py`:
  скрипт ренедерит `<style> × <fen-list>` → клетки + метки.
- chess-expert: курация **списка стилей и приоритетов** (какие 10 стилей
  входят в MVP), сбор и проверка лицензий на ассеты, разметка edge-case
  позиций.
- backend: реализация скрипта, манифест, выгрузка на S3.
- Источник FEN'ов: смесь из `archive_games`, `Puzzle.fen`, синтетика.

**Acceptance:**
- Локальный прогон даёт ≥ 1 М клеток и `manifest.yml` с SHA256 каждого
  стиля.
- Загрузка на S3 (`kingside-ml/datasets/board-recog/v1/`) автоматизирована.
- chess-expert apruv'ил список стилей и лицензии.

### KS-XXXX-3 [backend] Cell classifier training (Stage 2)

**Scope:**
- `packages/board-image-to-fen/src/python/training/train.py`:
  PyTorch + albumentations + ONNX export.
- Тренировочный run на арендованном GPU.
- `evaluate.py`: per-class и per-style accuracy.

**Acceptance:**
- ONNX-модель `model_v1.0.0.onnx` ≤ 1 MB.
- `evaluation_report.json`: per-cell ≥ 99 % на топ-3 стилях, end-to-end
  FEN match ≥ 90 % на синтетике.
- Загрузка модели в S3 (`models/board-recog/v1.0.0/`).

### KS-XXXX-4 [backend] Inference pipeline + FEN assembly (Stage 3)

**Scope:**
- `packages/board-image-to-fen/src/python/board_recognize.py`:
  объединение Stage 1 + Stage 2 + эвристики.
- TS-обёртка `recognizeUniversal()` в `src/index.ts`, тесты vitest.
- CLI флаг `--universal` в `cli.ts`.

**Acceptance:**
- 50-image manual test: end-to-end FEN match rate ≥ 80 % на смешанных стилях.
- `recognizeUniversal()` возвращает `UniversalRecognizeResult` (формат из
  ADR §5.1, JSON-эквивалент).

### KS-XXXX-5 [backend] NestJS board-recognition module

**Scope:**
- `apps/api/src/board-recognition/{module,controller,service}.ts` + DTO.
- Multipart endpoint `POST /api/board-recognition`.
- Auth-guard (только авторизованные).
- Health-check при старте: модель скачана и валидна.
- Юнит и e2e тесты (мок Python child_process).

**Acceptance:**
- Endpoint возвращает контракт ADR §5.1.
- Тесты на error-paths (board_not_detected, model_load_failed,
  image_too_large) зелёные.
- Документация в `docs/architecture/board-recognition-api.md` (контракт +
  примеры).

### KS-XXXX-6 [devops] S3 + model deployment

**Scope:**
- Создать бакет `kingside-ml` (если нет).
- IAM-policy для backend ECS task: `s3:GetObject` на `models/*`.
- Скрипт `tools/upload-board-model.sh` (или эквивалент в существующем
  `scripts/`) — публикует ONNX + report в S3 с тегированием версии.
- Dockerfile backend'а: установка `onnxruntime`, `albumentations`,
  предзагрузка модели в /var/cache.
- env-var `BOARD_RECOG_MODEL_VERSION`, дока в `.env.example`.

**Acceptance:**
- На стейдже backend стартует, тянет модель, health-check зелёный.
- Документация: «как обновить модель» в `docs/devops/`.

### KS-XXXX-7 [frontend] BoardImageDropzone + интеграции

**Scope:**
- `<BoardImageDropzone>` (drag/drop/paste/file picker) + превью + индикатор.
- Точка интеграции в Workshop (KS-2028 placeholder уже был — заменяем).
- Точка интеграции в lesson editor (отдельная подзадача, если editor
  сейчас не готов).
- Кнопки flip / side-to-move / редактировать.
- i18n RU/EN для всех новых текстов.
- Юнит-тесты vitest, e2e Playwright (1 happy-path: drop → распознано → FEN
  превью).

**Acceptance:**
- Drag&drop работает, превью FEN рядом с картинкой.
- Flip и side-to-move меняют FEN корректно.
- e2e зелёный.

### KS-XXXX-8 [chess-expert + backend] Iteration на слабых стилях (post-MVP)

**Scope:**
- Лог `lowConfidenceCells` отправляется в metrics (анонимизированно — без
  самой картинки, только статистика на per-style basis).
- chess-expert: периодически анализирует, какие стили проседают; backend
  расширяет датасет; новый train-run.

**Acceptance:**
- Регулярный (не блокирующий) процесс: каждые 2 недели — отчёт + при
  необходимости новый model_vX.Y.

### Зависимости между тикетами

```
KS-XXXX-1 (board det) ─┐
KS-XXXX-2 (dataset)   ─┼→ KS-XXXX-3 (train) → KS-XXXX-4 (pipeline) → KS-XXXX-5 (backend) ─┐
KS-XXXX-6 (devops)    ─┘                                                                    ├→ stage live
                                                                              KS-XXXX-7 (frontend) ─┘
KS-XXXX-8 (iteration) — после stage live, постоянно.
```

Параллелим: KS-XXXX-1, KS-XXXX-2, KS-XXXX-6 — независимые, можно стартовать
одновременно. KS-XXXX-7 (frontend) можно начать после KS-XXXX-5 (backend
endpoint), либо стабнуть моком.

## Последствия

**Плюсы:**

- Независимость от chessify и других платных API.
- Один пайплайн обслуживает все требуемые стили.
- Артефакт (ONNX) портируется и в браузер позже (для Workshop без backend
  round-trip).
- Существующий легаси-код (`recognizeBoardImage` для книг) не выкидывается.

**Минусы:**

- Сложность инфраструктуры: тренировка модели — отдельный процесс с GPU,
  выгрузка в S3, версионирование, health-checks.
- Зависимости в Docker'е растут: `onnxruntime`, `albumentations` (пара сотен
  МБ).
- Точность на «диком» фото-входе ниже, чем на синтетике; ожидание
  пользователя «как chessify» придётся управлять (UI должен явно
  показывать confidence и предлагать ручную правку).
- Новый код-путь на Python; единый разработчик должен поддерживать
  TS+Python+ML-pipeline.

**Риски:**

- Лицензии ассетов (см. Открытые вопросы 1) могут сократить число стилей в
  датасете.
- ONNX inference на большом объёме (если завирусится) добавит CPU-нагрузку
  на backend; план B — выделенный sidecar-сервис.
- Точность на real-photo может оказаться ниже целевых 70 %; в таком случае
  фото отправляется в editor с пометкой «низкая уверенность».

## Связанные документы

- `packages/board-image-to-fen/README.md` — текущий узкий пайплайн.
- KS-2028, KS-2030, KS-2132 — предыдущие итерации `board-image-to-fen`.
- KS-2358 — этот ADR.
