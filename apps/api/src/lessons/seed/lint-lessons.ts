/**
 * Standalone-запуск seed-линтера (без БД).
 *
 * Запуск: `npm run seed:lessons:lint --workspace=@kingside/api`
 * Подключается к `npm run lint` apps/api (Gherkin KS-1760).
 *
 * Проверки с PrismaClient (существование `puzzleId`) сюда не попадают —
 * это делается в `seed:lessons` перед upsert'ом. Здесь — чисто shape +
 * валидация FEN/PGN/UCI и уникальность slug'ов.
 */

import { COURSES } from './courses';
import { lintFixtures } from './lint';

async function main(): Promise<void> {
  const errors = await lintFixtures(COURSES);
  if (errors.length > 0) {
    process.stderr.write(
      `✗ seed-lessons lint failed (${errors.length} error(s)):\n` +
        errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n') +
        '\n',
    );
    process.exit(1);
  }
  process.stdout.write(`✓ seed-lessons lint OK (${COURSES.length} course(s))\n`);
}

main().catch((e) => {
  process.stderr.write(`✗ lint crashed: ${e.stack ?? e}\n`);
  process.exit(1);
});
