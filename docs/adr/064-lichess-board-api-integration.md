# ADR-064. Интеграция с Lichess Board API — игра на Lichess через UI Kingside

Статус: предложен (KS-2971).
Дата: 2026-05-14.
Связано: ADR-018 (`/api` prefix), ADR-061 (MCP auto-discovery — новый модуль будет помечен `@McpExclude`), broadcast-service (`apps/broadcast-service/src/sync/broadcast-sync.service.ts` — рабочий паттерн NDJSON-стрима к Lichess), `User.lichessUsername` (свободно вводимое имя в Settings — остаётся, но обогащается OAuth-линком).

## 1. Контекст и цель

### 1.1. Что предлагается

Дать пользователю Kingside возможность сыграть партию **на Lichess через наш интерфейс**:

1. Юзер на странице `/lichess/play` нажимает «Login with Lichess».
2. OAuth2-флоу Lichess (`/oauth?response_type=code`, PKCE, scope `board:play`). После согласия redirect к нам.
3. Мы храним `access_token` в БД, привязанный к нашему `userId`.
4. Юзер встаёт в seek-очередь / шлёт challenge / принимает входящий → Lichess матчит его с реальным игроком Lichess.
5. Партия играется в нашем `<MemoChessboard>`. Ходы летят `POST /api/board/game/{gameId}/move/{uci}`, состояние приходит NDJSON-стримом `GET /api/board/game/stream/{gameId}`. Часы — серверные, Lichess авторитативен.
6. После партии — ссылка `lichess.org/{gameId}` (рейтинги, история, анализ — на стороне Lichess). К нашему рейтингу/архиву партия НЕ привязывается.

### 1.2. Зачем

Продуктово:
- **Доступ к пулу игроков Lichess** без миграции — у нас сейчас 30s matchmaking-fallback в бота (KS-2160 §3), пользователи с рейтингом >1700 ждут реальных оппонентов минутами. Lichess закрывает эту дыру до момента, пока наш пул сам не вырастет.
- **Знакомый UI**: наш onboarding/customization доски (board theme, piece set, custom pieces — `useBoardSettings`), наши горячие клавиши, наш sound-pack. Юзер не уходит на сторонний сайт.
- **Telegram-аудитория**: у нас сильный канал из Telegram (`User.telegramId`), Lichess для них — внешний бренд; «играй на Lichess из Kingside» — точка удержания.

Что теряем (фиксируем явно):
- **Партии не наши.** PGN/clocks/история — у Lichess. Наша БД хранит только факт «юзер привязал Lichess-аккаунт», не сами игры (см. §5.2).
- **Рейтинг Lichess, не наш.** На наши рейтинги (`ratingBullet/Blitz/Rapid/Classical`) Lichess-партии **не влияют**. Это сознательное решение, фиксируется в §5.3.
- **Зависимость от внешнего API.** Если Lichess уйдёт в down/изменит TOS — фича ломается. Митигейшн в §8.

### 1.3. Что вне scope

- Игра против ботов Lichess (требует scope `bot:play`, TOS-другой, и наш аккаунт сам должен быть зарегистрирован как бот). Не делаем.
- Импорт сыгранных партий с Lichess через Games Export API (отдельная фича, отдельный ADR, см. §9.3).
- Турниры Lichess (Arena/Swiss через API). Не делаем — у нас своя турнирная подсистема.
- Чат внутри Lichess-партии. Не делаем — Lichess транслирует chat-events в стрим, но мы сознательно его не отображаем (упрощение MVP, чат можно добавить отдельно).

## 2. OAuth2 flow и хранение токенов

### 2.1. Регистрация приложения у Lichess

Lichess не требует «регистрации приложения» в Console (это его принципиальное отличие от Google/Facebook): любой клиент может выпустить access-token, указав свой `client_id` (произвольная строка) и `redirect_uri`. Это документировано на `lichess.org/api#section/Authentication`.

Параметры, которые проставляем мы:
- `client_id`: `app.kingside.site` (стабильный, неизменный).
- `redirect_uri`: `https://kingside.site/api/auth/lichess/callback` (по аналогии с Google/Facebook callback'ами в `OAuthCallbackController` — путь с префиксом `api/auth` для совместимости с историческими redirect URI, см. KS-2111).
- В dev: `http://localhost:3001/api/auth/lichess/callback`.

### 2.2. Flow

OAuth2 **Authorization Code + PKCE**. У Lichess нет `client_secret` (public client), поэтому PKCE обязателен.

Шаги:

1. **Frontend** генерирует `code_verifier` (random 43-128 chars, base64url) и `code_challenge` = base64url(SHA256(code_verifier)). Хранит `code_verifier` в `sessionStorage` (НЕ в localStorage — нужна одна сессия).
2. **Frontend** редиректит на `https://lichess.org/oauth?response_type=code&client_id=app.kingside.site&redirect_uri=...&scope=board:play&code_challenge=...&code_challenge_method=S256&state=<csrf>`.
3. Юзер логинится на Lichess, подтверждает scope. Lichess редиректит обратно на наш `redirect_uri` с `?code=...&state=...`.
4. **Backend** на callback'е (`OAuthCallbackController.lichessCallback`):
   - Сверяет `state` (CSRF). Если frontend не передал `state` через `sessionStorage` → 400.
   - НО `code_verifier` фронт хранит у себя — backend его не знает. Значит callback **не может** сразу обменять code на token; ему нужен code_verifier с фронта.

Развилка: где обмен code на token?

| | (а) backend обменивает | (б) frontend обменивает |
|---|---|---|
| Где хранится code_verifier | в Redis (короткий TTL) | sessionStorage браузера |
| Где access_token впервые виден | только backend | сначала frontend, потом отправляет backend'у |
| Защита от XSS | лучше: токен не появляется в JS | хуже: токен в JS-памяти на момент обмена |
| Сложность | средне (Redis state) | низко |

**Выбираем (а):**
- Frontend перед редиректом на Lichess делает `POST /lichess/oauth/init` с `{code_verifier, state}`. Backend кладёт `{code_verifier, userId, state}` в Redis с TTL=10 минут (ключ `lichess:oauth:state:<state>`).
- Frontend редиректит на Lichess только после `200 OK` от init.
- На callback'е backend поднимает запись из Redis по `state`, делает `POST https://lichess.org/api/token` с `code + code_verifier + client_id + redirect_uri`, получает `access_token`, шифрует, кладёт в `lichess_link`.
- Token никогда не появляется в браузере. Это ценно для §6 (TOS): даже если у нас XSS, токен утечь не может, аудит-trail на бэке.

### 2.3. Хранение access_token

Новая таблица `lichess_link` (миграция Prisma — backend, не architect). Поля:

```prisma
model LichessLink {
  id                String   @id @default(uuid()) @db.Uuid
  userId            String   @unique @map("user_id") @db.Uuid
  lichessUserId     String   @map("lichess_user_id")        // их id (lowercase username)
  lichessUsername   String   @map("lichess_username")       // их display name
  accessTokenEnc    String   @map("access_token_enc")       // см. §2.4 — base64 ciphertext
  accessTokenIv     String   @map("access_token_iv")        // base64 IV для AES-256-GCM
  accessTokenTag    String   @map("access_token_tag")       // base64 auth tag
  scopes            String[]                                 // ["board:play", ...]
  linkedAt          DateTime @default(now()) @map("linked_at")
  expiresAt         DateTime @map("expires_at")              // linkedAt + 1 year (Lichess token lifetime)
  lastUsedAt        DateTime @default(now()) @map("last_used_at")
  revokedAt         DateTime? @map("revoked_at")             // null = активен, не-null = revoked локально
  revocationReason  String?  @map("revocation_reason")       // "user_unlinked" | "lichess_401" | "expired" | "tos_violation"

  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([lichessUserId])
  @@index([expiresAt])         // для cron-задачи «истекают через 30 дней»
  @@map("lichess_links")
}
```

`User.lichessLink LichessLink?` — обратная связь. Единственность гарантирована `@unique` на `userId` (один Lichess-аккаунт на нашего юзера) + уникальность `lichessUserId` через приложение (не уникальный индекс — теоретически возможны коллизии, см. §8 риск №2).

### 2.4. Encryption at rest

`accessTokenEnc` — AES-256-GCM, ключ из env `LICHESS_TOKEN_ENCRYPTION_KEY` (32 байта base64). Реализация — стандартный node `crypto`:

```ts
// apps/api/src/lichess/token-crypto.ts
const ALGO = 'aes-256-gcm';
function encrypt(plaintext: string, key: Buffer): { enc: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: enc.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') };
}
```

Аналогично `decrypt`. Ключ хранится в `.env` (production) / Docker secret. Ротация ключа — отдельная процедура (см. §8 риск №5), в MVP не делаем.

Решение шифровать, а не хранить plaintext, обосновано: токен даёт доступ к OAuth scope `board:play` от имени пользователя (играть, шлёт challenge'и, видит challenge-list). Утечка дампа БД ≠ автокомпрометация всех Lichess-аккаунтов наших юзеров. AES-256-GCM — стандартный compliance-минимум.

### 2.5. Refresh-токенов у Lichess НЕТ

Это центральная особенность Lichess OAuth: только access_token, живёт **1 год** (`expires_in: 31536000` в ответе `/api/token`). После истечения юзер должен **заново пройти весь OAuth flow** — другого пути нет.

Это даёт нам два события для UX-проектирования:
1. Токен близок к истечению (`expires_at - now < 30 дней`).
2. Токен истёк или revoked (`expires_at < now`, или Lichess вернул 401).

### 2.6. UX истечения

#### 2.6.1. Profilactica: уведомление за 30/7/1 день

Cron-задача `apps/api/src/lichess/lichess-expiry.scheduler.ts` раз в сутки (`@Cron('0 6 * * *')`, UTC), выбирает все `lichess_links` с `expiresAt - now ∈ {30d, 7d, 1d}`. Для каждого:

- Создаёт `Notification` (наша существующая таблица из §5 schema.prisma) с типом `lichess_token_expiring`. Текст: «Привязка Lichess истекает через N дней. Чтобы продолжать играть, привяжите аккаунт заново.»
- Если у юзера есть `telegramId` — шлёт Telegram-нотификацию через существующий канал.
- Если есть `email` — шлёт email (опционально, в MVP можно не делать — у нас сейчас нет email-canal для нотификаций, см. KS-2683).
- Метка `lichess_links.last_notified_at` (новое поле, добавим) — не слать повторно тот же тип в течение 24 часов.

Без notification'а юзер может неделями не заходить и обнаружить «вдруг неработает» в момент важной партии.

#### 2.6.2. Истёкший токен: UX

Когда `expiresAt < now` или Lichess вернул 401:

1. Backend в `LichessClient` ловит 401 → атомарно ставит `revokedAt = now, revocationReason = 'lichess_401'` (или `'expired'`, если просто истекло).
2. Все активные board-streams для этого юзера получают `AbortController.abort()` (см. §3.2).
3. WS-gateway шлёт фронту событие `lichess:link-revoked` с причиной.
4. **Если юзер сейчас играет** (есть активный gameId): показываем блокирующий банер «Ваша Lichess-сессия истекла, партия прервана. [Кнопка] Подключиться заново». Партию доиграть в этой сессии не получится — Lichess уже сам пометил её абортнутой. После reauth юзер возвращается на `/lichess/play` (lobby), не на старую партию.
5. **Если юзер в lobby/seek**: показываем тот же баннер, но без «партия прервана».
6. Сам OAuth-flow при reauth — тот же `/lichess/oauth/init`, с дополнительным параметром `?reason=reauth` — на UI показываем «Здравствуйте, @username. Похоже, привязка истекла — войдите ещё раз.».

#### 2.6.3. Юзер отвязал Kingside у Lichess (revoke на их стороне)

Lichess даёт пользователю в их UI ссылку `lichess.org/account/oauth/app` — там видны все приложения с активным токеном, можно отозвать. После revoke любой запрос с этим токеном возвращает 401. Сценарий идентичен §2.6.2: первый 401 → revokedAt/local revoke → реauth-flow.

Других каналов узнать о revoke у Lichess нет (вебхуков они не шлют). Это значит между revoke и первым нашим запросом юзер видит «всё хорошо» — нормальный trade-off.

#### 2.6.4. Юзер сам отвязал на нашей стороне

Кнопка «Disconnect Lichess» в Settings:
- Frontend `POST /lichess/unlink`.
- Backend пытается отозвать токен на стороне Lichess: `DELETE https://lichess.org/api/token`. Этого требует **TOS** (хороший citizenship — не оставлять валидный токен у себя на диске). Если 200 OK или сетевой fail — продолжаем; если 401 (уже отозван) — игнорируем.
- Локально: `lichess_links.revokedAt = now, revocationReason = 'user_unlinked'`.
- Запись остаётся в БД (для аудита, не удаляем). При повторном линке — переиспользуем запись (UPSERT по `userId`), затирая старые поля.

### 2.7. Что показываем юзеру в Settings

Блок «Lichess account» рядом с существующими `chesscomUsername` / `lichessUsername`-полями:

- Не привязан: кнопка `[Connect Lichess]` → запускает §2.2 flow.
- Привязан: badge `Connected as @username (expires in 47 days)`. Кнопка `[Disconnect]` → §2.6.4.
- Истёк/revoked: badge `Connection expired`. Кнопка `[Reconnect]`.

Старое поле `User.lichessUsername` (свободно вводимое в Settings, см. SettingsPage:298) **остаётся** и работает как fallback display (на странице профиля показываем «Lichess: @foo»). Если есть `LichessLink` — приоритет у `LichessLink.lichessUsername`, и поле `User.lichessUsername` затирается им при линке (синхронизация в одну сторону).

## 3. Архитектура backend

### 3.1. Где располагать модуль

Развилка: новый Nest-модуль в `apps/api/src/lichess/` ИЛИ отдельный микросервис?

| | в `apps/api` | отдельный микросервис |
|---|---|---|
| Сложность инфры | низко (уже Nest, уже Prisma, уже Redis) | высоко (новый Docker-сервис, deploy, monitoring) |
| Изоляция нагрузки | стримы держат event-loop в основном API | изолировано |
| Перезапуск API не роняет board-streams | нет | да |
| Объём кода | ~1000 LOC | то же + boilerplate |
| Прецедент | `broadcast-service` именно так и сделан — выделен из `apps/api` для streams | подсказывает делать отдельный сервис |

**Выбираем (а) `apps/api` для MVP**, с явной возможностью миграции в отдельный сервис, если board-streams начнут мешать. Обоснование:

1. MVP-объём низкий. Сейчас Lichess Board API — гипотеза-эксперимент. До измерения нагрузки выделение в сервис — преждевременная оптимизация.
2. Паттерн с AbortController + AsyncIterable из `broadcast-sync.service.ts:1253-1307` копируется один-в-один в `apps/api/src/lichess/lichess-stream.service.ts`. Не нужно изобретать.
3. Если в проде окажется, что одновременных board-streams много (>500 параллельно) и event-loop начинает страдать — миграция в `apps/lichess-service` тривиальна (паттерн уже есть в `apps/broadcast-service`). Это запасной план.

Структура `apps/api/src/lichess/`:

```
lichess/
├── lichess.module.ts                — @McpExclude (TOS-чувствительный модуль, не для ассистента)
├── lichess.controller.ts            — REST: oauth/init, oauth/callback, unlink, link/status, seek, challenge, accept, decline
├── lichess.gateway.ts               — WS namespace /lichess: subscribe/unsubscribe stream, ходы, events
├── lichess-client.service.ts        — обёртка над REST Lichess (fetch + retry + 429 backoff)
├── lichess-stream.service.ts        — NDJSON стрим board/game/stream, AbortController map
├── lichess-link.service.ts          — CRUD + token-encryption + expiry/revocation
├── lichess-expiry.scheduler.ts      — cron 30/7/1 day notification
├── token-crypto.ts                  — AES-256-GCM helpers
├── dto/
│   ├── oauth-init.dto.ts
│   ├── seek.dto.ts
│   ├── challenge.dto.ts
│   └── ...
└── lichess.module.spec.ts
```

### 3.2. Где хранить активные стримы

Развилка: in-memory `Map<gameId, AbortController>` ИЛИ Redis?

**Выбираем in-memory.** Аргументы:

1. AbortController нельзя сериализовать в Redis — это live-объект. В Redis можно хранить только метаданные (`{ gameId, userId, startedAt }`) для observability.
2. На рестарт `apps/api` стримы пересоздаются: после старта приходит запрос фронта `WS /lichess subscribe` → backend поднимает токен из БД, открывает новый stream. Restart-окно ~3 секунды — приемлемо.
3. Один инстанс `apps/api` (текущая инфра — single instance). Если когда-то будет несколько инстансов — пользователь должен «прилипнуть» к одному (sticky session по userId) или мы переходим на отдельный сервис (§3.1 запасной план).

Реализация (зеркало `broadcast-sync.service.ts:359`):

```ts
@Injectable()
export class LichessStreamService implements OnModuleDestroy {
  private readonly activeStreams = new Map<string, AbortController>();
  // key: `${userId}:${gameId}` — один юзер не должен подписываться на одну партию дважды
  ...
  async onModuleDestroy() {
    for (const ctrl of this.activeStreams.values()) ctrl.abort();
    this.activeStreams.clear();
  }
}
```

Лимит: **один активный board-stream на токен** (TOS Lichess, см. §6.3). На уровне сервиса мы это enforcement'им: при попытке открыть второй stream для того же `userId` — abort'им предыдущий. UI должен пресекать раньше (одна вкладка с активной партией), но defense-in-depth.

### 3.3. Обработка NDJSON-стрима

URL: `GET https://lichess.org/api/board/game/stream/{gameId}`, header `Authorization: Bearer <token>`, `Accept: application/x-ndjson`.

Формат: одна строка JSON на событие, разделитель `\n`. Типы событий:
- `gameFull` — начальное состояние (один раз).
- `gameState` — обновление (ходы, часы, статус).
- `chatLine` — сообщение чата (игнорируем, см. §1.3).
- `opponentGone` — оппонент дисконнектнулся (показываем индикатор, по таймеру можно claim win).

Парсер:

```ts
private async runStream(userId: string, gameId: string, signal: AbortSignal) {
  const url = `${LICHESS_API}/api/board/game/stream/${gameId}`;
  const token = await this.link.decryptToken(userId);
  let retryDelay = 2000;
  const maxDelay = 60_000;

  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-ndjson' },
        signal,
      });
      if (res.status === 401) { await this.link.markRevoked(userId, 'lichess_401'); return; }
      if (res.status === 429) { await this.sleep(retryDelay, signal); retryDelay = Math.min(retryDelay * 2, maxDelay); continue; }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      retryDelay = 2000;
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        if (signal.aborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = JSON.parse(trimmed);
          await this.handleEvent(userId, gameId, event);
        }
      }
    } catch (e) {
      if (signal.aborted) break;
      this.logger.warn(`[lichess-stream] ${gameId} disconnected: ${(e as Error).message}, retry in ${retryDelay}ms`);
      await this.sleep(retryDelay, signal);
      retryDelay = Math.min(retryDelay * 2, maxDelay);
    }
  }
}
```

Источник паттерна: `broadcast-sync.service.ts:1262-1307`. Различия:
- Разделитель `\n` (NDJSON), не `\n\n\n` (broadcast PGN).
- Парсим JSON, не PGN.
- Auth header (broadcast-stream был public).
- 401 → markRevoked, return (не retry бесконечно).

### 3.4. Передача событий фронту: WS или прямой стрим в браузер?

Lichess не запрещает фронту ходить напрямую — CORS у них открыт. Развилка:

| | (а) backend → WS → frontend (наш гейтвей) | (б) frontend → Lichess напрямую |
|---|---|---|
| Кто видит access_token | только backend | frontend (в браузере) |
| TOS-аудит (контроль engine-assist) | backend знает «юзер в активной партии», может блокировать наши же engine-API | frontend на честном слове |
| Reconnect: переживёт релоад вкладки | да (backend держит stream, фронт переподписывается) | нет (релоад → новый stream → потеря части событий) |
| Лишний hop / latency | +30-80ms (наш WS over HTTP/2) | минимум |
| Контроль | backend единая точка для метрик, rate-limit, аудита | разбросано |
| Стоимость инфры | использует наш WS-gateway, который и так есть | дешевле для нас |
| Что если наш API упал | стримы рвутся, фронт ждёт | работает (Lichess живой) |

**Выбираем (а):**

1. Главный аргумент — **токен не должен попадать во фронт** (§2.2). Если фронт ходит напрямую, ему нужен токен, защита от XSS теряется.
2. **TOS-контроль.** Когда фронт стримит сам, мы не знаем «юзер в активной партии». Это нужно для §6: пока юзер в активной Lichess-партии, мы блокируем доступ к `/analysis`, `/puzzles` (где есть подсказки движка) — кнопки в навигации становятся disabled, ассистенту чат-страницы запрещаем разговоры про текущую партию. Это серверная политика, требует серверного знания о состоянии.
3. **Reconnect.** Юзер случайно закрыл вкладку, открыл снова через 5 секунд — фронт пере-подписывается, получает текущее состояние партии из памяти backend (последний `gameState`, который backend закешировал в Redis на 5 минут).

Latency +30-80ms приемлема — мы и так в нашем `/game` namespace укладываемся в эти цифры.

### 3.5. Что бросаем во фронт через WS

WS namespace `/lichess` (по аналогии с `/game`). События к фронту:

```ts
// packages/shared/types/lichess-contracts.ts (новый файл)
export const LichessEvents = {
  STATE: 'lichess:state',           // полное состояние (после connect или после gameStart)
  MOVE: 'lichess:move',             // один новый ход
  CLOCK: 'lichess:clock',           // обновление часов
  END: 'lichess:end',               // партия закончилась
  OPPONENT_GONE: 'lichess:opponent-gone',
  CHALLENGE_RECEIVED: 'lichess:challenge-received',
  CHALLENGE_DECLINED: 'lichess:challenge-declined',
  LINK_REVOKED: 'lichess:link-revoked',  // §2.6
  ERROR: 'lichess:error',
} as const;
```

От фронта к backend:
- `lichess:subscribe-game { gameId }` — подписаться на стрим конкретной партии.
- `lichess:unsubscribe-game { gameId }` — закрыть стрим.
- `lichess:subscribe-events` — подписаться на event-stream `/api/stream/event` (входящие challenge'и, начало партии).

Сами ходы шлём НЕ через WS (`socket.emit`), а через REST `POST /lichess/games/{gameId}/move`, чтобы получить явный 200/400 ответ и не таскать backend acknowledgement через WS. Lichess `POST /api/board/game/{gameId}/move/{uci}` — мы просто прокси, добавляя Authorization header.

### 3.6. Rate-limit handling

Lichess документирует общий лимит ~15 запросов в секунду на токен, отдельные endpoint'ы строже. Реакция на 429:
- В `LichessClient.request`: exponential backoff 2s → 4s → 8s → 16s → 32s → 60s (cap).
- В `runStream`: то же, до 60s между попытками.
- Per-user rate-limit на нашей стороне (Redis token-bucket): max 10 req/sec на `userId`. Чтобы юзер не выжег токен dos'ом через нашу прослойку.
- Метрика `lichess_rate_limit_total{endpoint}` в Prometheus — мониторим, нет ли систематических 429.

## 4. Архитектура frontend

### 4.1. Маршрут и навигация

Новый маршрут `/lichess/play` — отдельная страница. **Не интегрируем в существующий `/play`** (LobbyPage):

- LobbyPage — наш matchmaking, наши боты, наш `time_controls` UI. Lichess-флоу другой: их seek-format, их variants, их специфика (rated/casual, anonymous opponents).
- Смешение в одной странице запутает юзера: «я в Lichess или в Kingside?» — особенно вокруг рейтинга.

Структура:
- `/lichess/play` — landing с двумя секциями: `[Найти соперника]` (seek) и `[Входящие challenge'и]`.
- `/lichess/play?seeking=1` — после нажатия seek, страница ждёт матча, показывает «Searching opponent…» (один Lichess seek активен).
- `/lichess/game/:lichessGameId` — сама партия (см. §4.2).

Точка входа: в боковом меню (`Sidebar`) — пункт «Play on Lichess». Только для авторизованных в Kingside; внутри страницы — отдельный line CTA «Connect Lichess» если линка нет.

### 4.2. GamePage или LichessGamePage?

**Отдельный `LichessGamePage`**, не переиспользуем `GamePage`. Аргументы:

`GamePage` (см. файл `apps/web/src/pages/GamePage.tsx`, 876 строк):
- Завязан на `socket` namespace `/game` (нам нужен `/lichess`).
- Использует `useChallenge`, `useBotEngine`, `triggerBotMove` — бот-логика, не нужна.
- Использует `GameEvents.*` из `packages/shared` — наши WS-контракты, у Lichess другие.
- Использует `WsGameStatePayload`, `WsGameMoveServerPayload`, `WsGameEndPayload` — наши DTO с нашими полями (`ratingChange`, наши `players: { white, black }`-id'шники из User-таблицы). У Lichess другая семантика.
- `handleAnalyze` → `openAnalysis` → POST `/analyses` → редирект на наш `/analysis/{id}` (KS-2949 §2.6.1 фикс) — это для НАШИХ партий. Для Lichess-партии «анализ» = ссылка `lichess.org/{gameId}/analysis`, наш analysis-flow не подходит (см. §6).
- Tournament-логика (`tournamentId`, `arena/{id}`, berserk), challenge-rematch — Kingside-специфика.

Что переиспользуем:
- `MemoChessboard`, `useStablePosition`, `useFastDrag`, `useBoardHighlights` — чисто UI, агностичны.
- `useSounds`, `soundEventFromSan` — наши звуки, работают.
- `useBoardSettings`, `useResponsiveBoardSize` — кастомизация доски.
- `useChessGame` (есть в hooks/) — chess.js обёртка.

Структура `LichessGamePage` (~300-400 LOC):
- Подписка: `socket.emit('lichess:subscribe-game', { lichessGameId })` через отдельный socket к `/lichess` namespace.
- State: `fen`, `moves`, `clocks`, `status`, `playerColor`, `opponent: { username, rating, title }`, `timeControl`, `gameVariant`.
- Ход: вместо `socket.emit('game:move')` — `fetch POST /lichess/games/:id/move/:uci`. Backend проксирует на Lichess.
- Resignation: `POST /lichess/games/:id/resign`. Draw-offer: `POST /lichess/games/:id/draw/yes`.
- Часы: серверные. Lichess в `gameState` шлёт `wtime/btime` ms; рендерим как `ChessClock`-компонент (наш) или inline-таймер (зеркало `formatTime` из `GamePage.tsx:43`).
- Отсутствуют: rematch (Lichess их API — отдельный challenge, см. §4.6), berserk, tournament integration, modal «open in analysis».
- Кнопка «View on Lichess» внизу — ссылка `lichess.org/{gameId}` (после партии).

### 4.3. Часы

Lichess в `gameState` шлёт `wtime: 60000, btime: 60000, winc: 0, binc: 0` (ms). Источник правды — серверный, рендерим как декремент локально (`useEffect` interval 1s, как в `GamePage.tsx:395-409`), синхронизируем по каждому новому `gameState` (берсерк-style update — наш существующий паттерн).

Не используем DTO Lichess «напрямую» (через type-import) — оборачиваем в нашу `LichessGameState`-DTO (см. §4.5), чтобы изменение схемы Lichess не разорвало UI.

### 4.4. Что прячем (TOS Lichess)

Жёсткие правила, см. §6 (там же — единый список заблокированных разделов с обоснованием каждого).

UI-уровень:
- На `LichessGamePage` **не импортируем**: `useEngine`, `useStockfish`, `useExternalEngine`, `EvalBar`, `EngineSettingsModal`, `useEngineConfig`. Это означает, что во время Lichess-партии физически нет JavaScript-кода для движка на странице. ESLint-правило `no-restricted-imports` в файле `LichessGamePage.tsx` запретит даже случайный импорт.
- Кнопка «Hint» / «Show eval» / «Best move» отсутствует.
- Линка на `/analysis/...` нет ни в одной модалке после партии. Только `lichess.org/{gameId}/analysis` (там анализ — на стороне Lichess).
- Header «Опасно: вы играете против реального игрока на Lichess. Подсказки движка отключены.» — banner-disclaimer в верху страницы, не скрываемый.

Навигация:
- Пока юзер в активной Lichess-партии (backend знает по `activeStreams.has(userId)`), наша sidebar-навигация показывает заблокированными разделы из §6.1 (`/analysis`, `/precision`, `/workshop`, `/puzzles`, `/lessons` со steps-движком, `/ai-chat`). Клик → tooltip «Нельзя во время Lichess-партии (TOS Lichess)».
- Реализация: новый WS-event `lichess:active-game-started { gameId }` / `lichess:active-game-ended`, `FrontEndContext` хранит `isInLichessGame: boolean`, NavBar/Sidebar/Routes слушают.
- **Источник правды — backend.** UI-блокировка через WS-event и React-state — это UX-сахар (быстрая визуальная реакция и понятный tooltip). Если WS отвалился и фронт показывает устаревший `isInLichessGame=false`, попытка зайти на запрещённый роут или сделать запрос всё равно упирается в B9-guard (§7), который вернёт 403 на бэке. То есть нарушить TOS обходом frontend-блокировки невозможно — UI просто перестанет «знать» о запрете, а сервер не пропустит запрос.

### 4.5. Где показывать «вы играете на Lichess как @username»

В `LichessGamePage` header слева: avatar Lichess (если есть в их profile API) + `@username (1547 blitz)` + badge `Powered by Lichess`. Без рейтинга Kingside — он здесь нерелевантен.

### 4.6. Seek и Challenge

Страница `/lichess/play`:

**Seek form** (зеркало `lichess.org/?any` seek):
- Time control: dropdown `1+0 / 3+0 / 3+2 / 5+0 / 5+3 / 10+0 / 15+10` (выбираем 5-7 популярных, не весь Lichess-каталог).
- Color: random / white / black.
- Rated: switch (по умолчанию `rated: true`).
- Rating range: ±200 от текущего Lichess-рейтинга юзера (`profile.perfs.<perf>.rating`).
- Кнопка `[Find opponent]` → `POST /lichess/seek { timeControl, color, rated, ratingRange }` → backend проксирует `POST https://lichess.org/api/board/seek` (NDJSON-stream до момента матча).

**Incoming challenges**: subscribe to `/api/stream/event` от Lichess (backend держит этот стрим один на пользователя при подключении к `/lichess/play`). События `challenge` (входящие) рисуем как карточки с `[Accept] [Decline]`.

Rematch: после партии — кнопка `[Rematch]` шлёт challenge тому же оппоненту через Lichess Challenge API (`POST /api/challenge/{username}` с теми же параметрами).

## 5. Модель данных

### 5.1. Таблица `lichess_link`

Подробно — §2.3. Дополнительно поле `last_notified_at DateTime?` для expiry-cron'а.

### 5.2. Зеркалить ли партии Lichess в нашу БД?

Развилка:

| | (а) НЕ зеркалим | (б) зеркалим в `lichess_game_mirror` |
|---|---|---|
| Где история партий | lichess.org/@/{username} | у нас + у них |
| Доступ к PGN без интернета | нет | есть |
| Архивный поиск (наш `/archive`) | не работает по этим партиям | работает |
| Storage cost | 0 | 10-100KB на партию × N юзеров × N партий |
| Сложность кода | минимум (subscribe-stream → forget) | нужен post-end handler, parsing PGN, upsert в Prisma |
| Влияет ли на наши рейтинги | нет | нет (явно отделить) |
| Совместимость с TOS | full (мы — третий клиент) | full (мы можем хранить копии партий своего пользователя) |
| Конфликт identifier'ов | нет | нужен disambigation `Game.source = 'kingside' | 'lichess'` |

**В MVP выбираем (а) — НЕ зеркалим.** Аргументы:

1. Минимизируем scope MVP. Подключение, OAuth, stream, partai с ходами — уже большая фича. Mirror — отдельная задача.
2. Lichess Games Export API уже даёт всё, что нужно (`GET /api/games/user/{username}?max=...&perfType=...`) — если потом потребуется, импортнём batch'ом, не строя real-time mirror.
3. Архивный поиск (`/archive`) сейчас работает по нашей таблице `Game`. Смешать туда Lichess-партии (с другим whitePlayer-типом — там не наш user, а внешний string) — требует пересмотра модели `Game.whiteId` (uuid → optional). Это нетривиальное изменение, не для MVP.

Запасной план: в §11 «Follow-up» вынесена отдельная задача «Backfill через Games Export API», запуск по запросу пользователя.

### 5.3. Влияют ли Lichess-партии на наши рейтинги?

**НЕТ.** Зафиксировано явно:
- `User.ratingBullet/Blitz/Rapid/Classical` — только наши партии.
- Lichess-партии нашему рейтингу не считаются, мы их не пишем в `RatingHistory`.

Где показываем какой рейтинг (правила отображения):

| Место | Kingside-рейтинг | Lichess-рейтинг |
|---|---|---|
| Sidebar / topbar (наш глобальный UI) | да (текущий контракт) | **нет** — не смешиваем в глобальном хедере, иначе непонятно «какой именно из двух» |
| Profile page (`/profile/:username`) | блок «Kingside ratings» | отдельный блок «Lichess ratings» (если есть `LichessLink`), поднимается из `lichess.org/api/account` при загрузке профиля, кешируется 5 минут |
| `LichessPlayPage` (lobby) | нет (мы вне нашего matchmaking-flow) | да — в seek-форме показываем «ваш Lichess rapid: 1547» как контекст для ratingRange |
| `LichessGamePage` (header partii) | нет | да — `@username (1547 blitz)` |
| `GamePage` (наша live-партия) | да (как сейчас) | нет |
| Leaderboards / арены / турниры | да | нет — Lichess-рейтинг живёт только внутри Lichess-флоу |

Аргумент: смешать чужие партии в наш рейтинг — испортить математику Glicko. Юзеры на Lichess могут быть сильнее/слабее, чем на Kingside, и калибровка ломается. Параллельные рейтинги — единственная честная модель. Lichess-рейтинг показываем только в местах, где юзер явно находится в Lichess-флоу — это убирает двусмысленность «какой именно из двух».

## 6. TOS / соответствие правилам Lichess

Источник: `lichess.org/terms-of-service`, `lichess.org/api#section/Introduction` (Fair Play & Engine Assistance), Board API docs.

### 6.1. Запрет engine-assistance

> Using a computer engine to assist your play is strictly forbidden.

Что под этим подразумевается:
1. Внутренние chess-engines (Stockfish, Lc0, etc.) во время партии — нельзя.
2. Любые подсказки «best move», «threat», «winning continuation» — нельзя.
3. Любые eval-bar'ы во время партии — нельзя.
4. Opening book lookup в реальном времени — обычно разрешено для casual, запрещено для rated; мы для надёжности **запрещаем во всех режимах**.

Единый список разделов, заблокированных пока активен Lichess-stream (B9-guard на бэке + UI-блокировка в §4.4):

| Раздел | Используется ли Stockfish/engine | Блокируем | Причина |
|---|---|---|---|
| `/analysis/*` | да — `useStockfish`, `EvalBar`, best-move suggestions | **да** | Прямая подсказка хода — нарушение TOS |
| `/precision-replay` (анализ partii в режиме точности) | да — ACPL eval-bar по серверному Stockfish | **да** | Eval-bar = подсказка |
| `/workshop` | да — `useStockfish` для свободной аналитики позиции | **да** | Свободный engine-overlay |
| `/lessons/<step>` со step-type `endgame-drill` / `opening-drill` | да — `useStockfish` оценка хода ученика | **да** | Хотя это «обучающий контекст», движок виден на экране во время хода — нарушение |
| `/ai-chat` (чат-ассистент) | косвенно — ассистент может выдать «лучший ход» через knowledge-tools (ADR-063) | **да** | LLM не различает контексты; запрещаем как класс. На бэке `ChatAssistantService.streamResponse` проверяет `lichessStream.hasActiveGame(userId)` → 403 |
| `/puzzles/<id>` (обычные задачи) | да — клиентский Stockfish для верификации хода игрока | **да, для перестраховки** | Stockfish инициализирован в браузере, eval-arrow рисуется в `PuzzleGeneratorModal` при ошибке. Технически можно «увидеть линию»; даже если визуально не показано — engine крутится. Нарушение по букве TOS («using a computer engine»), а не только по подсказкам |
| `/precision` (тренировка точности — основной режим) | да — серверный Stockfish для ACPL | **да** | Аналогично puzzles |
| `/lessons` (любые) | потенциально да | **да** для всех lesson-step типов с engine-step (drill, eval-quiz). Lesson-step типа video/text/quiz без движка — НЕ блокируем, но проще запретить все lessons чем разрезать по step-types в guard'е |
| `/archive` (просмотр архива своих партий) | нет (просмотр PGN без движка) | **нет** | Просмотр сыгранного, движок не дёргается |
| `/profile`, `/friends`, `/tournaments` (просмотр), Settings | нет | **нет** | Не игровой контекст, движка нет |
| `/lichess/play` (lobby) | нет | **нет** (это и есть Lichess-флоу) | — |

Принцип: блокируем **любой раздел, где Stockfish может быть инициализирован на странице или вызван на бэке во время прохождения юзером** — даже если визуальной подсказки «best move» в UI нет. По букве TOS «использование engine» уже нарушение, не важно как именно. Это перестраховка: лишний раз заблокировали `/puzzles` где SF только верифицирует — пользователь подождёт окончания партии и решит задачи потом; потенциальный TOS-бан критичнее, чем 10 минут ожидания.

B9-guard (см. §7) применяется как Nest-`@UseGuards(LichessActiveGameGuard)` к контроллерам:
- `AnalysisController` (write-методы: POST/PATCH analyses), `AnalysisPublicController` остаётся доступен — он read-only.
- `PrecisionController` (все methods).
- `PuzzleController` (POST attempt; GET puzzles остаётся — посмотреть задачу можно, решать — нет).
- `WorkshopController` (все).
- `ChatAssistantController` (POST message).
- `LessonsController` (POST step-completion).

Не прячем (это разрешено):
- Move-list (история ходов своей партии) — можно.
- Часы — можно.
- Sound на ход / на shah / на end-game — можно (Lichess сами шлют sound-cue).
- Просмотр архива (`/archive`), профиля, друзей — можно, движка там нет.

### 6.2. Один scope, не путать `board:play` с `bot:play`

- `board:play` — для human-players через сторонний UI (Kingside).
- `bot:play` — для зарегистрированных как ботов аккаунтов (требует upgrade на стороне Lichess, иначе вернёт 401 на /api/bot/* endpoints).

Запрашиваем **только `board:play`**, и только в OAuth init. Никаких bot-related ручек (`/api/bot/...`) не вызываем. На стороне Lichess они сами банят аккаунты, играющие через `board:play` если их трафик «похож на бота» (statistically — слишком быстрые ходы, идеальное соответствие SF best-move и т.п.).

Кто следит:
- Lichess сам банит подозрительный трафик через свои anti-cheat алгоритмы. Это их проблема и их users.
- Мы **не должны** скрывать, что юзер играет от своего имени. Запрещено, например, делать ход за пользователя автоматически от его токена. Все ходы инициируются явным действием юзера на доске.

### 6.3. Один активный board-stream на токен

> Only one Board API stream per OAuth token is allowed.

Защита уровня сервиса (§3.2): `activeStreams.has(userId)` → abort предыдущий перед открытием нового. UI: не разрешаем ввести юзера в две Lichess-партии параллельно (если он попытается принять второй challenge во время игры — backend ответит 409 Conflict).

### 6.4. Disclaimer на странице

Постоянный header-banner на `LichessGamePage`:

> ⚠️ Игра идёт на серверах Lichess. Подсказки движка и анализ во время партии отключены согласно правилам Lichess. После окончания партии вы можете посмотреть анализ на [lichess.org/{gameId}/analysis].

Plus footer-line «Powered by Lichess» — корректность бренда.

### 6.5. Rate limits и quotas

Документированные:
- Общий: ~15 req/sec на токен (мы внутри backend rate-limit'им до 10 на нашей стороне, §3.6).
- Seek: один активный на токен. Lichess сам отменит, если откроем второй.
- Streams: 1 board-stream на токен (§6.3).

Если систематически ловим 429 на каком-то endpoint'е — добавляем агрессивнее backoff и метрику; на TOS-уровне это «warning», не нарушение. Lichess не банит за 429, но может за репитированно-агрессивный трафик.

## 7. План работ

Декомпозиция на тикеты. Зависимости отмечены `← {keys}`. Метки агентов: `B` (backend), `F` (frontend), `D` (devops), `Q` (qa), `A` (architect — этот ADR уже).

### Этап 1. Foundation (можно параллельно)

**B1. `lichess_links` миграция Prisma + DTO.**
- Файлы: `packages/db/prisma/schema.prisma` (model LichessLink, relation User.lichessLink), миграция `add_lichess_links`.
- Labels: `prisma`, `lichess`.
- Acceptance: миграция применяется, prisma-generated тип появляется, индексы `expires_at`, `lichess_user_id`.

**B2. Token-crypto + LichessLink-service.**
- Файлы: `apps/api/src/lichess/token-crypto.ts`, `lichess-link.service.ts`, `lichess.module.ts` (пустой пока).
- Env: `LICHESS_TOKEN_ENCRYPTION_KEY` в `.env.example` (32-byte base64).
- Acceptance: unit-тесты на encrypt/decrypt, на CRUD link'а, на mark-revoked.
- Labels: `lichess`, `security`.

**D1. ENV для Lichess.** ← независимо от B1/B2.
- Файлы: `.env.example`, deploy-скрипт `scripts/deploy.sh`, Docker compose.
- Variables: `LICHESS_API_URL=https://lichess.org`, `LICHESS_OAUTH_CLIENT_ID=app.kingside.site`, `LICHESS_REDIRECT_URI=...`, `LICHESS_TOKEN_ENCRYPTION_KEY=<generated>` (production).
- Acceptance: на стейдже все env присутствуют, секрет сгенерирован.
- Labels: `infra`, `lichess`.

### Этап 2. OAuth flow (← B1, B2, D1)

**B3. OAuth init/callback контроллер.**
- Файлы: `apps/api/src/lichess/lichess-oauth.controller.ts`, `oauth-init.dto.ts`.
- Endpoints: `POST /lichess/oauth/init` (фронт шлёт `{code_verifier_hash, state}`), `GET /api/auth/lichess/callback` (Lichess редиректит, обмен code→token, создание LichessLink, redirect фронту на `/lichess/play?linked=1`).
- Acceptance: e2e-тест c mock'ом Lichess (response 200 с фейковым access_token), запись в БД, encrypted token.
- Labels: `lichess`, `auth`, `tests`.

**F1. Frontend «Connect Lichess» + LinkStatus.** ← B3.
- Файлы: `apps/web/src/pages/LichessPlayPage.tsx` (landing), `apps/web/src/components/LichessConnectButton.tsx`, `apps/web/src/hooks/useLichessLink.ts`.
- Поток: PKCE на фронте, init-POST, redirect на `lichess.org/oauth`, после callback'а — `GET /lichess/link/status` → отображение `@username (expires in N)` / `[Connect]` / `[Reconnect]`.
- Также: блок «Lichess account» в `SettingsPage` (link/unlink из настроек).
- Acceptance: ручной e2e — Connect → переход на Lichess (тестовый аккаунт) → возврат → статус «linked».
- Labels: `lichess`, `auth`.

**B4. Unlink endpoint + DELETE token at Lichess.**
- Файл: `apps/api/src/lichess/lichess.controller.ts` метод `unlink`.
- Acceptance: после unlink — запись revoked, у Lichess вернулся 200 (или мы корректно поглотили 401/network-fail).
- Labels: `lichess`.

### Этап 3. Streaming и игра (← Этап 2)

**B5. LichessClient (REST-обёртка).**
- Файлы: `apps/api/src/lichess/lichess-client.service.ts`, `lichess-rate-limiter.ts`.
- Методы: `getAccount(userId)`, `seek(...)`, `acceptChallenge(...)`, `declineChallenge(...)`, `makeMove(...)`, `resign(...)`, `offerDraw(...)`, `cancelSeek(...)`.
- 429 backoff, 401 → markRevoked.
- Acceptance: unit-тесты с моками fetch.
- Labels: `lichess`.

**B6. LichessStreamService (NDJSON).**
- Файлы: `apps/api/src/lichess/lichess-stream.service.ts`.
- Methods: `subscribeGame(userId, gameId)`, `subscribeEvents(userId)`, `unsubscribe...`.
- Acceptance: интеграционный тест с моком NDJSON (читаем фикстуру с тремя `gameState`).
- Labels: `lichess`.

**B7. WS Gateway `/lichess`.** ← B5, B6.
- Файлы: `apps/api/src/lichess/lichess.gateway.ts`.
- События см. §3.5.
- Acceptance: ручной end-to-end — два пользователя через Lichess test API, ходы прокидываются.
- Labels: `lichess`, `game`.

**F2. SeekForm + ChallengeList.** ← B5, B7.
- Файлы: `apps/web/src/pages/LichessPlayPage.tsx` (расширение), `LichessSeekForm.tsx`, `LichessIncomingChallenges.tsx`.
- Acceptance: ручной e2e — нашли соперника, редирект на `/lichess/game/{id}`.
- Labels: `lichess`.

**F3. LichessGamePage.** ← B7.
- Файлы: `apps/web/src/pages/LichessGamePage.tsx`, `apps/web/src/hooks/useLichessGame.ts`, `apps/web/src/socket.ts` (новый socket к `/lichess`).
- TOS: `no-restricted-imports` на engine-хуки.
- Disclaimer banner.
- Часы, move-list, resign/draw, view-on-lichess link после окончания.
- Acceptance: e2e-тест с двумя браузерами + Lichess test-accounts.
- Labels: `lichess`, `game`.

### Этап 4. UX истечения + observability (← Этап 3)

**B8. Expiry scheduler.** ← B2.
- Файлы: `apps/api/src/lichess/lichess-expiry.scheduler.ts`.
- Cron: `@Cron('0 6 * * *')`, выборка `expiresAt - now ∈ {30d, 7d, 1d}`, создание `Notification`, отправка через telegram-channel.
- Acceptance: unit-тест на выборку нужных диапазонов, на cooldown 24h.
- Labels: `lichess`, `notifications`.

**F4. Re-auth UX.** ← F1, B7.
- Файлы: `apps/web/src/context/LichessActiveContext.tsx`, `LichessReauthBanner.tsx`.
- Слушает `lichess:link-revoked`, показывает баннер «Сессия истекла, [Re-connect]».
- Также: подписка на `lichess:active-game-started/ended` для блокировки навигации (§4.4).
- Acceptance: ручной — abort'ом токена на тестовом аккаунте проверить, что баннер появляется.
- Labels: `lichess`, `auth`.

**F5. i18n строк для Lichess UI.** ← F1, F2, F3, F4.
- Файлы: `apps/web/public/locales/en/lichess.json`, `apps/web/public/locales/ru/lichess.json` (новый namespace).
- Покрытие: Settings-блок «Lichess account», LichessPlayPage (seek-form, challenge-list), LichessGamePage (disclaimer-banner, opponent-info, after-game CTA), reauth-banner, nav-блокировка tooltip.
- Disclaimer (§6.4) должен быть на двух языках, текст финализирует пользователь — задача F5 готовит ключи + черновой EN-вариант от автора фичи.
- Acceptance: `useTranslation('lichess')` во всех компонентах фичи, no hardcoded strings (ESLint custom rule `i18next/no-literal-string` на новых файлах), RU/EN покрытие 100% ключей.
- Labels: `lichess`, `i18n`.

**B9. TOS-guard: блокировка движка во время Lichess-партии.** ← B7, F3.
- Файлы: `apps/api/src/lichess/lichess-active-game.guard.ts`, инжектируется в `ChatAssistantController`, `AnalysisController` (write-методы), `PrecisionController`.
- Логика: `if (lichessStream.hasActiveGame(userId)) throw new ForbiddenException('Locked during Lichess game')`.
- Frontend (см. F4) дополнительно блокирует навигацию на уровне роутов.
- Acceptance: e2e-тест — в активной партии POST `/analyses` возвращает 403.
- Labels: `lichess`, `security`, `tests`.

**B10. McpExclude на LichessModule.**
- Файлы: `apps/api/src/lichess/lichess.module.ts`.
- Декораторы `@McpExclude()` на классе модуля (ADR-061 §5) — TOS-чувствительный модуль ассистенту не выдаётся.
- Acceptance: `GET /_mcp/tools` не содержит секции `lichess`.
- Labels: `lichess`, `security`.

### Этап 5. QA и приёмка

**Q1. Smoke e2e на тестовом аккаунте.** ← Этапы 1-4.
- Сценарий: link → seek 5+0 rated false → принят оппонентом-ботом → 10 ходов → resign → unlink.
- **У Lichess нет staging-окружения.** Тестовые аккаунты создаются на проде Lichess как обычные (бесплатные) — DevOps на этапе D1 регистрирует 2 dedicated-аккаунта `kingside-test-1`/`kingside-test-2` (имена ориентировочные), пароли в Docker secret, для оппонента — bot-аккаунт Lichess или второй тестовый юзер. Trafic с этих аккаунтов попадает в реальные `lichess.org/games`, что нормально (как у любого автоматизированного теста с Lichess API).
- Tests: playwright e2e в `apps/e2e/`. CI прогон ограничен `casual`-режимом (rated=false), чтобы тестовые партии не загрязняли rapid-рейтинг тестовых аккаунтов.
- Acceptance: проходит в CI, артефакт скриншотов, тестовые аккаунты не получают ban от Lichess (мониторим `lichess.org/api/account` тестовых юзеров — если `disabled=true` пришёл, эскалируем).
- Labels: `lichess`, `tests`.

**Q2. TOS-аудит.** ← Этап 3, 4.
- Чек-лист: §6.1 проверить вручную, что нет engine-overlay'я, /analysis-навигация заблокирована, hint-кнопок нет, чат-ассистент 403 в активной партии.
- Артефакт: `docs/qa/lichess-tos-audit-<date>.md`.
- Acceptance: чек-лист пройден без замечаний.
- Labels: `lichess`, `security`, `tests`.

**Q3. Negative paths.**
- Сценарии: токен истёк во время партии, Lichess вернул 429, фронт перезагрузил вкладку посредине партии, два tab'а с одной партией (lock через WS-deduplication), offline / network glitch.
- Acceptance: каждый сценарий вручную пройден, поведение задокументировано.
- Labels: `lichess`, `tests`.

### Этап 6 (опционально, отдельный ADR/тикеты)

- `lichess_game_mirror` через Games Export API (§5.2 запасной план).
- Импорт Lichess-партий в наш `/archive` (требует пересмотра модели Game).
- Чат внутри Lichess-партии (мы сейчас игнорируем `chatLine`).

### Порядок выполнения и параллельность

- Этап 1 (B1, B2, D1) — параллельно, ~1-2 дня.
- Этап 2 (B3, B4, F1) — после Этапа 1, ~2-3 дня.
- Этап 3 (B5, B6, B7, F2, F3) — после Этапа 2, ~5-7 дней. B5/B6/B7 — последовательно. F2 и F3 параллельно после B7.
- Этап 4 (B8, B9, B10, F4) — после Этапа 3, ~2-3 дня. B10 — параллельно остальным.
- Этап 5 (Q1, Q2, Q3) — после Этапа 4, ~2-3 дня.

Итоговая оценка: **12-18 рабочих дней одного разработчика**.

## 8. Риски

| # | Риск | Вероятность | Импакт | Mitigation |
|---|---|---|---|---|
| 1 | Lichess изменит TOS / Board API, фича сломается | средне | средне | Все запросы версионированные через единый `LichessClient`; при изменении — точечный фикс; в alerting Slack-channel `#lichess-api-changes` (по тегу) |
| 2 | Коллизия `lichess_user_id` (два наших юзера привязали один Lichess-аккаунт) | низко | средне | На уровне сервиса при OAuth-callback'е проверяем, есть ли уже `LichessLink with this lichessUserId AND revokedAt IS NULL`; если есть и `userId != currentUser` — отказываем с понятным сообщением «этот Lichess-аккаунт уже привязан к другому Kingside-пользователю» |
| 3 | Массовое истечение токенов одновременно (например, год после релиза фичи большинство юзеров выпадают за месяц) | высоко (системно неизбежно) | средне | Cron §2.6.1 уведомляет за 30/7/1 день, юзер успевает re-link до истечения; реauth-flow максимально простой (одна кнопка); метрика `lichess_links_expiring_7d` в Prometheus — alert если >100 |
| 4 | NDJSON-стрим обрывается часто (мобильный 4G переключения, network glitches) | высоко | низко | Exponential backoff reconnect в `runStream` (зеркало `broadcast-sync.service.ts:1300-1304`); idempotent обработка событий (по `gameState.moves.length` — сравниваем с локальным); метрика `lichess_stream_reconnects_total` |
| 5 | Утечка `LICHESS_TOKEN_ENCRYPTION_KEY` → дешифровка всех access_token'ов в БД | низко | высокий | Хранение в Docker secret / `.env` с ограниченными правами; cron-задача ротации ключа (не в MVP, отдельный тикет); в MVP — документировать процедуру ротации в `docs/devops/` |
| 6 | XSS на нашем фронте → атакующий вызывает `POST /lichess/seek` и спамит challenge'ы | низко | средне | Серверный rate-limit per-user (§3.6, 10 req/sec); CSRF-токен на POST'ах (наша существующая защита); все Lichess-операции требуют наш JWT |
| 7 | Юзер открыл 2 вкладки с `/lichess/play` → два параллельных event-stream'а от Lichess → 429 / TOS-нарушение | средне | низко | Backend deduplicates: один event-stream на userId, на втором WS-connect от того же юзера переиспользуется существующий; UI не запрещает 2 вкладки (это раздражит), но автоматически работает корректно |
| 8 | Lichess UI меняется, юзер видит подсказки движка на их сайте, но не у нас → жалуется «у вас плохо» | средне | низко | Disclaimer (§6.4) явно объясняет ограничения и даёт ссылку на их анализ после партии; в FAQ-секции «Why no engine analysis?» |
| 9 | Активный Lichess-stream держит event-loop `apps/api`, тормозит остальные запросы при многих параллельных стримах | низко (на старте) | средне | Метрика `lichess_active_streams_count`; alert при >300; план миграции в отдельный сервис `apps/lichess-service` готов (§3.1) |
| 10 | Юзер думает, что Lichess-партия влияет на наш рейтинг, спорит после поражения | низко | низко | UI явно показывает «Lichess rating only, не влияет на ваш Kingside-рейтинг» под обоими часами; FAQ |
| 11 | Анти-cheat Lichess банит нашего юзера за подозрительный паттерн ходов | средне (любые third-party UI попадают) | средне (для юзера, не для нас) | Disclaimer в FAQ: «Lichess может банить за подозрительный трафик независимо от нас. Жалобы — на их support»; мы не вмешиваемся в скорость ходов / sound-cue (юзер играет «как сам») |
| 12 | Чат-ассистент Kingside случайно даёт совет «лучший ход — Nf3» во время Lichess-партии | низко | высокий (TOS-нарушение) | B9-guard блокирует ассистент в активной партии (`ChatAssistantService` → 403); регресс-тест в Q2 |
| 13 | Юзер unlink'ает прямо посреди партии → токен revoked, streamer падает, состояние партии теряется | низко | низко | unlink-endpoint предупреждает «у вас активная партия, она будет прервана»; кнопка disabled пока `hasActiveGame(userId)` (UI), и backend 409 если попытаются |

## 9. Альтернативы

### 9.1. Iframe Lichess

Открывать `lichess.org` в `<iframe>` на нашей странице.

Pro:
- 0 кода с нашей стороны.

Contra:
- Их UI, не наш — теряем смысл интеграции. Юзер с тем же успехом откроет вкладку Lichess.
- iframe sandboxing ломает их socket-логику.
- Lichess в их headers (`X-Frame-Options: SAMEORIGIN`) явно запрещает себя iframe'ить.

**Отклонено.**

### 9.2. Ничего не делать (status quo)

Pro:
- 0 кода, 0 поддержки, 0 риска.

Contra:
- KS-фундаментальная проблема малой базы игроков остаётся (см. §1.2). 30s matchmaking-fallback на бота — это не решение для опытных юзеров.

**Отклонено** — фича стратегически нужна.

### 9.3. Только импорт сыгранных партий через Games Export API

Сценарий: юзер привязывает Lichess, мы фоном выгружаем все его сыгранные на Lichess партии, кладём в `/archive`, даём наш анализ-flow.

Pro:
- Технически проще (нет real-time, нет board-stream, нет TOS-нюансов с engine во время партии).
- Полезно для архива и тренировки на ошибках через `/mistakes`.

Contra:
- Не решает задачу из §1.2 (доступ к пулу игроков). Юзер всё равно играет на Lichess отдельно, а в Kingside только смотрит.

**Не отклонено, но это другая фича.** Запасной план / параллельная задача — см. Этап 6 §7. Не блокирует и не блокируется этим ADR.

### 9.4. SDK Lichess (npm пакет `lichess.api`)

Существует unofficial wrapper `lichess.api` на npm. 

Contra:
- Unmaintained (последний commit 2 года назад).
- Lichess API простой, fetch + types достаточно. Зависимость не нужна.

**Отклонено**, пишем тонкий клиент сами.

## 10. Не входит в этот ADR

- Реализация (отдельные follow-up тикеты, см. §7).
- Текст FAQ и disclaimer'ов (контентная работа, KS-XXXX в Этапе 3).
- Дизайн Settings-блока «Lichess account» — макет от пользователя, frontend по нему.
- Метрики Prometheus конкретные (имена/labels — на backend в момент реализации).
- Полная имплементация ротации `LICHESS_TOKEN_ENCRYPTION_KEY` — отдельный devops-тикет после MVP.
- Мониторинг 429 / anti-cheat ban — отдельная задача observability.
- Чат Lichess внутри партии — отложено, Этап 6.
- Mirror партий в нашу БД — отложено, Этап 6.

## 11. Follow-up задачи

Координатор создаёт по этому ADR:

**Backend (B1-B10):**
1. `prisma`, `lichess` — миграция `lichess_links` (B1).
2. `lichess`, `security` — token-crypto + LichessLink-service (B2).
3. `lichess`, `auth`, `tests` — OAuth init/callback (B3).
4. `lichess` — unlink endpoint (B4).
5. `lichess` — LichessClient REST-обёртка (B5).
6. `lichess` — LichessStreamService NDJSON (B6).
7. `lichess`, `game` — WS gateway /lichess (B7).
8. `lichess`, `notifications` — Expiry scheduler (B8).
9. `lichess`, `security`, `tests` — TOS-guard на /analysis,/precision,/ai-chat (B9).
10. `lichess`, `security` — @McpExclude на LichessModule (B10).

**Frontend (F1-F5):**
11. `lichess`, `auth` — Connect button + Settings блок (F1).
12. `lichess` — SeekForm + ChallengeList (F2).
13. `lichess`, `game` — LichessGamePage (F3).
14. `lichess`, `auth` — Re-auth banner + navigation lock (F4).
15. `lichess`, `i18n` — i18n покрытие RU/EN (F5).

**Devops (D1):**
16. `infra`, `lichess` — ENV vars + secret generation + регистрация тестовых аккаунтов Lichess для CI (D1).

**QA (Q1-Q3):**
17. `lichess`, `tests` — e2e smoke (Q1).
18. `lichess`, `security`, `tests` — TOS audit checklist (Q2).
19. `lichess`, `tests` — negative paths (Q3).

Итого ~19 follow-up задач. Все зависимости — внутри §7 по этапам.
