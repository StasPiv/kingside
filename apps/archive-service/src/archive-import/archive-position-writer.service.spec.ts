import {
  buildPoolConfig,
  isLocalHost,
  resolveSslConfig,
  resetRdsCaBundleCacheForTests,
  stripSslParamsFromUrl,
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

// Fake CA — содержимое не валидируется юнит-тестами, только что Buffer
// дошёл до конфига Pool.
const FAKE_CA = Buffer.from('-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n');
const ca = (): Buffer | null => FAKE_CA;
const noCa = (): Buffer | null => null;

beforeEach(() => {
  resetRdsCaBundleCacheForTests();
});

describe('resolveSslConfig', () => {
  it('local docker-compose URL без env → SSL выкл', () => {
    expect(resolveSslConfig(LOCAL_URL, {}, ca)).toBe(false);
  });

  // KS-1893: для удалённых хостов теперь ставим `{ ca, rejectUnauthorized: true }`,
  // а не `{ rejectUnauthorized: false }`. Это и есть фикс верификации цепочки.
  it('URL с sslmode=require + CA найден → SSL с CA bundle и rejectUnauthorized:true', () => {
    expect(resolveSslConfig(RDS_REQUIRE, {}, ca)).toEqual({
      ca: FAKE_CA,
      rejectUnauthorized: true,
    });
  });

  it('URL с sslmode=no-verify → SSL с rejectUnauthorized:false (legacy bypass)', () => {
    expect(resolveSslConfig(RDS_NO_VERIFY, {}, ca)).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('URL с sslmode=disable → SSL выкл (даже для remote хоста)', () => {
    expect(resolveSslConfig(DISABLE_URL, {}, ca)).toBe(false);
  });

  it('env PGSSLMODE=require на локальном URL → SSL с CA', () => {
    expect(resolveSslConfig(LOCAL_URL, { PGSSLMODE: 'require' }, ca)).toEqual({
      ca: FAKE_CA,
      rejectUnauthorized: true,
    });
  });

  it('env PGSSLMODE=no-verify (KS-1618 workaround) → SSL c rejectUnauthorized:false', () => {
    expect(
      resolveSslConfig(LOCAL_URL, { PGSSLMODE: 'no-verify' }, ca),
    ).toEqual({ rejectUnauthorized: false });
  });

  it('env PGSSLMODE=disable → SSL выкл', () => {
    expect(resolveSslConfig(RDS_REQUIRE, { PGSSLMODE: 'disable' }, ca)).toBe(false);
  });

  it('ARCHIVE_IMPORTER_PG_SSL=1 на локальном URL → SSL с CA', () => {
    expect(
      resolveSslConfig(LOCAL_URL, { ARCHIVE_IMPORTER_PG_SSL: '1' }, ca),
    ).toEqual({ ca: FAKE_CA, rejectUnauthorized: true });
  });

  it('ARCHIVE_IMPORTER_PG_SSL=0 override даже при sslmode=require → SSL выкл', () => {
    expect(
      resolveSslConfig(RDS_REQUIRE, { ARCHIVE_IMPORTER_PG_SSL: '0' }, ca),
    ).toBe(false);
  });

  it('ARCHIVE_IMPORTER_PG_SSL=false override → SSL выкл', () => {
    expect(
      resolveSslConfig(RDS_REQUIRE, { ARCHIVE_IMPORTER_PG_SSL: 'false' }, ca),
    ).toBe(false);
  });

  it('URL без sslmode и пустые env для localhost → SSL выкл (сохраняет dev-поведение)', () => {
    expect(
      resolveSslConfig(
        LOCAL_URL,
        { PGSSLMODE: '', ARCHIVE_IMPORTER_PG_SSL: '' },
        ca,
      ),
    ).toBe(false);
  });

  // KS-1640: secure-by-default для удалённых хостов.

  it('RDS URL без sslmode + CA найден → SSL c CA bundle (secure-by-default)', () => {
    expect(resolveSslConfig(RDS_BARE, {}, ca)).toEqual({
      ca: FAKE_CA,
      rejectUnauthorized: true,
    });
  });

  // KS-1893: hotfix-выключатель для случаев, когда CA bundle сломан.
  it('ARCHIVE_IMPORTER_PG_SSL_NO_VERIFY=1 → no-verify (даже если CA доступен)', () => {
    expect(
      resolveSslConfig(
        RDS_REQUIRE,
        { ARCHIVE_IMPORTER_PG_SSL_NO_VERIFY: '1' },
        ca,
      ),
    ).toEqual({ rejectUnauthorized: false });
  });

  // KS-1893: graceful fallback для случая «CA-файл не нашли».
  // Лучше работающий импорт без верификации, чем падение на boot.
  it('CA не нашли → fallback на rejectUnauthorized:false (не падаем)', () => {
    expect(resolveSslConfig(RDS_REQUIRE, {}, noCa)).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('127.0.0.1 без sslmode → SSL выкл', () => {
    expect(resolveSslConfig(LOCAL_IP_URL, {}, ca)).toBe(false);
  });

  it('[::1] (IPv6 localhost) без sslmode → SSL выкл', () => {
    expect(resolveSslConfig(LOCAL_IPV6_URL, {}, ca)).toBe(false);
  });

  it('host.docker.internal без sslmode → SSL выкл', () => {
    expect(resolveSslConfig(DOCKER_URL, {}, ca)).toBe(false);
  });

  it('localhost + sslmode=disable → SSL выкл (явный override уважаем)', () => {
    expect(resolveSslConfig(LOCAL_DISABLE_URL, {}, ca)).toBe(false);
  });

  it('RDS + ARCHIVE_IMPORTER_PG_SSL=0 → SSL выкл (явный override bypass-ит default)', () => {
    expect(
      resolveSslConfig(RDS_BARE, { ARCHIVE_IMPORTER_PG_SSL: '0' }, ca),
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

// ─── KS-1893: stripSslParamsFromUrl ─────────────────────────────────
//
// Без вычистки sslmode из URL `pg-connection-string` парсит его и затирает
// наш `ssl: { ca, rejectUnauthorized: true }` в `pg/connection-parameters.js`
// (`Object.assign({}, config, parse(connectionString))`). Это и есть корень
// регрессии 24.04: даже когда мы передавали правильный ssl-конфиг, до
// `tls.connect` доходил пустой объект из parse(), интерпретируемый как
// verify-full против системного store.

describe('stripSslParamsFromUrl', () => {
  it('URL без query — не меняется', () => {
    expect(
      stripSslParamsFromUrl('postgresql://u:p@host:5432/db'),
    ).toBe('postgresql://u:p@host:5432/db');
  });

  it('убирает sslmode', () => {
    expect(
      stripSslParamsFromUrl('postgresql://u:p@host:5432/db?sslmode=require'),
    ).toBe('postgresql://u:p@host:5432/db');
  });

  it('убирает sslmode + sslrootcert + sslcert + sslkey + uselibpqcompat', () => {
    expect(
      stripSslParamsFromUrl(
        'postgresql://u:p@host/db' +
          '?sslmode=verify-full' +
          '&sslrootcert=/x.pem' +
          '&sslcert=/c.pem' +
          '&sslkey=/k.pem' +
          '&uselibpqcompat=true',
      ),
    ).toBe('postgresql://u:p@host/db');
  });

  it('сохраняет не-ssl параметры (application_name, connect_timeout)', () => {
    expect(
      stripSslParamsFromUrl(
        'postgresql://u:p@host/db?sslmode=require&application_name=archive&connect_timeout=10',
      ),
    ).toBe(
      'postgresql://u:p@host/db?application_name=archive&connect_timeout=10',
    );
  });

  it('пустой query после очистки → URL без знака ?', () => {
    expect(
      stripSslParamsFromUrl('postgresql://u:p@host/db?sslmode=require'),
    ).not.toContain('?');
  });

  it('case-insensitive по имени параметра (SSLmode=…)', () => {
    expect(
      stripSslParamsFromUrl('postgresql://u:p@host/db?SSLmode=require'),
    ).toBe('postgresql://u:p@host/db');
  });
});

// ─── KS-1893: buildPoolConfig — конструктор Pool ────────────────────
//
// Главный регрессионный тест задачи: фиксирует контракт «sslmode=require
// в URL → Pool получает ssl с CA + URL уже без sslmode». Если кто-то
// в будущем нечаянно переставит порядок parse/Object.assign в pg или
// верненёт sslmode в URL, тест упадёт до прода.

describe('buildPoolConfig (KS-1893)', () => {
  it('RDS URL c sslmode=require → ssl содержит CA, rejectUnauthorized:true', () => {
    const cfg = buildPoolConfig(RDS_REQUIRE, {}, ca);
    expect(cfg.ssl).toEqual({ ca: FAKE_CA, rejectUnauthorized: true });
  });

  it('connectionString передаваемый в Pool НЕ содержит sslmode', () => {
    const cfg = buildPoolConfig(RDS_REQUIRE, {}, ca);
    expect(cfg.connectionString).toBe(
      'postgresql://u:p@rds.example.com:5432/kingside',
    );
    expect(cfg.connectionString).not.toMatch(/sslmode/i);
  });

  it('local URL → ssl=false и URL без изменений', () => {
    const cfg = buildPoolConfig(LOCAL_URL, {}, ca);
    expect(cfg.ssl).toBe(false);
    expect(cfg.connectionString).toBe(LOCAL_URL);
  });

  it('hotfix ARCHIVE_IMPORTER_PG_SSL_NO_VERIFY=1 → ssl c rejectUnauthorized:false', () => {
    const cfg = buildPoolConfig(
      RDS_REQUIRE,
      { ARCHIVE_IMPORTER_PG_SSL_NO_VERIFY: '1' },
      ca,
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('CA не найден на удалённом хосте → ssl c rejectUnauthorized:false (graceful)', () => {
    const cfg = buildPoolConfig(RDS_REQUIRE, {}, noCa);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('конфиг содержит application_name=archive-importer и max=4', () => {
    const cfg = buildPoolConfig(RDS_REQUIRE, {}, ca);
    expect(cfg.application_name).toBe('archive-importer');
    expect(cfg.max).toBe(4);
  });
});
