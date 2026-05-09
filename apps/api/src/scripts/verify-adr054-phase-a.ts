/**
 * KS-2639 / ADR-054 Phase A. Verification-скрипт миграции
 * `20260509120000_adr054_phase_a_owner_visibility`.
 *
 * Проверяет на живой БД:
 *   1. Колонки `owner_id` / `is_public` появились в нужных таблицах.
 *   2. FK `courses.owner_id → users.id` с `ON DELETE CASCADE`.
 *   3. Partial-unique индексы:
 *        - `courses_slug_lang_system_uniq`  WHERE owner_id IS NULL
 *        - `courses_owner_slug_user_uniq`   WHERE owner_id IS NOT NULL
 *      и старый `courses_slug_lang_key` снят.
 *   4. Поведение на запись: одинаковый slug у двух пользовательских
 *      курсов разных владельцев — допустим; повторный — отвергается с
 *      `P2002`. Системный slug ↔ пользовательский slug одного значения
 *      не конфликтуют (разные namespace).
 *
 * Запуск (на dev/prod):
 *   DATABASE_URL=... node apps/api/dist/scripts/verify-adr054-phase-a.js
 *
 * Скрипт идемпотентен: создаёт временные записи с `slug = '__ks2639-…'`
 * и удаляет их в `finally`. Любой `ROLLBACK`-сценарий по ходу не оставляет
 * мусора в БД.
 */

import { PrismaClient, Prisma } from '@kingside/db';

interface IndexRow {
  indexname: string;
  indexdef: string;
}

interface ConstraintRow {
  conname: string;
  def: string;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const TAG = `__ks2639-${Date.now()}`;
  let anyFailure = false;

  const fail = (msg: string) => {
    anyFailure = true;
    process.stdout.write(`FAIL: ${msg}\n`);
  };
  const ok = (msg: string) => {
    process.stdout.write(`OK:   ${msg}\n`);
  };

  try {
    // ── 1. Колонки ────────────────────────────────────────────────
    const columns = await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('courses', 'lessons', 'lesson_steps')
        AND column_name IN ('owner_id', 'is_public')
      ORDER BY table_name, column_name
    `;
    const haveCourseOwner = columns.find(
      (c) => c.table_name === 'courses' && c.column_name === 'owner_id',
    );
    const haveCourseIsPublic = columns.find(
      (c) => c.table_name === 'courses' && c.column_name === 'is_public',
    );
    const haveLessonOwner = columns.find(
      (c) => c.table_name === 'lessons' && c.column_name === 'owner_id',
    );
    const haveStepOwner = columns.find(
      (c) => c.table_name === 'lesson_steps' && c.column_name === 'owner_id',
    );
    if (haveCourseOwner && haveCourseOwner.is_nullable === 'YES') {
      ok('courses.owner_id exists & nullable');
    } else {
      fail(`courses.owner_id missing or not nullable: ${JSON.stringify(haveCourseOwner)}`);
    }
    if (haveCourseIsPublic && haveCourseIsPublic.is_nullable === 'NO') {
      ok('courses.is_public exists & NOT NULL');
    } else {
      fail(`courses.is_public missing or nullable: ${JSON.stringify(haveCourseIsPublic)}`);
    }
    if (haveLessonOwner && haveLessonOwner.is_nullable === 'YES') {
      ok('lessons.owner_id exists & nullable');
    } else {
      fail(`lessons.owner_id missing or not nullable: ${JSON.stringify(haveLessonOwner)}`);
    }
    if (haveStepOwner && haveStepOwner.is_nullable === 'YES') {
      ok('lesson_steps.owner_id exists & nullable');
    } else {
      fail(`lesson_steps.owner_id missing or not nullable: ${JSON.stringify(haveStepOwner)}`);
    }

    // ── 2. FK ────────────────────────────────────────────────────
    const fk = await prisma.$queryRaw<ConstraintRow[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'courses_owner_id_fkey'
    `;
    if (fk.length === 1 && /ON DELETE CASCADE/.test(fk[0].def) && /REFERENCES users/.test(fk[0].def)) {
      ok(`FK courses.owner_id → users.id with ON DELETE CASCADE: ${fk[0].def}`);
    } else {
      fail(`FK courses_owner_id_fkey missing or wrong: ${JSON.stringify(fk)}`);
    }

    // ── 3. Partial-unique индексы ────────────────────────────────
    const idx = await prisma.$queryRaw<IndexRow[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('courses', 'lessons')
        AND (
          indexname LIKE 'courses_slug%'
          OR indexname LIKE 'courses_owner%'
          OR indexname LIKE 'lessons_owner%'
        )
      ORDER BY indexname
    `;
    const sysIdx = idx.find((i) => i.indexname === 'courses_slug_lang_system_uniq');
    const userIdx = idx.find((i) => i.indexname === 'courses_owner_slug_user_uniq');
    const oldUniq = idx.find((i) => i.indexname === 'courses_slug_lang_key');
    if (sysIdx && /WHERE \(owner_id IS NULL\)/.test(sysIdx.indexdef)) {
      ok(`partial-unique courses_slug_lang_system_uniq: ${sysIdx.indexdef}`);
    } else {
      fail(`partial-unique courses_slug_lang_system_uniq missing/wrong: ${JSON.stringify(sysIdx)}`);
    }
    if (userIdx && /WHERE \(owner_id IS NOT NULL\)/.test(userIdx.indexdef)) {
      ok(`partial-unique courses_owner_slug_user_uniq: ${userIdx.indexdef}`);
    } else {
      fail(`partial-unique courses_owner_slug_user_uniq missing/wrong: ${JSON.stringify(userIdx)}`);
    }
    if (!oldUniq) {
      ok('legacy unique index courses_slug_lang_key removed');
    } else {
      fail(`legacy index still present: ${oldUniq.indexname}`);
    }

    // ── 4. Поведение partial-unique на записи ────────────────────
    const ownerA = '11111111-1111-4111-a111-aaaa00000001';
    const ownerB = '11111111-1111-4111-a111-aaaa00000002';

    // Создаём двух тестовых пользователей (idempotent).
    await prisma.user.upsert({
      where: { id: ownerA },
      update: {},
      create: { id: ownerA, username: `ks2639-a-${Date.now()}` },
    });
    await prisma.user.upsert({
      where: { id: ownerB },
      update: {},
      create: { id: ownerB, username: `ks2639-b-${Date.now()}` },
    });

    const slug = `${TAG}-shared-slug`;

    const createCourse = (ownerId: string | null) =>
      prisma.course.create({
        data: {
          ownerId,
          slug,
          lang: 'ru',
          level: 'beginner',
          titleKey: `${TAG}.title`,
          descriptionKey: `${TAG}.desc`,
          isPublic: ownerId !== null,
        },
        select: { id: true, ownerId: true, slug: true },
      });

    // (4a) Системный slug + два пользовательских slug — все три должны
    //      сосуществовать (system & owner-A & owner-B namespace'ы).
    const sysCourse = await createCourse(null);
    ok(`created system course slug=${slug}: id=${sysCourse.id}`);

    const userACourse = await createCourse(ownerA);
    ok(`created user-A course slug=${slug}: id=${userACourse.id}`);

    const userBCourse = await createCourse(ownerB);
    ok(`created user-B course slug=${slug}: id=${userBCourse.id}`);

    // (4b) Дубль системного — должен упасть.
    let dupSystemErrCode: string | null = null;
    try {
      await createCourse(null);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        dupSystemErrCode = e.code;
      } else {
        throw e;
      }
    }
    if (dupSystemErrCode === 'P2002') {
      ok('duplicate system slug rejected (P2002)');
    } else {
      fail(`duplicate system slug NOT rejected: code=${dupSystemErrCode}`);
    }

    // (4c) Дубль пользовательского у того же owner — должен упасть.
    let dupUserErrCode: string | null = null;
    try {
      await createCourse(ownerA);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        dupUserErrCode = e.code;
      } else {
        throw e;
      }
    }
    if (dupUserErrCode === 'P2002') {
      ok('duplicate user-A slug rejected (P2002)');
    } else {
      fail(`duplicate user-A slug NOT rejected: code=${dupUserErrCode}`);
    }

    // (4d) Cleanup тестовых курсов и пользователей.
    await prisma.course.deleteMany({ where: { slug } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerA, ownerB] } } });
    ok('cleanup ok');
  } finally {
    await prisma.$disconnect();
  }

  if (anyFailure) {
    process.stdout.write('\nVERIFY FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nVERIFY OK\n');
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
