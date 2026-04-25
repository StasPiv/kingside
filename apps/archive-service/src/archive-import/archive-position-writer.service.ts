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
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  serializePositionRowCsv,
  type PositionRow,
} from './position-row-builder';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';

/**
 * Определяет нужен ли SSL для `pg.Pool` и в каком виде.
 *
 * Политика (secure-by-default, KS-1640 + KS-1893):
 *   1. Явное "нет" (`ARCHIVE_IMPORTER_PG_SSL=0|false|off`, `sslmode=disable`
 *      в URL или `PGSSLMODE=disable`) — SSL выключен. Полезно для диагностики.
 *   2. Явное "да" (`sslmode=...` в URL != disable, `PGSSLMODE=...` != disable,
 *      `ARCHIVE_IMPORTER_PG_SSL=1|true|...`) — SSL включён.
 *   3. Ничего не задано → смотрим хост из URL:
 *      - `localhost` / `127.0.0.1` / `::1` / `host.docker.internal` → SSL off
 *        (локальный docker-compose, dev).
 *      - любой другой (RDS, managed PG, remote) → SSL on.
 *
 * Что именно возвращается для удалённых хостов (KS-1893):
 *   а) Если `ARCHIVE_IMPORTER_PG_SSL_NO_VERIFY=1|true|...` — `{
 *      rejectUnauthorized: false }`. Это hotfix-выключатель: верификация
 *      цепочки полностью отключается. На случай, когда CA bundle
 *      недоступен или сломан, и нужно вернуть импорт за минуты.
 *   б) Иначе пытаемся загрузить AWS RDS CA bundle (полный
 *      `global-bundle.pem`, лежит в `apps/archive-service/certs/`,
 *      собирается в образ через nest-cli `assets`). Если файл найден —
 *      `{ ca, rejectUnauthorized: true }` — настоящая `verify-full`
 *      проверка против AWS-доверенных корней. Путь можно
 *      переопределить через `ARCHIVE_IMPORTER_PG_CA_PATH`.
 *   в) Если файл не найден (например, локальный CLI без билда + кто-то
 *      пытается смотреть на RDS из dev-машины) — fallback на `{
 *      rejectUnauthorized: false }` с warn-логом, чтобы CLI не падал
 *      молча на boot. Production-билд должен иметь файл; если нет —
 *      это deployment-bug, а не runtime.
 *
 * Регрессия KS-1893: `pg-connection-string` 2.12 для `sslmode=require`
 * перестал ставить `rejectUnauthorized: false` и теперь оставляет ssl
 * как `{}`, что в Node TLS = `verify-full` против системного trust store.
 * В системе нет AWS RDS root, отсюда `self-signed certificate in
 * certificate chain`. Простое перезаписывание `ssl` в нашем PoolConfig
 * НЕ помогает: `pg/connection-parameters.js` делает `Object.assign({},
 * config, parse(config.connectionString))` — parse() имеет приоритет.
 * Поэтому `buildPoolConfig` (см. ниже) ещё и **вычищает sslmode и
 * прочие ssl* из URL** перед передачей в Pool — чтобы наш `ssl` не был
 * перезатёрт.
 *
 * Экспортируется для unit-тестов.
 */
export function resolveSslConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
  loadCa: () => Buffer | null = loadRdsCaBundle,
): PoolConfig['ssl'] {
  const urlMode = extractSslMode(connectionString);
  const envMode = (env.PGSSLMODE ?? '').toLowerCase();
  const explicit = (env.ARCHIVE_IMPORTER_PG_SSL ?? '').toLowerCase();

  // Явное "нет" имеет высший приоритет.
  if (explicit === '0' || explicit === 'false' || explicit === 'off') return false;
  if (urlMode === 'disable' || envMode === 'disable') return false;

  // Любой из трёх сигналов включает SSL.
  const sslOn =
    !!urlMode || !!envMode || !!explicit || !isLocalHost(connectionString);
  if (!sslOn) return false;

  // Hotfix-выключатель верификации: для случаев, когда CA bundle сломан/
  // недоступен и надо немедленно вернуть импорт. Devops может выставить
  // через env, не пересобирая образ.
  const noVerify = (env.ARCHIVE_IMPORTER_PG_SSL_NO_VERIFY ?? '').toLowerCase();
  if (noVerify === '1' || noVerify === 'true' || noVerify === 'on') {
    return { rejectUnauthorized: false };
  }

  // sslmode=no-verify в URL — тоже честный no-verify (legacy, KS-1640).
  if (urlMode === 'no-verify' || envMode === 'no-verify') {
    return { rejectUnauthorized: false };
  }

  // Основной путь: CA bundle от AWS RDS, full verify.
  const ca = loadCa();
  if (ca) {
    return { ca, rejectUnauthorized: true };
  }

  // CA не найден — мягкий fallback. Лучше работающий импорт без
  // верификации, чем падение на boot. В лог уйдёт warn (см. ensurePool).
  return { rejectUnauthorized: false };
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
 * true если хост в URL — локальный.
 *
 * Экспортируется для тестов.
 */
export function isLocalHost(connectionString: string): boolean {
  try {
    const stripped = connectionString.replace(/^[a-z]+:\/\//i, '');
    const hostPart = stripped.split(/[/?#]/, 1)[0];
    const afterAuth = hostPart.includes('@')
      ? hostPart.slice(hostPart.lastIndexOf('@') + 1)
      : hostPart;
    const host = afterAuth.startsWith('[')
      ? afterAuth.slice(1, afterAuth.indexOf(']'))
      : afterAuth.split(':', 1)[0];
    return LOCAL_HOSTS.has(host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Удаляет `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, `uselibpqcompat`
 * и подобные ssl-параметры из query string подключения. Это нужно,
 * чтобы `pg-connection-string` не выставил свой `ssl` объект, который
 * `pg/connection-parameters.js` потом мерджит ПОВЕРХ нашего PoolConfig
 * через `Object.assign({}, config, parse(connectionString))` —
 * перезаписывая ssl, который мы только что аккуратно собрали.
 *
 * После этой функции в URL остаются нерелевантные query-параметры
 * (например, `application_name`), а ssl-конфигурация полностью
 * принадлежит `resolveSslConfig`.
 *
 * Экспортируется для unit-тестов.
 */
export function stripSslParamsFromUrl(connectionString: string): string {
  // Поддерживаем и без query, и с пустым query.
  const qIdx = connectionString.indexOf('?');
  if (qIdx < 0) return connectionString;
  const base = connectionString.slice(0, qIdx);
  const query = connectionString.slice(qIdx + 1);
  if (!query) return base;
  const SSL_KEYS = new Set([
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslpassword',
    'sslcrl',
    'uselibpqcompat',
  ]);
  const kept = query
    .split('&')
    .filter((kv) => {
      const eq = kv.indexOf('=');
      const key = (eq < 0 ? kv : kv.slice(0, eq)).toLowerCase();
      return !SSL_KEYS.has(key);
    })
    .join('&');
  return kept ? `${base}?${kept}` : base;
}

let cachedCa: Buffer | null | undefined; // undefined = не загружали ещё; null = пробовали и не нашли

/**
 * Загружает AWS RDS CA bundle из файла. Первый успех кешируется в
 * `cachedCa`, повторные вызовы не читают диск.
 *
 * Порядок lookup'а:
 *   1. `ARCHIVE_IMPORTER_PG_CA_PATH` — явный путь из env (devops).
 *   2. `__dirname/../certs/rds-ca.pem` — production layout (dist рядом
 *      с certs/, скопированными nest-cli `assets`).
 *   3. `__dirname/../../certs/rds-ca.pem` — dev layout (src/archive-import
 *      рядом с certs/).
 *
 * Возвращает `null`, если файл не найден ни по одному пути. Не бросает —
 * вызывающий код решает, fallback'нуть на no-verify или упасть.
 *
 * Экспортируется для тестов; они могут сбросить cache через
 * `resetRdsCaBundleCacheForTests()`.
 */
export function loadRdsCaBundle(): Buffer | null {
  if (cachedCa !== undefined) return cachedCa;

  const candidates: string[] = [];
  const fromEnv = process.env.ARCHIVE_IMPORTER_PG_CA_PATH;
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(resolvePath(__dirname, '..', 'certs', 'rds-ca.pem'));
  candidates.push(resolvePath(__dirname, '..', '..', 'certs', 'rds-ca.pem'));

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        cachedCa = readFileSync(p);
        return cachedCa;
      } catch {
        // следующий кандидат
      }
    }
  }
  cachedCa = null;
  return null;
}

/** Сброс кеша CA — только для тестов. */
export function resetRdsCaBundleCacheForTests(): void {
  cachedCa = undefined;
}

/**
 * Финальный конструктор `PoolConfig` для writer'а. Держит вместе три
 * связанных решения, чтобы они не разъезжались:
 *  - какой ssl-конфиг применять (`resolveSslConfig`);
 *  - какой URL передавать в `pg.Pool` (без ssl-параметров — иначе
 *    `pg-connection-string.parse` затрёт наш ssl);
 *  - константные параметры `application_name`, `max`.
 *
 * Экспортируется для тестов: спека проверяет, что для `sslmode=require`
 * Pool получит `ssl: { ca, rejectUnauthorized: true }` И URL без `sslmode`.
 */
export function buildPoolConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
  loadCa: () => Buffer | null = loadRdsCaBundle,
): PoolConfig {
  return {
    connectionString: stripSslParamsFromUrl(connectionString),
    max: 4,
    application_name: 'archive-importer',
    ssl: resolveSslConfig(connectionString, env, loadCa),
  };
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
    const config = buildPoolConfig(connectionString);

    // Diagnostic-line при старте: без CA на удалённом хосте — это
    // означает деградацию до no-verify, deployment-bug. Логируем,
    // чтобы регрессия не уходила в тишину.
    if (
      typeof config.ssl === 'object' &&
      config.ssl !== null &&
      config.ssl.rejectUnauthorized === false &&
      !isLocalHost(connectionString)
    ) {
      this.logger.warn(
        'pg.Pool created with rejectUnauthorized=false on a remote host. ' +
          'AWS RDS CA bundle was not found (apps/archive-service/certs/rds-ca.pem). ' +
          'Add the bundle to the image or set ARCHIVE_IMPORTER_PG_CA_PATH.',
      );
    }
    this.pool = new Pool(config);
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
