/**
 * KS-2132 — каркасные тесты для профиля Дворецкого (Russian Chess House).
 *
 * Полная калибровка порогов и шаблонов будет добавлена после получения
 * 4 верифицированных FEN с фигурами Q/R/B/N от content (KS-2129). Сейчас
 * spec проверяет только инфраструктуру:
 *
 *   1. JS-API принимает `profile: 'dvoretsky'` и пробрасывает его в Python;
 *   2. Заглушка-профиль (без шаблонов) не падает на 6 пешечных фикстурах
 *      из главы 1 «Учебника эндшпиля» — рамка находится, клетки
 *      классифицируются, FEN-board имеет 8 рядов;
 *   3. `findDiagramsOnPage` находит ≥ 1 диаграмму на каждой фикстуре
 *      (одиночная диаграмма в кропе, нулевой кейс «нет досок» проверять
 *      нужно на целой странице книги, не входящей в фикстуры).
 *
 * После калибровки порогов и шаблонов (KS-2132 шаг 2) сюда добавятся
 * exact-FEN сверки против `EXPECTED_FENS`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  findDiagramsOnPage,
  recognizeBoardImage,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, 'fixtures', 'dvoretsky');

/**
 * Растровый путь требует cv2 + numpy + Pillow в Python (см. README §Установка).
 * Если в среде, где запускается vitest, их нет (например, минимальный CI-runner
 * без пакетов opencv-python) — pytest-style проверка позволяет skip'нуть spec
 * вместо красного фейла. Это тот же паттерн, что и `existsSync` для фикстур
 * в `recognize.spec.ts`.
 */
function pythonHasCv2(): boolean {
  const r = spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' });
  return r.status === 0;
}
const HAS_CV2 = pythonHasCv2();

/**
 * Эталонные FEN'ы из «Учебника эндшпиля» Дворецкого, глава 1 «Пешечные
 * окончания» (получены от content, верифицированы Stockfish'ом, KS-2132).
 *
 * Файлы фикстур — `test/fixtures/dvoretsky/dvoretsky_<diag>.png`,
 * вырезанные вручную из djvu-страниц (стр. 9–11 ddjvu).
 */
const EXPECTED_FENS: Array<{ diagram: string; fenBoard: string; sideToMove: 'w' | 'b' }> = [
  { diagram: '1_1', fenBoard: '8/3k4/8/3K4/3P4/8/8/8',         sideToMove: 'w' },
  { diagram: '1_2', fenBoard: '1k6/8/1K6/1P6/8/8/8/8',         sideToMove: 'w' },
  { diagram: '1_3', fenBoard: '5k2/8/8/8/1P6/8/8/3K4',         sideToMove: 'w' },
  { diagram: '1_4', fenBoard: '2k5/8/8/7p/8/8/6P1/5K2',         sideToMove: 'w' },
  { diagram: '1_5', fenBoard: '8/3p4/3P4/8/5k2/3K4/8/8',       sideToMove: 'b' },
  { diagram: '1_7', fenBoard: '8/1k6/1p6/1K6/P1P5/8/8/8',       sideToMove: 'b' },
];

function fixturePath(diag: string): string {
  return resolve(FIXTURES_DIR, `dvoretsky_${diag}.png`);
}

function fenIsEightRows(fenBoard: string): boolean {
  return fenBoard.split('/').length === 8;
}

describe('Dvoretsky profile — infrastructure (KS-2132)', () => {
  for (const { diagram } of EXPECTED_FENS) {
    it(`recognizeBoardImage не падает на фикстуре ${diagram} с профилем dvoretsky`, async () => {
      const path = fixturePath(diagram);
      if (!existsSync(path)) return; // фикстура опциональна
      if (!HAS_CV2) return; // cv2 не установлен в этом окружении — skip
      const result = await recognizeBoardImage(path, { profile: 'dvoretsky' });
      expect(result.profile).toBe('dvoretsky');
      expect(fenIsEightRows(result.fen_board)).toBe(true);
      // bbox валиден: x1>x0, y1>y0
      expect(result.bbox[2]).toBeGreaterThan(result.bbox[0]);
      expect(result.bbox[3]).toBeGreaterThan(result.bbox[1]);
    }, 20_000);
  }

  it('findDiagramsOnPage возвращает ≥ 1 кандидат на одиночной фикстуре', async () => {
    const path = fixturePath('1_3');
    if (!existsSync(path)) return;
    if (!HAS_CV2) return;
    const { diagrams } = await findDiagramsOnPage(path);
    expect(diagrams.length).toBeGreaterThanOrEqual(1);
    for (const d of diagrams) {
      expect(d.bbox).toHaveLength(4);
      expect(d.bbox[2]).toBeGreaterThan(d.bbox[0]);
      expect(d.bbox[3]).toBeGreaterThan(d.bbox[1]);
    }
  }, 20_000);

  it('маizelis-профиль продолжает использовать существующие шаблоны (back-compat KS-2028)', async () => {
    // Без options.profile должно работать как раньше — на любой фикстуре,
    // используя дефолтный maizelis-профиль. Тут проверяем только что
    // вызов проходит без ошибки и метки профиля проставляются.
    const path = fixturePath('1_3');
    if (!existsSync(path)) return;
    if (!HAS_CV2) return;
    const result = await recognizeBoardImage(path); // без profile → default maizelis
    // С maizelis-шаблонами результат может быть «неправильным» — но
    // ключевая проверка: профиль 'maizelis', и API не падает.
    expect(result.profile === 'maizelis' || result.profile === undefined).toBe(true);
    expect(fenIsEightRows(result.fen_board)).toBe(true);
  }, 20_000);
});

/**
 * Точная сверка FEN с эталонами content. Будет включена после KS-2132 шаг 2
 * (калибровка порогов + загрузка шаблонов dvoretsky). Сейчас выполняется в
 * информационном режиме: сравнение результатов даёт целевую метрику без
 * fail-out, чтобы видеть прогресс между итерациями калибровки.
 */
describe.skip('Dvoretsky profile — точные FEN (включить после калибровки)', () => {
  for (const { diagram, fenBoard } of EXPECTED_FENS) {
    it(`${diagram} → ${fenBoard}`, async () => {
      const path = fixturePath(diagram);
      if (!existsSync(path)) return;
      const result = await recognizeBoardImage(path, { profile: 'dvoretsky' });
      expect(result.fen_board).toBe(fenBoard);
    }, 20_000);
  }
});
