/**
 * KS-2967 / ADR-063 §6.3 — юнит-тесты безопасности path-резолверов
 * knowledge-модуля. Защита от path-traversal, blocklist-приоритета,
 * абсолютных путей.
 */

import * as path from 'node:path';
import {
  globToRegExp,
  isPathAllowed,
  resolveAndAuthorize,
  resolveSafePath,
} from './knowledge.config';

const REPO = path.resolve('/tmp/knowledge-config-spec-repo');

describe('globToRegExp', () => {
  it('matches **/ across multiple segments', () => {
    const re = globToRegExp('apps/web/src/pages/**');
    expect(re.test('apps/web/src/pages/HomePage.tsx')).toBe(true);
    expect(re.test('apps/web/src/pages/sub/Deeper.tsx')).toBe(true);
    expect(re.test('apps/web/src/components/Foo.tsx')).toBe(false);
  });

  it('matches single * within one segment only', () => {
    const re = globToRegExp('docs/*/README.md');
    expect(re.test('docs/x/README.md')).toBe(true);
    expect(re.test('docs/x/y/README.md')).toBe(false);
  });

  it('honors caseInsensitive flag', () => {
    const re = globToRegExp('**/*key*', true);
    expect(re.test('apps/web/src/components/ApiKey.tsx')).toBe(true);
    expect(re.test('apps/web/src/components/JWT_KEY_helper.ts')).toBe(true);
  });

  it('escapes regex metacharacters in literals', () => {
    const re = globToRegExp('a.b/c+d');
    expect(re.test('a.b/c+d')).toBe(true);
    expect(re.test('aXb/cYd')).toBe(false);
  });
});

describe('isPathAllowed', () => {
  it('allows paths matching allowlist', () => {
    expect(isPathAllowed('apps/web/src/pages/ArchiveGamesPage.tsx')).toBe(true);
    expect(isPathAllowed('apps/web/src/components/Sidebar.tsx')).toBe(true);
    expect(isPathAllowed('apps/web/src/hooks/useAuth.ts')).toBe(true);
    expect(isPathAllowed('packages/shared/src/types/api-contracts.ts')).toBe(true);
    expect(isPathAllowed('docs/adr/063-assistant-knowledge-source.md')).toBe(true);
    expect(isPathAllowed('apps/api/README.md')).toBe(true);
  });

  it('denies paths outside allowlist', () => {
    expect(isPathAllowed('apps/api/src/main.ts')).toBe(false);
    expect(isPathAllowed('apps/api/src/prisma/prisma.service.ts')).toBe(false);
    expect(isPathAllowed('packages/db/prisma/schema.prisma')).toBe(false);
    expect(isPathAllowed('package.json')).toBe(false);
  });

  it('denies .env even if it sits under an allowlisted prefix', () => {
    expect(isPathAllowed('apps/web/.env.production')).toBe(false);
    expect(isPathAllowed('.env')).toBe(false);
    expect(isPathAllowed('apps/web/src/pages/.env.local')).toBe(false);
  });

  it('denies anything under auth/ or admin/ (blocklist wins over allowlist)', () => {
    expect(isPathAllowed('apps/web/src/pages/auth/LoginPage.tsx')).toBe(false);
    expect(isPathAllowed('apps/web/src/components/admin/AdminPanel.tsx')).toBe(false);
    expect(isPathAllowed('packages/shared/src/auth/index.ts')).toBe(false);
    expect(isPathAllowed('docs/architecture/admin/overview.md')).toBe(false);
  });

  it('denies files whose name contains key/token/credential (case-insensitive)', () => {
    expect(isPathAllowed('apps/web/src/components/ApiKey.tsx')).toBe(false);
    expect(isPathAllowed('apps/web/src/hooks/useAuthToken.ts')).toBe(false);
    expect(isPathAllowed('packages/shared/src/types/credentials.ts')).toBe(false);
  });

  it('denies node_modules / dist / build / .git even when matched by **', () => {
    expect(isPathAllowed('apps/web/src/pages/node_modules/anything.tsx')).toBe(false);
    expect(isPathAllowed('docs/dist/foo.md')).toBe(false);
    expect(isPathAllowed('packages/shared/src/build/x.ts')).toBe(false);
    expect(isPathAllowed('apps/web/src/.git/HEAD')).toBe(false);
  });

  it('denies test/spec files (noise reduction for search)', () => {
    expect(isPathAllowed('packages/shared/src/types/api-contracts.test.ts')).toBe(false);
    expect(isPathAllowed('apps/web/src/components/Sidebar.spec.tsx')).toBe(false);
  });
});

describe('resolveSafePath', () => {
  it('resolves a normal relative path inside repo', () => {
    const abs = resolveSafePath('apps/web/src/pages/HomePage.tsx', REPO);
    expect(abs).toBe(path.resolve(REPO, 'apps/web/src/pages/HomePage.tsx'));
  });

  it('rejects path traversal via ../', () => {
    expect(resolveSafePath('../../etc/passwd', REPO)).toBeNull();
    expect(resolveSafePath('apps/web/../../../etc/passwd', REPO)).toBeNull();
    expect(resolveSafePath('a/b/../../../../etc/passwd', REPO)).toBeNull();
  });

  it('rejects absolute paths', () => {
    expect(resolveSafePath('/etc/passwd', REPO)).toBeNull();
    expect(resolveSafePath('/app/apps/web/src/pages/x.tsx', REPO)).toBeNull();
  });

  it('rejects empty and NUL-containing paths', () => {
    expect(resolveSafePath('', REPO)).toBeNull();
    expect(resolveSafePath('apps/web/src\0/pages/HomePage.tsx', REPO)).toBeNull();
  });
});

describe('resolveAndAuthorize (end-to-end safety)', () => {
  it('returns absPath + relPath for normal allowlisted file', () => {
    const res = resolveAndAuthorize('apps/web/src/pages/HomePage.tsx', REPO);
    expect(res).not.toBeNull();
    expect(res?.relPath).toBe('apps/web/src/pages/HomePage.tsx');
  });

  it('returns null for blocklist match (env, auth, admin)', () => {
    expect(resolveAndAuthorize('apps/web/.env', REPO)).toBeNull();
    expect(resolveAndAuthorize('apps/web/src/pages/auth/login.tsx', REPO)).toBeNull();
    expect(resolveAndAuthorize('docs/admin/notes.md', REPO)).toBeNull();
  });

  it('returns null for path traversal even if final path looks allowlisted', () => {
    expect(
      resolveAndAuthorize('apps/web/src/pages/../../../../etc/passwd', REPO),
    ).toBeNull();
  });

  it('returns null for paths outside allowlist', () => {
    expect(resolveAndAuthorize('package.json', REPO)).toBeNull();
    expect(resolveAndAuthorize('apps/api/src/main.ts', REPO)).toBeNull();
    expect(resolveAndAuthorize('tools/check-features-catalog.mjs', REPO)).toBeNull();
  });

  it('returns null for absolute requested path', () => {
    expect(resolveAndAuthorize('/etc/passwd', REPO)).toBeNull();
  });
});
