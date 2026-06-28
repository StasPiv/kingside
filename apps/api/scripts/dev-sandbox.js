#!/usr/bin/env node
/**
 * KS-4773. Запуск `nest start --watch` с outDir вне репозитория.
 *
 * Проблема: в sandbox-окружении ряда агентов (layout) каталог
 * `apps/api/dist` смонтирован read-only. Стандартный `nest start --watch`
 * на инициализации копирует ассеты из `nest-cli.json`
 * (`i18n/**\/*.json`, `engine/polyglot-keys.json`, opening-trainer seeds)
 * в outDir и падает с `EROFS: read-only file system, mkdir`.
 *
 * Решение: переключить outDir на writable путь и подсунуть nest'у
 * temp-tsconfig с переопределённым `compilerOptions.outDir`.
 *
 *   1. outDir = `process.env.API_DIST_DIR ?? '/tmp/api-dist'`.
 *   2. `mkdir -p <outDir>` (writable).
 *   3. Генерация `apps/api/tsconfig.sandbox.json` (extends
 *      `./tsconfig.json`, переопределяет `compilerOptions.outDir`).
 *   4. `nest start --watch --path tsconfig.sandbox.json`.
 *
 * Файл `tsconfig.sandbox.json` перегенерируется на каждый запуск и
 * исключён из git (см. apps/api/.gitignore). В обычной dev-зоне
 * `npm run dev` остаётся как был.
 *
 * Использование:
 *   npm run dev:sandbox --workspace=@kingside/api
 *   API_DIST_DIR=/var/tmp/api-dist npm run dev:sandbox --workspace=@kingside/api
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const apiRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(apiRoot, '..', '..');
const outDir = process.env.API_DIST_DIR || '/tmp/api-dist';
fs.mkdirSync(outDir, { recursive: true });

// nest start --watch запускает Node с cwd=outDir → require('reflect-metadata')
// ищет node_modules рядом с main.js. В sandbox-зоне outDir=/tmp/* —
// node_modules там нет. Линкуем на корневой node_modules монорепо.
const nodeModulesLink = path.join(outDir, 'node_modules');
try {
  const stat = fs.lstatSync(nodeModulesLink);
  if (!stat.isSymbolicLink()) {
    // Если уже есть реальный каталог — не трогаем.
  }
} catch {
  fs.symlinkSync(
    path.join(projectRoot, 'node_modules'),
    nodeModulesLink,
    'dir',
  );
}

const tsconfigPath = path.join(apiRoot, 'tsconfig.sandbox.json');
const tsconfig = {
  extends: './tsconfig.json',
  compilerOptions: { outDir },
};
fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n');

// eslint-disable-next-line no-console
console.log(`[dev:sandbox] outDir = ${outDir}`);
// eslint-disable-next-line no-console
console.log(`[dev:sandbox] tsconfig = ${tsconfigPath}`);

// nest CLI ищем сначала в локальной .bin (npm workspace: бинарь
// может лежать в корне), потом в PATH. Под `npm run` PATH уже
// расширен, под прямым `node scripts/dev-sandbox.js` — нет.
function findNestBin() {
  const candidates = [
    path.join(apiRoot, 'node_modules', '.bin', 'nest'),
    path.resolve(apiRoot, '..', '..', 'node_modules', '.bin', 'nest'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'nest';
}

const nestBin = findNestBin();
// eslint-disable-next-line no-console
console.log(`[dev:sandbox] nest = ${nestBin}`);

const child = spawn(
  nestBin,
  ['start', '--watch', '--path', 'tsconfig.sandbox.json'],
  { cwd: apiRoot, stdio: 'inherit', shell: false },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
