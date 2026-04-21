/**
 * Пакетная запись строк в `archive_game_positions` через COPY FROM STDIN
 * (ADR-014 §5). На ~120k строк путь `createMany` занимает ~15с; COPY —
 * ~1-2с. Для идемпотентности используем staging TEMP TABLE + `INSERT ...
 * ON CONFLICT DO NOTHING`.
 *
 * Writer держит собственный `pg.Pool` (отдельно от Prisma). Воркер один,
 * пул небольшой (max 4). `close()` вызывается на остановке воркера.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  serializePositionRowCsv,
  type PositionRow,
} from './position-row-builder.js';
import { archivePositionRowsCopyDurationSeconds } from './metrics.js';

/**
 * Определяет нужен ли SSL для `pg.Pool`, покрывая три входа:
 *   1. `sslmode=...` в самом connection string (AWS RDS URL и прочий cloud).
 *   2. Env `PGSSLMODE` — совместимо с libpq.
 *   3. Env `ARCHIVE_IMPORTER_PG_SSL` — явный override для этого воркера.
 *
 * На локальном docker-compose ни один из трёх путей не активен → SSL
 * выключен, соединение идёт plain-текстом как раньше (KS-1619 Scenario 2).
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

  // Локальный dev без настроек — без SSL.
  return false;
}

function extractSslMode(connectionString: string): string | null {
  const m = connectionString.toLowerCase().match(/[?&]sslmode=([a-z_-]+)/);
  return m ? m[1] : null;
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

export class ArchivePositionWriter {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 4,
      application_name: 'archive-importer',
      // KS-1619: без этого pg.Pool не включает SSL в облаке (Prisma тянет
      // SSL по дефолту сам, pg — нет), и RDS отбивает запрос на pg_hba.
      ssl: resolveSslConfig(connectionString),
    });
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

    return archivePositionRowsCopyDurationSeconds.time({ source }, async () => {
      const client = await this.pool.connect();
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
    await this.pool.end();
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
