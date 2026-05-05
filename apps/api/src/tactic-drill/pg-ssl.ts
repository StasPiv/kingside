/**
 * KS-2411 — SSL-конфиг для подключения индексера к archive-RDS.
 *
 * Контекст: индексер `tactic-drill` (CLI `scripts/index-tactic-drills`
 * и cron `tactic-drill-incremental.scheduler`) подключается к
 * `ARCHIVE_DATABASE_URL` через `pg.Client`. До KS-2411 в RunTask'ах
 * приходилось ставить `NODE_TLS_REJECT_UNAUTHORIZED=0` — глобальный
 * TLS-bypass, отключающий верификацию ВСЕХ TLS-соединений процесса.
 *
 * Этот helper зеркалит подход `apps/archive-service` (KS-1893):
 *   - URL чистится от ssl* query-параметров (иначе `pg-connection-string`
 *     parse() перезатрёт наш ssl в Object.assign({}, config, parse(url)));
 *   - ssl собирается явно: `{ ca: <bundle>, rejectUnauthorized: true }`
 *     для удалённых хостов, `false` для localhost (dev).
 *
 * AWS RDS global CA bundle лежит в `apps/api/certs/rds-ca.pem`
 * (вшивается Dockerfile'ом). В образе путь — `/app/apps/api/certs/rds-ca.pem`.
 * Также прописан в `NODE_EXTRA_CA_CERTS`, что подстрахует другие TLS-
 * соединения, но pg-pool сам по умолчанию игнорирует системный
 * trust-store и требует явный ca в config.ssl.
 *
 * ENV-переключатели:
 *   - `ARCHIVE_PG_CA_PATH` — переопределить путь к CA bundle (например,
 *     если в task-def подключён сторонний volume).
 *   - `ARCHIVE_PG_NO_VERIFY=1|true|on` — hotfix-bypass: отключить
 *     верификацию (вернёт `{ rejectUnauthorized: false }`). Полезно
 *     для срочного запуска RunTask'а, если CA сломан/недоступен.
 *     Это локальный bypass только для archive-RDS соединения, в
 *     отличие от глобального NODE_TLS_REJECT_UNAUTHORIZED=0.
 */

import type { ClientConfig } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
]);

/** Извлекает host из postgres URL (без пользовательской и query частей). */
export function extractHost(connectionString: string): string {
  try {
    const stripped = connectionString.replace(/^[a-z]+:\/\//i, '');
    const hostPart = stripped.split(/[/?#]/, 1)[0];
    const afterAuth = hostPart.includes('@')
      ? hostPart.slice(hostPart.lastIndexOf('@') + 1)
      : hostPart;
    return afterAuth.startsWith('[')
      ? afterAuth.slice(1, afterAuth.indexOf(']'))
      : afterAuth.split(':', 1)[0];
  } catch {
    return '';
  }
}

export function isLocalHost(connectionString: string): boolean {
  return LOCAL_HOSTS.has(extractHost(connectionString).toLowerCase());
}

/**
 * Удаляет ssl* query-параметры из URL — иначе `pg-connection-string`
 * вернёт собственный ssl-объект, который перезатрёт наш через
 * Object.assign в pg/connection-parameters.js. Аналогично
 * `archive-position-writer.service.ts`.
 */
export function stripSslParamsFromUrl(connectionString: string): string {
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

let cachedCa: Buffer | null | undefined; // undefined = не пробовали; null = не нашли

/**
 * Загружает AWS RDS CA bundle. Кеш — на процесс, переиспользуется
 * между запусками индексера (CLI работает один раз, scheduler
 * вызывает несколько раз).
 *
 * Lookup-порядок:
 *   1. `ARCHIVE_PG_CA_PATH` из env — явный override.
 *   2. `__dirname/../../certs/rds-ca.pem` — production layout
 *      (dist/tactic-drill/pg-ssl.js рядом с certs/, скопированными
 *      Dockerfile'ом в `/app/apps/api/certs/`).
 *   3. `__dirname/../../../certs/rds-ca.pem` — dev layout
 *      (src/tactic-drill/pg-ssl.ts → ../../certs/).
 */
export function loadRdsCaBundle(): Buffer | null {
  if (cachedCa !== undefined) return cachedCa;

  const candidates: string[] = [];
  const fromEnv = process.env.ARCHIVE_PG_CA_PATH;
  if (fromEnv) candidates.push(fromEnv);
  // production: dist/tactic-drill/pg-ssl.js — родитель dist/, дед apps/api,
  // CA лежит в apps/api/certs/. От __dirname: ../../certs/rds-ca.pem.
  candidates.push(resolvePath(__dirname, '..', '..', 'certs', 'rds-ca.pem'));
  // dev: src/tactic-drill/pg-ssl.ts — ../../certs (apps/api/certs).
  candidates.push(
    resolvePath(__dirname, '..', '..', '..', 'certs', 'rds-ca.pem'),
  );

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
 * Финальный конструктор `ClientConfig` для `pg.Client` индексера.
 * Возвращает: cleaned URL + явный ssl config.
 *
 * Логика ssl:
 *   - localhost / dev → ssl=false.
 *   - удалённый + ARCHIVE_PG_NO_VERIFY → `{ rejectUnauthorized: false }`
 *     (локальный hotfix bypass для одного соединения).
 *   - удалённый + CA найден → `{ ca, rejectUnauthorized: true }` (verify-full).
 *   - удалённый + CA не найден → `{ rejectUnauthorized: false }` с прикладом
 *     warn-callback'а (если передан) — fallback, чтобы CLI не падал
 *     на boot. Production-билд должен иметь CA.
 */
export function buildArchivePgClientConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
  loadCa: () => Buffer | null = loadRdsCaBundle,
  onMissingCa?: (msg: string) => void,
): ClientConfig {
  const cleaned = stripSslParamsFromUrl(connectionString);
  let ssl: ClientConfig['ssl'] = false;

  if (!isLocalHost(connectionString)) {
    const noVerify = (env.ARCHIVE_PG_NO_VERIFY ?? '').toLowerCase();
    if (noVerify === '1' || noVerify === 'true' || noVerify === 'on') {
      ssl = { rejectUnauthorized: false };
    } else {
      const ca = loadCa();
      if (ca) {
        ssl = { ca, rejectUnauthorized: true };
      } else {
        ssl = { rejectUnauthorized: false };
        if (onMissingCa) {
          onMissingCa(
            'archive-RDS CA bundle not found (apps/api/certs/rds-ca.pem). ' +
              'Falling back to no-verify SSL. Add the bundle to the image ' +
              'or set ARCHIVE_PG_CA_PATH.',
          );
        }
      }
    }
  }

  return {
    connectionString: cleaned,
    ssl,
  };
}
