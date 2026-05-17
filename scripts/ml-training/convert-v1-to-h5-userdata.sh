#!/bin/bash
# KS-3071 / runbook §9.5 вариант (b) — одноразовая конверсия датасета v1 → v1-h5.
# CPU EC2 (c7i.large), без GPU. ~30–60 мин (включая sync 1M PNG из v1/).
# По завершении: aws s3 cp recursive в s3://kingside-ml/datasets/board-recog/v1-h5/.
# В завершении (успех/ошибка) self-terminate.

set -euxo pipefail
exec > >(tee -a /var/log/convert.log /dev/console) 2>&1

S3_TMP="s3://kingside-ml/_tmp/convert-v1-h5"
S3_DST="s3://kingside-ml/datasets/board-recog/v1-h5"
trap 'aws s3 cp /var/log/convert.log "$S3_TMP/convert.log" || true; shutdown -h now' EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends docker.io awscli ca-certificates unzip
systemctl enable --now docker

# Параллелим S3 (по умолчанию max_concurrent_requests=10 — для 1М мелких файлов
# = часы. С 256 потоков и большой очередью — ~30 минут на v1/).
aws configure set default.s3.max_concurrent_requests 256
aws configure set default.s3.max_queue_size 100000
aws configure set default.s3.multipart_threshold 64MB
aws configure set default.s3.multipart_chunksize 16MB

WORK=/opt/work
mkdir -p "$WORK/v1" "$WORK/v1-h5"
cd "$WORK"

# (1) Training-код (содержит convert_v1_to_h5.py, dataset.py с h5-backend).
aws s3 cp s3://kingside-ml/_tmp/board-recog-training.tar.gz "$WORK/code.tar.gz"
EXPECTED_SHA="75f06cf5586adee0c3b58b5c4259acbbf13ad9f7dea0dc295a2313d9fcf0817a"
ACTUAL_SHA=$(sha256sum "$WORK/code.tar.gz" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "sha mismatch: got $ACTUAL_SHA want $EXPECTED_SHA" >&2; exit 1
fi
tar xzf "$WORK/code.tar.gz" -C "$WORK/"
test -f "$WORK/training/convert_v1_to_h5.py"

# (2) Скачиваем весь v1 (PNG + splits + manifest). С 256 параллельностью
#     ~30 мин. cp --recursive быстрее чем sync (без discovery scan).
echo "==== sync v1 start: $(date -u +%FT%TZ) ===="
aws s3 cp s3://kingside-ml/datasets/board-recog/v1/ "$WORK/v1/" \
  --recursive --only-show-errors
echo "==== sync v1 done: $(date -u +%FT%TZ) ===="
du -sh "$WORK/v1"
find "$WORK/v1/cells" -type f | wc -l

# (3) Конверсия внутри pytorch образа (там Python 3.11 + numpy + Pillow).
#     h5py ставится из requirements.txt в текущем training/.
docker pull pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime
docker run --rm \
  --network host \
  -v "$WORK:/work" \
  pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime \
  bash -c '
    set -euxo pipefail
    cd /work
    pip install --no-cache-dir h5py==3.11.0
    # Backend (KS-3080) реализовал CLI как --data-dir/--output-dir/--workers/--splits
    # (runbook §9.5 говорит --src/--dst — но это псевдокод-шаблон, актуально из py).
    python -m training.convert_v1_to_h5 \
        --data-dir /work/v1 \
        --output-dir /work/v1-h5 \
        --workers $(nproc)
    ls -la /work/v1-h5
    ls -la /work/v1-h5/splits
  '

# (4) sha256 каждого .h5 и заливка.
cd "$WORK/v1-h5"
for f in cells_train.h5 cells_val.h5 cells_test.h5; do
  if [ -f "$f" ]; then
    sha256sum "$f"
  fi
done > "$WORK/v1-h5.sha256"
cat "$WORK/v1-h5.sha256"

echo "==== upload v1-h5 start: $(date -u +%FT%TZ) ===="
aws s3 cp "$WORK/v1-h5/" "$S3_DST/" --recursive --only-show-errors
aws s3 cp "$WORK/v1-h5.sha256" "$S3_DST/h5.sha256.txt"
echo "==== upload v1-h5 done: $(date -u +%FT%TZ) ===="

echo "OK $(date -u +%FT%TZ)" > /tmp/ok.txt
aws s3 cp /tmp/ok.txt "$S3_TMP/completion-OK.txt"
echo "[done] $S3_DST/"
