/**
 * KS-2411 — тесты helper'а ssl-конфига для archive-RDS.
 */

import {
  buildArchivePgClientConfig,
  extractHost,
  isLocalHost,
  resetRdsCaBundleCacheForTests,
  stripSslParamsFromUrl,
} from './pg-ssl';

describe('extractHost / isLocalHost', () => {
  it('parses host from postgres URL', () => {
    expect(extractHost('postgres://u:p@db.example.com:5432/x')).toBe(
      'db.example.com',
    );
    expect(extractHost('postgresql://localhost/x')).toBe('localhost');
    expect(extractHost('postgresql://u@127.0.0.1:5432/x')).toBe('127.0.0.1');
  });

  it('detects local hosts', () => {
    expect(isLocalHost('postgres://u@localhost:5432/x')).toBe(true);
    expect(isLocalHost('postgres://u@127.0.0.1/x')).toBe(true);
    expect(isLocalHost('postgres://u@host.docker.internal/x')).toBe(true);
    expect(isLocalHost('postgres://u@kingside-archive.rds.aws/x')).toBe(false);
  });
});

describe('stripSslParamsFromUrl', () => {
  it('strips sslmode and friends, keeps other params', () => {
    const url =
      'postgres://u:p@host:5432/db?sslmode=require&application_name=foo&sslrootcert=/x';
    expect(stripSslParamsFromUrl(url)).toBe(
      'postgres://u:p@host:5432/db?application_name=foo',
    );
  });

  it('handles URL without query', () => {
    expect(stripSslParamsFromUrl('postgres://u:p@host/db')).toBe(
      'postgres://u:p@host/db',
    );
  });

  it('handles URL with only ssl params (returns base without ?)', () => {
    expect(stripSslParamsFromUrl('postgres://h/d?sslmode=require')).toBe(
      'postgres://h/d',
    );
  });
});

describe('buildArchivePgClientConfig', () => {
  beforeEach(() => {
    resetRdsCaBundleCacheForTests();
  });

  it('localhost → ssl=false', () => {
    const cfg = buildArchivePgClientConfig(
      'postgres://u@localhost:5432/db',
      {},
      () => null,
    );
    expect(cfg.ssl).toBe(false);
    expect(cfg.connectionString).toBe('postgres://u@localhost:5432/db');
  });

  it('remote + ARCHIVE_PG_NO_VERIFY=1 → rejectUnauthorized=false', () => {
    const cfg = buildArchivePgClientConfig(
      'postgres://u@kingside-archive.rds.aws:5432/db?sslmode=require',
      { ARCHIVE_PG_NO_VERIFY: '1' },
      () => Buffer.from('CA'),
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    // sslmode из URL очищен (иначе pg-connection-string перетрёт ssl).
    expect(cfg.connectionString).toBe(
      'postgres://u@kingside-archive.rds.aws:5432/db',
    );
  });

  it('remote + CA найден → verify-full', () => {
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\n...');
    const cfg = buildArchivePgClientConfig(
      'postgres://u@kingside-archive.rds.aws:5432/db?sslmode=require',
      {},
      () => ca,
    );
    expect(cfg.ssl).toEqual({ ca, rejectUnauthorized: true });
  });

  it('remote + CA не найден → fallback no-verify, вызывает onMissingCa', () => {
    const warn = jest.fn();
    const cfg = buildArchivePgClientConfig(
      'postgres://u@kingside-archive.rds.aws:5432/db',
      {},
      () => null,
      warn,
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/CA bundle not found/);
  });

  it('localhost не вызывает onMissingCa даже без CA', () => {
    const warn = jest.fn();
    buildArchivePgClientConfig(
      'postgres://u@localhost:5432/db',
      {},
      () => null,
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
