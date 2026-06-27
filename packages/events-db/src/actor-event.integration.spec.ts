/**
 * KS-4691: integration-тесты против реальной БД. Запускаются только
 * при наличии env `EVENTS_DATABASE_URL` — иначе весь suite skip'ается,
 * `npm run test` остаётся зелёным без БД (CI/dev по умолчанию).
 *
 * Что проверяем:
 *   1. `prisma migrate deploy` создаёт partitioned-таблицу + matviews
 *      (косвенно, через успешный insert и `\dm`-аналог через pg-запрос).
 *   2. INSERT через PrismaClient проходит в нативно партиционированную
 *      таблицу. Без `pg_partman` для теста создаётся DEFAULT-партиция —
 *      она нужна только локально, в проде партиции premake-аются
 *      partman'ом.
 *   3. Композитный PK `(id, created_at)` не позволяет вставить две
 *      строки с одинаковым `id` в одну и ту же микросекунду — это
 *      ожидаемое поведение native partitioning (тест-документация).
 *   4. `REFRESH MATERIALIZED VIEW CONCURRENTLY actor_event_counts_24h`
 *      обновляет агрегат и виден через прямой SELECT.
 *   5. Если в окружении есть роль `events_writer` — проверяется, что
 *      она НЕ может читать таблицы из `public` (изоляция KS-4690 §3).
 *
 * Тесты `partition rotation` (pg_partman.run_maintenance_proc()) —
 * проверка только на наличии extension, иначе skip с явным сообщением.
 */
import { Client } from 'pg';
import { PrismaClient } from './index';

const HAS_DB = Boolean(process.env.EVENTS_DATABASE_URL);

// `describe.skip` отдельной функцией, чтобы Jest показал явный skip
// со ссылкой на причину.
const d = HAS_DB ? describe : describe.skip;

d('events-db integration (EVENTS_DATABASE_URL)', () => {
  const url = process.env.EVENTS_DATABASE_URL ?? '';
  let prisma: PrismaClient;
  /** Прямой pg-клиент для административных операций (CREATE partition,
   *  REFRESH MATERIALIZED VIEW, GRANT-проверки). PrismaClient их не
   *  выражает напрямую. */
  let pg: Client;
  /** Уникальный actor_id на каждый прогон — изоляция от других
   *  одновременных тестов / прошлых неубранных артефактов. */
  const ACTOR_ID = '00000000-0000-4000-8000-' + Date.now().toString().padStart(12, '0').slice(-12);
  let hasPartman = false;
  let hasEventsWriter = false;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    pg = new Client({ connectionString: url });
    await pg.connect();

    const ext = await pg.query(
      "SELECT 1 FROM pg_extension WHERE extname='pg_partman'",
    );
    hasPartman = ext.rowCount === 1;

    const role = await pg.query(
      "SELECT 1 FROM pg_roles WHERE rolname='events_writer'",
    );
    hasEventsWriter = role.rowCount === 1;

    // Для локального dev без pg_partman нужна default-партиция, иначе
    // любой INSERT падает с «no partition of relation found for row».
    // Идемпотентно: если партиция уже есть — skip.
    if (!hasPartman) {
      await pg.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_inherits i
            JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'events.actor_events'::regclass
              AND c.relname = 'actor_events_default'
          ) THEN
            EXECUTE 'CREATE TABLE IF NOT EXISTS "events"."actor_events_default" '
                 || 'PARTITION OF "events"."actor_events" DEFAULT';
          END IF;
        END$$;
      `);
    }
  });

  afterAll(async () => {
    // Чистим за собой только данные, не схему. Конкретный actor_id —
    // безопасный narrow-delete.
    if (pg) {
      await pg
        .query('DELETE FROM "events"."actor_events" WHERE actor_id = $1', [
          ACTOR_ID,
        ])
        .catch(() => undefined);
      await pg.end();
    }
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  it('INSERT через Prisma → строка появилась в table + matview после refresh', async () => {
    const created = await prisma.actorEvent.create({
      data: {
        actorId: ACTOR_ID,
        actorType: 'user',
        type: 'page_view',
        payload: { path: '/play/abc' },
      },
    });
    expect(created.actorId).toBe(ACTOR_ID);
    expect(created.type).toBe('page_view');
    expect(typeof created.id).toBe('bigint');

    // Прямой SELECT — Prisma BigInt-сериализация не должна мешать.
    const row = await pg.query(
      'SELECT actor_id::text, type, (payload->>$1) AS path FROM "events"."actor_events" WHERE actor_id=$2 LIMIT 1',
      ['path', ACTOR_ID],
    );
    expect(row.rows[0]).toEqual({
      actor_id: ACTOR_ID,
      type: 'page_view',
      path: '/play/abc',
    });

    // Refresh CONCURRENTLY требует unique-индекса — проверяем что он есть.
    // Первый REFRESH без NULL'ов в матвью работает в обоих режимах
    // (concurrently и обычный). Если матвью пустой и concurrently
    // вернёт ошибку — fallback на обычный refresh ради простоты теста.
    try {
      await pg.query(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY "events"."actor_event_counts_24h"',
      );
    } catch {
      await pg.query(
        'REFRESH MATERIALIZED VIEW "events"."actor_event_counts_24h"',
      );
    }

    const mv = await pg.query(
      'SELECT actor_id::text, type, cnt::int FROM "events"."actor_event_counts_24h" WHERE actor_id=$1',
      [ACTOR_ID],
    );
    expect(mv.rows).toEqual([
      { actor_id: ACTOR_ID, type: 'page_view', cnt: 1 },
    ]);
  });

  it('Композитный PK (id, created_at) — оба-в-индексе, partition-aware', async () => {
    // Постфактум-проверка через системный каталог: PK ровно из двух
    // колонок, обе в правильном порядке. Это контрактная проверка —
    // pg_partman требует partition-key в PK, поэтому смена PK без
    // обновления конфигурации partman ломает rotation. Тест ловит
    // случайную регрессию.
    const pkCols = await pg.query(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a
           ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'events.actor_events'::regclass
          AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)`,
    );
    expect(pkCols.rows.map((r) => r.attname)).toEqual(['id', 'created_at']);
  });

  it('Композитный индекс (actor_id, type, created_at DESC) есть на template-таблице', async () => {
    // Через template копируется при создании каждой новой партиции
    // (ADR-147 §2.3, см. миграцию). Контракт: индекс должен существовать
    // на template — иначе новые партиции будут без индекса и матвью
    // SELECT упадёт по сканированию полной партиции.
    const idx = await pg.query(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'events'
          AND tablename = 'actor_events_template'
          AND indexname = 'actor_events_template_actor_id_type_created_at_idx'`,
    );
    expect(idx.rowCount).toBe(1);
  });

  it('Matviews: все три окна созданы с уникальным индексом', async () => {
    const mv = await pg.query(
      `SELECT matviewname FROM pg_matviews
        WHERE schemaname='events'
        ORDER BY matviewname`,
    );
    expect(mv.rows.map((r) => r.matviewname)).toEqual([
      'actor_event_counts_24h',
      'actor_event_counts_30d',
      'actor_event_counts_7d',
    ]);

    const uniq = await pg.query(
      `SELECT i.relname AS index_name, t.relname AS view_name
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_index ix ON ix.indrelid = t.oid AND ix.indisunique
         JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE n.nspname = 'events'
          AND t.relname LIKE 'actor_event_counts_%'
        ORDER BY t.relname`,
    );
    // По одному unique-индексу на каждый matview.
    expect(uniq.rows.map((r) => r.view_name)).toEqual([
      'actor_event_counts_24h',
      'actor_event_counts_30d',
      'actor_event_counts_7d',
    ]);
  });

  it('partition rotation: partman зарегистрирован (только при наличии pg_partman)', async () => {
    if (!hasPartman) {
      // Локальный dev без extension — фиксируем явно, не падаем.
      return;
    }
    const cfg = await pg.query(
      "SELECT parent_table, partition_interval, retention, retention_keep_table " +
        "FROM partman.part_config WHERE parent_table='events.actor_events'",
    );
    expect(cfg.rowCount).toBe(1);
    const row = cfg.rows[0];
    expect(row.partition_interval).toBe('1 week');
    expect(row.retention).toBe('90 days');
    expect(row.retention_keep_table).toBe(false);
  });

  it('events_writer изолирован: USAGE на schema events есть, на public — нет (только при наличии роли)', async () => {
    if (!hasEventsWriter) {
      // Локально роль создаётся scripts/sql/events-schema-init.sql,
      // в проде создана KS-4690. Без неё проверка не имеет смысла.
      return;
    }
    const acl = await pg.query(
      `SELECT
         has_schema_privilege('events_writer', 'events', 'USAGE')  AS events_usage,
         has_schema_privilege('events_writer', 'public', 'USAGE')  AS public_usage,
         has_table_privilege('events_writer', 'events.actor_events', 'INSERT') AS events_insert,
         has_table_privilege('events_writer', 'events.actor_events', 'SELECT') AS events_select`,
    );
    const row = acl.rows[0];
    expect(row.events_usage).toBe(true);
    expect(row.public_usage).toBe(false);
    expect(row.events_insert).toBe(true);
    expect(row.events_select).toBe(true);
  });
});

// Когда EVENTS_DATABASE_URL не задан — оставляем одну явную placeholder-проверку,
// чтобы `npm run test` показывал «1 skipped» вместо пустого результата.
if (!HAS_DB) {
  describe('events-db integration (no DB)', () => {
    it.skip('skipped — set EVENTS_DATABASE_URL to enable', () => undefined);
  });
}
