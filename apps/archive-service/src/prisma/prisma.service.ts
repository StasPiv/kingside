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
  const augmented = ensureConnectionLimit(raw, defaultLimit);
  return augmented === raw
    ? undefined // ничего не меняли — оставляем дефолтный путь Prisma
    : { datasourceUrl: augmented };
}

/**
 * Гарантирует наличие `connection_limit` в DATABASE_URL.
 *
 * Логика:
 *   - URL не парсится (битый) → возвращаем как есть, пусть Prisma даст
 *     понятную ошибку при connect.
 *   - параметр уже задан (любым значением, включая `=1`) → не трогаем,
 *     devops знает что делает.
 *   - параметра нет → добавляем `connection_limit=<defaultLimit>`.
 */
export function ensureConnectionLimit(url: string, defaultLimit: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    moduleLogger.warn('ARCHIVE_DATABASE_URL is not a valid URL — leaving as-is');
    return url;
  }
  if (parsed.searchParams.has('connection_limit')) {
    return url;
  }
  parsed.searchParams.set('connection_limit', String(defaultLimit));
  // Prisma также понимает `pool_timeout` — оставляем default (10s).
  return parsed.toString();
}
