import { describe, expect, it } from 'vitest';
import { resolveSslConfig } from './archive-position-writer.js';

const LOCAL_URL = 'postgresql://kingside:kingside@localhost:5432/kingside';
const RDS_REQUIRE = 'postgresql://u:p@rds.example.com:5432/kingside?sslmode=require';
const RDS_NO_VERIFY = 'postgresql://u:p@rds.example.com:5432/kingside?sslmode=no-verify';
const DISABLE_URL = 'postgresql://u:p@host/db?sslmode=disable';

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

  it('URL с sslmode=disable → SSL выкл', () => {
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

  it('URL без sslmode и пустые env → SSL выкл (сохраняет dev-поведение)', () => {
    expect(
      resolveSslConfig(LOCAL_URL, {
        PGSSLMODE: '',
        ARCHIVE_IMPORTER_PG_SSL: '',
      }),
    ).toBe(false);
  });
});
