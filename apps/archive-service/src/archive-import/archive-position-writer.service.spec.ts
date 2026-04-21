import {
  isLocalHost,
  resolveSslConfig,
} from './archive-position-writer.service';

const LOCAL_URL = 'postgresql://kingside:kingside@localhost:5432/kingside';
const LOCAL_IP_URL = 'postgresql://kingside:kingside@127.0.0.1:5432/kingside';
const LOCAL_IPV6_URL = 'postgresql://kingside:kingside@[::1]:5432/kingside';
const DOCKER_URL = 'postgresql://kingside:kingside@host.docker.internal:5432/kingside';
const RDS_BARE = 'postgresql://u:p@kingside-db.cluster-abc.us-east-1.rds.amazonaws.com:5432/kingside';
const RDS_REQUIRE = 'postgresql://u:p@rds.example.com:5432/kingside?sslmode=require';
const RDS_NO_VERIFY = 'postgresql://u:p@rds.example.com:5432/kingside?sslmode=no-verify';
const DISABLE_URL = 'postgresql://u:p@rds.example.com/db?sslmode=disable';
const LOCAL_DISABLE_URL = 'postgresql://u:p@localhost/db?sslmode=disable';

describe('resolveSslConfig', () => {
  it('local docker-compose URL без env → SSL выкл', () => {
    expect(resolveSslConfig(LOCAL_URL, {})).toBe(false);
  });

  it('URL с sslmode=require → SSL с rejectUnauthorized:false', () => {
    expect(resolveSslConfig(RDS_REQUIRE, {})).toEqual({ rejectUnauthorized: false });
  });

  it('URL с sslmode=no-verify → SSL с rejectUnauthorized:false', () => {
    expect(resolveSslConfig(RDS_NO_VERIFY, {})).toEqual({ rejectUnauthorized: false });
  });

  it('URL с sslmode=disable → SSL выкл (даже для remote хоста)', () => {
    expect(resolveSslConfig(DISABLE_URL, {})).toBe(false);
  });

  it('env PGSSLMODE=require на локальном URL → SSL вкл', () => {
    expect(resolveSslConfig(LOCAL_URL, { PGSSLMODE: 'require' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('env PGSSLMODE=no-verify (KS-1618 workaround) → SSL вкл', () => {
    expect(resolveSslConfig(LOCAL_URL, { PGSSLMODE: 'no-verify' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('env PGSSLMODE=disable → SSL выкл', () => {
    expect(resolveSslConfig(RDS_REQUIRE, { PGSSLMODE: 'disable' })).toBe(false);
  });

  it('ARCHIVE_IMPORTER_PG_SSL=1 на локальном URL → SSL вкл', () => {
    expect(resolveSslConfig(LOCAL_URL, { ARCHIVE_IMPORTER_PG_SSL: '1' })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('ARCHIVE_IMPORTER_PG_SSL=0 override даже при sslmode=require → SSL выкл', () => {
    expect(
      resolveSslConfig(RDS_REQUIRE, { ARCHIVE_IMPORTER_PG_SSL: '0' }),
    ).toBe(false);
  });

  it('ARCHIVE_IMPORTER_PG_SSL=false override → SSL выкл', () => {
    expect(
      resolveSslConfig(RDS_REQUIRE, { ARCHIVE_IMPORTER_PG_SSL: 'false' }),
    ).toBe(false);
  });

  it('URL без sslmode и пустые env для localhost → SSL выкл (сохраняет dev-поведение)', () => {
    expect(
      resolveSslConfig(LOCAL_URL, {
        PGSSLMODE: '',
        ARCHIVE_IMPORTER_PG_SSL: '',
      }),
    ).toBe(false);
  });

  // KS-1640: secure-by-default для удалённых хостов.

  it('RDS URL без sslmode → SSL вкл (secure-by-default, KS-1640)', () => {
    expect(resolveSslConfig(RDS_BARE, {})).toEqual({ rejectUnauthorized: false });
  });

  it('127.0.0.1 без sslmode → SSL выкл', () => {
    expect(resolveSslConfig(LOCAL_IP_URL, {})).toBe(false);
  });

  it('[::1] (IPv6 localhost) без sslmode → SSL выкл', () => {
    expect(resolveSslConfig(LOCAL_IPV6_URL, {})).toBe(false);
  });

  it('host.docker.internal без sslmode → SSL выкл', () => {
    expect(resolveSslConfig(DOCKER_URL, {})).toBe(false);
  });

  it('localhost + sslmode=disable → SSL выкл (явный override уважаем)', () => {
    expect(resolveSslConfig(LOCAL_DISABLE_URL, {})).toBe(false);
  });

  it('RDS + ARCHIVE_IMPORTER_PG_SSL=0 → SSL выкл (явный override bypass-ит default)', () => {
    expect(
      resolveSslConfig(RDS_BARE, { ARCHIVE_IMPORTER_PG_SSL: '0' }),
    ).toBe(false);
  });
});

describe('isLocalHost', () => {
  it.each([
    ['postgresql://localhost:5432/db', true],
    ['postgresql://kingside:pwd@localhost:5432/db', true],
    ['postgresql://kingside:pwd@127.0.0.1/db', true],
    ['postgresql://kingside:pwd@[::1]:5432/db', true],
    ['postgresql://kingside:pwd@host.docker.internal/db', true],
    ['postgresql://u:p@db.rds.amazonaws.com:5432/db', false],
    ['postgresql://u:p@internal-pg.kingside.local:5432/db', false],
    ['postgresql://u:p@10.0.0.5:5432/db', false],
  ])('isLocalHost(%s) = %s', (url, expected) => {
    expect(isLocalHost(url as string)).toBe(expected);
  });
});
