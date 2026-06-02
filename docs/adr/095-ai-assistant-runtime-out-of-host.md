# ADR-095. Вынос рантайма AI-ассистента из webhook-server.py в зону агентов

Статус: предложен (KS-3572).
Дата: 2026-06-02.
Связано: ADR-061 (MCP API auto-discovery), ADR-062 (features-catalog), ADR-063 (knowledge source), KS-3321 (текущий инцидент), KS-2967 (Phase 2 knowledge-tools).

## 1. Контекст

Сегодня AI-ассистент на проде упирается в `ChatDaemon` внутри `webhook-server.py`. Файл живёт на личной машине пользователя и обслуживается через nginx на VPS Kamatera (`63.250.57.89`). Этот файл — инфраструктура управления агентами (правило проекта: его правит ТОЛЬКО пользователь, ни один агент не имеет права туда писать).

Симптомы (KS-3321, повтор 02 июня):
- 45-секундный таймаут на `ChatDaemon` захардкожен в `webhook-server.py`.
- После рестарта webhook первый запрос с `--resume` сессии большого пользователя (`06f68cfd`) превышает 45 с (cold-start: загрузка MCP-tools + восстановление `.jsonl`-сессии). Daemon убивается по таймауту → retry-цикл стартует тот же cold-start заново → процесс никогда не успевает прогреться → ассистент молчит.
- Любая оптимизация (повышение таймаута, pre-warm-pool, отказ от `--resume`, кэш MCP-tools) требует правок в `webhook-server.py` — это вне зоны всех агентов.

Текущая авторизация:
- Claude Code CLI с **OAuth-credentials** (`~/.claude/.credentials.json`) — подписка Claude Pro/Max пользователя. `ANTHROPIC_API_KEY` не задействован.
- Лог из daemon-сессии: `"apiKeySource":"none"`, `"rateLimitType":"five_hour"`, `"overageDisabledReason":"out_of_credits"` — лимиты per-account, разделяемые с агентами.

Цитата пользователя из задачи: «ассистент не должен зависеть от моей зоны, любые runtime/operations ассистента — в зоне агентов».

**Жёсткое ограничение пользователя (через координатора, KS-3572 уточнение):**
- Использовать **ANTHROPIC_API_KEY** (per-token billing) **нельзя** — стоимость неприемлема.
- Остаются только **OAuth-пути** на существующей подписке Claude Pro/Max.

## 2. Цели и нон-цели

### Цели

1. Runtime ассистента полностью в нашем репо / нашем AWS-стеке. Никаких файлов на хосте пользователя в критическом пути.
2. Cold-start первого ответа после рестарта — **<45 с p99**. Идеально — <10 с p50.
3. Сохранить полный набор MCP-tools, доступный сейчас через webhook (включая Phase 2 knowledge-tools из KS-2967).
4. Авторизация через **OAuth Claude Pro/Max** — без `ANTHROPIC_API_KEY`.
5. Возможность откатиться на текущий webhook за 1 minute через ENV-флаг (миграция без простоя).

### Нон-цели

- Замена UX чата (фронт, SSE-стрим, history) — остаётся как есть.
- Перепроектирование MCP-сервера `tools/mcp-kingside.mjs` (он уже в нашей зоне, правит backend).
- Многоязычность, goal-driven навигация, RAG (ADR-063 Phase 3) — отдельные задачи.
- Полный отказ от `webhook-server.py` для агентов — он остаётся для разработческих агентов (это его прямое назначение), но **перестаёт быть критическим путём для пользовательского чата**.

## 3. Решение (краткое)

Принимаем **C2** — отдельный сервис `apps/ai-runtime` в нашем репо, контейнер в ECS Fargate, запускает `claude` CLI как subprocess с OAuth-credentials из AWS Secrets Manager.

Обоснование (см. §4 и §6):
- Изоляция OAuth-credentials в отдельной task definition с минимальным IAM-scope (не смешиваем с api, где много другого).
- Отдельный auto-scaling — pre-warm-pool горячих daemon'ов масштабируется независимо от api.
- Падение subprocess'а `claude` (OOM, OAuth refresh fail) не валит api, чат деградирует в «временно недоступен».
- При device fingerprint regression — откатить отдельный сервис проще, чем откатывать api.
- Архитектурно близко к существующим `archive-importer`, `tactic-worker` — паттерн в проекте отработан.

Вариант **B** (claude CLI прямо в api) — отвергнут из-за смешения ответственностей и одной OAuth-сессии на весь api-кластер (если api ауто-скейлится — каждый под тянет credentials и стартует свой пул daemon'ов, multi-process OAuth contention неисследована).

Реализация — поэтапная, через ENV-флаг `AI_CHAT_RUNTIME=webhook|ai-runtime` в api. Откат — переключение флага без redeploy.

## 4. Сравнение оставшихся вариантов

|  | **B. claude CLI в `apps/api`** | **C2. Отдельный сервис `apps/ai-runtime` (выбран)** |
|---|---|---|
| OAuth credentials | Mount в каждый api-pod через Secrets Manager | Mount только в `ai-runtime`-pod'ы |
| IAM-scope для секрета | широкий (api имеет много IAM permissions) | узкий (отдельная task role) |
| Auto-scaling сетки | вместе с api (избыточные daemon'ы на каждом api-pod'е) | независимый, по chat-RPS |
| Pre-warm pool | в каждом api-pod'е, дублируется | централизованный, экономия памяти |
| Падение subprocess | риск для всего api-pod'а (OOM Killer на ноду) | изолировано в `ai-runtime` |
| Размер api-образа | +200-300 MB (Claude Code npm + node runtime) | api не растёт |
| Multi-process OAuth contention | риск (N api-pod'ов = N процессов под одной OAuth-сессией) | контролируем (один pool менеджер) |
| Сложность инфры | низкая (один Dockerfile меняется) | средняя (новая ECS service, task-def, ALB-route) |
| Объём работ MVP | 3-4 дня backend + 1 день devops | **5-7 дней backend + 2-3 дня devops** |
| Откат на webhook | ENV-флаг в api | ENV-флаг в api + остановка ai-runtime service |
| Совместимость с future-фичами (например, отдельный pool по тарифам) | низкая | высокая |

**Решение:** C2. Дополнительные 2-3 дня devops окупаются изоляцией и независимым scaling. Pattern «отдельный сервис в `apps/*`» уже отработан (см. `apps/archive-importer`, `apps/tactic-worker`).

## 5. Архитектура C2

### 5.1. Компоненты

```
┌────────────────────────────────────────────────────────────────┐
│                          Frontend (web)                        │
└────────────────────────────────────────────────────────────────┘
                                  │ POST /chat
                                  ▼
┌────────────────────────────────────────────────────────────────┐
│                     apps/api (ECS Fargate)                     │
│   chat.controller.ts → ChatAssistantService                    │
│                                                                │
│   if (AI_CHAT_RUNTIME === 'ai-runtime')                        │
│     → AiRuntimeClient.invoke({ userId, message, conv })        │
│   else (webhook)                                               │
│     → existing fetch(AI_CHAT_WEBHOOK_URL)  ← fallback          │
└────────────────────────────────────────────────────────────────┘
                                  │ POST /invoke (internal HTTP)
                                  ▼
┌────────────────────────────────────────────────────────────────┐
│              apps/ai-runtime (ECS Fargate, новый)              │
│                                                                │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  HTTP-сервер (Express/Nest-mini)                         │ │
│   │   POST /invoke   { userId, message, conversationId }     │ │
│   │   POST /warm     (опционально, для health-check)         │ │
│   │   GET  /health                                           │ │
│   └──────────────────────────────────────────────────────────┘ │
│                            │                                   │
│                            ▼                                   │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  DaemonPool                                              │ │
│   │   - N pre-warmed `claude` subprocess'ов (idle)           │ │
│   │   - lease(userId) → возвращает горячий daemon            │ │
│   │   - sessionStore — мапа userId → daemonId + sessionId    │ │
│   │   - refill — при опустошении пула стартует новые         │ │
│   └──────────────────────────────────────────────────────────┘ │
│                            │ spawn                             │
│                            ▼                                   │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  `claude` CLI (subprocess)                               │ │
│   │   - OAuth creds: mount /home/runtime/.claude/credentials │ │
│   │     ← AWS Secrets Manager (CLAUDE_OAUTH_CREDENTIALS)     │ │
│   │   - MCP config: tools/mcp-kingside.mjs (тот же что у     │ │
│   │     webhook-server.py, COPY в образ)                     │ │
│   │   - --resume <sessionId> для возобновления контекста     │ │
│   └──────────────────────────────────────────────────────────┘ │
│                            │ MCP-protocol                      │
│                            ▼                                   │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  MCP-сервер kingside (stdio)                             │ │
│   │   - ходит в api за /_mcp/tools                           │ │
│   │   - knowledge-tools (KS-2967), lesson-tools и т.п.       │ │
│   └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
                                  │ HTTP/MCP discovery
                                  ▼
                          api /_mcp/tools
```

### 5.2. Структура нового сервиса `apps/ai-runtime`

```
apps/ai-runtime/
  Dockerfile                        # node + claude CLI + mcp-kingside.mjs
  package.json
  src/
    main.ts                         # HTTP-сервер (Nest или плоский Express)
    invoke.controller.ts            # POST /invoke
    daemon-pool/
      daemon-pool.service.ts        # пул горячих daemon'ов
      daemon-lease.ts               # lease/release семафор
      claude-process.ts             # обёртка над spawn('claude', ...)
    session/
      session-store.service.ts      # мапа userId → sessionId, persist в Redis
    health/
      health.controller.ts          # GET /health, GET /ready
    oauth/
      credentials-loader.ts         # читает /run/secrets/claude-creds
  scripts/
    install-claude-code.sh          # npm i -g @anthropic-ai/claude-code
    smoke.sh                        # локальный smoke OAuth+invoke
```

Dependencies:
- Node.js 20-slim (как api).
- `@anthropic-ai/claude-code` (глобально через npm).
- `mcp-kingside.mjs` — COPY из `tools/` в финальный образ (или через npm-workspace, обсуждаемо).

### 5.3. Авторизация и mount OAuth-credentials

Поток:
1. Пользователь локально выполняет `claude login` → получает `~/.claude/.credentials.json` (~471 байт, JSON с `access_token` + `refresh_token` + `expires_at` + связанный email).
2. **Пользователь** загружает содержимое файла в AWS Secrets Manager:
   - имя секрета `kingside/ai-runtime/claude-oauth-credentials`,
   - тип SecretString (raw JSON-payload).
3. ECS task definition `ai-runtime`:
   - `secrets`-блок маппит secret value в env-переменную `CLAUDE_OAUTH_CREDENTIALS_JSON`.
   - `entrypoint.sh` пишет содержимое в `/home/runtime/.claude/.credentials.json` (chmod 600, chown runtime), запускает HTTP-сервер.
4. При spawn `claude` CLI читает credentials из `~/.claude/.credentials.json`, делает refresh access-token при истечении.
5. После refresh **новый refresh_token не сохраняется** обратно в Secrets Manager (in-memory только). См. §6.1 — это требует периодической ручной ротации.

IAM-роль `AiRuntimeTaskRole`:
- `secretsmanager:GetSecretValue` только на `kingside/ai-runtime/*`.
- `logs:CreateLogStream`, `logs:PutLogEvents` на свой log group.
- Никаких других permissions (ни S3, ни SES, ни api-database — это всё остаётся в api).

### 5.4. Pre-warm pool

```ts
class DaemonPool {
  private readonly pool: ClaudeProcess[] = [];
  private readonly minIdle = 2;     // ENV: AI_RUNTIME_MIN_IDLE
  private readonly maxTotal = 8;    // ENV: AI_RUNTIME_MAX_TOTAL
  private readonly leases = new Map<string, ClaudeProcess>(); // userId → process

  async lease(userId: string): Promise<ClaudeProcess> {
    // 1. Если у юзера уже leased daemon — вернуть его.
    const existing = this.leases.get(userId);
    if (existing && existing.alive) return existing;

    // 2. Взять idle из пула.
    const idle = this.pool.shift();
    if (idle) {
      this.leases.set(userId, idle);
      this.refillAsync(); // фоном пополнить
      return idle;
    }

    // 3. Если total < maxTotal — спавнить новый.
    if (this.totalCount() < this.maxTotal) {
      const fresh = await this.spawnAndWarm();
      this.leases.set(userId, fresh);
      return fresh;
    }

    // 4. Иначе — wait queue (FIFO с таймаутом 30с).
    return this.waitForRelease(userId, 30_000);
  }

  release(userId: string, daemon: ClaudeProcess): void {
    this.leases.delete(userId);
    if (daemon.alive && this.pool.length < this.minIdle) {
      this.pool.push(daemon); // возвращаем в idle
    } else {
      daemon.terminate();
    }
  }

  private async spawnAndWarm(): Promise<ClaudeProcess> {
    const p = new ClaudeProcess({ /* mcp-config, oauth-creds */ });
    await p.start();
    await p.sendDummyPing(); // первый MCP-handshake — самое долгое
    return p;
  }
}
```

Параметры (ENV):
- `AI_RUNTIME_MIN_IDLE=2` — минимум горячих daemon'ов вне зависимости от нагрузки.
- `AI_RUNTIME_MAX_TOTAL=8` — потолок total (idle + leased) на один pod.
- `AI_RUNTIME_LEASE_TIMEOUT_MS=30000` — макс ожидание в очереди.
- `AI_RUNTIME_DAEMON_IDLE_TTL_MS=300000` — idle > 5 мин → graceful kill (освободить память).

Cold-start первого daemon'а при старте контейнера:
- `claude` CLI запускается, MCP-handshake с `mcp-kingside.mjs`, первый ping → ~8-15 с (по логам KS-3321 cold-start без `--resume` ≤ 6 с, с heavy MCP discovery — оценка 10-15 с).
- 2 daemon'а warmed parallel → ready после ~15 с от старта pod'а.
- ECS health-check `/ready` отдаёт 200 только когда `pool.length >= minIdle`.

При запросе чата:
- Если у юзера уже leased daemon — `lease()` ~0 ms + сразу message-pipe в `claude --resume <sessionId>` → **p50 ~1-3 с** (с учётом самого инференса модели).
- Если daemon берётся из idle — ~50-100 ms на assign + первый message-pipe → **p50 ~2-5 с**.
- Если пришлось спавнить — **p99 ~15 с** (но это редкий случай при правильно настроенном `minIdle`).

### 5.5. История сессий — гибридный подход

Сейчас:
- `webhook-server.py` хранит `.jsonl`-сессии в `~/.claude/projects/<project-path>/<session-id>.jsonl` на хосте пользователя.
- `claude --resume <session-id>` загружает весь jsonl и восстанавливает контекст.

После миграции — **два слоя**:

**Слой A: эфемерные jsonl в контейнере** (для `--resume` живого daemon'а).
- Запись в `/var/lib/ai-runtime/sessions/<userId>/<sessionId>.jsonl` (EFS volume на ECS Fargate, см. §5.6).
- Когда daemon живой и leased — продолжаем писать в его jsonl.
- TTL: 24 часа без активности → удаляется (cron внутри pod'а).

**Слой B: persistent summary в нашей БД** (для долгой памяти).
- Уже существует таблица `chat_assistant_messages` / `chat_assistant_conversations` (см. `apps/api/src/ai-chat/`).
- Дополнительно (опционально, отдельная задача): хранить «сжатый контекст» (последние N tool-uses + ключевые факты) — но это **не требуется для MVP**, текущая БД достаточна.

Решение по `--resume`:
- **MVP:** жёсткий attach userId → daemon → sessionId (через lease). Пока daemon жив — пользователь продолжает в той же сессии (`--resume`).
- **При killing daemon'а** (OOM, idle TTL, OAuth refresh fail): следующий запрос — **новая `claude`-сессия без `--resume`**, но с подгрузкой последних `HISTORY_LIMIT=10` сообщений из БД в первое user-message-приглашение (это уже делается в `ChatAssistantService.streamResponse`).
- **При старте нового pod'а после redeploy:** все sessionId'ы недействительны → также новая сессия с историей из БД.

Этот подход:
- Убирает зависимость от EFS persistence между redeploy'ями (EFS можно даже не использовать в MVP — jsonl только в локальном tmpfs).
- Терпим к рестартам: пользователь не видит «забыл всё», потому что последние 10 сообщений всё равно подаются модели.
- Не воспроизводит проблему KS-3321 (бесконечный cold-start `--resume` тяжёлой сессии): мы контролируем размер jsonl сами (limit на размер, периодическая ротация).

### 5.6. EFS volume — опционально

В MVP сессии можно держать в `tmpfs` (`emptyDir`-эквивалент в ECS Fargate — `/tmp`). После рестарта pod'а они теряются — но это OK благодаря §5.5.

Если в будущем понадобится persistence (например, чтобы daemon переживал rolling-update без потери `--resume`): EFS volume mount в `/var/lib/ai-runtime`. **Не делаем в Этапе A**, отдельная задача после observability.

### 5.7. Shared rate-limit Pro/Max и митигация

Anthropic Pro/Max лимит — **per-account**, не per-device. Сейчас один аккаунт пользователя использует:
1. Все разработческие агенты (`coordinator`, `backend`, `frontend`, `architect` и т.п. — через `webhook-server.py`).
2. AI-ассистент пользовательского чата (через webhook на VPS).

После миграции на `ai-runtime` это всё так же будут две группы потребителей одной OAuth-сессии. **Митигация:**

**Уровень 1 — мониторинг.**
- `ai-runtime` пишет в logs / Prometheus метрику `claude_rate_limit_status` (из `rate_limit_info` ответа Claude Code).
- Дашборд: % использования 5-hour window, ETA до сброса.
- Алёрт при >70%: координатор / пользователь видят approaching limit.

**Уровень 2 — приоритизация.**
- В `DaemonPool` — два queue: `priority=user-chat` (приоритет 0) и `priority=agent` (приоритет 1). На практике это значит — pre-warm pool НЕ делится с агентами; agent-pool отдельный (или агенты вообще остаются на старом webhook у пользователя, что и происходит сегодня).
- В MVP агенты остаются на webhook-server.py пользователя → user-chat получает выделенный лимит на `ai-runtime`. Это раздельные source IP и device fingerprint — но Anthropic считает по account, так что фактически это **просто разные источники потребления одного лимита**, не отдельные лимиты.

**Уровень 3 — degradation.**
- При получении `rateLimitType: five_hour` + `overageDisabledReason: out_of_credits` от Claude Code → `ai-runtime` отдаёт api статус 429 c `Retry-After` равным `resetsAt - now`.
- api возвращает пользователю «AI-ассистент временно перегружен, попробуйте через N минут».
- Это лучше чем сейчас (KS-3321: «молчит без ошибки 45 с»).

**Уровень 4 — отдельный аккаунт (future).**
- Если 5-hour лимита не хватит — пользователь заводит **второй Claude Pro/Max аккаунт** именно под `ai-runtime`. Это даёт независимый rate-bucket.
- Стоимость второго Pro — $20/мес, Max — больше. Намного дешевле API per-token billing при заметных объёмах чата.
- Решение по второму аккаунту — после observability (Этап C). В MVP идём с одним.

### 5.8. Migration-path без простоя

ENV-флаг `AI_CHAT_RUNTIME` в api с тремя значениями:
- `webhook` (default) — текущая логика, fetch на `AI_CHAT_WEBHOOK_URL`.
- `ai-runtime` — fetch на новый сервис `http://ai-runtime.internal:8080/invoke`.
- `ai-runtime-with-fallback` — сначала `ai-runtime`; при 5xx/timeout — fallback на webhook.

Фазы:
1. **Phase M1 (Этап A+B+C):** разработка, локальный smoke, dev-deploy `ai-runtime` сервиса. Прод api на `AI_CHAT_RUNTIME=webhook` (ничего не меняется).
2. **Phase M2 (Этап D):** прод deploy `ai-runtime` параллельно с webhook'ом. api всё ещё на `webhook`. Smoke на prod через прямой curl `ai-runtime`.
3. **Phase M3 (Этап E):** api переключается на `AI_CHAT_RUNTIME=ai-runtime-with-fallback`. Реальный пользовательский траффик идёт на `ai-runtime`. Любая регрессия → fallback на webhook автоматически.
4. **Phase M4 (Этап F):** после 7 дней стабильной работы → `AI_CHAT_RUNTIME=ai-runtime` (без fallback). Webhook остаётся для агентов.
5. **Phase M5 (опционально, далеко):** если хотим — можно перевести и агентов на свой runtime (отдельная задача, выходит за рамки KS-3572).

Откат на любой фазе:
- M3-M4: смена ENV в api → rolling redeploy api (~3 минуты). Webhook жив, всё работает.
- M2: остановка `ai-runtime` service в ECS (api всё ещё на webhook).
- M1: ничего не катилось в прод — пустой rollback.

## 6. Риски

### 6.1. Device fingerprint Anthropic anti-abuse

**Это главный неисследованный риск.** Anthropic в Claude Code может привязывать OAuth-сессию к device fingerprint (machine-id, MAC, IP, install-uuid). При переносе `~/.claude/.credentials.json` на другую машину refresh может провалиться или сработать один раз и заблокироваться.

Эмпирических данных у нас нет. Backend в комментарии #9901 явно отметил: «**эмпирически не проверял — нужен тест**».

**Smoke-план (обязательный до Этапа B):**
1. На локальной dev-машине пользователя выполнить `claude login` → получить свежие credentials.
2. Скопировать `~/.claude/.credentials.json` в Docker-контейнер на той же машине (docker run + bind mount).
3. Выполнить внутри контейнера: `claude --print "Hello, return JSON {ok:true}"`. Ожидание: успех, возврат ответа.
4. Подождать 1 час, повторить тот же запрос → проверить что refresh access-token прошёл штатно.
5. Поднять контейнер на чужой машине (например, на сервере devops через `docker run` с тем же volume) → повторить шаги 3-4. Если работает — fingerprint не привязан к machine.
6. Если шаг 5 даёт `401 unauthorized` или `invalid_grant` → fingerprint привязан → **C2 невыполнимо как описано**.

**Если smoke провалился (fingerprint строгий):**
- **Вариант обхода 1:** держать webhook-server.py на VPS Kamatera, но в нашей зоне — например, выпросить SSH у пользователя у devops и переехать на ECS-EC2 (не Fargate) с persistent EBS. Это компромисс — runtime всё ещё опирается на claude CLI с OAuth, но контейнер не путешествует.
- **Вариант обхода 2:** взять API tier (`ANTHROPIC_API_KEY`) — но пользователь сказал «дорого». Эту опцию открываем только если C2 принципиально невозможен и пользователь готов пересмотреть.
- **Вариант обхода 3:** разнообразные undocumented Claude CLI флаги для отключения fingerprint — без официальной документации это нестабильно и может перестать работать в любом релизе Claude Code.

Smoke результаты документируем в отдельной задаче-исследовании (см. §8 follow-ups KS-3572-A).

### 6.2. Multi-process OAuth contention

Если в `DaemonPool` одновременно работают N `claude`-процессов под одной OAuth-сессией — может произойти:
- Race на refresh access-token: два процесса видят expired, оба делают refresh, Anthropic возвращает invalid_grant второму.
- Token rotation: каждый refresh может invalidate предыдущий refresh_token, и daemon'ы потеряют валидность.

**Mitigation:**
- Один глобальный refresh-broker внутри `ai-runtime`: следит за `expires_at`, делает refresh ДО передачи credentials в daemon. Все daemon'ы при старте получают свежий access_token, refresh у них отключён (если такой режим есть в Claude CLI; иначе credentials в RO-mount и каждый daemon делает refresh самостоятельно — тогда нужен smoke на race).
- Smoke в §6.1 шаг 7: поднять 4 параллельных `claude`-процесса с одним credentials-файлом, гонять параллельные запросы 30 минут → проверить что ни один не упал на refresh.

### 6.3. Размер контейнера ai-runtime

Claude Code CLI (`@anthropic-ai/claude-code`) — Node.js пакет с зависимостями. Грубая оценка: +200-300 MB к base node:20-slim. Это OK для ECS Fargate.

### 6.4. MCP-сервер kingside как зависимость

`tools/mcp-kingside.mjs` сегодня живёт в `tools/` и используется `webhook-server.py`. В новом образе его нужно COPY и запускать как stdio-MCP child процесс при старте `claude`. Это требует уточнения формата claude CLI-флагов (`--mcp-config` JSON-файл).

**Mitigation:** в Этапе A backend пишет smoke-test, который запускает `claude --mcp-config ... --print test` локально и проверяет что MCP-tools видны (через `tool_use` events).

### 6.5. Стоимость и квоты ECS Fargate

Один pod ai-runtime (0.5 vCPU / 1 GB RAM, оценка под `minIdle=2 maxTotal=8` daemon'ы): ~$10/мес on-demand в `us-east-1`. Один pod хватит на MVP с одним активным пользователем (текущая ситуация). Auto-scaling от 1 до 3 pod'ов — ~$30/мес worst-case. Это **существенно меньше** даже минимального API tier потребления.

### 6.6. Отсутствие SSH на VPS Kamatera

Текущий webhook продолжает жить на VPS пользователя. Если он упадёт во время Phase M3 (где `ai-runtime-with-fallback`) — fallback на webhook не сработает. Это **не блокер**, а ограничение fallback'а.

**Mitigation:** в Phase M4 fallback убирается — webhook больше не критический путь.

## 7. Открытые вопросы к пользователю

1. **Smoke OAuth-credentials в Docker.** Готов ли провести smoke-тест по плану §6.1 (выложить свежие credentials, мы поднимем контейнер на dev-машине, прогоняем 24 часа)? Без этого начинать Этап B рискованно — может оказаться что fingerprint привязан и весь дизайн нерабочий.
2. **Второй Claude Pro/Max аккаунт.** Если smoke пройдёт, но в проде увидим что 5-hour лимит разделяется с агентами и упирается — готов ли завести второй аккаунт ($20/мес Pro) специально под `ai-runtime`? Это не для MVP, но нужно понимать на горизонте.
3. **AWS Secrets Manager — кто загружает credentials.** Загружает пользователь сам (через AWS Console / CLI с personal IAM), или делегирует devops? Файл маленький (~471 байт), это безопасное действие.
4. **Ротация refresh_token.** Refresh_token Claude Code может ротироваться при каждом refresh access-token. Сохранять обратно в Secrets Manager автоматически — потенциально опасно (если процесс упадёт между ротациями, токен потеряется). Допускаем ли мы сценарий «раз в N недель пользователь делает `claude login` локально и кладёт свежий credentials в Secrets Manager»?
5. **Webhook-server.py для агентов — оставляем как есть?** Да, по §5.7 + §5.8. Подтвердить, что цель миграции — **только пользовательский чат**, агенты остаются на текущем webhook.

## 8. Декомпозиция на задачи

### Этап A — Research/Smoke (backend, 1 день)

**KS-XXXX (создаст координатор): Smoke OAuth-credentials Claude Code в Docker.**

1. Скрипт `tools/smoke-claude-oauth.sh`: docker run `node:20-slim`, npm i `@anthropic-ai/claude-code`, mount `~/.claude/.credentials.json`, прогнать `claude --print "test"`.
2. Прогон на dev-машине пользователя (его credentials).
3. Прогон на другой машине (devops-машина или CI-runner) с теми же credentials.
4. Прогон 4 параллельных процессов (race-test) — refresh contention.
5. Прогон через 1 час и через 24 часа — проверка refresh-цикла.
6. Отчёт: работает / не работает / условно работает с N ограничений.

**Acceptance:** комментарий с результатами в KS-3572. Если работает — двигаемся к Этапу B. Если нет — пишем в ADR новый раздел «отступление» и обсуждаем с пользователем.

### Этап B — Скелет сервиса apps/ai-runtime (backend, 3-4 дня)

**KS-XXXX: Создать `apps/ai-runtime` — HTTP-сервер + DaemonPool + Claude CLI subprocess.**

1. `apps/ai-runtime/package.json`, `Dockerfile`, `src/main.ts` (Express или Nest-mini).
2. `DaemonPool` + `ClaudeProcess` обёртка (§5.4).
3. `SessionStoreService` — мапа userId → sessionId в Redis (используем существующий Redis из api).
4. `POST /invoke { userId, message, conversationId, history?: Message[] }` → возвращает SSE-стрим или JSON.
5. `GET /health` (liveness), `GET /ready` (readiness — pool.length >= minIdle).
6. Mount OAuth credentials через entrypoint.sh (§5.3).
7. Unit-тесты DaemonPool (mock claude-process), integration smoke с реальным claude.

**Acceptance:** локально `docker compose up ai-runtime` → `curl localhost:8080/invoke` возвращает ответ от Claude. Тесты зелёные.

### Этап C — Интеграция с api и observability (backend, 1-2 дня)

**KS-XXXX: api переключатель AI_CHAT_RUNTIME и AiRuntimeClient.**

1. `apps/api/src/ai-chat/ai-runtime.client.ts` — HTTP-клиент к ai-runtime с retry-on-502.
2. В `chat.controller.ts` ветка: если `AI_CHAT_RUNTIME=ai-runtime|ai-runtime-with-fallback` → AiRuntimeClient, иначе текущая логика.
3. Метрики: `ai_runtime_invoke_duration_seconds{phase=lease|warm|spawn|claude}`, `ai_runtime_pool_size`, `claude_rate_limit_percentage`.
4. Логирование: PII-safe — userId truncate, message length вместо payload.
5. Тесты на ветвление по ENV-флагу.

**Acceptance:** локальный e2e: api + ai-runtime + mock claude → /chat возвращает ответ.

### Этап D — Деплой инфры (devops, 2-3 дня)

**KS-XXXX: ECS service + IAM + Secrets Manager для ai-runtime.**

1. CloudFormation/Terraform (или ручной apply, как в проекте сейчас принято — devops уточнит).
2. ECS task definition `ai-runtime` с задачей `0.5 vCPU / 1 GB`, IAM role с минимальным scope (§5.3).
3. Secret `kingside/ai-runtime/claude-oauth-credentials` — placeholder, пользователь загружает значение.
4. ECS service с desired=1, auto-scaling 1-3 по RPS.
5. ALB или service-discovery в VPC (api → ai-runtime через internal DNS).
6. CloudWatch log group, retention 14 дней.
7. Deploy скрипт `scripts/deploy-ai-runtime.sh` (по аналогии с существующими).

**Acceptance:** dev-кластер: pod up, /health отвечает 200, в Secrets есть placeholder.

### Этап E — Прод-катка (devops + backend, 0.5 дня)

**KS-XXXX: переключение прода на ai-runtime-with-fallback.**

1. Пользователь загружает свежие OAuth credentials в Secrets Manager.
2. Devops обновляет ENV в api `AI_CHAT_RUNTIME=ai-runtime-with-fallback`, force redeploy.
3. Backend мониторит логи api 24 часа: % запросов попавших на fallback, latency p50/p90/p99.
4. Если fallback rate <1% и latency p50 <5с — отметка «успех».

**Acceptance:** комментарий в KS-3572 с метриками за 24 часа.

### Этап F — Финализация (devops, 15 минут)

**KS-XXXX: AI_CHAT_RUNTIME=ai-runtime без fallback.**

1. Devops снимает fallback (ENV → `ai-runtime`).
2. Webhook на VPS Kamatera **остаётся** для агентов — не трогаем.

**Acceptance:** прод работает 7 дней на `ai-runtime` без инцидентов → задача закрыта.

## 9. Что НЕ входит в этот ADR

- Перенос **разработческих агентов** (`coordinator`, `backend`, etc.) с `webhook-server.py` на свой runtime. Это отдельный, более крупный пересмотр — выходит за рамки KS-3572.
- Полная замена авторизации на ANTHROPIC_API_KEY. Пользователь явно отказался (стоимость). Если в будущем стоимость станет приемлемой — отдельный ADR на пересмотр.
- Реализация RAG / embeddings (ADR-063 Phase 3).
- Изменения в Frontend / UX чата.
- Хранение «сжатого контекста» в БД (long-term memory ассистента) — отдельная задача после observability.

## 10. Резюме

Выносим runtime AI-ассистента из `webhook-server.py` (хост пользователя) в новый сервис `apps/ai-runtime` (ECS Fargate, наша зона). Авторизация — OAuth Claude Pro/Max (без API key). Cold-start <45 с обеспечивается pre-warm pool горячих daemon'ов. История сессий — гибрид эфемерных jsonl (для живого daemon'а) + БД (для долгой памяти, fallback при kill). Миграция через ENV-флаг `AI_CHAT_RUNTIME` с fallback на текущий webhook — откат за 3 минуты.

**Главный неизвестный риск:** device fingerprint Anthropic при переносе OAuth credentials в Fargate-контейнер. **До Этапа B обязателен smoke (Этап A) на dev-окружении.** Если smoke провалится — дизайн нерабочий, и мы возвращаемся к пользователю обсуждать допущения (в первую очередь — пересмотр запрета на ANTHROPIC_API_KEY как fallback).
