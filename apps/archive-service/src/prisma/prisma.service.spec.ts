/**
 * KS-2119 / KS-2134. Юнит-тесты на augmentArchiveDatabaseUrl —
 * augmentation DATABASE_URL дефолтами для пула + timeout/keepalive.
 *
 * Логика:
 *   - Если параметр уже задан (любым значением) — НЕ перезаписываем,
 *     devops контролирует через secret.
 *   - Если параметра нет — подставляем default.
 *   - Битый URL → возвращаем как есть (Prisma отвалится с понятной ошибкой).
 */

import { augmentArchiveDatabaseUrl, ensureConnectionLimit } from './prisma.service';

const BASE_URL = 'postgresql://user:pass@host:5432/archive';

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('augmentArchiveDatabaseUrl (KS-2119 / KS-2134 / KS-2138)', () => {
  it('добавляет все defaults к чистому URL', () => {
    const result = augmentArchiveDatabaseUrl(BASE_URL, 20);
    const params = paramsOf(result);
    expect(params.get('connection_limit')).toBe('20');
    expect(params.get('connect_timeout')).toBe('5');
    expect(params.get('application_name')).toBe('archive-service');
    // server-side timeouts через libpq options
    expect(params.get('options')).toBe(
      '-c idle_session_timeout=1800000 -c statement_timeout=60000',
    );
    // KS-2138: отключаем PS cache Prisma engine
    expect(params.get('pgbouncer')).toBe('true');
  });

  it('не перезаписывает явно заданный connection_limit', () => {
    const url = `${BASE_URL}?connection_limit=5`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('connection_limit')).toBe('5');
    expect(params.get('options')).toContain('idle_session_timeout');
  });

  it('не перезаписывает явно заданный options (если devops уже выставил свой)', () => {
    const url = `${BASE_URL}?options=-c%20statement_timeout%3D30000`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('options')).toBe('-c statement_timeout=30000');
    expect(params.get('connection_limit')).toBe('20');
  });

  it('не перезаписывает явно заданный application_name (полезно для отдельных воркеров)', () => {
    const url = `${BASE_URL}?application_name=archive-importer-daily`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('application_name')).toBe('archive-importer-daily');
  });

  it('возвращает URL как есть, если он уже содержит все defaults (нет изменений)', () => {
    const fullUrl =
      `${BASE_URL}?connection_limit=20` +
      `&connect_timeout=5&application_name=archive-service` +
      `&options=${encodeURIComponent('-c idle_session_timeout=1800000 -c statement_timeout=60000')}` +
      `&pgbouncer=true`;
    expect(augmentArchiveDatabaseUrl(fullUrl, 20)).toBe(fullUrl);
  });

  it('не перезаписывает явно заданный pgbouncer (devops может выключить)', () => {
    const url = `${BASE_URL}?pgbouncer=false`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('pgbouncer')).toBe('false');
  });

  it('возвращает битый URL без изменений (Prisma даст понятную ошибку при connect)', () => {
    const broken = 'not://a-valid::url';
    expect(augmentArchiveDatabaseUrl(broken, 20)).toBe(broken);
  });

  it('сохраняет существующие query-параметры в URL', () => {
    const url = `${BASE_URL}?schema=public&sslmode=require`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('schema')).toBe('public');
    expect(params.get('sslmode')).toBe('require');
    expect(params.get('connection_limit')).toBe('20');
    expect(params.get('options')).toContain('idle_session_timeout');
    expect(params.get('pgbouncer')).toBe('true');
  });
});

describe('ensureConnectionLimit (deprecated alias)', () => {
  it('делегирует в augmentArchiveDatabaseUrl — back-compat для прежнего имени', () => {
    expect(ensureConnectionLimit(BASE_URL, 20)).toBe(
      augmentArchiveDatabaseUrl(BASE_URL, 20),
    );
  });
});
