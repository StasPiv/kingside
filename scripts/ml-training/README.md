# ML-training scripts (board-recog)

Имплементация runbook'а `docs/operations/ml-training-board-recog-runbook.md`.
Сценарий — разовая GPU-тренировка модели распознавания клеток шахматной доски
на временной EC2 g4dn.xlarge. Все зависимости — внутри Docker-образа
`pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime`. На хосте **никакого `apt install`**.

Файлы:

| Файл | Где запускается | Назначение |
|---|---|---|
| `user-data.sh` | хост EC2 (через `RunInstances --user-data`) | Pull artefacts из S3 + `docker run --gpus all` контейнера + shutdown→terminate |
| `bootstrap.sh` | внутри Docker-контейнера на EC2 | sha256-check кода, pip install, `aws s3 sync` датасета, train→evaluate→export→upload в `_tmp/runs/` |
| `cpu-dry-run.sh` | локально (ноутбук devops) | Проверка bootstrap на CPU перед GPU-запуском, ~10 мин |

## Однократный pre-flight

```bash
# 1. CPU dry-run: тот же образ, тот же код, mini-датасет, 1 эпоха на CPU.
./scripts/ml-training/cpu-dry-run.sh
# Зелёный exit-code = bootstrap чистый.
```

## Запуск GPU-тренировки

```bash
# 2. Залить bootstrap.sh в S3 (user-data его оттуда забирает).
aws s3 cp scripts/ml-training/bootstrap.sh s3://kingside-ml/_tmp/board-recog-bootstrap.sh

# 3. Поднять инстанс.
aws ec2 run-instances \
    --region eu-central-1 \
    --image-id $(aws ec2 describe-images --region eu-central-1 --owners amazon \
        --filters 'Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*' \
                  'Name=state,Values=available' \
        --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text) \
    --instance-type g4dn.xlarge \
    --iam-instance-profile Name=kingside-ml-train \
    --security-group-ids sg-01ff3482db9b2b834 \
    --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=ml-train,Value=board-recog-v1.0.0},{Key=Name,Value=kingside-ml-train-v1.0.0}]' \
    --user-data file://scripts/ml-training/user-data.sh
```

Инстанс ~50–60 минут крутит тренировку, заливает артефакты в
`s3://kingside-ml/_tmp/runs/v1.0.0-<ts>/`, делает `shutdown -h now`. AWS
автоматически переводит в `terminated` (благодаря `InstanceInitiatedShutdownBehavior`).

## После прогона — финальная заливка

После ручной валидации `evaluation_report.json` по acceptance ADR-040 §4.1
(per-cell ≥99% топ-3 / ≥95% остальные / FEN ≥90% / model.onnx ≤1 МБ):

```bash
aws s3 cp s3://kingside-ml/_tmp/runs/<run_id>/model.onnx ./model_v1.0.0.onnx
aws s3 cp s3://kingside-ml/_tmp/runs/<run_id>/evaluation_report.json ./evaluation_report.json
tools/upload-board-model.sh 1.0.0 ./model_v1.0.0.onnx ./evaluation_report.json
```

См. runbook §3.9 и §3.8 (типовые ошибки).
