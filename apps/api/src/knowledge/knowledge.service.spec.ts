/**
 * KS-2967 / ADR-063 §11 — интеграционные тесты безопасности
 * KnowledgeService.search и .read через fixture-репозиторий во
 * временной директории. Не зависят от реального дерева монорепо.
 */

import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeService } from './knowledge.service';
import { RipgrepRunner, type RipgrepResult } from './ripgrep-runner';

/**
 * Кастомный мок-runner. В hermetic Jest sandbox реального `rg` нет,
 * поэтому search-тесты подменяют `RipgrepRunner.run` фиксированными
 * результатами. Это покрывает пост-обработку (фильтрация blocklist,
 * limit, mapping в результаты).
 */
class FakeRipgrep extends RipgrepRunner {
  next: RipgrepResult = { kind: 'ok', stdout: '' };
  override async run(): Promise<RipgrepResult> {
    return this.next;
  }
}

function vimgrepLine(p: string, line: number, col: number, text: string): string {
  return `${p}:${line}:${col}:${text}`;
}

describe('KnowledgeService (KS-2967 / ADR-063 §11)', () => {
  let tmpRoot: string;
  let svc: KnowledgeService;
  let fakeRg: FakeRipgrep;
  let prevRepoRoot: string | undefined;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kingside-knowledge-'));
    // Раскладка под allowlist + ловушки blocklist:
    writeFile(
      'apps/web/src/pages/ArchiveGamesPage.tsx',
      [
        '// KS-2068 (F2 / ADR-033 §4)',
        'export function ArchiveGamesPage() {',
        '  // Filters: player, event, eco, since, until, result, minElo, minPly, maxPly, sort',
        '  return null;',
        '}',
      ].join('\n'),
    );
    writeFile(
      'apps/web/src/pages/SettingsPage.tsx',
      [
        'export function SettingsPage() {',
        '  // animationDuration: none / fast / normal = 0 / 100 / 200 ms',
        '  return null;',
        '}',
      ].join('\n'),
    );
    writeFile(
      'apps/web/src/components/Sidebar.tsx',
      'export function Sidebar() { return null; }',
    );
    writeFile(
      'packages/shared/src/constants.ts',
      'export const TIME_CONTROL_PRESETS = { ultraBullet15: "0.25_0" };',
    );
    writeFile(
      'docs/adr/063-assistant-knowledge-source.md',
      '# ADR-063\n\nThe assistant uses knowledge.search and knowledge.read.',
    );
    writeFile('apps/api/README.md', '# api\nSearchable: hello-world-marker.');

    // Blocklist-ловушки:
    writeFile('.env', 'SECRET=very-secret-value\n');
    writeFile('apps/web/.env.production', 'API_KEY=topsecret\n');
    writeFile(
      'apps/api/src/auth/jwt-strategy.ts',
      'export const JWT_SECRET = "should-not-be-readable";',
    );
    writeFile(
      'apps/web/src/components/admin/AdminPanel.tsx',
      'export function AdminPanel() { return null; }',
    );
    writeFile(
      'apps/web/src/pages/ApiKeyConfig.tsx',
      '// the very word KEY in filename triggers blocklist',
    );

    // Огромный файл — для теста file_too_large.
    writeFile(
      'apps/web/src/pages/HugePage.tsx',
      Array(50_000).fill('// line').join('\n'),
    );

    // Файл для теста range_too_large.
    writeFile(
      'apps/web/src/pages/LongPage.tsx',
      Array(2000).fill('// line').join('\n'),
    );

    // Бинарный файл — NUL-байты.
    fs.mkdirSync(path.join(tmpRoot, 'apps/web/src/pages'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'apps/web/src/pages/Binary.tsx'),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x00]),
    );

    prevRepoRoot = process.env.KNOWLEDGE_REPO_ROOT;
    process.env.KNOWLEDGE_REPO_ROOT = tmpRoot;
    fakeRg = new FakeRipgrep();
    svc = new KnowledgeService(fakeRg);
  });

  afterAll(() => {
    if (prevRepoRoot === undefined) delete process.env.KNOWLEDGE_REPO_ROOT;
    else process.env.KNOWLEDGE_REPO_ROOT = prevRepoRoot;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): void {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  // ── search (через мок RipgrepRunner, т.к. реальный rg в jest sandbox недоступен) ──

  it('search returns matches from allowlisted files', async () => {
    fakeRg.next = {
      kind: 'ok',
      stdout: vimgrepLine(
        'apps/web/src/pages/ArchiveGamesPage.tsx',
        3,
        5,
        '  // Filters: player, event, eco, since, until, result, minElo',
      ),
    };
    const res = await svc.search({ q: 'minElo' });
    expect(res.results.length).toBeGreaterThan(0);
    expect(
      res.results.some((r) =>
        r.path.endsWith('apps/web/src/pages/ArchiveGamesPage.tsx'),
      ),
    ).toBe(true);
  });

  it('search includes ±2 lines of context in snippet', async () => {
    fakeRg.next = {
      kind: 'ok',
      stdout: vimgrepLine(
        'apps/web/src/pages/SettingsPage.tsx',
        2,
        5,
        '  // animationDuration: none / fast / normal',
      ),
    };
    const res = await svc.search({ q: 'animationDuration' });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].snippet).toContain('SettingsPage');
  });

  it('search drops post-hoc any rg-leaked blocklist path (.env / auth / admin / *key*)', async () => {
    fakeRg.next = {
      kind: 'ok',
      stdout: [
        vimgrepLine('.env', 1, 1, 'SECRET=very-secret-value'),
        vimgrepLine('apps/api/src/auth/jwt-strategy.ts', 1, 18, 'export const JWT_SECRET'),
        vimgrepLine('apps/web/src/components/admin/AdminPanel.tsx', 1, 1, 'export function AdminPanel'),
        vimgrepLine('apps/web/src/pages/ApiKeyConfig.tsx', 1, 1, '// KEY'),
        vimgrepLine('apps/web/src/pages/ArchiveGamesPage.tsx', 1, 1, '// legit hit'),
      ].join('\n'),
    };
    const res = await svc.search({ q: 'secret' });
    expect(res.results.map((r) => r.path)).toEqual([
      'apps/web/src/pages/ArchiveGamesPage.tsx',
    ]);
  });

  it('search honors limit and slices results down', async () => {
    fakeRg.next = {
      kind: 'ok',
      stdout: Array.from({ length: 10 }, (_, i) =>
        vimgrepLine('apps/web/src/pages/ArchiveGamesPage.tsx', i + 1, 1, `line ${i + 1}`),
      ).join('\n'),
    };
    const res = await svc.search({ q: 'line', limit: 3 });
    expect(res.results.length).toBe(3);
    expect(res.truncated).toBe(true);
  });

  it('search returns 503 ServiceUnavailable when rg backend errors (e.g. ENOENT)', async () => {
    fakeRg.next = { kind: 'error', message: 'spawn rg ENOENT' };
    await expect(svc.search({ q: 'minElo' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('search returns 503 ServiceUnavailable on timeout', async () => {
    fakeRg.next = { kind: 'timeout' };
    await expect(svc.search({ q: 'minElo' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // ── read ────────────────────────────────────────────────────────

  it('read returns a slice from an allowlisted file', async () => {
    const res = await svc.read({
      path: 'apps/web/src/pages/ArchiveGamesPage.tsx',
      startLine: 1,
      endLine: 5,
    });
    expect(res.startLine).toBe(1);
    expect(res.endLine).toBeGreaterThanOrEqual(3);
    expect(res.content).toContain('ArchiveGamesPage');
    expect(res.totalLines).toBeGreaterThan(0);
  });

  it('read 404 for .env (blocklist)', async () => {
    await expect(svc.read({ path: '.env' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.read({ path: 'apps/web/.env.production' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('read 404 for auth/admin paths', async () => {
    await expect(
      svc.read({ path: 'apps/api/src/auth/jwt-strategy.ts' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.read({ path: 'apps/web/src/components/admin/AdminPanel.tsx' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('read 404 for *key* / *token* / *credential* (case-insensitive)', async () => {
    await expect(
      svc.read({ path: 'apps/web/src/pages/ApiKeyConfig.tsx' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('read 404 for path traversal attempts', async () => {
    await expect(svc.read({ path: '../../etc/passwd' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.read({ path: 'apps/web/../../../etc/passwd' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('read 404 for absolute paths', async () => {
    await expect(svc.read({ path: '/etc/passwd' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('read 404 for non-existent files (hide-not-found applies)', async () => {
    await expect(
      svc.read({ path: 'apps/web/src/pages/NotARealPage.tsx' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('read 400 for range > 500 lines', async () => {
    await expect(
      svc.read({
        path: 'apps/web/src/pages/LongPage.tsx',
        startLine: 1,
        endLine: 1000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('read 400 for files larger than 200KB', async () => {
    await expect(
      svc.read({ path: 'apps/web/src/pages/HugePage.tsx' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('read 400 for binary files (NUL-byte detection)', async () => {
    await expect(
      svc.read({ path: 'apps/web/src/pages/Binary.tsx' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('read clamps endLine to totalLines when over file end', async () => {
    const res = await svc.read({
      path: 'apps/web/src/pages/ArchiveGamesPage.tsx',
      startLine: 1,
      endLine: 500,
    });
    expect(res.endLine).toBe(res.totalLines);
  });
});
