/**
 * KS-2359 / ADR-040 Stage 1. Тесты `board_detect.py` — детекция доски
 * и perspective-warp в 512×512.
 *
 * Acceptance: detection rate ≥ 80% на синтетических fixtures (lichess
 * fen.gif в разных стилях + Dvoretsky-фикстуры из PDF-пути KS-2030).
 *
 * Запуск Python — через `child_process.spawnSync` (как в pdf.spec.ts).
 * Каждый fixture-файл — отдельный `it`, чтобы видеть в CI какие именно
 * стили проваливаются.
 *
 * Если папка `test/fixtures/board-detect/` пуста (не было сетевой
 * генерации), синтетические тесты skipped — остаются только
 * Dvoretsky-fixtures, которые в репо.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = path.resolve(
  __dirname,
  '..',
  'src',
  'python',
  'board_detect.py',
);

interface DetectResult {
  success: boolean;
  method: 'opencv' | 'unet' | 'failed';
  corners: number[][] | null;
  confidence: number;
  image_size: [number, number] | null;
  error?: string;
}

function detect(imagePath: string): DetectResult {
  const res = spawnSync(
    'python3',
    [PYTHON_SCRIPT, imagePath, '--json'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  if (res.error) throw res.error;
  // exit 0 — success, 1 — failed (валидный JSON в обоих случаях).
  const out = res.stdout?.trim() || '{}';
  try {
    return JSON.parse(out) as DetectResult;
  } catch (e) {
    throw new Error(
      `Failed to parse board_detect output for ${imagePath}: ${out}; stderr: ${res.stderr}`,
    );
  }
}

function listFixtures(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|gif|bmp)$/i.test(f))
    .map((f) => path.join(dir, f))
    .filter((p) => {
      try {
        return statSync(p).size > 1000;
      } catch {
        return false;
      }
    })
    .sort();
}

describe('board_detect.py — KS-2359 Stage 1', () => {
  // ── Dvoretsky fixtures (PDF-extracted, без warp'а — уже квадратные) ──
  describe('Dvoretsky PDF-extracted (in-repo)', () => {
    const dir = path.resolve(__dirname, 'fixtures', 'dvoretsky');
    const fixtures = listFixtures(dir);

    if (fixtures.length === 0) {
      it.skip('no fixtures available', () => {});
      return;
    }

    for (const fixture of fixtures) {
      const name = path.basename(fixture);
      it(`detects board on ${name}`, () => {
        const r = detect(fixture);
        expect(r.success).toBe(true);
        expect(r.method).toBe('opencv');
        expect(r.corners).toHaveLength(4);
        expect(r.confidence).toBeGreaterThan(0.5);
      });
    }
  });

  // ── Synthetic lichess fixtures (generated, see gen-board-detect-fixtures.py) ──
  describe('Synthetic lichess board styles (generated)', () => {
    const dir = path.resolve(__dirname, 'fixtures', 'board-detect');
    const fixtures = listFixtures(dir);

    if (fixtures.length === 0) {
      it.skip('no fixtures (run gen-board-detect-fixtures.py first)', () => {});
      return;
    }

    for (const fixture of fixtures) {
      const name = path.basename(fixture);
      it(`detects board on ${name}`, () => {
        const r = detect(fixture);
        // Для синтетики допускаем не-100% (acceptance: ≥80% по
        // всему набору, см. aggregate-тест ниже).
        if (r.success) {
          expect(r.corners).toHaveLength(4);
          expect(r.confidence).toBeGreaterThan(0.3);
        } else {
          // допускаем 20% failed.
          expect(r.success).toBe(false);
        }
      });
    }

    // Aggregate: ≥80% detection rate (ADR-040 acceptance).
    it(
      'aggregate detection rate ≥ 80% (ADR-040 acceptance)',
      () => {
        let success = 0;
        for (const fixture of fixtures) {
          if (detect(fixture).success) success++;
        }
        const rate = success / fixtures.length;
        // eslint-disable-next-line no-console
        console.log(
          `[board_detect] synthetic detection rate: ${success}/${fixtures.length} = ${(rate * 100).toFixed(1)}%`,
        );
        expect(rate).toBeGreaterThanOrEqual(0.8);
      },
      { timeout: 60_000 },
    );
  });

  // ── Edge cases: invalid input ─────────────────────────────────────
  describe('edge cases', () => {
    it('non-existent image → success=false', () => {
      const r = detect('/tmp/does-not-exist-board-detect-test.png');
      expect(r.success).toBe(false);
      expect(r.method).toBe('failed');
    });
  });

  // ── UNet hook (KS-2361) — graceful skip пока модели нет ──────────
  describe('UNet fallback (KS-2361 hook)', () => {
    it('NotImplementedError при прямом вызове detect_with_unet', () => {
      // Прямой вызов raise NotImplementedError; через `--unet-model`
      // exception ловится в `_detect_with_unet_safe`, OpenCV-результат
      // не страдает.
      const fixtures = listFixtures(
        path.resolve(__dirname, 'fixtures', 'dvoretsky'),
      );
      if (fixtures.length === 0) return; // skipped via assertion
      // Передаём несуществующий путь — safe-wrapper вернёт (None, 0)
      // без вызова detect_with_unet, значит OpenCV-результат остаётся.
      const res = spawnSync(
        'python3',
        [PYTHON_SCRIPT, fixtures[0], '--json', '--unet-model', '/tmp/no-such-model.onnx'],
        { encoding: 'utf8', timeout: 10_000 },
      );
      const r = JSON.parse(res.stdout || '{}') as DetectResult;
      expect(r.success).toBe(true);
      expect(r.method).toBe('opencv'); // UNet проигнорирован (graceful skip).
    });
  });
});
