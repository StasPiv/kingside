import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * KS-1722: статический guard для всех CLI-шим'ов archive-service.
 *
 * Цель — гарантировать, что ни один CLI не запускает scheduler immediate
 * tick через `ImporterModule`. Все 6 CLI должны бутстрапить
 * `AdHocCliModule` (KS-1720), который не подключает `ScheduleModule` и
 * `ArchiveImportService`.
 *
 * Тест читает исходник каждого CLI и проверяет:
 *   1) Есть импорт `AdHocCliModule from './ad-hoc-cli.module'`.
 *   2) Нет импорта `ImporterModule from '../importer.module'`.
 *   3) `createApplicationContext(AdHocCliModule, ...)` вызывается, а не
 *      `createApplicationContext(ImporterModule, ...)`.
 *
 * Если кто-то «по привычке» вернёт `ImporterModule` в один из CLI — этот
 * тест сразу укажет на регрессию. Bootstrap-инвариант (CLI-bootstrap не
 * берёт Redis-lock `archive:import:lock:twic`) проверяется отдельно в
 * `ad-hoc-cli.module.spec.ts`: все CLI стартуют от одного и того же
 * `AdHocCliModule`, поэтому достаточно проверить инвариант на нём один раз.
 */

const CLI_DIR = __dirname;

/**
 * Список всех CLI-шим'ов archive-service. При добавлении нового CLI —
 * вписать сюда. Если новый CLI ОБОСНОВАННО требует `ImporterModule`
 * (крайне маловероятно) — задокументировать в самом файле и исключить
 * отсюда отдельным тест-кейсом, не молчанием.
 */
const CLI_FILES = [
  'import-twic-issue.ts',
  'backfill.ts',
  'backfill-twic.ts',
  'classify-existing.ts',
  'cleanup-positions.ts',
  'rebuild-position-stats.ts',
  'backfill-players-events.ts',
] as const;

describe.each(CLI_FILES)('CLI %s — bootstrap module guard (KS-1722)', (file) => {
  const source = readFileSync(join(CLI_DIR, file), 'utf8');

  it('импортирует AdHocCliModule из ./ad-hoc-cli.module', () => {
    expect(source).toMatch(
      /import\s+\{\s*AdHocCliModule\s*\}\s+from\s+['"]\.\/ad-hoc-cli\.module['"]/,
    );
  });

  it('НЕ импортирует ImporterModule из ../importer.module', () => {
    // Любая форма импорта `ImporterModule` из `importer.module` — регрессия.
    // Само слово `ImporterModule` в комментариях («переключено с
    // ImporterModule на AdHocCliModule») допустимо — оно не порождает
    // runtime-зависимости на сам модуль.
    expect(source).not.toMatch(/from\s+['"]\.\.\/importer\.module['"]/);
  });

  it('createApplicationContext получает AdHocCliModule, не ImporterModule', () => {
    expect(source).toMatch(
      /createApplicationContext\s*\(\s*AdHocCliModule\b/,
    );
    expect(source).not.toMatch(
      /createApplicationContext\s*\(\s*ImporterModule\b/,
    );
  });
});
