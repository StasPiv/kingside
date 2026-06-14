# ADR-126 — Вынос board-recognition из apps/api в отдельный сервис

- Статус: **Proposed** (2026-06-14). Реализация — backlog, требует апрува стоимости пользователем.
- Задача: KS-3708.
- Связанные ADR / задачи:
  - ADR-040 (universal board-image recognition) — текущая архитектура.
  - ADR-040-v2 (retraining) — формат моделей и pipeline.
  - ADR-018 (archive-service extraction) — образец «вынесли HTTP-модуль из api в отдельный домен».
  - ADR-021/022 (broadcast-service) — образец HTTP+worker сервиса.
  - ADR-042 (tactic-worker) — образец offline-сервиса (не HTTP). Stockfish-кейс из KS-2433 здесь имеет ограниченную применимость, см. §6.
  - ADR-045 (backend deploy-perf) — общие инвариaнты деплоя ECS.
  - KS-3701 (профиль развёртывания api), KS-3707 (правки api-образа без архитектурных изменений).
- Авторы: architect.

---

## 1. Контекст

### 1.1. Что есть сейчас

Board-recognition — это HTTP-эндпоинт `POST /board-recognition` (`apps/api/src/board-recognition/`, JWT-auth, multipart, лимит 8 MB). Запрос идёт через тонкий NestJS-controller → service → `RecognizeUniversalProvider`, который lazy-импортирует `@kingside/board-image-to-fen` и спавнит Python-скрипт `board_recognize.py` через `child_process`.

```
[apps/web SetPositionModal]                       [apps/api]                       [Python child-process]
  BoardImageDropzone ──POST /board-recognition──► BoardRecognitionController ────► board_recognize.py
                                                  └─► RecognizeUniversalProvider     ├─ board_detect.py
                                                      └─► @kingside/board-image-to-fen├─ ONNX classifier (12 MB)
                                                                                      ├─ ONNX findboards (12 MB)
                                                                                      └─ ONNX corner_detector (optional)
```

Контракт (DTO в `apps/api/src/board-recognition/dto/recognize-board.dto.ts` + клиент в `apps/web/src/api/boardRecognition.ts`):
- Вход: multipart `image` (PNG/JPG/BMP/WebP, ≤8 MB) + опциональный body `profile = auto | maizelis | dvoretsky | generic`.
- Выход: `BoardRecognitionResponse` = `{ fen, fenBoard, orientation, orientationConfidence, bbox, modelVersion, lowConfidenceCells[], warnings[], boards?[] }`.
- Ошибки: 400 `image_required` / `image_too_large` / `unsupported_media_type` / `board_not_detected`; 422 `recognition_unreliable`; 500 `model_load_failed` / `inference_failed`.
- Поддерживается режим multi-board (KS-3110) — массив `boards[]` если на скриншоте несколько досок.

### 1.2. Что board-recognition тащит в api-образ

Из разбивки слоёв по KS-3701 / `docs/devops/deploy-perf-api-2026-06-05.md`:

| Источник | Размер | Эффект на api |
|---|---|---|
| `RUN pip3 install numpy + Pillow + opencv-python-headless + onnxruntime` (слой #17) | **116.6 МБ** | целиком relevant |
| `apt install python3 + python3-pip + python3-venv + libgl1 + libglib2.0-0 + libsm6 + libxext6 + ffmpeg` (часть слоя #6) | **~60–80 МБ** | relevant (после KS-3717 awscli уже выпал) |
| `COPY packages/board-image-to-fen` (слой #14) | 3.4 МБ | relevant |
| `.bake-cache/{model.onnx, findboards.onnx}` (слой #25) | **24 МБ** | relevant (запекаются в образ по KS-3709) |
| Энтрипоинт-скачивание моделей из S3 (`download_*` в `docker-entrypoint.sh`) | 0 МБ образа | +3–7 с старта при отсутствии bake |

**Итого: ~204–224 МБ образа** (формулировка в KS-3708 «~230 МБ» подтверждается). Плюс `pip install` ~30–60 с при пересборке тяжёлого слоя (по KS-3701 — не каждый деплой, но регулярно при правках Dockerfile/зависимостей). Плюс ~3 с старта контейнера за счёт меньшего размера ECR-pull (см. оценки ниже).

### 1.3. Latency и нагрузка

Прямых метрик в коде нет. Косвенно:
- Цель ADR-040 §4.3 — `≤ 2 сек end-to-end` на 1080p входе.
- Единственный пользовательский путь — компонент `BoardImageDropzone` внутри `SetPositionModal` (`apps/web/src/components/SetPositionModal.tsx`). Это **редкая** ручная операция (открыть редактор позиции → загрузить картинку), не каждое посещение сайта.
- Оценка: десятки запросов в день, пиковая burst — до нескольких в минуту (например, контент-инженер заливает диаграммы из книги).
- Точные цифры **должны быть собраны** перед запуском работ (метрика по `BoardRecognitionController` или access-log api за 7 дней) — это входит в первый тикет реализации.

---

## 2. Цели и не-цели

**Цели:**
1. Убрать из api Python-стек + системные либы под OpenCV/ONNX и пакет `@kingside/board-image-to-fen`.
2. Сохранить пользовательский контракт неизменным — frontend не должен знать о переезде (либо прозрачное прокси через api, либо смена baseURL через `VITE_…`).
3. Latency end-to-end не выше текущего ADR-040-таргета (≤2 с p95).
4. Стоимость инфраструктуры — конкретная цифра в долларах в месяц, чтобы пользователь согласовал.

**Не-цели:**
- Переписывание pipeline-логики (`board_recognize.py`, `board_detect.py`) — переезжает как есть.
- Переписывание `@kingside/board-image-to-fen` — TS-обёртка либо умирает (если идём на «чистый Python»), либо переезжает в новый сервис как dev-tool для локальной отладки.
- Frontend-перенос (`apps/web/src/api/boardRecognition.ts`) — на первом этапе остаётся как есть; смена baseURL — опционально на втором этапе после стабильности.
- Замена ONNX-моделей или перетренировка (это ADR-040-v2).

---

## 3. Развилки

### 3.1. Стек: Python (FastAPI/Litestar) — победитель

| Вариант | За | Против |
|---|---|---|
| **Python + FastAPI/Litestar** ✅ | Pipeline уже целиком на Python (`board_recognize.py`, `board_detect.py`, ONNX-inference, OpenCV). Убирает 2 лишних слоя (TS-обёртка `@kingside/board-image-to-fen` + spawn + temp-file ping-pong). Меньше образа без Node.js runtime. | Новый стек в монорепо — Python-сервис в продакшене (раньше Python только в `packages/board-image-to-fen` как CLI). Нужно подтянуть Pythonразработку: pytest, pip-tools/uv для lockfile, ruff для линта. |
| Node + NestJS (тонкая обёртка, как сейчас) | Сохраняет TS-конвенцию монорепо, переиспользует Dockerfile-шаблон `archive-service` / `broadcast-service`. | Тащит Node runtime (~70 МБ) + child_process в Python, остаётся spawn-overhead + temp-file. Зачем нужен NestJS для одного эндпоинта-обёртки — нет ответа. |
| Lambda Python (без HTTP-сервера, сразу handler) | Lambda сама управляет процессом, не нужен веб-сервер. | Решение по hosting и стеку склеиваются. Удобнее разделить — стек на Python, hosting обсуждаем отдельно (§3.3). |

**Решение: Python 3.11 + Litestar** (легче и быстрее FastAPI на минимальной обвязке, async-first). Альтернатива FastAPI принимается — devops пусть выберет по знакомству.

### 3.2. Транспорт: REST (multipart) — победитель

| Вариант | За | Против |
|---|---|---|
| **REST `POST /recognize` (multipart, как сейчас)** ✅ | Контракт уже есть, фронт-клиент не меняется. Multipart binary-friendly. Один потребитель (api). | — |
| gRPC | Типизация через protobuf, streaming. | Один эндпоинт с binary payload — overkill. Schema-evolution уже работает через `packages/shared` DTO. В монорепо нет другой gRPC-инфры, нужно поднимать с нуля. |
| REST + presigned-S3 (frontend → S3 → trigger recognition) | Снимает 8 МБ payload с api. | Латентность ↑ (лишний round-trip), сложнее auth и cleanup, ради экономии 8 МБ multipart — не стоит. |

**Решение: REST multipart.** Endpoint в новом сервисе — `POST /recognize` (без `/api`-префикса, аналогично archive-service в ADR-018). Тело и схема ответа — 1-в-1 текущие.

### 3.3. Hosting: Fargate Spot (рекомендация) vs Lambda Container

Это **развилка для пользовательского апрува** — стоимость различается, но обе цифры маленькие.

| Вариант | Стоимость (eu-central-1, прикидка) | Latency | Минусы |
|---|---|---|---|
| **Fargate Spot, 0.25 vCPU + 0.5 GB RAM, desiredCount=1** ✅ | ~$5–7/мес (Spot ~70% дешевле on-demand) | Стабильная p95 ≤ 2 с (всегда тёплый). | Прерывания Spot — но recognize stateless и идемпотентен, ECS перезапустит. |
| Fargate on-demand, 0.25 vCPU + 0.5 GB RAM | ~$7.5/мес | Та же. | Дороже Spot, без выигрыша. |
| Lambda Container Image (Python 3.11, 1 GB RAM, ~250 МБ image) | ~$2–3/мес (1 000 req/день, ~5 с каждая) + 0$ за idle | **Холодный старт 8–15 с** (ONNX-модели + opencv грузятся в память) — UX-провал на первый запрос после простоя. |
| Lambda Container + Provisioned Concurrency (1 instance) | +$15–18/мес поверх pay-per-use, итого ~$17–21/мес | Холодные старты убраны (1 инстанс всегда тёплый). | Дороже Fargate Spot, тот же эффект «один тёплый воркер 24/7». |

**Рекомендация: Fargate Spot, 0.25 vCPU + 0.5 GB RAM, desiredCount=1.** Самый дешёвый стабильный вариант, нет cold-start, прерывания Spot для recognize-API некритичны.

**Open question для пользователя:** если ~$5–7/мес неприемлемы и есть желание платить только за фактические запросы — выбираем Lambda Container без Provisioned Concurrency (~$2–3/мес), но UX-латенция первого запроса после паузы будет 8–15 с (приемлемо для редкой ручной операции «открыл редактор → загрузил картинку», но не для частого использования). Если редкость подтвердится метриками (см. §1.3), Lambda без Provisioned — рабочий вариант.

### 3.4. Размещение и сетевая граница

- Поднимаем сервис в **той же VPC**, что api / archive-service / game-service (`kingside` cluster, `eu-central-1`).
- **Без публичного ALB.** Сервис общается только с api по приватной сети.
- Discovery: AWS Cloud Map (Service Discovery) → внутренний DNS `recognition.kingside.internal:8080`. ALB не нужен — один потребитель, нет смысла платить $16/мес за load-balancer.
- При желании на втором этапе — поддомен `recog.kingside.site` через ALB, если фронт начнёт ходить напрямую (но и тогда лучше через api-прокси, чтобы не светить отдельный auth).

### 3.5. Авторизация между api и сервисом

| Вариант | За | Против |
|---|---|---|
| **Shared secret в HTTP header `X-Internal-Auth`** ✅ | Простейшая реализация (env-var в обоих сервисах, валидация в Litestar middleware). Secret в AWS Secrets Manager. | Требует ротации (раз в N месяцев). Не самостоятельный «zero-trust», полагается на security group VPC. |
| mTLS | Crypto-grade auth. | Cert-management overhead, выпуск/ротация сертификатов, для одного потребителя — overengineering. |
| IAM-Auth (SigV4 на API Gateway) | Управление через IAM-роли. | Нужен API Gateway в схеме, дополнительная стоимость и сложность. |
| Только VPC security group (без auth заголовка) | Минимум кода. | Любой workload в VPC может стучаться — расширяет blast-radius при компрометации. |

**Решение: shared secret + security group.** Security group: разрешён вход только с api task'ов. Secret: ротация — раз в полгода вручную (devops добавит в runbook).

### 3.6. Контракт между api и сервисом

Два варианта:

**A. api проксирует** (фронт продолжает звать `POST /board-recognition` на api, api форвардит на recognition-сервис, прокидывает auth-заголовок и тело).

**B. фронт ходит напрямую на recognition-сервис** через новый поддомен (внешний ALB + TLS + CORS + JWT-валидация в сервисе).

| Критерий | A: api-прокси | B: напрямую |
|---|---|---|
| Изменения frontend | Нет | Сменить `VITE_BOARD_RECOG_URL`, обновить env, передеплоить web |
| Auth | JWT валидируется в api (как сейчас), сервис — только shared secret | Нужно валидировать JWT в сервисе (либо OIDC-introspect, либо share JWT secret) |
| Инфра | Только internal Cloud Map | Внешний ALB + TLS-cert + CORS + новый поддомен |
| Стоимость | $0 доп. | +$16/мес ALB |
| Уменьшает RPS api? | Минимально (request тащит 8 МБ через api в любом случае; но api держит TCP-socket до сервиса, blocking-IO короткая) | Да (api вообще из цепочки выпадает) |

**Решение: A. api-прокси на этапе M1.** Если по метрикам окажется, что recognize держит api-pod'ы под нагрузкой (вряд ли — операция редкая) — переходим на B (отдельный поддомен) отдельным ADR.

---

## 4. Архитектура (выбранный вариант)

```
[apps/web]
   │ POST /board-recognition (multipart, JWT)
   ▼
[apps/api  — BoardRecognitionController (тонкий прокси)]
   │ POST http://recognition.kingside.internal:8080/recognize
   │ Header: X-Internal-Auth: <shared-secret-from-secretsmanager>
   ▼
[apps/recognition-service  — Litestar, Python 3.11, Fargate Spot 0.25/0.5]
   │ /recognize → board_recognize.recognize_universal(...)
   ▼
   Python pipeline (board_detect → cell-classifier → FEN-assembly)
   ONNX models из /var/cache/board-recog (baked + S3 fallback)
```

### 4.1. Структура нового воркспейса

```
apps/recognition-service/
  Dockerfile
  pyproject.toml          # uv lockfile (deterministic)
  pre-bake.sh             # копия запекания моделей из apps/api/scripts/
  src/
    main.py               # Litestar app, health, /recognize, /metrics
    recognize.py          # импорт recognize_universal из packages/...
    auth.py               # X-Internal-Auth middleware
    model_loader.py       # порт из apps/api/src/board-recognition/model-loader.service.ts
  tests/
    test_recognize.py
    test_health.py
```

### 4.2. Что переезжает из api

| Что | Куда |
|---|---|
| `apps/api/src/board-recognition/{module,controller,service}.ts` | Заменяется на тонкий proxy-controller (15–30 строк): forward multipart + headers + body. Тесты переписать на mock fetch к сервису. |
| `apps/api/src/board-recognition/model-loader.service.ts` | Удаляется. Health-check api больше не репортит boardRecog (но добавляет блок «recognition-service reachable»). Логика выбора disabled/loaded/error переезжает в Python (`model_loader.py`). |
| `apps/api/src/board-recognition/dto/recognize-board.dto.ts` | Остаётся в api для типизации proxy + frontend. Перенос в `packages/shared/types/api-contracts.ts` — на втором этапе (отдельная задача). |
| `apps/api/docker-entrypoint.sh` блок `download_*_model()` | Удаляется. Переезжает в Python-сервис, в его собственный entrypoint. |
| `apps/api/scripts/download-model.mjs` | Заменяется на Python-эквивалент (`boto3`-скрипт или `aws-sdk` в pre-bake). Если pre-bake достаточен — скрипт вообще не нужен. |
| `apps/api/.bake-cache/{model.onnx, findboards.onnx}` | Переезжает в `apps/recognition-service/.bake-cache/`. |
| `apt install` (libgl1, libglib2.0-0, libsm6, libxext6, python3*, ffmpeg) | Удаляется из `apps/api/Dockerfile`. Остаётся в `apps/recognition-service/Dockerfile`. |
| `pip install` (numpy, Pillow, opencv-python-headless, onnxruntime) | Удаляется из `apps/api/Dockerfile`. Переезжает в `apps/recognition-service/pyproject.toml`. |
| `packages/board-image-to-fen/src/python/*.py` | Копируется в `apps/recognition-service/src/recognize/` (или зависит как git-submodule / pip editable). См. §4.4. |
| `packages/board-image-to-fen` (TS-обёртка) | Остаётся как **CLI для локальной разработки** chess-expert'ом. В api больше не импортируется, удаляется из `apps/api/Dockerfile` + `apps/api/package.json`. |

### 4.3. Что переезжает в api новое

- `apps/api/src/board-recognition/board-recognition.controller.ts` — становится тонким прокси (Nest `HttpService` или `fetch`-обёртка).
- `apps/api/src/board-recognition/recognition-client.ts` — клиент с retry/timeout, маппит ошибки сервиса в текущие HTTP-коды (контракт фронта неизменный).
- Env: `BOARD_RECOG_SERVICE_URL` (default — Cloud Map DNS), `BOARD_RECOG_SERVICE_AUTH` (из Secrets Manager).
- Health-check api: новый чек «recognition-service `/health` отвечает» (не блокирующий — degraded, не unhealthy; чтобы падение recognition-сервиса не клало api).

### 4.4. Где живёт Python-код recognize-pipeline'а

**Решение: переезжает целиком в `apps/recognition-service/src/recognize/`** (через `git mv` из `packages/board-image-to-fen/src/python/`). Преимущества:
- Один источник правды.
- Python deps управляются `pyproject.toml` сервиса.
- TS-обёртка `@kingside/board-image-to-fen` либо помечается deprecated, либо переписывается на REST-клиент к сервису (для CLI Nuance-режима chess-expert'у).

**Альтернатива:** оставить Python в `packages/board-image-to-fen` и тащить в Docker. Минус: монорепо тогда обслуживает Python-пакет, который никто кроме сервиса не импортирует. Принципиально хуже.

### 4.5. Модели

- Pre-bake в Docker (как сейчас в api по KS-3709) — копируем те же 24 МБ baked-versions в образ сервиса.
- S3 fallback (entrypoint скачивает) — переезжает в Python-сервис, читает те же ENV (`BOARD_RECOG_MODEL_VERSION`, bucket, region).
- ONNX-runtime в Python — основной сценарий. Версии моделей не меняются.

### 4.6. Dockerfile наброска

```dockerfile
FROM python:3.11-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY src ./src

FROM base AS production
COPY --from=build /app/.venv /app/.venv
COPY --from=build /app/src /app/src
COPY .bake-cache /var/cache/board-recog
ENV PATH=/app/.venv/bin:$PATH
ENV BOARD_RECOG_MODEL_DIR=/var/cache/board-recog
EXPOSE 8080
CMD ["python", "-m", "src.main"]
```

Оценка размера: `python:3.11-slim` (~45 МБ) + libgl-family (~50 МБ) + venv с numpy/onnxruntime/opencv-headless/Pillow/litestar (~250 МБ) + код (~10 МБ) + bake-models (24 МБ) ≈ **~380 МБ**. Сравнимо с tactic-worker (~350–420 МБ по ADR-042 §3).

---

## 5. Влияние на api

| Метрика | До | После |
|---|---|---|
| Размер образа api | 710.9 МБ (по KS-3701) → ~580 МБ (после KS-3707) | **~360–420 МБ** (−~160–220 МБ) |
| Длительность `docker build` (cold) | `pip install` 30–60 с + apt-extra 5–10 с | 0 (Python убран) |
| Время старта контейнера до /health | 12.3 с (по KS-3701), из них 3–7 с — `download_*` модели | ~5 с (entrypoint пропускает board-recog блок) |
| ECR pull (через NAT, ~21 МБ/с по KS-3060) | ~33.9 с на 710 МБ → ~27 с на 580 МБ | **~17–20 с** (−~7–10 с) |
| Health-check api: блок `boardRecog` | присутствует, репортит состояние model | удаляется (либо заменяется на reachability check к сервису) |
| Сложность api-Dockerfile | python3 + pip3 + 5 apt-libs + bake-cache + entrypoint blocks | минус всё перечисленное |

**Итого дополнительная экономия деплоя api при «cold» rollout: ~10–20 с** (минус ECR-pull + минус entrypoint download). При «warm» (минимальные изменения, кеш слоёв горячий) — выигрыша по времени почти нет, но образ всё равно меньше = меньше storage cost в ECR (мелочь) и меньше attack-surface.

---

## 6. Сравнение с KS-2433 (Stockfish-кейс)

KS-2433 ≠ образец «вынос в сервис». Это было «удаление фичи + бинарей» — `GameReportService` оказался не нужен, движок удалён вместе с кодом, отдельный сервис не появлялся (StockfishService в момент закрытия KS-2433 уже жил в tactic-worker по ADR-042).

| Аспект | KS-2433 (Stockfish) | KS-3708 (board-recognition) |
|---|---|---|
| Фича остаётся? | Нет, удалена целиком | **Да, активно используется** в SetPositionModal |
| Куда переезжает движок? | Не переезжает (уже был в tactic-worker как offline-tool) | В новый HTTP-сервис (online-tool) |
| Контракт с фронтом | Удаление endpoint'ов | Контракт сохраняется (api-прокси) |
| Runtime | Offline batch (ECS RunTask по расписанию) | Online HTTP (постоянный Fargate-сервис) |

Реальные образцы — **ADR-018 (archive-service)** и **ADR-021 (broadcast-service)**: оба — выделение HTTP-домена из api в отдельный сервис. Главные отличия от наших образцов:
- У нас нет своей БД (recognize stateless, всё in-memory + ONNX-файлы).
- У нас Python, а не NestJS (там были оба на NestJS, чтобы переиспользовать DI/конвенции; у нас core уже на Python).
- У нас нет публичного endpoint'а (api-прокси), у archive/broadcast — есть.

---

## 7. Стоимость

### 7.1. Прямые расходы (Fargate Spot, рекомендуемый вариант)

| Статья | $/мес | Комментарий |
|---|---|---|
| Fargate Spot, 0.25 vCPU + 0.5 GB RAM, 24/7 | ~$5–7 | Без ALB (Cloud Map discovery) |
| CloudWatch Logs (10 МБ/день) | ~$0.5 | Стандартный retention 7 дней |
| ECR storage (380 МБ image, ~5 ревизий) | ~$0.2 | $0.10/ГБ |
| Secrets Manager (1 secret для shared-auth) | $0.4 | $0.40/secret |
| **Итого** | **~$6–8** | |

Альтернатива (Lambda Container, без Provisioned Concurrency): ~$2–3/мес pay-per-use, но cold-start 8–15 с — обсудить с пользователем (см. §3.3).

### 7.2. Эффект на стоимость api

- ECR storage api: −150 МБ × 5 ревизий ≈ −$0.08/мес (мелочь).
- Fargate task api: не меняется (CPU/RAM те же).
- ECR data-transfer при pull (через NAT, $0.045/ГБ × ~150 МБ × 4 деплоя/день ≈ −$0.8/мес. Мелочь.

**Прямой денежный эффект от выноса — отрицательный (+$5–8/мес).** Польза не в долларах, а в:
- Скорости итераций (api-деплой быстрее).
- Меньше CPU minutes на сборку (api-Dockerfile упрощается).
- Меньше attack-surface api (нет Python и нативных либ).
- Изоляция: при OOM или зависании recognize-pipeline api не падает.

### 7.3. Эффект на usage-расходы

- Recognize-сервис при том же объёме запросов потребляет столько же CPU-времени, что раньше тратил api → нагрузка на api ↓ (вряд ли заметно).
- При росте board-recog трафика (например, контент-инженер заливает много диаграмм) — scaling сервиса не аффектит api.

---

## 8. План тикетов

Цепочка зависимостей: 8.1 → (8.2 параллельно с 8.3) → 8.4 → 8.5 → 8.6.

### 8.1. [backend + chess-expert] Сбор метрик текущей нагрузки (pre-flight)

**Scope:**
- Включить access-log по `BoardRecognitionController` на 7 дней (если нет — добавить логирование запросов с `req_id`, `user_id`, `image_size`, `latency_ms`, `status`).
- Спустя неделю снять статистику: rpd/rpm, p50/p95/p99 latency, размер payload, распределение по часам.
- Записать результат в `docs/architecture/board-recognition-load-2026-XX.md`.

**Acceptance:**
- Файл с метриками лежит в `docs/architecture/`.
- @architect ревьюит и подтверждает: «Lambda без Provisioned имеет смысл» или «нужен warm Fargate».

**Зависимости:** нет. Блокирует выбор hosting (если метрик нет — берём рекомендацию §3.3 = Fargate Spot).

### 8.2. [backend] Создать apps/recognition-service (skeleton)

**Scope:**
- Воркспейс `apps/recognition-service/` (Python 3.11 + Litestar/FastAPI + uv lockfile + pytest + ruff).
- `git mv packages/board-image-to-fen/src/python/* → apps/recognition-service/src/recognize/`.
- Litestar-handlers: `GET /health`, `POST /recognize` (multipart, валидация, маппинг ошибок).
- `model_loader.py` — порт из TS-аналога (env BOARD_RECOG_MODEL_VERSION / disabled / loaded / error).
- `auth.py` — middleware валидации `X-Internal-Auth`.
- Тесты: pytest на `/health`, smoke на `/recognize` (фикстура — картинка стартовой позиции).
- README с инструкцией локального запуска (`uv run python -m src.main`).

**Acceptance:**
- `pytest` зелёный.
- `docker build -t kingside-recognition-service .` собирается, образ ~380 МБ.
- Локально: `docker run -p 8080:8080 …` → `curl -F image=@start.png http://localhost:8080/recognize` возвращает FEN.

**Зависимости:** 8.1 (понимать какой hosting — влияет на размерности Dockerfile/Litestar config, минорно).

### 8.3. [devops] Инфраструктура Fargate Spot + Cloud Map + Secrets

**Scope:**
- ECR repo `kingside-recognition-service`.
- ECS task-def `kingside-recognition-service` (Fargate Spot, 0.25 vCPU + 0.5 GB RAM, log group, awsvpc).
- ECS service `kingside-recognition-service`, desiredCount=1, в той же VPC что api.
- Security group: вход только с api task-role / api security group, порт 8080.
- AWS Cloud Map: `recognition.kingside.internal` → ECS service.
- Secrets Manager: `kingside/recognition-service/shared-auth` (32-байт random), плюс копия в `kingside/api/board-recog-service-auth`.
- IAM роли: task-execution + task-role для recognition-service (доступ к S3 `models/board-recog/*` для скачивания ONNX, Secrets для shared-auth, CloudWatch Logs).
- CI: build-pipeline для нового сервиса (path-filtered, по образцу archive-service).
- Runbook `docs/runbooks/recognition-service.md` (как смотреть логи, как обновить модель в S3, как ротировать shared-auth).

**Acceptance:**
- ECS service в RUNNING, /health отвечает 200.
- api-task может достучаться `curl http://recognition.kingside.internal:8080/health` (smoke с задеплоенного api).
- Runbook опубликован.

**Зависимости:** 8.2 (нужен Dockerfile + образ в ECR).

**Стоимость:** ~$6–8/мес (см. §7.1). **Нужен апрув пользователя перед стартом этого тикета.**

### 8.4. [backend] api-прокси + удаление board-recognition кода

**Scope:**
- `apps/api/src/board-recognition/board-recognition.controller.ts` → thin proxy:
  - Принимает multipart как сейчас.
  - Форвардит на `BOARD_RECOG_SERVICE_URL` с заголовком `X-Internal-Auth` из ENV.
  - Маппит ошибки сервиса в текущие коды (контракт фронта неизменный).
- Удалить: `board-recognition.service.ts`, `model-loader.service.ts`, `recognize-universal.provider.ts`, dependency `@kingside/board-image-to-fen` в api package.json.
- `apps/api/Dockerfile`:
  - Удалить `apt install` Python + libgl* + libglib2.0-0 + libsm6 + libxext6 + ffmpeg (оставить только нужное для Node).
  - Удалить `pip install ...`.
  - Удалить `COPY packages/board-image-to-fen`.
  - Удалить `mkdir /var/cache/board-recog` + `COPY .bake-cache`.
- `apps/api/docker-entrypoint.sh`:
  - Удалить функции `download_board_recog_model`, `download_corner_detector`, `download_find_boards_model`.
  - Удалить параллельные `wait` блоки и `export BOARD_DETECT_NN_MODEL`/`BOARD_FINDBOARDS_MODEL_PATH`.
- `apps/api/scripts/download-model.mjs` — удалить (или оставить с пометкой deprecated, если ещё где-то нужен — проверить, что нет).
- `apps/api/src/health.controller.ts`:
  - Удалить блок `boardRecog`. Опционально — добавить reachability-check `recognition-service /health` (degraded, не unhealthy).
- Тесты: переписать `board-recognition.controller.spec.ts` на mock fetch (или nock).
- `.env.example`: добавить `BOARD_RECOG_SERVICE_URL`, удалить `BOARD_RECOG_MODEL_VERSION`/`BOARD_RECOG_MODEL_PATH`/`BOARD_RECOG_MODEL_DIR`/`BOARD_RECOG_MODEL_BUCKET`/`BOARD_RECOG_MODEL_REGION`/`BOARD_FINDBOARDS_MODEL_VERSION`/`BOARD_FINDBOARDS_MODEL_PATH`.

**Acceptance:**
- Тесты api зелёные.
- Размер api-образа измерен до/после, цифры в комментарии задачи.
- На стейдже full happy-path: web → api-прокси → recognition-service → FEN.

**Зависимости:** 8.3 (сервис должен быть в RUNNING).

### 8.5. [backend] Удаление packages/board-image-to-fen из api-flow

**Scope:**
- Подтвердить, что после 8.4 пакет `@kingside/board-image-to-fen` не импортируется ни одним workspace api/web (grep).
- Если используется только chess-expert'ом для CLI — оставить как dev-tool с пометкой в README.
- Если не используется нигде — удалить пакет целиком (`rm -rf packages/board-image-to-fen` + `npm install` для очистки lockfile).

**Acceptance:**
- `grep -r '@kingside/board-image-to-fen' apps packages` — пусто или только в `apps/recognition-service` (если оставлен как dev-tool) или вообще пусто.
- Размер `node_modules/.package-lock.json` уменьшился (мелочь).

**Зависимости:** 8.4.

### 8.6. [devops + coordinator] Мониторинг и алерты

**Scope:**
- CloudWatch alarm: `recognition-service` task health-check fails → notify (то же канал, что для api).
- Metrics dashboard: rpm, p50/p95/p99 latency, error rate, model status (loaded/disabled/error).
- Алерт на длительный disabled/error статус модели (>10 минут).
- Документация: «как добавить модель новой версии» (как сейчас в `docs/devops/`, переписать под новый сервис).

**Acceptance:**
- Alarm срабатывает при ручном `aws ecs stop-task` на recognition-service.
- Dashboard опубликован, ссылка в runbook.

**Зависимости:** 8.3.

---

## 9. Открытые вопросы (на согласование пользователя через координатора)

1. **Стоимость ~$6–8/мес на Fargate Spot — апрув?** Альтернатива: Lambda Container без Provisioned Concurrency (~$2–3/мес) с риском 8–15 с cold-start первой операции (для редкой ручной операции «открыл редактор → загрузил» это приемлемо; для случая «контент-инженер залил 50 диаграмм подряд» — первый запрос медленный, остальные тёплые).
2. **Frontend на этапе M1 — через api-прокси (рекомендация) или сразу на отдельный поддомен?** Прокси проще (фронт не трогаем), отдельный поддомен снимает api из цепочки (+$16/мес ALB или ApiGW HTTP-API ~$1/мес).
3. **`packages/board-image-to-fen` — оставить как CLI dev-tool или удалить полностью?** Зависит от того, использует ли его chess-expert для локальной разработки или для пакетного импорта диаграмм из книг. Если нет — удалить.
4. **Кто триггерит pre-flight метрики (тикет 8.1)?** Координатор решает: дать неделю на сбор статистики до апрува стоимости, или принять hosting-решение «по образцу» (Fargate Spot) и стартовать без метрик.

---

## 10. Резюме

- Вынос board-recognition из api в отдельный **Python-сервис на Fargate Spot (0.25 vCPU + 0.5 GB RAM, ~$6–8/мес)** убирает из api ~204–224 МБ образа (pip + system libs + bake-models), ускоряет cold-pull api на ~7–10 с, упрощает Dockerfile и снимает Python с api полностью.
- Образец — **ADR-018 (archive-service)** и **ADR-021 (broadcast-service)**, а не KS-2433 (Stockfish был удалён, не вынесен).
- Контракт с фронтом не меняется (api-прокси). Auth между api и сервисом — shared secret + VPC security group.
- **Денежный эффект отрицательный** (+$6–8/мес), плюсы — в скорости итераций, изоляции и упрощении api.
- 6 тикетов на реализацию (1 pre-flight + 1 skeleton + 1 infra + 1 api-cleanup + 1 package-cleanup + 1 monitoring), зависимости описаны.
- **Стоимость требует согласования пользователя** перед стартом тикета 8.3 (создание Fargate Spot service).
