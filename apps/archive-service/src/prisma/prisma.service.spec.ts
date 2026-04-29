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

describe('augmentArchiveDatabaseUrl (KS-2119 / KS-2134)', () => {
  it('добавляет все KS-2134 defaults к чистому URL', () => {
    const result = augmentArchiveDatabaseUrl(BASE_URL, 20);
    const params = paramsOf(result);
    expect(params.get('connection_limit')).toBe('20');
    expect(params.get('socket_timeout')).toBe('10');
    expect(params.get('connect_timeout')).toBe('5');
    expect(params.get('application_name')).toBe('archive-service');
    expect(params.get('keepalives')).toBe('1');
    expect(params.get('keepalives_idle')).toBe('30');
    expect(params.get('keepalives_interval')).toBe('10');
    expect(params.get('keepalives_count')).toBe('3');
  });

  it('не перезаписывает явно заданный connection_limit', () => {
    const url = `${BASE_URL}?connection_limit=5`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('connection_limit')).toBe('5');
    // Остальные KS-2134 defaults всё равно подставлены.
    expect(params.get('socket_timeout')).toBe('10');
  });

  it('не перезаписывает явно заданный socket_timeout', () => {
    const url = `${BASE_URL}?socket_timeout=30`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('socket_timeout')).toBe('30');
    expect(params.get('connection_limit')).toBe('20');
  });

  it('не перезаписывает явно заданный application_name (полезно для отдельных воркеров)', () => {
    const url = `${BASE_URL}?application_name=archive-importer-daily`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('application_name')).toBe('archive-importer-daily');
  });

  it('не перезаписывает keepalives* если уже заданы', () => {
    const url = `${BASE_URL}?keepalives=0&keepalives_idle=60`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('keepalives')).toBe('0');
    expect(params.get('keepalives_idle')).toBe('60');
    // не заданные — добавлены
    expect(params.get('keepalives_interval')).toBe('10');
    expect(params.get('keepalives_count')).toBe('3');
  });

  it('возвращает URL как есть, если он уже содержит все defaults (нет изменений)', () => {
    const fullUrl =
      `${BASE_URL}?connection_limit=20` +
      `&socket_timeout=10&connect_timeout=5&application_name=archive-service` +
      `&keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=3`;
    expect(augmentArchiveDatabaseUrl(fullUrl, 20)).toBe(fullUrl);
  });

  it('возвращает битый URL без изменений (Prisma даст понятную ошибку при connect)', () => {
    const broken = 'not://a-valid::url';
    expect(augmentArchiveDatabaseUrl(broken, 20)).toBe(broken);
  });

  it('сохраняет существующие query-параметры в URL', () => {
    const url = `${BASE_URL}?schema=public&pgbouncer=true`;
    const params = paramsOf(augmentArchiveDatabaseUrl(url, 20));
    expect(params.get('schema')).toBe('public');
    expect(params.get('pgbouncer')).toBe('true');
    expect(params.get('connection_limit')).toBe('20');
    expect(params.get('socket_timeout')).toBe('10');
  });
});

describe('ensureConnectionLimit (deprecated alias)', () => {
  it('делегирует в augmentArchiveDatabaseUrl — back-compat для прежнего имени', () => {
    expect(ensureConnectionLimit(BASE_URL, 20)).toBe(
      augmentArchiveDatabaseUrl(BASE_URL, 20),
    );
  });
});
