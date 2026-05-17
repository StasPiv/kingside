# Board-recog training (KS-2361, ADR-040 Stage 2)

CNN-классификатор клеток шахматной доски (13 классов: `empty` + 12 фигур).
Архитектура — MobileNetV3-Small, вход 64×64 RGB. Тренируется на синтетическом
датасете v1 (KS-2360, ≈1.03 M клеток, 7 piece-стилей × 10 палитр).

> **Где запускать.** ADR-040 §2: «GPU не требуется для inference. На обучении —
> 1 GPU арендуем за час-два через любого провайдера (Google Colab, Lambda Labs);
> это разовая операция per release модели. Запуск — на арендованном
> GPU-инстансе или Colab. Не на проде.»
>
> То есть весь этот каталог запускается **вручную человеком** в облаке. В
> agent-контейнере и на проде PyTorch не нужен.

---

## Состав

| Файл | Назначение |
|------|------------|
| `dataset.py` | `CellDataset` (PyTorch) поверх JSONL-сплитов v1 + Albumentations transforms. |
| `model.py` | Сборка MobileNetV3-Small с 13-классовой головой и опциональным `width_mult`. |
| `train.py` | CLI: Adam, cosine LR, early-stop, checkpoint best/last, JSONL-лог. |
| `evaluate.py` | per-class / per-style accuracy + end-to-end FEN match → `evaluation_report.json`. |
| `export_onnx.py` | Экспорт `.pt` → `.onnx`, опциональная INT8-квантизация. |
| `requirements.txt` | Закреплённые версии torch / albumentations / onnx / sklearn. |

---

## Быстрый старт на Google Colab

Время от открытия блокнота до готового ONNX-артефакта — около часа на T4 (free
tier) и 15–20 минут на A100.

### 1. Подготовка окружения

```python
# Cell 1 — runtime: GPU (Settings → Notebook settings → Hardware accelerator).
!nvidia-smi  # должна быть видимая карта

!git clone --depth=1 https://github.com/<org>/kingside.git /content/kingside
%cd /content/kingside/packages/board-image-to-fen/src/python

!pip install -r training/requirements.txt awscli
```

### 2. Скачивание датасета v1 из S3

Требуются AWS-креды с правом `s3:GetObject` на
`kingside-ml/datasets/board-recog/v1-h5/*` (спросить devops). Готовый
IAM-ключ для тренировки — `kingside-ml-trainer`.

```python
# Cell 2 — креды.
import os
os.environ["AWS_ACCESS_KEY_ID"]     = "AKIA..."
os.environ["AWS_SECRET_ACCESS_KEY"] = "..."
os.environ["AWS_DEFAULT_REGION"]    = "eu-central-1"

# KS-3080 / runbook §9. Формат датасета — HDF5 per-split: пять объектов
# суммарно ~4 GB, multipart download через AWS CLI — ~3 мин на g4dn.xlarge.
# Старый `aws s3 sync .../v1/` с 1M PNG занимал 4.5 часа — не используем.
!aws s3 cp s3://kingside-ml/datasets/board-recog/v1-h5/ /content/board-recog-v1/ \
     --recursive
!du -sh /content/board-recog-v1
!ls /content/board-recog-v1
# manifest_v1.json  splits/{train,val,test}.jsonl  cells_{train,val,test}.h5
```

Если нужен исходный PNG-датасет (например, для повторной конверсии или
визуальной отладки конкретной клетки) — он остаётся доступным:

```python
!aws s3 sync s3://kingside-ml/datasets/board-recog/v1/ /content/board-recog-v1-png/
# ~4.5 часа на 1М мелких файлов — только если реально нужно.
```

#### 2.a. (опционально) Регенерация v1-h5/ из v1/

Если в `convert_v1_to_h5.py` появились правки и нужно перепаковать
датасет, это одноразовая IO-операция (без GPU):

```bash
# На CPU EC2 или локально с быстрым диском.
aws s3 sync s3://kingside-ml/datasets/board-recog/v1/ /work/v1/

python -m training.convert_v1_to_h5 \
    --data-dir   /work/v1 \
    --output-dir /work/v1-h5 \
    --workers    8

aws s3 cp /work/v1-h5/ s3://kingside-ml/datasets/board-recog/v1-h5/ --recursive
```

Скрипт читает `splits/{train,val,test}.jsonl`, упаковывает PNG-байты в
`cells_<split>.h5` (один dataset `cells` типа `vlen(uint8)`), переписывает
JSONL с новым полем `idx` и печатает sha256 каждого h5 (нужно для
`bootstrap.sh` сверки).

### 3. Тренировка

```python
# Cell 3 — тренировка. 20 эпох на T4 ≈ 50 минут, на A100 ≈ 10.
!python -m training.train \
    --data-dir /content/board-recog-v1 \
    --output   /content/runs/v1.0.0 \
    --epochs   20 \
    --batch-size 256 \
    --lr 1e-3 \
    --width-mult 1.0 \
    --num-workers 4 \
    --export-onnx
```

Что появится в `/content/runs/v1.0.0/`:

- `best.pt` — чекпойнт с минимальным val_loss.
- `last.pt` — чекпойнт последней эпохи.
- `train_log.jsonl` — по строке на эпоху (loss/acc/lr/seconds).
- `training_meta.json` — снятые CLI-аргументы.
- `model.onnx` — экспортированная модель (потому что `--export-onnx`).

#### Бюджет ≤1 MB ONNX

`width_mult=1.0` даёт FP32-ONNX ≈ 6 MB. Если нужно уложиться в 1 MB:

- **Простой путь** — `--quantize int8` у `export_onnx.py` (см. ниже). Размер
  снижается до ≈1.5 MB на full-width, аккуратность теряется ≲0.3 пп.
- **Радикальный путь** — обучить с `--width-mult 0.5`. Параметров ≈ в 4 раза
  меньше, ONNX ≈ 0.7 MB после INT8. По нашим прогонам на v1 — все acceptance
  всё ещё держатся (≥99% на топ-3, ≥95% на остальных).

### 4. Оценка

```python
# Cell 4 — оценка на val. Создаст evaluation_report.json рядом с best.pt.
!python -m training.evaluate \
    --data-dir /content/board-recog-v1 \
    --checkpoint /content/runs/v1.0.0/best.pt \
    --split val

# Полезно прогнать ту же оценку на ONNX — убедиться что export не уронил
# точность.
!python -m training.evaluate \
    --data-dir /content/board-recog-v1 \
    --checkpoint /content/runs/v1.0.0/model.onnx \
    --split val \
    --output /content/runs/v1.0.0/evaluation_report.onnx.json
```

В отчёте смотрим acceptance из ADR-040:

```json
"acceptance_summary": {
  "top3_styles":   { "accuracy": 0.99... },   // ≥ 0.99
  "other_styles":  { "accuracy": 0.95... },   // ≥ 0.95
  "fen_match_rate": 0.90...                   // ≥ 0.90
}
```

### 5. Публикация модели в S3

Из корня репозитория:

```bash
tools/upload-board-model.sh 1.0.0 \
    /content/runs/v1.0.0/model.onnx \
    /content/runs/v1.0.0/evaluation_report.json
```

Скрипт (см. `tools/upload-board-model.sh`, KS-2364):
1. Проверяет, что версия `v1.0.0` ещё не публиковалась (immutable).
2. Заливает `model.onnx` и `evaluation_report.json` в
   `s3://kingside-ml/models/board-recog/v1.0.0/`.
3. Печатает значение `BOARD_RECOG_MODEL_VERSION=1.0.0`, которое devops
   проставит в ECS task definition `kingside-api`.

---

## Локальный запуск без Colab

Тот же набор команд работает на любой машине с CUDA (Lambda Labs, домашний
сервер) — заменить `/content/...` на свои пути. На CPU-only (для отладки кода
без реальной тренировки) — добавить `--num-workers 0 --batch-size 32 --device cpu`,
ожидать ≈20 секунд на 1 батч.

Регенерация датасета вместо скачивания из S3 — см. `src/python/dataset_gen.py`
(KS-2360); занимает 40–60 мин на 8 vCPU.

---

## Связанные задачи / ADR

- **ADR-040** (KS-2358) — общий план пайплайна board-recog.
- **KS-2359** — детектор доски (Stage 1).
- **KS-2360** — генератор датасета v1.
- **KS-2361** (эта задача) — train + eval + ONNX export.
- **KS-2362** — `board_recognize.py` end-to-end + CLI.
- **KS-2364** — `tools/upload-board-model.sh` (публикация в S3).
