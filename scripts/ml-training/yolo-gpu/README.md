# YOLO-GPU training runbook (board-recognition v4 / v5)

Процедура восстановлена по scrollback-сессии devops от 19 мая 2026
(`d838bb20-9a1e-4696-bb74-16bc540f805e`) — той, в которой реально тренировались
выпущенные модели `models/board-recog/v2.0.0/` (find-pieces, KS-3091 v4)
и `models/board-recog/findboards_v1.0.0/` (find-boards, KS-3110).
Сама процедура нигде не была закоммичена; этот каталог — её фиксация для
повторного запуска без повторного «вспоминания» по логам.

Параллельный runbook для board-recog v1 (cell-classifier через PyTorch image
+ HDF5) живёт уровнем выше в `scripts/ml-training/` — он другой и
переиспользоваться для YOLO не должен.

## Общие свойства

- AMI: `ami-03aa80bc63bbd3638` — *Deep Learning OSS Nvidia Driver AMI GPU
  PyTorch 2.4.1 (Ubuntu 22.04) 20250623*. Tesla T4 15 ГБ, CUDA 12.4,
  driver 570.133.20. NVMe instance store автоматически смонтирован на
  `/opt/dlami/nvme/` — в этом каталоге работаем, EBS не трогаем.
- Тип инстанса: `g4dn.xlarge` on-demand. **Спот не запустится** — на нашем
  AWS-аккаунте квота на G-family Spot = 0 (см. AWS Service Quotas
  `L-3819A6DF`). Подъём квоты через AWS Support — 1–3 дня. Пока on-demand.
- Регион: `eu-central-1`.
- Стоимость: $0.526/час on-demand. Реальная пилотная тренировка ≤ 30 мин
  → счёт ≤ $0.30 за прогон.
- Доставка датасета: **через S3 как транзит** (`s3://kingside-ml/datasets/board-recog/<DATASET>.tar`).
  На EC2 tar скачивается через IAM instance profile с read-only-доступом
  на этот префикс. scp/rsync напрямую с shared-хоста не используем —
  10–20 Мбит/с против 250+ МБ/с с S3 в том же регионе.
- ultralytics 8.4.51, torch 2.4.1+cu124 — версии зафиксированы в `user-data.sh`,
  чтобы совпадать с backend-локалкой (если backend подтянет другую — рассинхрон
  ONNX-экспорта).
- SSH-доступ ограничен `0.0.0.0/0` нельзя, только текущий внешний IP машины,
  с которой запускался `setup-aws.sh` (детектируется через `curl ifconfig.me`).

## Что уже лежит в S3 (не пересобирать без причины)

| Объект | Размер | Назначение |
|---|---|---|
| `s3://kingside-ml/datasets/board-recog/v4-objdet.tar` | 374 МиБ | train для find-pieces v4 (KS-3091) |
| `s3://kingside-ml/datasets/board-recog/v5-findboards.tar` | 534 МиБ | train для find-boards v5 (KS-3110) |
| `s3://kingside-ml/models/board-recog/v2.0.0/model.onnx` | 12 МБ | finalised find-pieces, прод |
| `s3://kingside-ml/models/board-recog/findboards_v1.0.0/model.onnx` | 12 МБ | finalised find-boards, прод |

SHA256 `v5-findboards.tar` = `13fd3ea688a50930ce8ba030832350702b7542040e1834be1f6e9e1fabde0b13`
(подтверждён в момент upload). Если содержимое валидно — переиспользуй.

## Файлы каталога

| Файл | Где запускается | Назначение |
|---|---|---|
| `setup-aws.sh` | shared-хост devops | keypair + SG + IAM role + instance-profile. Идемпотентно: повторный запуск без ошибки. |
| `launch.sh` | shared-хост devops | `aws ec2 run-instances` + ожидание `READY`-маркера. Печатает SSH-команды для backend. |
| `user-data.sh` | внутри EC2 (через `--user-data`) | NVMe-init, `aws s3 cp` датасета, `pip install` ultralytics, prefetch `yolov8n.pt`, маркер `/opt/dlami/nvme/READY`. |
| `teardown.sh` | shared-хост devops | terminate инстанса + удаление SG / IAM / keypair / локальных tmp-файлов. |

## Полный сценарий: запуск, train, выгрузка, гашение

### 0. Положить датасет в S3 (один раз, если ещё нет)

Если у backend есть `/tmp/<DATASET>.tar`:
```
aws s3 cp /tmp/<DATASET>.tar \
    s3://kingside-ml/datasets/board-recog/<DATASET>.tar \
    --region eu-central-1
```
Структура внутри tar:
```
<DATASET>/
  images/{train,val}/*.png
  labels/{train,val}/*.txt   (YOLO формат — class cx cy w h)
  dataset.yaml               (path/train/val/nc/names)
  manifest.json              (опционально)
```

### 1. Создать AWS-обвес

```
./scripts/ml-training/yolo-gpu/setup-aws.sh
```

Создаёт:
- keypair `kingside-gpu-pilot`, приватник кладёт в `/tmp/kingside-gpu-pilot.pem` (chmod 600);
- security group `kingside-gpu-pilot`, разрешает 22/tcp только с текущего внешнего IP;
- IAM role `kingside-gpu-pilot-role` + inline policy `s3-read-board-recog`
  (`s3:GetObject` + `s3:ListBucket` на `arn:aws:s3:::kingside-ml`
  и `arn:aws:s3:::kingside-ml/datasets/board-recog/*`);
- instance profile `kingside-gpu-pilot-profile` с этой ролью.

Если уже есть — переиспользуется. После создания скрипт ждёт 10 секунд
на eventual-consistency IAM (без этого первый `run-instances` иногда
ругается на «invalid instance profile»).

### 2. Запустить инстанс

```
./scripts/ml-training/yolo-gpu/launch.sh <DATASET>
# например:
./scripts/ml-training/yolo-gpu/launch.sh v5-findboards
```

Шаги внутри:
- генерирует `/tmp/gpu-user-data.sh` (template из `user-data.sh` + подставленный `DATASET_TAR`);
- `aws ec2 run-instances` с правильными флагами (см. ниже);
- ждёт state `running`, забирает public IP;
- поллит на инстансе наличие `/opt/dlami/nvme/READY` (timeout 10 мин);
- печатает SSH-команды для backend и сохраняет:
  - `/tmp/kingside-gpu-pilot.id`     — instance-id;
  - `/tmp/kingside-gpu-pilot.ip`     — public IP;
  - `/tmp/kingside-gpu-pilot.sg`     — SG ID (для teardown).

Команда `run-instances` (для справки, runbook не запускает её руками):
```
aws ec2 run-instances \
  --region eu-central-1 \
  --image-id ami-03aa80bc63bbd3638 \
  --instance-type g4dn.xlarge \
  --key-name kingside-gpu-pilot \
  --security-group-ids <SG_ID> \
  --iam-instance-profile Name=kingside-gpu-pilot-profile \
  --user-data fileb:///tmp/gpu-user-data.sh \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=120,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=kingside-gpu-pilot},{Key=Project,Value=kingside},{Key=Purpose,Value=<DATASET>-yolo-train}]' \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2'
```

### 3. Тренировка (backend через SSH)

После того как `launch.sh` напечатает реквизиты, backend гонит train сам:

```
ssh -i /tmp/kingside-gpu-pilot.pem \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    ubuntu@<IP> \
  '/opt/conda/bin/yolo train \
     data=/opt/dlami/nvme/data/<DATASET>/dataset.yaml \
     model=yolov8n.pt \
     epochs=8 imgsz=512 batch=16 \
     device=0 workers=4 cache=ram \
     project=/opt/dlami/nvme/runs name=<RUN_NAME> \
     patience=20 plots=False save_period=1 seed=2026 exist_ok=True'
```

Фиксированные параметры (использовались в выпущенных моделях):
- `imgsz=512`, `batch=16`, `workers=4`, `cache=ram`.
- `device=0` (Tesla T4).
- `patience=20`, `save_period=1` (сохраняем каждую эпоху, чтобы выбрать
  лучшую по реальным изображениям — на синтетике после 4 эпох идёт
  overfit, см. KS-3091 комментарии backend).
- `seed=2026` для воспроизводимости.

`<RUN_NAME>` договорённость:
- `ks3091v4` для find-pieces,
- `ks3110` для find-boards.

После train — экспорт ONNX (вручную, ultralytics не делает в train pipeline):
```
ssh -i /tmp/kingside-gpu-pilot.pem ubuntu@<IP> \
  '/opt/conda/bin/yolo export \
     model=/opt/dlami/nvme/runs/<RUN_NAME>/weights/best.pt \
     format=onnx imgsz=512 simplify=True'
# .onnx появится рядом с best.pt
```

### 4. Стяжка артефактов

```
mkdir -p /tmp/<RUN_NAME>-yolo-gpu
scp -i /tmp/kingside-gpu-pilot.pem \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    ubuntu@<IP>:'/opt/dlami/nvme/runs/<RUN_NAME>/weights/*' \
    /tmp/<RUN_NAME>-yolo-gpu/
```

Также нужен `evaluation_report.json` — backend генерирует его на инстансе
после train (через свой evaluate-скрипт), и кладёт туда же. ВАЖНО:
не писать report через `tee` поверх stdout от ultralytics — JSON
получится «грязный» (так было с v5, пришлось чистить вручную). Писать
строго через `json.dump()` в чистый файл.

### 5. Публикация модели на S3

После валидации `evaluation_report.json` глазами:

Для find-pieces v* — есть скрипт `tools/upload-board-model.sh`:
```
bash tools/upload-board-model.sh 2.0.0 \
     /tmp/ks3091v4-yolo-gpu/best.onnx \
     /tmp/ks3091v4-yolo-gpu/evaluation_report.json
```

Для find-boards — скрипт **не подходит** (он жёстко ставит префикс
`v<MAJOR>.<MINOR>[.<PATCH>]/`, а find-boards живёт в
`findboards_v<X.Y.Z>/`). Делаем ручной cp с теми же metadata-полями:
```
MODEL_SHA=$(sha256sum /tmp/ks3110-yolo-gpu/best.onnx | awk '{print $1}')
aws s3 cp /tmp/ks3110-yolo-gpu/best.onnx \
    s3://kingside-ml/models/board-recog/findboards_vX.Y.Z/model.onnx \
    --region eu-central-1 \
    --content-type application/octet-stream \
    --metadata "sha256=${MODEL_SHA},version=findboards_vX.Y.Z,task=detect-board"
aws s3 cp /tmp/ks3110-yolo-gpu/evaluation_report.json \
    s3://kingside-ml/models/board-recog/findboards_vX.Y.Z/evaluation_report.json \
    --region eu-central-1 --content-type application/json
```

### 6. Гашение инстанса

ОБЯЗАТЕЛЬНО — иначе on-demand $0.526/час идёт нон-стоп.

```
./scripts/ml-training/yolo-gpu/teardown.sh
```

Если запущен сразу после `launch.sh`, читает instance-id / SG ID из
`/tmp/kingside-gpu-pilot.{id,sg}`. После terminate сносит:
- SG (`kingside-gpu-pilot`),
- IAM role + policy + instance profile (`kingside-gpu-pilot-*`),
- keypair (`kingside-gpu-pilot`),
- локальные `/tmp/kingside-gpu-pilot.*` и `/tmp/gpu-user-data.sh`.

Полная очистка нужна потому что:
- keypair одноразовый (приватник был в `/tmp`, при следующем запуске
  всё равно перевыпускать) — оставлять висеть на стороне AWS не нужно;
- SG-имя `kingside-gpu-pilot` уникально, при повторном `setup-aws.sh`
  упрётся в `InvalidGroup.Duplicate` если оставить старую;
- IAM-обвес мелкий, без затрат — но висящие AssumeRole-инструменты
  в проде не нужны.

## Типовые ошибки (по log'ам последней реальной тренировки)

1. **`MaxSpotInstanceCountExceeded` на spot.**
   У нашего аккаунта G-Spot quota = 0. Запрос квоты через AWS Service Quotas
   `L-3819A6DF` → AWS Support, 1–3 дня. Пока on-demand.

2. **`InvalidIAMInstanceProfile.NotFound` сразу после create.**
   IAM eventual consistency. `setup-aws.sh` спит 10 секунд после create.
   Если всё равно ловишь — добавь ещё 10.

3. **`polars not found` в ultralytics 8.4.51.**
   У `yolo train` есть post-train hook, который пытается импортировать `polars`,
   но в `ultralytics==8.4.51 --no-deps` его нет. Если упадёт — на инстансе:
   `/opt/conda/bin/pip install polars`. Уже зашит в `user-data.sh`.

4. **`evaluation_report.json` грязный.**
   Если backend пишет через `tee` или `yolo val > report.json` — в файл
   попадает stdout-преамбула (banner ultralytics + progress-бар), `json.load`
   падает. Я в прошлый раз чистил вручную, выделив хвост от первого `{`
   после преамбулы. Решение на стороне backend: писать report исключительно
   через `json.dump(obj, open(..., 'w'))`.

5. **Smoke прошёл, полный train валится через 15 мин.**
   GPU OOM (batch=16 на T4 15ГБ — впритык при `cache=ram` + 1500 train),
   диск NVMe заполнился `epoch*.pt` (15 эпох × 24 МБ = 360 МБ, тривиально,
   но при `save_period=1` и 50 эпохах уже 1.2 ГБ). Проверять
   `df /opt/dlami/nvme` и `nvidia-smi` параллельным SSH.

6. **Локальный CPU-бенч `evaluation_report` показывает `torch-2.4.1+cpu`.**
   Это не train, а пост-валидация на ноутбуке backend. На EC2 был
   `torch 2.4.1+cu124` (CUDA). Не путать: train на GPU, evaluate report
   может быть и на CPU потом, главное — мониторинг GPU-Util ≥ 80% во
   время train.
