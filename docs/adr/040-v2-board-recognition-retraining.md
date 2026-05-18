# ADR-040-v2 — Пересмотр board-recognition: датасет, тренинг, acceptance-гейт

## Статус

Proposed (KS-3090). Реализация — после согласования плана с пользователем.

Этот документ — ревизия ADR-040 (`040-universal-board-image-recognition.md`),
не заменяет его. Архитектура пайплайна (Stage 1 detect → Stage 2 classify →
Stage 3 FEN-assembly), форматы артефактов (ONNX, `evaluation_report.json`),
API-контракт `POST /api/board-recognition` и структура пакета
`packages/board-image-to-fen/` — **сохраняются**. Меняется только то, что
сказано в этом документе: §3 (датасет), §4.3 (метрики и порог приёмки),
§5.1 (поведение сервиса при невалидном результате), §5.3 (acceptance-гейт
публикации модели), §7 (план внедрения).

## Контекст

### Что случилось

Модель `v1.0.0` (KS-3071) была обучена по ADR-040 и выкачена на прод. В ночь
17.05.2026 backend по живым логам api увидел, что модель идеологически
сломана:

- 3 запроса `POST /board-recognition` упали в 500 (`board_recognize.py exit=1`,
  stderr пустой);
- 3 запроса вернули 200 c FEN, содержащим клинически невозможные позиции
  (5 королей, ферзи на чужих линиях, и т. п.) — без срабатывания 422 на
  стороне api;
- hotfix'ы (KS-3094 — клиентский URL, KS-3095 — typed mapping
  ошибок и auto-fallback) починили падения, но **не качество**.

### Корневая причина

ADR-040 §3.4 декларировал расщепление датасета **по позициям внутри
одного стиля**: «Train/val/test = 80/10/10 по позициям». Это значит, что в
тренировку и в валидацию попадали клетки одного и того же piece-set'а
(kingside_default, lichess_cburnett/merida/wikipedia/alpha, chess.com classic
и т. д.). Полученная модель — классификатор знакомых спрайтов, а не
универсальный распознаватель. На любом сдвиге пикселей (палитра, перерендер
компонента доски, обновление piece-set'а на стороне внешнего источника)
предсказания сыпются.

Это прямо противоречит сформулированной в ADR-040 цели — «универсальное
распознавание любой шахматной доски». Архитектурное решение требует ревизии
**раньше**, чем оптимизация модели или расширение датасета: оптимизировать
сломанный подход нельзя.

Дополнительно: на стороне api результат с `sanity.valid === false` уходит в
ответ как 200 с непустым `warnings`, FEN при этом отдаётся «как есть». Это
ошибочное поведение: вне зависимости от качества модели, валидно-невалидная
позиция — это hard-сигнал, который должен превращаться в 4xx, а не в
«warning при 200».

## Решение

### Принципы

1. **Train / validation — несовместимые множества стилей.** Модель в
   тренировке **ни одного раза** не видит клетки из piece-set'ов, на которых
   её будут проверять. Это инвариант, проверяемый и в коде, и в acceptance-
   гейте.
2. **Acceptance-гейт стоит до S3.** Невалидная модель не должна попадать в
   `kingside-ml/models/board-recog/`. Решение принимает скрипт публикации,
   а не человек.
3. **Невалидный результат на api — 4xx, а не 200.** Sanity-фильтр стоит
   на горячем пути и работает прямо сейчас, до выхода новой модели.

### 1. Стратегия датасета (замена §3 ADR-040)

#### 1.1 Train-сет — только то, чего нет на проде

В тренировку входят **только** источники, отличные от целевых стилей:

- **Программная синтетика на чужих ассетах.** Силуэты фигур — open-source
  SVG-наборы, **не входящие в список целевых стилей** (см. ниже). Допустимые
  источники: `monarchy` (lichess), `tatiana`, `caliente`, `fantasy`, `pirouetti`,
  `riohacha`, `dubrovny`, `kosal`, `letter`, аналогичные «не-mainstream»
  open-source наборы. Цвет клеток — процедурная палитра HSV-сэмплинга, не
  фиксированные пресеты целевых платформ.
- **Жёсткая Albumentations-аугментация.** Сверх ADR-040 §3.2 добавляются:
  - `Perspective` (distort_limit 0.04–0.08) — не только Rotate ±3°;
  - сильный цветовой сдвиг (`HueSaturationValue` ±20/±30/±20, `RGBShift`
    ±20);
  - симуляция артефактов рендера: `Downscale(0.5, 0.9)`, `ImageCompression
    (quality_lower=50)`, `Sharpen` со случайным α.
- **Сторонние датасеты реальных досок (license-clean):**
  - `ChessReD` (Real chess Recognition Dataset, Wölflein & Arandjelović,
    CC-BY-4.0) — 10 800 изображений 100 позиций под 8 ракурсами + разметка
    угловых точек и FEN;
  - `Chess Cog` (Czyzewski et al., MIT) — синтетика + 2 880 реальных
    изображений с разметкой;
  - открытые Kaggle-наборы — добавляются по мере проверки лицензий.

Изображения этих наборов **сэмплируются равномерно** с программной
синтетикой, чтобы модель не «заучила» один источник.

#### 1.2 Held-out validation-сет — целевые стили

Валидация — на **строго отделённом** множестве стилей, которые модель в
трейне не видела. MVP-список:

| Стиль | Источник | Использование |
|---|---|---|
| `kingside_default` | `react-chessboard` v5, наш UI | Skip-checks frontend Workshop |
| `lichess_cburnett` | lila/public/piece/cburnett | Скриншоты Lichess (Anish Giri, обзоры) |
| `lichess_merida` | lila/public/piece/merida | Альтернативный lichess piece-set |
| `lichess_wikipedia` | lila/public/piece/wikipedia | Диаграммы Wikipedia/учебники |
| `lichess_alpha` | lila/public/piece/alpha | Минималистичный стиль |
| `chesscom_classic` | chess.com CDN, бесплатный | Скриншоты chess.com |
| `chesscom_modern` | chess.com CDN, бесплатный | Скриншоты chess.com |

Каждый стиль рендерится в 500 позиций (одинаковая FEN-выборка для всех
стилей — это упрощает сравнение per-style). Итого validation-сет: 7 × 500 =
3 500 досок (≈ 224 000 клеток). Этот сет — **зафиксирован хешем** и
переезжает между запусками неизменным.

#### 1.3 Инвариант изоляции

В `dataset_gen.py` добавляется явный assert: пересечение между
`train_styles` и `val_styles` пусто. В тренировочном `train.py` тот же
инвариант — guard на старте: модель не может стартовать, если в датасете
обнаружен validation-стиль среди train-сэмплов (проверка по полю стиля в
manifest'е).

### 2. Метрики и acceptance-порог (замена §4.3 ADR-040)

#### 2.1 Что считаем

Метрики из ADR-040 §4.3 (per-class accuracy, per-style accuracy, end-to-end
FEN match, latency 95p) — сохраняются. Меняется **только применимость**:
все метрики per-style считаются **на held-out стилях**. Цифры по «знакомым»
стилям не отчитываются — их нет.

Дополнительно вводится метрика **board-validity rate**: доля позиций, на
которых результирующий FEN проходит sanity-чек (1+1 король, нет пешек на
1/8 ранге, ≤ 32 фигуры, ≤ 9 ферзей на сторону). Это нижний бар: любая модель,
систематически выдающая невозможные позиции, отбрасывается.

#### 2.2 Пороги

Два уровня — pilot (этап D, CPU) и release (этап F, AWS GPU).

| Метрика | Pilot (CPU, ограниченный train) | Release (AWS GPU) |
|---|---|---|
| Per-cell accuracy, **min** среди held-out стилей | ≥ 95 % | ≥ 99 % |
| Per-cell accuracy, **avg** по held-out | ≥ 97 % | ≥ 99.5 % |
| End-to-end FEN match, **min** среди held-out стилей | ≥ 30 % | ≥ 70 % |
| End-to-end FEN match, **avg** по held-out | ≥ 50 % | ≥ 85 % |
| Board-validity rate, **min** | ≥ 90 % | ≥ 99 % |
| Latency 95p (image → FEN) | ≤ 3 сек | ≤ 2 сек |

Pilot — это **разрешение продолжать**, не release. Цель pilot'а — доказать,
что подход работает лучше v1.0.0 на held-out стилях; абсолютные FEN-match
требования низкие (CPU + ограниченный train). Release — это **разрешение
выкатывать в прод**; здесь пороги жёсткие.

Минимум среди стилей важнее среднего: модель не должна «прятать» провал на
одном стиле за хорошим средним. Если по любому из held-out стилей FEN match
ниже минимума — модель к публикации **не допускается**, даже если average
выше.

#### 2.3 Формат отчёта

`evaluation_report.json` расширяется до:

```json
{
  "model_version": "1.1.0",
  "git_sha": "...",
  "train_styles": ["monarchy", "tatiana", "caliente", "..."],
  "val_styles": ["kingside_default", "lichess_cburnett", "..."],
  "isolation_invariant": "ok",
  "per_style": {
    "kingside_default": {
      "per_cell_accuracy": 0.9912,
      "fen_match_rate": 0.84,
      "board_validity_rate": 0.99,
      "confusion": {"K→Q": 12, "n→b": 8, "...": "..."}
    },
    "lichess_cburnett": { "...": "..." }
  },
  "summary": {
    "per_cell_min": 0.9912,
    "per_cell_avg": 0.9956,
    "fen_match_min": 0.78,
    "fen_match_avg": 0.86,
    "validity_min": 0.99,
    "latency_p95_ms": 1840
  },
  "passes_pilot_gate": true,
  "passes_release_gate": true
}
```

Поля `passes_pilot_gate` / `passes_release_gate` — вычисляются в
`evaluate.py` по таблице порогов §2.2. Acceptance-скрипт (см. §3 ниже)
читает их же.

### 3. Acceptance-гейт публикации модели (замена §5.3 ADR-040)

`tools/upload-board-model.sh` дорабатывается: после проверки валидности
JSON отчёта добавляется gate-проверка.

```bash
GATE_LEVEL="${BOARD_RECOG_GATE_LEVEL:-release}"   # release | pilot
GATE_FIELD="passes_${GATE_LEVEL}_gate"

PASSES=$(python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(str(r.get('${GATE_FIELD}', False)).lower())" "$REPORT_PATH")

if [[ "$PASSES" != "true" ]]; then
  echo "error: model does not pass ${GATE_LEVEL} gate (${GATE_FIELD}=${PASSES})" >&2
  echo "       see ${REPORT_PATH} for per-style metrics" >&2
  exit 3
fi
```

Семантика:
- По умолчанию gate — `release`. Pilot-публикация требует явного
  `BOARD_RECOG_GATE_LEVEL=pilot` (devops знает, что делает).
- Принудительный bypass через `BOARD_RECOG_GATE_BYPASS=1` — допустим
  только при отладке самого скрипта, **не для prod-моделей**. Лог bypass'а
  идёт в stderr.
- Gate проверяет **отчёт**, а не саму модель. Это значит: ответственность
  за то, что отчёт честный, лежит на `evaluate.py`. Поэтому `evaluate.py` в
  CI прогоняется на эталонной мини-выборке (см. этап C, exit-criteria).

### 4. Sanity-gate на api (временный, замена §5.1 ADR-040 в части ответа)

В `apps/api/src/board-recognition/board-recognition.service.ts`,
функция `toResponse` — добавить проверку до возврата успешного ответа:

```ts
if (raw.sanity && raw.sanity.valid === false) {
  throw new UnprocessableEntityException({
    code: 'recognition_unreliable',
    message: 'recognition produced invalid board (' +
             (raw.sanity.issues ?? []).join('; ') + ')',
    fenAttempt: raw.fen,           // диагностика, frontend не доверяет
    issues: raw.sanity.issues ?? [],
  });
}
```

Поведение:
- Backend отдаёт `422 recognition_unreliable` вместо `200 + warning`.
- В payload — список конкретных issue (5 королей, пешка на 8 ранге, …) и
  «попытка FEN» для диагностики. Frontend **не подставляет** этот FEN на
  доску — показывает пользователю «не удалось распознать, попробуйте другой
  снимок».
- `lowConfidenceCells` сам по себе **не** триггерит 422 — это soft-сигнал,
  модель сама не уверена; пользователь видит warning и может править.

Это решение временное в том смысле, что на новой модели
`board_validity_rate ≥ 99%` сделает срабатывания 422 редкими. Но сам
422-путь остаётся в коде навсегда — он не «костыль к плохой модели», а
правильная семантика API.

### 5. Что не меняется

- Архитектура трёхступенчатого пайплайна (board detect → cell classify →
  FEN assembly) — без изменений.
- Структура пакета `packages/board-image-to-fen/` и существующий код-путь
  (`recognizeUniversal`, `board_recognize.py`, `recognizer.py` для книг) —
  без изменений.
- API-контракт `POST /api/board-recognition` в части успешного ответа —
  без изменений. Добавляется только новый код ошибки `422 recognition_
  unreliable` к существующим `400 board_not_detected` / `500 model_load_
  failed` / `500 inference_failed`.
- Версионирование модели, S3-структура, ECS-деплой — без изменений.
- Frontend-компоненты (`<BoardImageDropzone>`) — без изменений в контракте.
  Изменение: обработка нового 422-кода — отдельный тикет (см. §6, KS-3090-G).

## 6. План внедрения (замена §7 ADR-040)

Этапы A–F. Параллелизация обозначена явно.

### Этап A — Sanity-gate на api (немедленно)

- **Исполнитель:** backend.
- **Scope:** правка `board-recognition.service.ts` (см. §4 этого ADR); юнит-
  тест на 5+ невалидных позициях из логов прода 17.05; e2e на штатном
  happy-path (sanity.valid === true → 200, не сломали).
- **Exit-criteria:**
  - `POST /api/board-recognition` на изображении, для которого Python-
    pipeline возвращает `sanity.valid === false`, отдаёт **422
    `recognition_unreliable`** с полями `code`, `message`, `fenAttempt`,
    `issues`.
  - `lowConfidenceCells` сам по себе по-прежнему → 200 + warning.
  - В контракте OpenAPI (если ведём) и в `docs/architecture/board-
    recognition-api.md` (создать, если нет) — описан новый код.
- **Параллелизм:** не зависит от B–F. Деплоится сразу.

### Этап B — Генератор синтетики + сторонние датасеты

- **Исполнители:** backend (реализация), chess-expert (методика — список
  стилей, приоритеты, проверка лицензий, edge-case позиций).
- **Scope:**
  - `packages/board-image-to-fen/src/python/dataset_gen.py` —
    расширение: добавить `--style-set train|val|both`, маркировку стилей в
    manifest'е (`train_only` / `val_only`), assert на пересечение;
  - реализовать загрузку чужих open-source piece-set'ов (monarchy, tatiana,
    caliente, fantasy, pirouetti, riohacha, dubrovny, kosal, letter — список
    уточняет chess-expert);
  - интеграция ChessReD и Chess Cog (download + лицензия + конверсия в
    единый формат меток);
  - расширение Albumentations-pipeline (см. §1.1 этого ADR).
- **Exit-criteria:**
  - Локальный прогон `dataset_gen.py --style-set both` даёт:
    - train: ≥ 1.5 M клеток на синтетике + ≥ 200k клеток с ChessReD/Chess
      Cog;
    - val: ровно 7 × 500 × 64 = 224 000 клеток held-out стилей.
  - `manifest.yml` содержит SHA256 каждого стиля и поле `usage:
    train_only|val_only`.
  - assert «`set(train_styles) ∩ set(val_styles) == ∅`» падает при попытке
    нарушения.
  - chess-expert apruv'ил список целевых стилей и лицензии чужих наборов
    (komментарий в задаче).
  - Заливка train-сета на S3 (`kingside-ml/datasets/board-recog/v2/`)
    автоматизирована.

### Этап C — Новый train.py + evaluate.py

- **Исполнитель:** backend.
- **Scope:**
  - `packages/board-image-to-fen/src/python/training/train.py` —
    guard на старте: bail если в DataLoader-сэмпле обнаружен стиль из
    val-сета (по полю manifest'а);
  - `packages/board-image-to-fen/src/python/training/evaluate.py` —
    расширить отчёт до формата §2.3 этого ADR; добавить вычисление
    `passes_pilot_gate` / `passes_release_gate` по таблице §2.2;
    добавить `board_validity_rate` в per-style и summary;
  - юнит-тесты `evaluate.py` на синтетическом фейк-отчёте: модель,
    специально проваливающая один стиль, не получает `passes_release_gate
    = true`, даже если average хороший.
- **Exit-criteria:**
  - Юнит-тесты на gate-логику зелёные (минимум: «провал по min» →
    false; «провал по validity» → false; «всё ок» → true).
  - Холостой dry-run `train.py --epochs=1` на mini-датасете завершается
    без ошибок, генерирует `evaluation_report.json` нового формата.

### Этап D — CPU pilot (доказать, что подход работает)

- **Исполнители:** backend (тренинг), devops (инфраструктура CPU-инстанса).
- **Scope:**
  - Pilot-train на CPU (1 машина, ~ 8–24 ч), уменьшенный датасет (200k
    train-клеток), MobileNetV3-Small или собственный 5-слойный CNN — на
    усмотрение backend, обоснование в комментарии к тикету;
  - artefact: `model_v0.9.0-pilot.onnx` + `evaluation_report.json` нового
    формата.
- **Exit-criteria:**
  - `passes_pilot_gate === true` в отчёте, т. е. per-cell min ≥ 95 %,
    FEN match min ≥ 30 %, validity min ≥ 90 % на held-out;
  - сравнительная таблица «v1.0.0 vs pilot v0.9.0» на тех же 7 стилях —
    pilot ≥ v1.0.0 по всем трём метрикам;
  - решение пользователя: продолжаем на AWS GPU или возвращаемся к датасету.
- **Параллелизм:** требует завершения B и C.

### Этап E — Acceptance-гейт публикации модели

- **Исполнитель:** devops (правка скрипта), backend (поля отчёта согласованы
  на этапе C).
- **Scope:**
  - `tools/upload-board-model.sh` — добавить gate-проверку §3 этого ADR;
    переменные `BOARD_RECOG_GATE_LEVEL`, `BOARD_RECOG_GATE_BYPASS`;
  - документация в `docs/devops/` — как обновлять модель в новой схеме;
  - smoke-test скрипта на тестовом отчёте (один проходит gate, второй —
    нет; exit-code и stderr корректны).
- **Exit-criteria:**
  - `upload-board-model.sh` отказывается публиковать `evaluation_report.
    json`, в котором `passes_release_gate === false`, с понятным сообщением;
  - bypass-флаг работает и логирует свой факт в stderr;
  - запись в `docs/devops/...` сверена с реальным поведением скрипта.
- **Параллелизм:** можно стартовать сразу после C (нужны поля отчёта); не
  блокирует D, но обязательна до F.

### Этап F — Финальный тренинг на AWS GPU + выкатка

- **Исполнители:** backend (тренинг), devops (AWS GPU-инстанс,
  деплой ECS).
- **Scope:**
  - Полный train-run на полном датасете (этап B), AWS GPU (g4dn / g5,
    1× T4 или 1× A10G — выбор devops);
  - artefact: `model_v1.1.0.onnx` + `evaluation_report.json`;
  - публикация через `upload-board-model.sh` (gate-проверка из этапа E);
  - обновление `BOARD_RECOG_MODEL_VERSION` в ECS task definition, деплой.
- **Exit-criteria:**
  - `passes_release_gate === true` — иначе скрипт публикации откажет;
  - после деплоя `/health` зелёный, smoke-тест на 5 эталонных скриншотах
    (по 1 на каждый из основных целевых стилей) показывает корректный
    FEN;
  - 24 ч мониторинга прод-логов: доля 5xx по `/board-recognition` < 0.5 %,
    доля 422 < 5 % на реальном трафике (если выше — модель отзывается).
- **Параллелизм:** последовательно после D и E.

### Зависимости

```
A (sanity-gate, backend) ──────────────────────── deploy immediately
B (dataset) ──┐
C (train+eval+gate-logic) ──┐
E (upload-gate, devops) ────┤
                            ├─→ D (CPU pilot) → решение пользователя → F (AWS train + deploy)
```

A не зависит ни от чего; B, C, E можно вести параллельно сразу после
согласования; D — после B+C; F — после D + успешного решения пользователя.

## 7. Декомпозиция на тикеты

Координатор создаёт следующие тикеты в backlog (To Do, без старта реализации
до сигнала пользователя). Метки на каждом: 1–3 из разрешённого списка
(`puzzle, infra, tests, performance`).

| Тикет | Этап | Исполнитель | Краткое описание |
|---|---|---|---|
| KS-3090-A | A | backend | Sanity-gate 422 в `board-recognition.service.ts` |
| KS-3090-B | B | backend + chess-expert | Расширение `dataset_gen.py`: train/val разделение, чужие piece-set'ы, ChessReD/Chess Cog |
| KS-3090-C | C | backend | `train.py` guard + `evaluate.py` новый формат отчёта и gate-логика |
| KS-3090-D | D | backend + devops | CPU pilot, сравнение с v1.0.0 |
| KS-3090-E | E | devops | Acceptance-gate в `upload-board-model.sh` |
| KS-3090-F | F | backend + devops | Финальный train на AWS GPU + выкатка |
| KS-3090-G | — | frontend | Обработка нового кода 422 `recognition_unreliable` в `<BoardImageDropzone>` |

KS-3090-G — побочный, зависит от A; чтобы пользователь не видел технический
422, frontend показывает понятный текст и предлагает другой снимок. Метки
тикета: `puzzle`.

Детали (scope, exit-criteria) каждого тикета — в §6 этого ADR; координатор
переносит их в тело тикета один-в-один.

## Открытые вопросы

1. **Конкретный список train-стилей.** В §1.1 перечислены кандидаты; chess-
   expert на этапе B утверждает финальный список и проверяет лицензии. Если
   open-source наборов окажется недостаточно для «жирной» синтетики, можно
   ввести процедурную генерацию силуэтов (шахматные глифы Unicode +
   рандомизация толщины линий) — но это решение приниматься на этапе B по
   факту, не в этом ADR.
2. **Real-photo доля в train.** ChessReD/Chess Cog — это фото с разметкой
   FEN. Если их пропорция в общем train-сете окажется слишком большой,
   модель сместится к фото-стилю и потеряет на screenshot-стилях. Бюджет —
   ≤ 15 % от train-клеток на этапе B (пересмотр после первых метрик pilot'а).
3. **Side-to-move и castling rights.** Эти поля FEN из одного снимка не
   определяются (см. ADR-040 §3.3). v2 этого не меняет: side-to-move =
   `w`, castling = `KQkq` по умолчанию, frontend даёт toggle. На held-out
   метрику `fen_match_rate` это не влияет — match считается по
   `fen_board`, а не по полному FEN.
4. **Размер модели на проде.** Размер MobileNetV3-Small (~ 600 KB) и
   latency не меняются. Если на финальном датасете окажется, что модель
   нужно расширить, — это вход в ADR-040-v3, не сюда.

## Последствия

**Плюсы:**

- Принцип «train ≠ val по стилям» физически не позволяет модели стать
  классификатором знакомых спрайтов. Это фундаментальное исправление, не
  «улучшение».
- Acceptance-гейт публикации модели исключает повторение сценария
  17.05.2026: модель с провалом на одном из стилей не доедет до S3.
- Sanity-gate 422 убирает «200 + мусор» прямо сейчас, до выхода новой
  модели. Пользователь либо видит корректный FEN, либо понятный отказ —
  третьего состояния нет.
- Артефакт (ONNX) и весь downstream-pipeline остаются совместимыми; api
  даже не нужно перерелизить под смену модели.

**Минусы:**

- Validation-сет 7 × 500 досок зафиксирован хешем — если со временем
  целевые стили обновятся (chess.com выкатит новый piece-set по умолчанию),
  validation-сет придётся версионировать (`val_v2`, `val_v3`). Это
  организационная цена, но не техническая.
- Сторонние датасеты (ChessReD, Chess Cog) требуют проверки лицензий и
  скачивания десятков ГБ — этап B становится тяжелее, чем был в исходном
  ADR-040 §3.
- Acceptance-гейт может «застрять» на финальном train'е (модель не
  проходит). Это правильное поведение, но требует от backend быстрой
  итерации: либо чинить датасет, либо bumpить пороги (через ADR-040-v3,
  не молча).
- CPU pilot — лишняя итерация по времени (~ день–два), но снимает риск
  потратить деньги на AWS GPU на сломанном подходе.

**Риски:**

- ChessReD и Chess Cog имеют разные форматы разметки; их интеграция может
  занять больше, чем кажется. Митигация — chess-expert на этапе B
  утверждает приоритеты, и при необходимости сторонний датасет
  откладывается на v3.
- На held-out стилях release-порог per-cell ≥ 99 % может оказаться
  недостижимым без увеличения параметров модели. Митигация — pilot-этап
  даст раннюю оценку: если pilot сильно не дотягивает, пороги
  пересматриваются явно в ADR-040-v3, а не в коде.

## Связанные документы

- `docs/adr/040-universal-board-image-recognition.md` — исходный ADR,
  остаётся в силе кроме §3, §4.3, §5.1 (часть про ответ), §5.3, §7.
- `packages/board-image-to-fen/README.md` — обновляется на этапе B (новая
  структура датасета) и этапе E (gate-флаги скрипта).
- `docs/architecture/board-recognition-api.md` — создаётся/обновляется на
  этапе A (новый код 422).
- KS-2358 — исходный эпик ADR-040.
- KS-3071 — train v1.0.0 (идеологически сломан, причина этой ревизии).
- KS-3072 — 50-image manual acceptance test (будет реализован уже в новой
  парадигме на этапе F).
- KS-3094, KS-3095 — hotfix'ы 17.05.2026 (починили падения, не качество).
- KS-3090 — этот ADR.
