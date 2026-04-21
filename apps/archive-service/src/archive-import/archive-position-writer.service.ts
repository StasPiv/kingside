/**
 * Пакетная запись строк в `archive_game_positions` через COPY FROM STDIN
 * (ADR-014 §5). На ~120k строк путь `createMany` занимает ~15с; COPY —
 * ~1-2с. Для идемпотентности используем staging TEMP TABLE + `INSERT ...
 * ON CONFLICT DO NOTHING`.
 *
 * Writer держит собственный `pg.Pool` (отдельно от Prisma). Воркер один,
 * пул небольшой (max 4). `close()` вызывается на остановке воркера.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  serializePositionRowCsv,
  type PositionRow,
} from './position-row-builder';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';

/**
 * Определяет нужен ли SSL для `pg.Pool`.
 *
 * Политика (secure-by-default, KS-1640):
 *   1. Явное "нет" (`ARCHIVE_IMPORTER_PG_SSL=0|false|off`, `sslmode=disable`
 *      в URL или `PGSSLMODE=disable`) — SSL выключен, даже если хост не
 *      local. Полезно для диагностики.
 *   2. Явное "да" (`sslmode=...` в URL != disable, `PGSSLMODE=...` != disable,
 *      `ARCHIVE_IMPORTER_PG_SSL=1|true|...`) — SSL включён.
 *   3. Ничего не задано → смотрим хост из URL:
 *      - `localhost` / `127.0.0.1` / `::1` / `host.docker.internal` → SSL off
 *        (локальный docker-compose, dev).
 *      - любой другой (RDS, managed PG, remote) → SSL on с
 *        `{ rejectUnauthorized: false }`.
 *
 * Раньше (до KS-1640) по умолчанию SSL было off — и на RDS без явного
 * `sslmode=require` в ARCHIVE_DATABASE_URL прод валился с `no pg_hba.conf entry`,
 * что замалчивалось silent-fail'ом в backfill.ts (тоже фикс этой задачи).
 *
 * `rejectUnauthorized: false` — RDS presents a CA-bundle, которого нет
 * в системных корнях Node runtime'а; так же ведёт себя `sslmode=require`
 * у libpq. Если понадобится строгая проверка — добавить путь к CA через
 * отдельный env (ADR-013 §10.D) — отложено до прод-сертификат-стори.
 *
 * Экспортируется для unit-тестов.
 */
export function resolveSslConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig['ssl'] {
  const urlMode = extractSslMode(connectionString);
  const envMode = (env.PGSSLMODE ?? '').toLowerCase();
  const explicit = (env.ARCHIVE_IMPORTER_PG_SSL ?? '').toLowerCase();

  // Явное "нет" имеет высший приоритет.
  if (explicit === '0' || explicit === 'false' || explicit === 'off') return false;
  if (urlMode === 'disable' || envMode === 'disable') return false;

  // Любой из трёх сигналов включает SSL.
  if (urlMode) return { rejectUnauthorized: false };
  if (envMode) return { rejectUnauthorized: false };
  if (explicit) return { rejectUnauthorized: false };

  // Ничего не задано → смотрим хост. Удалённый хост (RDS, managed PG) —
  // SSL on; локальный dev — off. Fallback при нераспознанном URL — off
  // (сохраняет старое поведение, не ломает случайные кейсы без хоста).
  return isLocalHost(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

function extractSslMode(connectionString: string): string | null {
  const m = connectionString.toLowerCase().match(/[?&]sslmode=([a-z_-]+)/);
  return m ? m[1] : null;
}

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
]);

/**
 * true если хост в URL — локальный. Используется как fallback для secure-
 * by-default SSL: если ARCHIVE_DATABASE_URL без `sslmode`, но указывает на RDS/
 * managed-PG, SSL всё равно включится. Плюс явный `sslmode=disable`
 * остаётся уважаемым override'ом для диагностики.
 *
 * Экспортируется для тестов.
 */
export function isLocalHost(connectionString: string): boolean {
  try {
    // URL не понимает `postgresql://` без ощутимого хоста в Node < 16 —
    // вырезаем host вручную: `scheme://[user[:pass]@]host[:port][/...]`.
    const stripped = connectionString.replace(/^[a-z]+:\/\//i, '');
    const hostPart = stripped.split(/[/?#]/, 1)[0];
    const afterAuth = hostPart.includes('@')
      ? hostPart.slice(hostPart.lastIndexOf('@') + 1)
      : hostPart;
    // IPv6 в URL: `[::1]:5432` — вырезаем скобки.
    const host = afterAuth.startsWith('[')
      ? afterAuth.slice(1, afterAuth.indexOf(']'))
      : afterAuth.split(':', 1)[0];
    return LOCAL_HOSTS.has(host.toLowerCase());
  } catch {
    return false;
  }
}

/** Имя временной staging-таблицы. Уникально на соединение — изолировано. */
const STAGE_TABLE = '_agp_stage';

/**
 * DDL staging-таблицы: структура идентична `archive_game_positions`, но без
 * PK/индексов — её наполняют COPY'ем, затем переливают INSERT'ом.
 */
const STAGE_DDL = `CREATE TEMP TABLE ${STAGE_TABLE} (
  position_key BYTEA NOT NULL,
  bucket TEXT NOT NULL,
  game_id UUID NOT NULL,
  ply SMALLINT NOT NULL,
  move_uci TEXT,
  side_to_move CHAR(1) NOT NULL,
  played_at TIMESTAMP(3),
  avg_elo SMALLINT,
  result CHAR(1)
) ON COMMIT DROP`;

const COPY_STMT = `COPY ${STAGE_TABLE} (
  position_key, bucket, game_id, ply, move_uci,
  side_to_move, played_at, avg_elo, result
) FROM STDIN WITH (FORMAT CSV, NULL '')`;

const INSERT_STMT = `INSERT INTO archive_game_positions (
  position_key, bucket, game_id, ply, move_uci,
  side_to_move, played_at, avg_elo, result
) SELECT
  position_key, bucket, game_id, ply, move_uci,
  side_to_move, played_at, avg_elo, result
FROM ${STAGE_TABLE}
ON CONFLICT (position_key, bucket, game_id) DO NOTHING`;

/**
 * `@Injectable()` — singleton. Pool создаётся лениво при первом `write()`,
 * чтобы не падать на boot в окружениях, где `ARCHIVE_DATABASE_URL` ещё не
 * установлен (unit-тесты, CLI smoke).
 *
 * `onModuleDestroy` закрывает pool при shutdown ImporterModule.
 */
@Injectable()
export class ArchivePositionWriterService implements OnModuleDestroy {
  private readonly logger = new Logger(ArchivePositionWriterService.name);
  private pool: Pool | null = null;

  constructor(private readonly metrics: ArchiveImportMetricsService) {}

  private ensurePool(): Pool {
    if (this.pool) return this.pool;
    const connectionString = process.env.ARCHIVE_DATABASE_URL ?? '';
    if (!connectionString) {
      throw new Error('ARCHIVE_DATABASE_URL is not set');
    }
    this.pool = new Pool({
      connectionString,
      max: 4,
      application_name: 'archive-importer',
      // KS-1619: без этого pg.Pool не включает SSL в облаке (Prisma тянет
      // SSL по дефолту сам, pg — нет), и RDS отбивает запрос на pg_hba.
      ssl: resolveSslConfig(connectionString),
    });
    return this.pool;
  }

  /**
   * Записывает `rows` через COPY в TEMP staging → `INSERT ... ON CONFLICT
   * DO NOTHING`. Пустой массив — no-op. Измеряется гистограмма
   * `archive_importer_position_rows_copy_duration_seconds`.
   *
   * Возвращает количество реально вставленных строк (rowCount от INSERT).
   * В extend-mode backfill это значение != rows.length: часть строк попадает
   * в ON CONFLICT DO NOTHING и не вставляется. Нужно для прогресс-лога и
   * sanity-check (KS-1633).
   */
  async write(rows: PositionRow[], source = 'unknown'): Promise<number> {
    if (rows.length === 0) return 0;

    return this.metrics.timePositionRowsCopy(source, async () => {
      const pool = this.ensurePool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(STAGE_DDL);
        await this.copyRows(client, rows);
        const result = await client.query(INSERT_STMT);
        await client.query('COMMIT');
        return result.rowCount ?? 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  private async copyRows(client: PoolClient, rows: PositionRow[]): Promise<void> {
    const stream = client.query(copyFrom(COPY_STMT));
    const source = Readable.from(chunksFromRows(rows));
    await pipeline(source, stream);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close().catch((err) => {
      this.logger.warn(`pool end failed: ${(err as Error).message}`);
    });
  }
}

/**
 * Генератор чанков для Readable.from. Выдаём по несколько строк в одном
 * chunk'е, чтобы не создавать миллионы Buffer'ов на больших батчах.
 */
function* chunksFromRows(rows: PositionRow[]): Generator<string> {
  const CHUNK = 256;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, rows.length);
    let buf = '';
    for (let j = i; j < end; j++) {
      buf += serializePositionRowCsv(rows[j]);
    }
    yield buf;
  }
}
