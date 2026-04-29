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
 * KS-2134. Дополнительные defaults для DATABASE_URL, лечащие холодный
 * first-hit 5-7 сек и leak `SELECT 1` в `pg_stat_activity` (16+ мин).
 *
 * Корень leak'а — `HealthController.pingWithTimeout()` использует
 * `Promise.race([ping, timeout])`, но pending Prisma-запрос не
 * отменяется при срабатывании 500мс таймаута. В сочетании с RDS
 * default `idle_session_timeout=0` (Postgres сам не выкидывает
 * idle-сессии) и долгим TCP keepalive-default (5 мин + 2×30 с до
 * детекции мёртвого сокета) соединение зависает.
 *
 * Server-side timeouts на kingside-archive-db (snapshot devops):
 *   idle_in_transaction_session_timeout = 24 ч
 *   idle_session_timeout = 0 (без лимита)
 *   tcp_keepalives_idle/interval/count = 300/30/2
 *
 * Параметры:
 *   - `socket_timeout=10` — Prisma сама закроет запрос дольше 10 сек.
 *     Главный фикс leak'а: даже если HealthController отбросит
 *     результат через 500мс race-таймаут, реальное соединение
 *     закроется через 10 сек (вместо 16+ мин на проде).
 *   - `connect_timeout=5` — быстрый фейл при недоступности RDS,
 *     вместо TCP-default ~30 сек.
 *   - `application_name=archive-service` — для diagnostic'ов
 *     `pg_stat_activity` (devops снимок: текущее application_name
 *     пустое, не видно кто держит коннекты).
 *   - TCP keepalive: `keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=3`
 *     — обнаружить мёртвое соединение за ~60 сек вместо TCP-default
 *     2 часа. Если NAT/SG между ECS и RDS режет idle-TCP раньше,
 *     keepalive поднимет это до того, как пользовательский запрос
 *     попадёт на дохлый коннект.
 *
 * Override через env: если параметр уже задан в `ARCHIVE_DATABASE_URL`,
 * НЕ перезаписываем — devops сохраняет контроль через secret.
 */
const DEFAULT_DATABASE_URL_PARAMS: Record<string, string> = {
  socket_timeout: '10',
  connect_timeout: '5',
  application_name: 'archive-service',
  keepalives: '1',
  keepalives_idle: '30',
  keepalives_interval: '10',
  keepalives_count: '3',
};

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
