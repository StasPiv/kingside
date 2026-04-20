/**
 * Пакетная запись строк в `archive_game_positions` через COPY FROM STDIN
 * (ADR-014 §5). На ~120k строк путь `createMany` занимает ~15с; COPY —
 * ~1-2с. Для идемпотентности используем staging TEMP TABLE + `INSERT ...
 * ON CONFLICT DO NOTHING`.
 *
 * Writer держит собственный `pg.Pool` (отдельно от Prisma). Воркер один,
 * пул небольшой (max 4). `close()` вызывается на остановке воркера.
 */

import { Pool, type PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  serializePositionRowCsv,
  type PositionRow,
} from './position-row-builder.js';
import { archivePositionRowsCopyDurationSeconds } from './metrics.js';

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
    });
  }

  /**
   * Записывает `rows` через COPY в TEMP staging → `INSERT ... ON CONFLICT
   * DO NOTHING`. Пустой массив — no-op. Измеряется гистограмма
   * `archive_importer_position_rows_copy_duration_seconds`.
   */
  async write(rows: PositionRow[], source = 'unknown'): Promise<void> {
    if (rows.length === 0) return;

    await archivePositionRowsCopyDurationSeconds.time({ source }, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(STAGE_DDL);
        await this.copyRows(client, rows);
        await client.query(INSERT_STMT);
        await client.query('COMMIT');
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
