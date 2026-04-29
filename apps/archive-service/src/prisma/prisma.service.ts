import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@kingside/archive-db';

const moduleLogger = new Logger('PrismaService');

/**
 * Дефолт `connection_limit` для пользовательского пула Prisma в
 * archive-service (KS-2119).
 *
 * Контекст инцидента: prod держал `connection_limit=3`, prewarm
 * (`ArchiveService.prewarmTopPositions` + `prewarmRecentGames`) занимал
 * почти все 3 connection — пользовательские `/tree`, `/games`, health
 * timing'ились с `Timed out fetching a new connection from the
 * connection pool` → CF 526. RDS свободен (CPU 7-10%, активно ~3 conn,
 * лимит RDS — десятки), упор именно в client-side limit.
 *
 * 20 — компромисс: достаточно, чтобы prewarm + ~10 параллельных
 * пользовательских запросов одновременно не клинили друг друга, и
 * сильно ниже t3.micro RDS `max_connections` (по умолчанию ≥80).
 *
 * Override через env: если `ARCHIVE_DATABASE_URL` уже содержит
 * `?connection_limit=N` или `&connection_limit=N`, мы НЕ перезаписываем —
 * deвops сохраняет полный контроль через secret. Если параметра нет —
 * подставляем дефолт.
 */
const DEFAULT_CONNECTION_LIMIT = 20;

/**
 * KS-2134. Дополнительные defaults для DATABASE_URL.
 *
 * Фаза 1 (коммит e58cdbf1): `socket_timeout`, TCP keepalive — на проде
 * НЕ помогли. Devops снимок:
 *   - холодный first-hit `/games` 5.88 сек (без улучшения);
 *   - висящие SELECT 1 от archive-service остались (3+ мин);
 *   - WARN `db ping timeout` участился — 6 событий за 5 мин;
 *   - сработал только `application_name=archive-service`.
 * Гипотеза devops: TCP keepalive не пробрасывается через NAT/SG между
 * ECS и RDS; client-side `socket_timeout` не отменяет idle session
 * на сервере.
 *
 * Фаза 2: переключаемся на server-side timeouts через Postgres
 * `options=-c parameter=value` query parameter (libpq стандарт).
 * Параметры применяются к session при connect и НЕ зависят от
 * Prisma client implementation.
 *
 * Параметры (фаза 2):
 *   - `options=-c idle_session_timeout=1800000 -c statement_timeout=60000`
 *     — Postgres закроет idle сессии через 30 мин и убьёт запросы дольше
 *     60 сек.
 *
 *     **KS-2138 hotfix.** Изначально стояло `idle_session_timeout=60000`
 *     (60 сек), но devops локализовал что это сжимает пул до 1 коннекта
 *     при простое >60 сек: warmup-коннекты сами закрываются, и любой
 *     запрос пользователя форсирует Prisma открыть новое соединение
 *     Fargate→RDS через NAT (5-7 сек). Параллельные запросы (count +
 *     list) выстраиваются в очередь до 20 сек.
 *
 *     30 мин компромисс: leak-страховка через `.catch()` в HealthController
 *     + pool=20 + 30 мин самоистечение делают leak самозалечивающимся
 *     (через 30 мин leak-сессия закроется, новых не доливается).
 *
 *     После KS-2137 (RDS Proxy) сможем убрать idle_session_timeout совсем —
 *     Proxy сам держит warm pool на AWS-side.
 *
 *     `statement_timeout=60000` оставлен — лимитирует тяжёлые запросы
 *     (защита от runaway query), не идёт по idle-таймеру.
 *
 *   - `connect_timeout=5` — быстрый фейл при недоступности RDS.
 *   - `application_name=archive-service` — для diagnostic'ов
 *     `pg_stat_activity`.
 *
 * Параметры из фазы 1 (`socket_timeout`, TCP keepalive) — убраны как
 * нерабочие в текущей сетевой топологии.
 *
 * Лечение холодного first-hit — комбинация из `OnModuleInit` warm-up
 * (см. `PrismaService.onModuleInit`) + длинный `idle_session_timeout`,
 * чтобы warmup-коннекты не закрывались сервером раньше первого
 * пользовательского запроса.
 *
 * Override через env: если параметр уже задан в `ARCHIVE_DATABASE_URL`,
 * НЕ перезаписываем — devops сохраняет контроль через secret.
 */
const DEFAULT_DATABASE_URL_PARAMS: Record<string, string> = {
  connect_timeout: '5',
  application_name: 'archive-service',
  options: '-c idle_session_timeout=1800000 -c statement_timeout=60000',
};

/**
 * KS-2134 фаза 2. При старте `PrismaService` открываем N коннектов
 * параллельно через `SELECT 1`. Это лечит холодный first-hit 5-7 сек на
 * `/games` после fresh deploy: Prisma lazy pool init создаёт коннекты
 * только при первом запросе, а первый коннект к RDS из ECS-Fargate +
 * NAT может занимать ~5 сек (TCP handshake + TLS).
 *
 * 5 коннектов — половина типичного `connection_limit=20`. Этого хватит
 * чтобы первые ~5 параллельных `/games` запросов сразу попали на готовые
 * коннекты, остальные подождут <100 мс пока пул допарсит.
 */
const WARMUP_CONNECTIONS = 5;

/**
 * Prisma-клиент для archive-service. Использует пакет `@kingside/archive-db`
 * и переменную `ARCHIVE_DATABASE_URL` (см. schema `packages/archive-db`).
 *
 * KS-2119: при инициализации augment'ит URL дефолтным `connection_limit`,
 * если он не задан явно. Это защищает от регрессии «забытый параметр
 * в secret → пул 1 connection (default Prisma) → все 500».
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super(buildPrismaOptions(DEFAULT_CONNECTION_LIMIT));
  }

  async onModuleInit() {
    await this.$connect();
    // KS-2134 фаза 2: warm-up пула параллельными SELECT 1, чтобы первый
    // пользовательский запрос не платил TCP handshake + TLS (~5 сек на
    // ECS-Fargate → RDS через NAT).
    await this.warmupPool(WARMUP_CONNECTIONS);
  }

  /**
   * KS-2134 фаза 2. Прогрев пула: N параллельных `SELECT 1`. Каждый
   * запрос берёт свободный коннект из пула, что заставляет Prisma
   * создать новый (если пул пуст) или переиспользовать существующий.
   * После Promise.all'а в пуле гарантированно ≥ N открытых коннектов.
   *
   * Ошибки логируем, но НЕ кидаем — health check всё равно покажет
   * degraded если RDS недоступен, и фаталить старт сервиса из-за
   * прогрева избыточно.
   */
  private async warmupPool(n: number): Promise<void> {
    try {
      await Promise.all(
        Array.from({ length: n }, () =>
          this.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok'),
        ),
      );
      moduleLogger.log(`prisma pool warmed up: ${n} connections`);
    } catch (err) {
      moduleLogger.warn(
        `prisma pool warmup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/**
 * Возвращает PrismaClient options с возможной заменой DATABASE_URL на
 * augmented-версию. Если env-переменной нет — отдаёт `undefined`
 * (Prisma сам прочитает env как обычно и упадёт с понятной ошибкой,
 * не молча).
 */
function buildPrismaOptions(
  defaultLimit: number,
): { datasourceUrl: string } | undefined {
  const raw = process.env.ARCHIVE_DATABASE_URL;
  if (!raw) return undefined;
  const augmented = augmentArchiveDatabaseUrl(raw, defaultLimit);
  return augmented === raw
    ? undefined // ничего не меняли — оставляем дефолтный путь Prisma
    : { datasourceUrl: augmented };
}

/**
 * Гарантирует наличие `connection_limit` и набора timeout/keepalive
 * параметров в DATABASE_URL (см. `DEFAULT_DATABASE_URL_PARAMS`).
 *
 * Логика для каждого параметра:
 *   - URL не парсится (битый) → возвращаем как есть, пусть Prisma даст
 *     понятную ошибку при connect.
 *   - параметр уже задан (любым значением, включая `=1`) → не трогаем,
 *     devops знает что делает.
 *   - параметра нет → подставляем default.
 *
 * KS-2119: добавлен `connection_limit` (default 20).
 * KS-2134: добавлены `socket_timeout`, `connect_timeout`,
 *   `application_name`, `keepalives*` — лечат leak `SELECT 1` в
 *   `pg_stat_activity` и холодный first-hit 5-7 сек.
 */
export function augmentArchiveDatabaseUrl(url: string, defaultLimit: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    moduleLogger.warn('ARCHIVE_DATABASE_URL is not a valid URL — leaving as-is');
    return url;
  }

  let changed = false;
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', String(defaultLimit));
    changed = true;
  }
  for (const [name, value] of Object.entries(DEFAULT_DATABASE_URL_PARAMS)) {
    if (!parsed.searchParams.has(name)) {
      parsed.searchParams.set(name, value);
      changed = true;
    }
  }

  // Prisma также понимает `pool_timeout` — оставляем default (10s).
  return changed ? parsed.toString() : url;
}

/** @deprecated KS-2134: использует `augmentArchiveDatabaseUrl`. Оставлен ради
 * back-compat имени, экспортированного из модуля. Удалить после миграции
 * всех вызовов. */
export function ensureConnectionLimit(url: string, defaultLimit: number): string {
  return augmentArchiveDatabaseUrl(url, defaultLimit);
}
