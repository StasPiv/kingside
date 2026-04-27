/**
 * KS-2017 / B-1: тесты CLI.
 *  - smoke: validate <mini.lesson.yml> → exit 0;
 *  - validate <broken-no-slug> → exit 1;
 *  - validate <broken-bad-fen> → exit 1, упоминает diagrams[0].fen;
 *  - dry-run использует mock fetch и печатает diff (зеркальная БД → unchanged);
 *  - import без --yes печатает «dry-run only»;
 *  - export пишет файлы в out-директорию (mock fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runValidate, runDryRun, runImport, runExport } from '../src/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

let stdoutBuf = '';
let stderrBuf = '';
const writeStdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
  stdoutBuf += String(chunk);
  return true;
});
const writeStderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
  stderrBuf += String(chunk);
  return true;
});

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
});

afterEach(() => {
  // restore не нужен — мы меняем `mockImplementation` повторно при необходимости.
});

describe('CLI: validate', () => {
  it('exit 0 на валидном уроке', async () => {
    const code = await runValidate(join(FIXTURES, 'mini.lesson.yml'), { color: false });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('valid');
    expect(stdoutBuf).toContain('1 lesson(s)');
  });

  it('exit 1 на отсутствующем slug', async () => {
    const code = await runValidate(join(FIXTURES, 'broken-no-slug.lesson.yml'), { color: false });
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/required|slug/i);
  });

  it('exit 1 на битом FEN с указанием шага', async () => {
    const code = await runValidate(join(FIXTURES, 'broken-bad-fen.lesson.yml'), {
      color: false,
    });
    expect(code).toBe(1);
    // Видимый человекочитаемый путь до поля
    expect(stderrBuf).toContain('diagrams[0]');
    expect(stderrBuf).toContain('fen');
  });
});

describe('CLI: dry-run / import (mock fetch)', () => {
  it('dry-run: course не найден → diff с action=create', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify([]), // пустой список курсов
      });
    vi.stubGlobal('fetch', fetchMock);
    const code = await runDryRun(
      join(FIXTURES, 'mini-dir'),
      'http://localhost:3001',
      undefined,
      { color: false },
    );
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('created');
    vi.unstubAllGlobals();
  });

  it('import без --yes: только dry-run, exit 0, не дёргает POST', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify([]),
      });
    vi.stubGlobal('fetch', fetchMock);
    const code = await runImport(
      join(FIXTURES, 'mini-dir'),
      'http://localhost:3001',
      undefined,
      false,
      { color: false },
    );
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('Dry-run only');
    expect(fetchMock).toHaveBeenCalledTimes(1); // только GET courses
    vi.unstubAllGlobals();
  });

  it('import --yes: POST на /lessons/admin/import, ответ 404 → not_implemented', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method });
      if (calls.length === 1) {
        return { ok: true, text: async () => JSON.stringify([]) };
      }
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);
    const code = await runImport(
      join(FIXTURES, 'mini-dir'),
      'http://localhost:3001',
      'admin-token',
      true,
      { color: false },
    );
    expect(code).toBe(2); // not_implemented
    expect(stdoutBuf).toMatch(/admin import endpoint is not deployed/);
    expect(calls.some((c) => c.url.endsWith('/lessons/admin/import') && c.method === 'POST')).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('CLI: export', () => {
  let tmp = '';
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lesson-import-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('пишет course.yml + *.lesson.yml в --out (mock fetch)', async () => {
    const courseId = '11111111-1111-1111-1111-111111111111';
    const lessonId = '22222222-2222-2222-2222-222222222222';
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/lessons/admin/courses')) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify([{ id: courseId, slug: 'capablanca-primer' }]),
        };
      }
      if (u.endsWith(`/lessons/admin/courses/${courseId}`)) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              id: courseId,
              slug: 'capablanca-primer',
              level: 'beginner',
              titleKey: 'lessons.cap.title',
              descriptionKey: 'lessons.cap.desc',
              lessons: [
                {
                  id: lessonId,
                  slug: 'ch1',
                  order: 1,
                  blockKey: 'chapter-1',
                  kind: 'theory',
                  titleKey: 'lessons.ch1.t',
                  summaryKey: 'lessons.ch1.s',
                },
              ],
            }),
        };
      }
      if (u.endsWith(`/lessons/admin/lessons/${lessonId}`)) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              id: lessonId,
              slug: 'ch1',
              order: 1,
              blockKey: 'chapter-1',
              kind: 'theory',
              titleKey: 'lessons.ch1.t',
              summaryKey: 'lessons.ch1.s',
              steps: [
                {
                  id: 'step1',
                  order: 1,
                  type: 'text',
                  payload: { type: 'text', bodyMarkdown: 'hello' },
                },
              ],
            }),
        };
      }
      return { ok: false, status: 404, statusText: 'NF', text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const code = await runExport({
      course: 'capablanca-primer',
      baseUrl: 'http://localhost:3001',
      out: tmp,
      token: 'admin',
    });
    expect(code).toBe(0);
    const courseYml = readFileSync(join(tmp, 'course.yml'), 'utf8');
    expect(courseYml).toMatch(/slug: capablanca-primer/);
    // exporter префиксует файл (order+1).padStart(2,'0') — для order=1 → '02'.
    const lessonYml = readFileSync(join(tmp, '02-ch1.lesson.yml'), 'utf8');
    expect(lessonYml).toMatch(/slug: ch1/);
    expect(lessonYml).toMatch(/type: text/);
    vi.unstubAllGlobals();
  });
});
