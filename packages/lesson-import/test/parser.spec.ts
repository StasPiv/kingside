/**
 * KS-2017 / B-1: тесты parser.ts
 *  - валидный мини-пример из ADR §4.14 → проходит;
 *  - битые YAML / схема → ValidationFailure с понятными сообщениями.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  loadBundle,
  parseLessonYaml,
  parseCourseYaml,
  ValidationFailure,
} from '../src/parser.js';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

describe('parser.ts', () => {
  it('валидирует мини-пример урока (§4.14 ADR)', async () => {
    const path = join(FIXTURES, 'mini.lesson.yml');
    const bundle = await loadBundle(path);
    expect(bundle.lessons).toHaveLength(1);
    expect(bundle.lessons[0]!.data.slug).toBe('ch2-p1-mini');
    expect(bundle.lessons[0]!.data.steps).toHaveLength(3);
  });

  it('валидирует мини-пример курса (через course.yml в директории)', async () => {
    const path = join(FIXTURES, 'mini-dir');
    const bundle = await loadBundle(path);
    expect(bundle.course).toBeDefined();
    expect(bundle.course!.data.slug).toBe('capablanca-primer');
  });

  it('валидирует директорию (course.yml + *.lesson.yml)', async () => {
    const path = join(FIXTURES, 'mini-dir');
    const bundle = await loadBundle(path);
    expect(bundle.course?.data.slug).toBe('capablanca-primer');
    expect(bundle.lessons).toHaveLength(1);
    expect(bundle.lessons[0]!.data.slug).toBe('ch2-p1-mini');
  });

  it('падает на отсутствующем slug урока', async () => {
    const path = join(FIXTURES, 'broken-no-slug.lesson.yml');
    await expect(loadBundle(path)).rejects.toThrow(ValidationFailure);
    try {
      await loadBundle(path);
    } catch (e) {
      const f = e as ValidationFailure;
      expect(f.errors.length).toBeGreaterThan(0);
      expect(f.errors[0]!.file).toBe(path);
      // ошибка должна упоминать что чего-то не хватает
      const allMessages = f.errors.map((er) => er.message).join('\n');
      expect(allMessages).toMatch(/required|slug/i);
    }
  });

  it('падает на неверном FEN внутри диаграммы', async () => {
    const path = join(FIXTURES, 'broken-bad-fen.lesson.yml');
    await expect(loadBundle(path)).rejects.toThrow(ValidationFailure);
    try {
      await loadBundle(path);
    } catch (e) {
      const f = e as ValidationFailure;
      // hum-путь должен содержать steps[0] (text).diagrams[0].fen
      const targets = f.errors
        .map((er) => er.instancePath)
        .filter((p) => p.includes('diagrams[0]'));
      expect(targets.length).toBeGreaterThan(0);
    }
  });

  it('падает на синтаксической ошибке YAML', () => {
    const broken = parseSafe(() =>
      parseLessonYaml('/tmp/bad.yml', 'foo: [unclosed'),
    );
    expect(broken).toBeInstanceOf(ValidationFailure);
    const f = broken as ValidationFailure;
    expect(f.errors[0]!.keyword).toBe('yaml-syntax');
  });

  it('parseCourseYaml принимает валидный course.yml', () => {
    const raw = readFileSync(join(FIXTURES, 'mini.course.yml'), 'utf8');
    const out = parseCourseYaml(join(FIXTURES, 'mini.course.yml'), raw);
    expect(out.data.slug).toBe('capablanca-primer');
    expect(out.data.tags).toEqual(['fundamentals', 'rules', 'capablanca']);
  });
});

function parseSafe(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
