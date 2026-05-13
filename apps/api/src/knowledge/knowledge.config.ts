/**
 * KS-2967 / ADR-063 §6.3 — конфиг и path-резолверы для knowledge-tools.
 *
 * Allowlist / blocklist — единственная защита от чтения чувствительных
 * файлов. Меняется редко и осознанно. PR-ревью обязателен.
 *
 * Логика проверки пути:
 *   1. `path.resolve(REPO_ROOT, requested)` → абсолютный путь.
 *   2. Результат должен начинаться с `REPO_ROOT + sep` (защита от
 *      path-traversal через `..`, абсолютные пути и т.п.).
 *   3. Путь должен матчиться хотя бы одним allowlist-паттерном.
 *   4. Путь НЕ должен матчиться ни одним blocklist-паттерном (даже
 *      если попал в allowlist по wildcard).
 *
 * Glob-синтаксис намеренно минимальный (без зависимостей на picomatch /
 * minimatch — это критичный путь безопасности, контролируем сами):
 *   - `**` — любая последовательность сегментов включая `/`.
 *   - `*`  — любая последовательность символов кроме `/`.
 *   - `?`  — один символ кроме `/`.
 *   - всё остальное — литерал, экранируется.
 */

import * as path from 'node:path';

/**
 * Корень репозитория. В production — `/app` (Dockerfile WORKDIR
 * apps/api → `process.cwd() = /app/apps/api`, `../..` = `/app`).
 * В dev — `/project`. Можно переопределить через env `KNOWLEDGE_REPO_ROOT`
 * (для тестов и нестандартных раскладок).
 */
export function getRepoRoot(): string {
  const fromEnv = process.env.KNOWLEDGE_REPO_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), '..', '..');
}

/**
 * Пути (относительно REPO_ROOT), доступные knowledge-tools для search
 * и read. Strict: только pages/components/hooks/context/layouts фронта,
 * i18n-локали, типы и константы shared-пакета, документация и
 * сервисные README. Backend-исходники, тесты, секреты — НЕ здесь.
 */
export const KNOWLEDGE_ALLOWLIST: readonly string[] = [
  'apps/web/src/pages/**',
  'apps/web/src/components/**',
  'apps/web/src/hooks/**',
  'apps/web/src/context/**',
  'apps/web/src/layouts/**',
  'apps/web/public/locales/**',
  'packages/shared/src/**',
  'docs/adr/*.md',
  'docs/architecture/*.md',
  'docs/features/**/*.md',
  'docs/user/**/*.md',
  'apps/*/README.md',
];

interface BlockRule {
  /** Glob-паттерн относительно REPO_ROOT (forward-slashes). */
  pattern: string;
  /** Если true — match выполняется по lowercase. */
  caseInsensitive?: boolean;
}

/**
 * Запрещённые пути. Имеют ПРИОРИТЕТ над allowlist'ом: если путь
 * матчится хоть одним blocklist-правилом — отказ. Случайное попадание
 * в allowlist по wildcard НЕ открывает доступ.
 */
export const KNOWLEDGE_BLOCKLIST: readonly BlockRule[] = [
  { pattern: '**/.env*' },
  { pattern: '**/secrets/**' },
  { pattern: '**/secret/**' },
  { pattern: '**/auth/**' },
  { pattern: '**/admin/**' },
  { pattern: '**/*.test.ts' },
  { pattern: '**/*.test.tsx' },
  { pattern: '**/*.spec.ts' },
  { pattern: '**/*.spec.tsx' },
  { pattern: '**/*.spec.mjs' },
  { pattern: '**/node_modules/**' },
  { pattern: '**/dist/**' },
  { pattern: '**/build/**' },
  { pattern: '**/.git/**' },
  // case-insensitive: ловит JWT_KEY, ApiToken, .credential, etc.
  { pattern: '**/*key*', caseInsensitive: true },
  { pattern: '**/*token*', caseInsensitive: true },
  { pattern: '**/*credential*', caseInsensitive: true },
  // защищаем sensitive endpoints/guards даже из shared-зон.
  { pattern: 'apps/api/src/jwt-strategy*' },
  { pattern: 'apps/api/src/mcp/mcp-discovery-key.guard*' },
];

/**
 * Конвертирует glob в RegExp с anchor'ами `^...$`. Минимальный набор —
 * без curly-braces, без отрицания, без классов символов с диапазонами.
 * Этого хватает для allowlist'а; расширять — только осознанно, через
 * этот файл и PR-ревью.
 */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      // `**` — любая последовательность сегментов. Если за ним идёт
      // `/`, то поглощаем и его (чтобы `a/**/b` матчило `a/b` тоже).
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
      continue;
    }
    if (ch === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    // экранируем regex-метасимволы
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

/**
 * Проверяет относительный путь (forward-slashes, от REPO_ROOT) против
 * allowlist'а и blocklist'а.
 */
export function isPathAllowed(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  // Блок имеет приоритет.
  for (const rule of KNOWLEDGE_BLOCKLIST) {
    if (globToRegExp(rule.pattern, rule.caseInsensitive).test(norm)) {
      return false;
    }
  }
  for (const allow of KNOWLEDGE_ALLOWLIST) {
    if (globToRegExp(allow).test(norm)) return true;
  }
  return false;
}

/**
 * Резолвит запрошенный путь к абсолютному, проверяя:
 *   - результат лежит внутри REPO_ROOT (anti path-traversal);
 *   - путь не пустой и не абсолютный (`/etc/passwd` отклоняется).
 *
 * Возвращает абсолютный путь или `null`, если выход за пределы repo /
 * запрос абсолютного пути.
 */
export function resolveSafePath(requested: string, repoRoot: string): string | null {
  if (typeof requested !== 'string' || requested.length === 0) return null;
  if (path.isAbsolute(requested)) return null;
  const norm = requested.replace(/\\/g, '/');
  if (norm.includes('\0')) return null;
  const abs = path.resolve(repoRoot, norm);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!abs.startsWith(rootWithSep) && abs !== repoRoot) return null;
  return abs;
}

/**
 * Полная проверка: запрашиваемый путь → абсолютный путь, если он
 * лежит внутри repo, проходит allowlist и не попал в blocklist.
 * Иначе `null`. `null` — единая точка отказа для всех нарушений
 * (path traversal, абсолютный путь, blocklist, не allowlist), вызывающий
 * не должен по выходному значению различать причины — hide-not-found.
 */
export function resolveAndAuthorize(
  requested: string,
  repoRoot: string,
): { absPath: string; relPath: string } | null {
  const abs = resolveSafePath(requested, repoRoot);
  if (!abs) return null;
  const rel = path
    .relative(repoRoot, abs)
    .split(path.sep)
    .join('/');
  if (!isPathAllowed(rel)) return null;
  return { absPath: abs, relPath: rel };
}

/** Hard-cap на размер одного `read` в строках. Описано в KS-2967 §1 read. */
export const KNOWLEDGE_READ_MAX_RANGE = 500;

/** Default endLine - startLine + 1 для read. */
export const KNOWLEDGE_READ_DEFAULT_RANGE = 200;

/** Default / max limit для search (ADR-063 §6.4). */
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 100;

/** Тайм-аут ripgrep, мс (KS-2967 §1 search). */
export const KNOWLEDGE_SEARCH_TIMEOUT_MS = 3000;

/** Контекст ±N строк вокруг каждого match. */
export const KNOWLEDGE_SEARCH_CONTEXT_LINES = 2;

/** Максимальный размер файла для search/read, в байтах. */
export const KNOWLEDGE_MAX_FILE_BYTES = 200 * 1024;
