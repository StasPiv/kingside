# Runbook: разовая ML-тренировка board-recog v1.0 на AWS

> **Owner:** devops (исполнение), architect (постановка).
> **Контекст:** ADR-040 §4 (board-recog тренировка), KS-2361 (training-скрипты),
> KS-2364 (S3 + upload-скрипт), KS-3071 (тренировка v1.0), KS-3073 (этот документ).
>
> Документ описывает, **как именно** devops запускает разовую GPU-тренировку модели
> распознавания клеток шахматной доски. После однократной настройки квот и IAM
> любая последующая итерация (v1.0.x, v1.1.x …) — это один `aws ec2 run-instances`
> с готовым user-data из репозитория.

## 0. TL;DR

Подход: **Docker-контейнер `pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime` на
EC2 g4dn.xlarge поверх AWS Deep Learning Base GPU AMI**. Все «движущиеся»
зависимости (torch, albumentations, opencv, onnxruntime, awscli) живут внутри
Docker-образа; на голом инстансе мы НЕ ставим ничего, кроме `docker run`.

Полный жизненный цикл:

```
[локальный CPU-dry-run] → [aws ec2 run-instances + user-data из репо]
                              → docker pull pytorch/pytorch
                              → docker run --gpus all (bootstrap внутри образа)
                              → train.py → evaluate.py → export_onnx
                              → aws s3 cp артефактов в _tmp/runs/<ts>/
                              → shutdown -h now → InstanceInitiatedShutdown=terminate
                          ↓
            [архитектор/координатор валидируют evaluation_report.json]
                          ↓
                  [devops запускает tools/upload-board-model.sh]
                          ↓
                  [devops правит ECS task def BOARD_RECOG_MODEL_VERSION=1.0.0]
```

Стоимость одного полного прогона: g4dn.xlarge × 1 час on-demand =
**~$0.53** в eu-central-1. С CPU-dry-run на c7i.large (15 мин) — ещё $0.02.

---

## 1. Почему именно Docker-на-EC2, а не альтернативы

KS-3071 показала, что **сборка окружения на голом Ubuntu внутри user-data — это
сапёрский путь**. Каждое падение (`awscli` нет в apt у Ubuntu 24.04, `libgl1`
переименован в Ubuntu 22.04, `python3-venv` конфликтует с системным `python3` в
DLAMI Base) требовало нового запуска GPU-инстанса. Любое решение, в котором
зависимости фиксируются **в иммутабельном артефакте**, эту проблему снимает.

Сравнение пяти вариантов:

| Подход | Время до 1-го запуска | Цена / прогон | Сложность настройки | Auto-terminate | Подходит для разовой v1.0? |
|---|---|---|---|---|---|
| Docker-on-EC2 + готовый DLAMI Base GPU AMI | ~30 мин | $0.53 | низкая | да (`shutdown=terminate`) | **✅ выбран** |
| Свой AMI (Packer) | 2–4 часа (билд AMI) | $0.53 | средняя | да | overkill для одной модели; полезно, если тренировок будет ≥5 |
| AWS Deep Learning Container на ECS | 1–2 часа | $0.55 | средняя (cluster + capacity provider + task def) | через ECS task lifecycle | overkill; обоснован при ≥ еженедельных тренировках |
| AWS Batch | 2–3 часа | $0.55 | высокая (compute env + queue + job def + IAM роли service/job) | да | оправдан при cron-ML, не для разовой |
| AWS SageMaker Training Job | 2–3 часа | $0.74 (+30% sagemaker-наценка) | средняя (надо адаптировать `train.py` под `SM_CHANNEL_*` env-vars или построить кастомный образ) | да (managed) | сильнее всех «без вмешательства», но требует доработки training-скриптов |

### Почему именно Docker-on-EC2 для **разовой** v1.0

1. **Образ `pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime` уже совпадает по версиям
   с `training/requirements.txt`.** torch 2.4.1 / CUDA 12.1 — это ровно то, что
   мы пиновали в KS-2361. Никаких пересборок.
2. **DLAMI Base GPU (Ubuntu 22.04) уже имеет:**
   - NVIDIA-драйверы под CUDA 12.x;
   - `docker.io` запущен и в группе `ec2-user` (либо `ubuntu`);
   - `nvidia-container-toolkit` зарегистрирован как docker runtime.
   То есть `docker run --gpus all` работает «из коробки», `apt install` не
   нужен ни для чего.
3. **Локальная отладка тривиальна.** Тот же образ, тот же `train.py`,
   запускается на ноуте разработчика без GPU: `docker run --rm -v $PWD:/work
   pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime python -m training.train
   --device cpu …`. Bootstrap проверяется до того, как поднят GPU-счётчик.
4. **Один файл user-data в репо.** Никакой ручной правки между запусками. Если
   шаг падает — правится файл, коммитится, перезапускается `run-instances`.
5. **Что не вошло.** Custom AMI / SageMaker / Batch — все требуют отдельной
   инфра-задачи (Packer-template, или адаптация `train.py` к `SM_*` контракту,
   или compute-environment + job-queue). Для **одной** модели v1.0 это не
   окупается. Если в роадмапе появится v2.0/v3.0 + дообучение по телеметрии —
   мигрируем на SageMaker (см. §7 «Когда переходить»).

### Что Docker-on-EC2 НЕ решает

- **Квота на GPU-инстансы у нового AWS-аккаунта = 0.** Это пользовательский
  тикет в AWS Support, занимает часы; обходить нечем (см. §6, действия пользователя).
- **Docker Hub rate-limit для анонимных pull** (100 запросов/6ч на IP). На
  разовой тренировке не упирается, но в роадмапе фиксации — переехать в ECR.
- **Самотерминирование инстанса по таймауту** — у нас триggered `shutdown -h now`
  в user-data; плюс `InstanceInitiatedShutdownBehavior=terminate`. Дополнительный
  CloudWatch-alarm («любой инстанс с тегом `ml-train`, живущий >4 ч → SNS-уведомление
  пользователю») — см. §3.7.

---

## 2. Архитектура одного прогона

```mermaid
flowchart TD
    A[devops локально: cpu-dry-run.sh<br/>docker run --rm cpu pytorch ...] -->|зелёный bootstrap| B
    B[devops: aws ec2 run-instances<br/>+ user-data из репо] --> C
    C[EC2 g4dn.xlarge<br/>AMI DLAMI Base GPU Ubuntu 22.04] -->|user-data: docker run --gpus all| D
    D[Container pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime] --> E
    E[bootstrap.sh inside container:<br/>pip install requirements.txt + awscli<br/>aws s3 cp code.tar.gz<br/>aws s3 sync dataset v1] --> F
    F[python -m training.train ...] --> G
    G[python -m training.evaluate ...] --> H
    H[python -m training.export_onnx ...] --> I
    I[aws s3 cp runs/v1.0.0/* → s3://kingside-ml/_tmp/runs/v1.0.0-{ts}/] --> J
    J[shutdown -h now] --> K
    K[InstanceInitiatedShutdownBehavior=terminate]
    L[архитектор/координатор валидируют<br/>evaluation_report.json] -.->|после J| M
    M[devops: tools/upload-board-model.sh 1.0.0 ...] --> N
    N[ECS task def update<br/>BOARD_RECOG_MODEL_VERSION=1.0.0]
```

### Зачем здесь dry-run на CPU

Цель — выявить **bootstrap-ошибки** (опечатка в имени файла, отсутствует
зависимость, неверная S3-ссылка) до того, как мы заплатили за GPU-минуту.
Достаточно прогнать 1 эпоху на 1000 клеток. Bootstrap идентичен по командам
тому, что запустится на GPU; меняются только `--device`, `--num-workers`,
`--epochs` и кусок данных.

---

## 3. Пошаговый план для devops

> Все артефакты — в репозитории (никакого «отредактировал и забыл закоммитить»).
> Файлы создаёт devops в задаче KS-3071 (этот документ только спецификация).

### 3.1. Артефакты в репозитории (создаёт devops)

```
scripts/ml-training/
  user-data.sh           # bash, передаётся в RunInstances --user-data file://
  bootstrap.sh           # bash, исполняется внутри Docker-контейнера
  cpu-dry-run.sh         # bash, локальный dry-run (запускается до GPU)
  README.md              # одностраничная инструкция «как запустить»
```

`scripts/` уже в scope devops (по таблице ownership). Не путать с
`packages/board-image-to-fen/src/python/training/` — там лежат **алгоритмы**
(training-скрипты), они в зоне backend и трогать их не надо.

### 3.2. IAM (одноразовая настройка)

#### Instance Profile `kingside-ml-train` (уже создан в KS-3071, проверить)

Policy (минимальный набор):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadDatasetAndCode",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::kingside-ml",
        "arn:aws:s3:::kingside-ml/datasets/board-recog/*",
        "arn:aws:s3:::kingside-ml/_tmp/*"
      ]
    },
    {
      "Sid": "WriteRunArtifacts",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::kingside-ml/_tmp/runs/*"
    },
    {
      "Sid": "SSMAgentSelfManage",
      "Effect": "Allow",
      "Action": "ssm:UpdateInstanceInformation",
      "Resource": "*"
    }
  ]
}
```

Плюс managed-policy `AmazonSSMManagedInstanceCore` (нужна для Session Manager —
без неё `aws ssm start-session` не подключится для отладки).

> Финальная заливка в `models/board-recog/v1.0.0/` происходит **не из instance
> profile**, а с локальной машины devops через `tools/upload-board-model.sh`
> после человеческой валидации evaluation_report.json. Поэтому write-доступ
> инстанса ограничен `_tmp/runs/` — это сразу отрезает риск «обучилось плохо,
> но уехало в prod».

#### IAM-юзер `kingside-ci` (devops логинится в AWS)

Добавить, если не выдано (KS-3071 показал, что часть этого отсутствует):

```json
{
  "Sid": "EC2ManageMLTrain",
  "Effect": "Allow",
  "Action": [
    "ec2:RunInstances",
    "ec2:TerminateInstances",
    "ec2:StopInstances",
    "ec2:DescribeInstances",
    "ec2:DescribeInstanceStatus",
    "ec2:DescribeImages",
    "ec2:DescribeKeyPairs",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSubnets",
    "ec2:DescribeVpcs",
    "ec2:CreateTags"
  ],
  "Resource": "*"
},
{
  "Sid": "PassMLTrainRole",
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::*:role/kingside-ml-train"
},
{
  "Sid": "SSMDebug",
  "Effect": "Allow",
  "Action": [
    "ssm:StartSession",
    "ssm:TerminateSession",
    "ssm:DescribeSessions",
    "ssm:SendCommand",
    "ssm:GetCommandInvocation",
    "ssm:ListCommandInvocations",
    "ssm:ListCommands",
    "ssm:DescribeInstanceInformation"
  ],
  "Resource": "*"
},
{
  "Sid": "ReadOnlyLogs",
  "Effect": "Allow",
  "Action": [
    "logs:DescribeLogGroups",
    "logs:DescribeLogStreams",
    "logs:GetLogEvents",
    "logs:FilterLogEvents"
  ],
  "Resource": "*"
}
```

> **Уроки KS-3071, пункт 5:** `ssm:GetCommandInvocation / ListCommandInvocations /
> ListCommands` нужны для разбора падений user-data. Если их нет, devops
> вынужден поднимать SSH (или гадать). Эти права — НЕ опциональны.

### 3.3. Подготовка датасета и кода в S3 (одноразово)

Уже сделано в KS-3071:

- `s3://kingside-ml/datasets/board-recog/v1/` — датасет v1, манифест с SHA256.
- `s3://kingside-ml/_tmp/board-recog-training.tar.gz` — упакованный `packages/board-image-to-fen/src/python/training/` (sha256 фиксирован).

Перед каждым прогоном devops **сверяет sha256** локально-скачанного архива с
содержимым `s3api head-object` (метаданные `sha256=...`). Несовпадение → стоп.

> **Урок KS-3071, пункт 3:** код, попадающий в инстанс, должен быть
> immutable-артефактом с известным хешем. Не `git clone HEAD` (HEAD может
> поменяться между запусками), а tar.gz с зафиксированным sha256.

### 3.4. user-data.sh — что внутри

Полный контракт (логика, не точный bash; финальную версию пишет devops в
KS-3071):

```bash
#!/bin/bash
set -euxo pipefail

# 0. Гарантия терминирования при ЛЮБОМ выходе скрипта.
trap 'shutdown -h now' EXIT

# 1. CloudWatch-логи user-data (для последующего разбора).
exec > >(tee -a /var/log/user-data.log /dev/console) 2>&1

# 2. Тег, что инстанс «знает кто он».
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
RUN_ID="v1.0.0-$(date -u +%Y%m%dT%H%M%SZ)"

# 3. ВАЖНО: НИКАКОГО apt install. DLAMI Base GPU уже имеет docker + nvidia.
docker --version
nvidia-smi

# 4. Запуск контейнера. Все зависимости — внутри образа + pip install
#    в первом слое bootstrap.sh. На хосте — НИЧЕГО.
mkdir -p /opt/work
aws s3 cp s3://kingside-ml/_tmp/board-recog-training.tar.gz /opt/work/code.tar.gz
aws s3 cp s3://kingside-ml/_tmp/board-recog-bootstrap.sh /opt/work/bootstrap.sh
chmod +x /opt/work/bootstrap.sh

docker run --rm --gpus all \
    --shm-size=2g \
    -e RUN_ID="$RUN_ID" \
    -v /opt/work:/work \
    pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime \
    bash /work/bootstrap.sh

# 5. EXIT trap уведёт инстанс на shutdown. RunInstances запущен с
#    InstanceInitiatedShutdownBehavior=terminate → инстанс пропадёт.
```

> Важно: `aws s3 cp` на хосте отрабатывает потому что в DLAMI Base **уже
> предустановлен AWS CLI** (это часть deep-learning AMI). Если завтра AMI
> поменяется — fallback на `docker run … pip install awscli && aws s3 cp` через
> отдельный bootstrap-step (загрузка через snapshot AMI metadata).

### 3.5. bootstrap.sh — что внутри

```bash
#!/bin/bash
set -euxo pipefail
cd /work

# Распаковываем training-код (sha256 уже сверен на стороне user-data; здесь
# повторяем для contained-проверки).
EXPECTED_SHA="<тот sha256, что выдал backend при заливке tar.gz>"
ACTUAL_SHA=$(sha256sum code.tar.gz | awk '{print $1}')
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { echo "code sha mismatch"; exit 1; }
tar xzf code.tar.gz
cd python

# pip install внутри контейнера — версии всё из того же образа.
pip install --no-cache-dir -r training/requirements.txt awscli

# Скачиваем датасет. Через инстанс-профиль, ключи не нужны.
mkdir -p /work/data
aws s3 sync s3://kingside-ml/datasets/board-recog/v1/ /work/data/ \
    --exclude '*' \
    --include 'cells/*' \
    --include 'splits/*' \
    --include 'manifest_v1.json'

# Тренировка. --width-mult 0.5 чтобы уложить ONNX ≤ 1 MB (см. README KS-2361).
mkdir -p /work/runs/$RUN_ID
python -m training.train \
    --data-dir /work/data \
    --output   /work/runs/$RUN_ID \
    --epochs 20 \
    --batch-size 256 \
    --lr 1e-3 \
    --width-mult 0.5 \
    --num-workers 4 \
    --export-onnx

# Оценка PyTorch-чекпойнта.
python -m training.evaluate \
    --data-dir /work/data \
    --checkpoint /work/runs/$RUN_ID/best.pt \
    --split val

# Оценка ONNX-экспорта (проверка, что export не уронил точность).
python -m training.evaluate \
    --data-dir /work/data \
    --checkpoint /work/runs/$RUN_ID/model.onnx \
    --split val \
    --output /work/runs/$RUN_ID/evaluation_report.onnx.json

# Заливаем все артефакты в _tmp/runs/, НЕ в models/v1.0.0/.
# В models/ кладёт человек через tools/upload-board-model.sh после ревью.
aws s3 cp /work/runs/$RUN_ID/ s3://kingside-ml/_tmp/runs/$RUN_ID/ \
    --recursive \
    --exclude '*' \
    --include 'model.onnx' \
    --include 'best.pt' \
    --include 'last.pt' \
    --include 'evaluation_report.json' \
    --include 'evaluation_report.onnx.json' \
    --include 'train_log.jsonl' \
    --include 'training_meta.json'

echo "[done] artifacts: s3://kingside-ml/_tmp/runs/$RUN_ID/"
```

### 3.6. RunInstances — параметры

```bash
aws ec2 run-instances \
    --image-id ami-0654627d77623c930 \
    --instance-type g4dn.xlarge \
    --iam-instance-profile Name=kingside-ml-train \
    --security-group-ids sg-01ff3482db9b2b834 \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=ml-train,Value=board-recog-v1.0.0},{Key=Name,Value=kingside-ml-train-v1.0.0}]' \
    --user-data file://scripts/ml-training/user-data.sh \
    --region eu-central-1
```

Ключевые моменты:

- `ImageId` — Deep Learning Base GPU Nvidia Driver AMI (Ubuntu 22.04), последняя
  актуальная версия в eu-central-1 (devops при каждом запуске обновляет ID
  через `aws ec2 describe-images --owners amazon --filters "Name=name,Values=Deep
  Learning Base GPU * Ubuntu 22.04*"`).
- IMDSv2 обязателен (`HttpTokens=required`) — best practice безопасности.
- `InstanceInitiatedShutdownBehavior=terminate` — без этого `shutdown -h now`
  только остановит, не удалит инстанс.
- EBS gp3 100 ГБ — на датасет (~4 ГБ) + Docker-образ (~6 ГБ) + чекпойнты
  (~50 МБ × 20 эпох) + запас. gp3 дешевле gp2 и быстрее.

### 3.7. Защита от утечки $$ (instance leak)

Три уровня защиты, в порядке надёжности:

1. **EXIT trap + shutdown** в `user-data.sh` (см. §3.4).
2. **InstanceInitiatedShutdownBehavior=terminate** в run-instances (см. §3.6).
3. **CloudWatch-alarm**: метрика `EC2 → InstanceState` для тега
   `ml-train=board-recog-v1.0.0`, alarm при `state=running` AND `age>4h` →
   SNS Topic `ml-train-leaks` → email пользователя. Создаётся одноразово,
   живёт постоянно. Любой инстанс с этим тегом, который застрял > 4 ч, —
   получает уведомление.

### 3.8. Обработка типовых ошибок

| Симптом | Причина | Что делать |
|---|---|---|
| `docker pull` зависает / 429 | Docker Hub rate-limit | (a) повторить через 10 мин; (b) если регулярно — мигрировать образ в ECR (`aws ecr create-repository`, `docker tag && docker push`) |
| `nvidia-smi: not found` внутри docker | DLAMI ставит nvidia-driver, но toolkit нужно проверить | До тренировки на хосте: `docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi`. Если нет — `apt list --installed | grep nvidia-container-toolkit`; в крайнем случае поменять AMI на «AWS Deep Learning OSS Nvidia Driver Ubuntu 22.04» (другая редакция той же линейки) |
| `pip install: ResolutionImpossible` для torch==2.4.1 | внутри образа torch уже стоит, конфликт версий | Убрать `torch` и `torchvision` из аргументов `pip install`: `pip install --no-cache-dir $(grep -v 'torch' training/requirements.txt) awscli`. requirements.txt в нашем образе уже выполнен в части torch. |
| `CUDA out of memory` на g4dn.xlarge (16 ГБ VRAM) | `--batch-size 256` для нашей модели — впритык | Пересоздать инстанс с `--batch-size 128` (или 64). 1 эпоха станет на ~30% дольше. T4 имеет 16 ГБ — для MobileNetV3-Small `width_mult=0.5` `bs=256` должно влезать; если падает — `bs=128`. |
| Тренировка идёт, но `val_acc` стоит на ~7.7% (1/13) | bug в датасете / неверный split / dataloader сломан | Сразу остановить (`aws ec2 terminate-instances`). Прогнать `evaluate.py` на CPU локально с тем же датасетом — voспроизвести bug. **Не оставлять GPU крутящимся, пока разбираешься.** |
| user-data не запустился (инстанс висит на «pending» >5 мин) | синтаксическая ошибка в user-data.sh; AMI без cloud-init | `aws ssm start-session --target i-…` → `tail /var/log/cloud-init-output.log`. Если SSM не подключается — terminate, проверить, что у роли есть `AmazonSSMManagedInstanceCore`. |
| Спот-инстанс отозван в середине | Spot interruption | `last.pt` сохраняется каждую эпоху. На on-demand для разовой v1.0 риска нет; spot — только когда повторяемся регулярно. |
| `aws s3 cp` падает с `AccessDenied` | instance-profile не привязан к роли или роль не имеет нужного префикса | `aws sts get-caller-identity` на инстансе → должна быть `assumed-role/kingside-ml-train/...`. Если нет — `run-instances` без `--iam-instance-profile` (опечатка); пересоздать. |
| Артефакт `model.onnx` > 1 МБ | `width_mult=1.0` без INT8 даёт ~6 MB | Перезапустить с `--width-mult 0.5` либо использовать `python -m training.export_onnx --quantize int8 …`. См. README KS-2361. |
| `evaluation_report.json` не достигает acceptance ADR-040 §4.1 | плохая сходимость / маленький датасет / неверная аугментация | Отчитаться координатору. **НЕ заливать в `models/`.** Решение об итерации — у архитектора (новые гиперпараметры / расширение датасета / другая аугментация). |

### 3.9. После прогона — финальная заливка модели

Делается **с локальной машины devops** (или из агентского контейнера, у
которого есть STS-кредиты на write в `models/`), не из EC2:

```bash
aws s3 cp s3://kingside-ml/_tmp/runs/$RUN_ID/model.onnx ./model_v1.0.0.onnx
aws s3 cp s3://kingside-ml/_tmp/runs/$RUN_ID/evaluation_report.json ./evaluation_report.json

# Архитектор/координатор смотрят evaluation_report.json:
#   - per-cell ≥ 99% на топ-3 стилях
#   - per-cell ≥ 95% на остальных синтетических
#   - FEN match rate ≥ 90%
#   - размер ./model_v1.0.0.onnx ≤ 1 MB

# Если апрув — публикуем (immutable).
tools/upload-board-model.sh 1.0.0 ./model_v1.0.0.onnx ./evaluation_report.json

# Скрипт распечатает строку BOARD_RECOG_MODEL_VERSION=1.0.0 — её и проставить.
aws ecs register-task-definition ... --container-definitions \
    '<существующее с обновлённой env BOARD_RECOG_MODEL_VERSION=1.0.0>'
aws ecs update-service --cluster kingside --service kingside-api --task-definition kingside-api:<new>
aws ecs wait services-stable --cluster kingside --services kingside-api
curl -s https://api.kingside.../api/health | jq .modelVersion   # "1.0.0"
```

---

## 4. Локальный CPU-dry-run (обязательный шаг до GPU)

Цель: убедиться, что **bootstrap.sh** проходит до `train` без ошибок. Тренировку
полную на CPU не гоняем (она 20+ часов), достаточно `--epochs 1` на mini-датасете
из 1000 клеток.

`scripts/ml-training/cpu-dry-run.sh`:

```bash
#!/bin/bash
set -euxo pipefail

# 1. Подготовить mini-датасет (1000 клеток из v1).
mkdir -p /tmp/board-recog-dryrun/data
aws s3 cp s3://kingside-ml/datasets/board-recog/v1/manifest_v1.json /tmp/board-recog-dryrun/data/
# Скачиваем только первые 1000 файлов cells/ через --page-size + head — детали в скрипте

# 2. Тот же образ, без --gpus.
docker run --rm \
    -v /tmp/board-recog-dryrun:/work \
    -v $(pwd):/code:ro \
    pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime \
    bash -c "
        cd /code/packages/board-image-to-fen/src/python &&
        pip install --no-cache-dir \$(grep -v '^torch' training/requirements.txt) awscli &&
        python -m training.train \
            --data-dir /work/data \
            --output /work/runs/dryrun \
            --epochs 1 \
            --batch-size 32 \
            --num-workers 0 \
            --device cpu
    "

# Зелёный exit-code = bootstrap чистый. GPU можно запускать.
```

Время прогона: ~10 мин на ноуте.

> **Урок KS-3071, пункт 2:** не тестируем установку окружения на живом GPU. У
> CPU-инстанса c7i.large цена $0.085/час, у g4dn.xlarge $0.526/час. Каждая
> bootstrap-ошибка на GPU стоит в 6× дороже, чем тот же фикс на CPU.

---

## 5. Уроки KS-3071 — закрепляем в чек-листе

Список инвариантов, которые devops держит в голове на каждой ML-задаче:

1. **`apt install` пакетов, специфичных для версии Ubuntu, запрещён.** Всё, что
   варьируется между релизами (`awscli`, `libgl1`, `python3-venv`), идёт через
   фиксированный Docker-образ. Хост — только `docker` и `nvidia-toolkit`,
   которые УЖЕ стоят в DLAMI.
2. **Bootstrap-этап проверяется на CPU до GPU.** `scripts/ml-training/cpu-dry-run.sh`
   — обязательное предусловие RunInstances на g4dn/p3/p4d.
3. **`user-data.sh` и `bootstrap.sh` — файлы в репозитории, версионируемые
   git'ом.** Любая правка между падениями — это commit + push, не ручное
   редактирование в консоли AWS. Сравнить, что побежало → diff в git log.
4. **Код тренировки на инстансе — immutable tar.gz с зафиксированным sha256.**
   Не `git clone HEAD`. Хеш сверяется и на хосте (перед `docker run`), и внутри
   контейнера (в начале `bootstrap.sh`).
5. **IAM `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations`,
   `ssm:ListCommands`, `ssm:StartSession`** — обязательная часть permissions для
   debug-аккаунта (KS-3071 показал, что без них разбор падений превращается в
   гадание). Выдать заранее, не «по факту первого инцидента».
6. **EXIT trap + `InstanceInitiatedShutdownBehavior=terminate` + CloudWatch
   alarm на тег `ml-train`** — три уровня защиты от `instance leak`. Один из
   них может отказать (например, `set -e` ловит ошибку до `trap`), остальные
   подстрахуют.
7. **Артефакт на пути «обучили → опубликовали» проходит через ручной gate.**
   Тренировка пишет в `_tmp/runs/`, в `models/v<X>.<Y>.<Z>/` модель попадает
   только через `tools/upload-board-model.sh`, который человек запускает
   ПОСЛЕ человеческой проверки `evaluation_report.json`. Это сохраняет
   политику ADR-040 («не выкатывать в прод без апрува по acceptance»).

---

## 6. Что нужно от пользователя как разовое действие

> Это блок специально структурирован как чек-лист — пользователь должен пройти
> сверху вниз ОДИН раз, после чего devops дальше работает без участия.

1. **Quota request в AWS Support — On-Demand G/VT instances.**
   - Service: EC2. Quota: `Running On-Demand G and VT instances`
     (code `L-DB2E81BA`). Запросить **≥4 vCPU** (g4dn.xlarge = 4 vCPU) в
     регионе **eu-central-1**.
   - Тикет открывается через AWS Console → Service Quotas → EC2 → найти по
     коду → Request quota increase.
   - Время одобрения для новых аккаунтов: от 1 ч до 1 суток. Стоимость: 0.
2. **Quota request — Spot G/VT instances** *(желательно, не обязательно)*:
   - Quota: `All G and VT Spot Instance Requests` (code `L-3819A6DF`),
     запросить **≥4 vCPU** в eu-central-1.
   - Spot позволит экономить 60-70% от on-demand на будущих итерациях модели.
     Для разовой v1.0 не блокирует.
3. **Расширить IAM-политику юзера `kingside-ci`** добавлениями из §3.2
   (`EC2ManageMLTrain`, `PassMLTrainRole`, `SSMDebug`, `ReadOnlyLogs`).
   Если у пользователя есть git-управляемый IaC под IAM-политики — добавление
   через PR; если нет — через AWS Console.
4. **Подтвердить отсутствие SCP / Organization policy**, запрещающего G-instance
   в eu-central-1. На одиночном аккаунте обычно нет, но если используется AWS
   Organizations — проверить `aws organizations describe-policy`.
5. **Опционально: SNS Topic `ml-train-leaks` + email-subscription** на
   пользователя, чтобы получать уведомление о застрявших ml-train инстансах
   (см. §3.7). Создаётся одноразово; devops дальше подключит CloudWatch alarm.

После выполнения этих пунктов devops в KS-3071 запускает:

```
1. локальный cpu-dry-run.sh    → зелёный
2. aws ec2 run-instances ...   → g4dn.xlarge запустился
3. ждём ~50 минут              → инстанс сам терминировался
4. валидируем evaluation_report.json
5. tools/upload-board-model.sh 1.0.0 ...
6. ECS update + проверка /api/health
```

Без участия пользователя на шагах 1-6.

---

## 7. Когда переходить с Docker-on-EC2 на SageMaker / Batch

Текущий путь оправдан, пока:

- тренировок ≤ 1–2 в квартал;
- каждая тренировка инициируется человеком (по сигналу «накопили данных,
  обновим модель»);
- метрики ручного evaluation_report.json достаточны (нет regression-suite по
  серии моделей).

Переход на **SageMaker Training Job** оправдан, когда:

- появляется регулярный cron-ретренинг (например, еженедельно на новых
  телеметрических данных из KS-XXXX-8 в ADR-040);
- нужен MLflow / SageMaker Experiments для tracking;
- хочется hyperparameter tuning через `HyperparameterTuner`;
- готовы потратить 1–2 дня на адаптацию `training/train.py` под контракт
  `SM_CHANNEL_TRAIN` / `SM_MODEL_DIR` / `SM_NUM_GPUS`.

Переход на **AWS Batch** оправдан, когда:

- ML-задач становится несколько (board-recog, puzzle-classifier, eval-prediction
  и т. п.);
- хочется централизованную очередь с приоритизацией;
- хотим использовать spot fleet с автозаменой при interruption.

До тех пор Docker-on-EC2 — самый дешёвый по cognitive overhead путь. ADR на
миграцию писать **только** тогда, когда сработают триггеры выше.

---

## 8. Связанные документы

- ADR-040 (`docs/adr/040-universal-board-image-recognition.md`) — стек,
  acceptance, общий пайплайн.
- `packages/board-image-to-fen/src/python/training/README.md` — описание
  training-скриптов, аргументы CLI, acceptance из ADR.
- `tools/upload-board-model.sh` — публикация финальной модели в S3.
- KS-3071 — выполнение этого runbook'а на v1.0.
- KS-2364 — инфра-задача S3 + IAM (закрыта).
- KS-2361 — training-скрипты (закрыта).
