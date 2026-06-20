# ADR-139: Service-account авторизация агентов для админ-API

Связанные тикеты: KS-4452.
Связанные ADR: 137 rev2 (`BlogAdminController`), 138 (загрузка обложек в S3).

## 1. Контекст

Агенты (backend, content, marketing) выполняют админ-операции — например, создают статьи блога через `PUT /admin/blog/posts/:id` с обложкой (ADR-137 rev2, ADR-138). Это требует авторизации.

**Что есть в проекте:**

* `JwtAuthGuard` — passport-jwt, для аутентифицированных пользователей;
* `AdminUserGuard` — после JWT проверяет username в `KS_ADMIN_USERS` (новый `BlogAdminController` использует именно его);
* `AdminEmailGuard` — после JWT проверяет email в `KS_ADMIN_EMAILS` (lessons admin);
* `AdminApiKeyGuard` — простой header `x-admin-key` против env `ADMIN_API_KEY`, используется на `/admin/feedback*`, `/admin/users/cleanup-bots` и т.п. (служебный модуль `AdminController`).

**Что не работает для агентов:**

* personal JWT пользователя не передаётся (явный отказ);
* у backend в его контейнере нет ни прод `JWT_SECRET`, ни записи в `KS_ADMIN_USERS` — он не может подписать токен под аккаунтом админа;
* ECS RunTask с прямым Prisma отвергнут как «городить инфраструктуру».

Нужен **service-account** механизм — учётка для агента, не привязанная к человеку.

## 2. Рассмотренные варианты

| Вариант | Безопасность | Сложность реализации | Удобство для агента | Совместимость |
|---|---|---|---|---|
| **A. Технический пользователь + API-token в БД (выбран)** | средне-высокая (token-rotation через БД, scope-ограничения, hash хранения, audit) | низкая — переиспользуем паттерн `AdminApiKeyGuard`, добавляем БД-таблицу и Service-Guard | максимум: один header, один curl-шаг | как альтернатива `JwtAuthGuard+AdminUserGuard` через composite-guard, фронт админки JWT не теряет |
| **B. mTLS / IP-allowlist на `/internal/*`** | высокая (peer-cert) | высокая — настройка ALB, CA, выдача клиентских сертов, отдельный префикс | средняя — нужен сертификат, прокси | новый префикс, дубль маршрутов или прокси-роутинг |
| **C. OAuth 2.0 client-credentials grant** | высокая (стандарт) | очень высокая — `/oauth/token`, JWT-issuance, scope, refresh, библиотека oauth2-server | средняя — два шага (token-request → API), но «по учебнику» | новый блок, поверх JWT |
| **D. Делегированный JWT-scope (backend подписывает)** | средне-низкая (если ключ утечёт — токены подделать тривиально) | средняя — нужно занести `JWT_SECRET` в контейнер backend | низкая — backend всё равно не имеет ключа в проде | переиспользует JwtAuthGuard, но требует доступа к секрету там, где его нет |

Подробнее по каждому:

### A. Тех-пользователь + API-token

* В БД таблица `agent_service_accounts` (handle, hashed_token, scopes, revoked).
* Агенту выдают plain-токен один раз (CLI на стороне backend), хранит в env.
* `ServiceAccountGuard` проверяет header `X-Service-Account-Token`, ищет по hash в БД, проверяет scopes, подставляет `req.user` как виртуальный пользователь.
* Композитный `AdminOrServiceGuard` пропускает либо `(JwtAuthGuard+AdminUserGuard)`, либо `ServiceAccountGuard`. Применяется на `BlogAdminController` и других нужных контроллерах.

Безопасность: token хранится hash'ом (sha256, для длинных random-strings достаточно — это не пароль пользователя). Утечка plain-токена компрометирует только этот аккаунт; revoke — один UPDATE в БД, без redeploy api. Scope-разделение позволяет ограничить агента (например `blog:write` — может, `users:delete` — нет).

### B. mTLS / IP-allowlist на `/internal/*`

Требует:
* CA для подписания клиентских сертов;
* настройка `ssl_verify_client` на ALB / nginx;
* выдача каждому агенту своего сертификата;
* отдельный префикс или поддомен для internal-маршрутов.

Сложно операционно для одного разработчика. Реально нужно когда служб много и они изолированы по сетям.

### C. OAuth 2.0 client-credentials

Стандарт. Требует:
* библиотеку (`@nestjs/passport-oauth2` или `oauth2-server`);
* эндпоинт `/oauth/token` с обработкой grant_type;
* JWT-issuance + signing;
* scope-логику;
* документацию для клиентов.

Хорошо ляжет когда планируется внешний API для third-party. Сейчас агенты — внутренние, библиотечный overhead не окупается.

### D. Делегированный JWT (backend подписывает)

Требует:
* доступ к прод `JWT_SECRET` у backend;
* пользователь явно сказал, что у backend этого ключа нет;
* если ключ всё-таки положить — это эквивалент варианту A, но без аудита и revoke без redeploy.

Отвергнут по контексту.

## 3. Решение

**Выбран вариант A: технический пользователь + API-token в БД.**

### 3.1. Схема БД

```prisma
/// KS-4452 / ADR-139. Service-account для агентов и интеграций.
/// `tokenHash` — sha256(plain). Plain выдаётся один раз при создании
/// (CLI), потом нигде не хранится. Утечка → UPDATE revokedAt → токен
/// невалидный, redeploy не нужен.
model AgentServiceAccount {
  id          String   @id @default(uuid()) @db.Uuid
  /// Уникальный handle (`agent-backend`, `agent-marketing`, `ci-builder`).
  /// Используется в логах и `req.user.username`.
  handle      String   @unique
  /// sha256 hex от plain-токена (64 символа). Plain нигде не хранится.
  tokenHash   String   @unique @map("token_hash")
  /// Список scope-строк: `blog:write`, `blog:read`, `lessons:write`,
  /// и т.д. Строки сравниваются по equality + wildcard (`blog:*`).
  scopes      String[] @default([])
  /// Описание для админки (зачем выдан, кому).
  description String?  @db.Text
  /// Кем создан (handle админа или null для системных).
  createdBy   String?  @map("created_by")
  createdAt   DateTime @default(now()) @map("created_at")
  /// NULL → активен. Дата → токен невалиден с этого момента.
  revokedAt   DateTime? @map("revoked_at")
  /// Последний успешный вход (для аудита и cleanup unused).
  lastUsedAt  DateTime? @map("last_used_at")

  @@index([revokedAt])
  @@map("agent_service_accounts")
}
```

### 3.2. Guard

`apps/api/src/auth/service-account.guard.ts`:

```ts
@Injectable()
export class ServiceAccountGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = req.headers['x-service-account-token'];
    if (!token || typeof token !== 'string') return false;
    const hash = sha256hex(token);
    const acc = await this.prisma.agentServiceAccount.findUnique({
      where: { tokenHash: hash },
    });
    if (!acc || acc.revokedAt) {
      throw new UnauthorizedException('Invalid service token');
    }
    // Подставляем виртуального пользователя — совместимо с req.user в
    // дальнейшем коде. id = id записи, username = handle.
    req.user = {
      id: acc.id,
      username: acc.handle,
      isServiceAccount: true,
      scopes: acc.scopes,
    };
    // Аудит: обновляем lastUsedAt без блокировки запроса.
    this.prisma.agentServiceAccount
      .update({ where: { id: acc.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return true;
  }
}
```

### 3.3. Композитный guard

`apps/api/src/auth/admin-or-service.guard.ts`:

```ts
/**
 * Пропускает запрос если выполнен ОДИН из:
 *  - JwtAuthGuard + AdminUserGuard (человек-админ через UI);
 *  - ServiceAccountGuard со scope, удовлетворяющим @RequiredScope().
 */
@Injectable()
export class AdminOrServiceGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly adminUser: AdminUserGuard,
    private readonly service: ServiceAccountGuard,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const hasServiceHeader = !!req.headers['x-service-account-token'];
    if (hasServiceHeader) {
      const ok = await this.service.canActivate(ctx);
      if (!ok) return false;
      const required = this.reflector.get<string>('requiredScope', ctx.getHandler());
      if (required && !hasScope(req.user.scopes, required)) {
        throw new ForbiddenException(`Missing scope: ${required}`);
      }
      return true;
    }
    // Фронт админки: классический путь.
    const jwtOk = await (this.jwt.canActivate(ctx) as Promise<boolean>);
    if (!jwtOk) return false;
    return this.adminUser.canActivate(ctx) as boolean | Promise<boolean>;
  }
}
```

Декоратор `@RequiredScope('blog:write')` ставится на endpoint.

### 3.4. Применение

`BlogAdminController` (ADR-137 rev2): заменить `@UseGuards(JwtAuthGuard, AdminUserGuard)` на `@UseGuards(AdminOrServiceGuard)` + `@RequiredScope('blog:write')` на mutating-методах. Read-методы (`GET /admin/blog/posts`) — `blog:read`.

`AdminController` (feedback, chat, cleanup-bots) — оставляем как есть с `AdminApiKeyGuard`: это другой паттерн (общий ключ через nginx), не пересекается с агентами.

`LessonsAdmin*Controller` — переход опциональный, отдельной задачей если потребуется агентам.

### 3.5. CLI создания токена

`apps/api/src/auth/create-service-account.cli.ts`:

```bash
$ npm run cli:service-account -- create \
    --handle agent-backend \
    --scopes blog:write,blog:read \
    --description "Backend agent for blog publishing"

handle:      agent-backend
plain-token: ks_sa_8f3a...{32 random chars}...
SAVE IT — это единственный показ. Сохрани в env агента: KS_SERVICE_TOKEN.
```

CLI:
1. Генерирует 32 случайных байта (URL-safe base64 без padding) → plain.
2. Считает `sha256hex(plain)`.
3. INSERT с handle, tokenHash, scopes, createdBy.
4. Печатает plain один раз, дальше — только handle и hash.

Дополнительно: `revoke --handle <h>`, `list`, `rotate --handle <h>` (создать новый токен, старый помечать revoked после grace-периода).

### 3.6. Доставка токена в контейнеры агентов

Токен передаётся через env `KS_SERVICE_TOKEN` (или `AGENT_SERVICE_TOKEN`) при старте контейнера. Источник:
* AWS Secrets Manager → env через ECS task-def — стандартный путь, как `JWT_SECRET` сейчас в api;
* docker-compose локально — `.env` файл.

Агент в коде читает `process.env.KS_SERVICE_TOKEN` и кладёт в header `X-Service-Account-Token` при вызове `/admin/*`.

### 3.7. Аудит

Каждый успешный вход обновляет `lastUsedAt`. Действия пишутся в обычные application-логи с `req.user.username = handle` — отличить от человеческого аккаунта можно по флагу `isServiceAccount`. Если потребуется отдельная audit-таблица (`service_account_audit_log`) — отдельной задачей.

### 3.8. Формат токена

`ks_sa_<32 random url-safe base64 chars>`. Префикс `ks_sa_` помогает:
* GitHub secret scanner может распознавать по шаблону (если когда-нибудь утечёт в публичный репо);
* визуально отличается от JWT (`eyJ...`) в логах.

## 4. План задач-наследников

| T | Кому | Задача |
|---|---|---|
| T1 | backend | Prisma migration `agent_service_accounts` (поля по §3.1, индекс по `revokedAt`) |
| T2 | backend | `ServiceAccountGuard` (§3.2) — проверка header, hash-lookup, подстановка `req.user`, async `lastUsedAt` update |
| T3 | backend | `AdminOrServiceGuard` (§3.3) + декоратор `@RequiredScope(scope)`. Утилита `hasScope` с wildcard (`blog:*`) |
| T4 | backend | CLI `create-service-account.cli.ts`: команды `create`, `list`, `revoke`, `rotate`. README с примерами |
| T5 | backend | Применить `AdminOrServiceGuard` + `@RequiredScope` в `BlogAdminController` (ADR-137 rev2). Тесты: header-pass, jwt-pass, scope-fail, revoked-fail |
| T6 | devops | Создать первый service-account `agent-backend` через CLI на проде. Положить plain-токен в AWS Secrets Manager под именем `kingside/agent/backend-service-token`. ENV `KS_SERVICE_TOKEN` в task-def контейнеров агентов (если они в ECS) или через ту же доставку секретов |
| T7 | backend | Документация для агентов: `docs/operations/agent-service-auth.md` — как получить токен, как его передавать, какие scope существуют, что делать при 401/403 |
| T8 (опц.) | backend | Применить `AdminOrServiceGuard` в `LessonsAdmin*Controller` если потребуется (есть кейс или явный запрос) |
| T9 (опц.) | backend | Отдельная таблица `service_account_audit_log` — только если простого `lastUsedAt` + app-логов окажется недостаточно |
| T10 (опц.) | devops | Алерт CloudWatch на 401 ставку с подозрительных IP — bruteforce token guessing. MVP — нет |

## 5. Порядок и точки безопасной остановки

```
T1 → T2 → T3 → T4 (backend)
       ↓
T5 (применение в BlogAdmin)
       ↓
T6 (devops — создание токена на прод)
       ↓
T7 (документация)
```

T8–T10 — опциональны, в любой момент после T7.

**Точки безопасной остановки:**

* После T4 — модуль готов, ни на одном маршруте не висит → текущая авторизация не задета;
* После T5 — `BlogAdminController` принимает оба пути; человек-админ через JWT работает как раньше, агент — может через токен (после T6);
* После T7 — полный сценарий «выпустил → положил в секреты → агент дёрнул curl с `-H X-Service-Account-Token`».

**Откат:**

* До T5 — удалить маршрут регистрации guard'а; `BlogAdminController` остаётся на `JwtAuthGuard+AdminUserGuard`.
* После T5 — удалить применение в контроллере, оставить guard в коде неактивным.
* После T6 — revoke токенов через CLI или UPDATE `revokedAt=now()`.

## 6. Последствия

**Плюсы.**

* Минимум новых движущихся частей — не SSO, не mTLS, не OAuth-сервер.
* Совместимо с человеческой админкой — JWT-маршрут не меняется.
* Revoke без redeploy.
* Scope-based — агент с `blog:write` не сможет удалить юзера.
* Audit через `lastUsedAt` и обычные логи.
* Утечка одного токена не компрометирует остальные.

**Минусы / риски.**

* Plain-токен показывается один раз — если потерян, надо rotate (CLI поддержит).
* Hash в БД — sha256 без соли. Это допустимо для случайных 32-байтных токенов (rainbow-table не работает), но если перейдём на короткие human-readable — нужен argon2.
* Нет отдельного audit-log таблицы. Если регулятор/security потребует — добавим (T9).
* `AdminOrServiceGuard` — композиция двух разнородных гардов. Тесты должны покрыть оба пути и комбинации (header + JWT одновременно — priority service).

## 7. Открытые вопросы

1. **Срок жизни токена** — MVP без expiration (`revokedAt` единственный путь отозвать). Если требуется auto-expire — добавить `expiresAt`. Реально нужно для CI-токенов с коротким сроком жизни (push на merge); для постоянных агентов — не критично.
2. **Rate-limit на токен** — отдельно от `UserRateLimitGuard` (он работает per-userId, что для service-account означает «общий лимит на всех вызовов»). MVP — переиспользуем UserRateLimit; если service-account генерит сильный трафик — отдельный лимит на токен.
3. **Wildcard в scope** — `blog:*` или `*:write`? MVP — только exact match + один уровень wildcard (`blog:*` совпадает с `blog:write`/`blog:read`). Решается в T3.
4. **Health-check без токена** — если агент будет делать `GET /health` через тот же контроллер, надо явный `@Public()` или вынести на отдельный controller. Сейчас `/health` уже отдельно — не задевает.
5. **Frontend админки** — никаких изменений, JWT-путь сохранён. Если в будущем дадим админу UI «управлять service-accounts» — отдельная страница, не блокирует MVP.
