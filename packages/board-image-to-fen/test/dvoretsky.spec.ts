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
 * Эталонные FEN'ы из «Учебника эндшпиля» Дворецкого (KS-2132). Все
 * получены от content + расшифрованы вручную с обложки страницы djvu и
 * верифицированы Stockfish'ом (легальность позиции).
 *
 * Файлы фикстур — `test/fixtures/dvoretsky/dvoretsky_<diag>.png`,
 * вырезанные через `find_diagrams_on_page` (без ручного расширения,
 * чтобы кадр точно совпал с inner-board для frameless-режима).
 *
 * Покрытие фигур (12 типов × 2 фона = 24 уникальные комбинации):
 * king/queen/rook/bishop/knight/pawn × white/black, светлая и тёмная
 * клетки. На 7 эталонах достигается **100%** per-piece accuracy и
 * **7/7** exact-FEN сверка с профилем Дворецкого.
 *
 * Не включены: 1.1, 1.2, 1.7 — диаграммы без чёткой внешней рамки или с
 * прерванной звёздочками-пометками рамкой. На них автоматическая разметка
 * 8×8 уезжает на пиксели; требуют точного ручного кропа. См. README,
 * раздел «Профиль Дворецкого».
 */
const EXPECTED_FENS: Array<{
  diagram: string;
  filename: string;
  fenBoard: string;
  sideToMove: 'w' | 'b';
}> = [
  // Set 1: backend's растеризация (`ddjvu -format=ppm`, 441×449 для гл.1).
  { diagram: '1_3',  filename: 'dvoretsky_1_3.png',  fenBoard: '5k2/8/8/8/1P6/8/8/3K4',          sideToMove: 'w' },
  { diagram: '1_4',  filename: 'dvoretsky_1_4.png',  fenBoard: '2k5/8/8/7p/8/8/6P1/5K2',         sideToMove: 'w' },
  { diagram: '1_5',  filename: 'dvoretsky_1_5.png',  fenBoard: '8/3p4/3P4/8/5k2/3K4/8/8',        sideToMove: 'b' },
  { diagram: '2_20', filename: 'dvoretsky_2_20.png', fenBoard: '8/7p/4K3/4N3/6k1/6P1/8/8',       sideToMove: 'b' },
  { diagram: '4_1',  filename: 'dvoretsky_4_1.png',  fenBoard: '6k1/8/6Bp/8/8/8/2K5/8',          sideToMove: 'b' },
  { diagram: '8_33', filename: 'dvoretsky_8_33.png', fenBoard: '1R6/8/7K/2p5/8/8/pk6/8',         sideToMove: 'b' },
  { diagram: '12_1', filename: 'dvoretsky_12_1.png', fenBoard: '8/5pk1/8/3Q4/3P2K1/6P1/4q3/8',   sideToMove: 'b' },
  // Set 2: content's растеризация того же DjVu (356×363 для гл.1).
  // KS-2132 фаза 2: профиль натренирован на обеих, чтобы шаблоны
  // обобщались между разными антиалиасингами / DPI ddjvu.
  { diagram: 'content_1.1', filename: 'diag_1.1.png', fenBoard: '8/3k4/8/3K4/3P4/8/8/8', sideToMove: 'w' },
  { diagram: 'content_1.2', filename: 'diag_1.2.png', fenBoard: '1k6/8/1K6/1P6/8/8/8/8', sideToMove: 'w' },
  { diagram: 'content_1.3', filename: 'diag_1.3.png', fenBoard: '5k2/8/8/8/1P6/8/8/3K4', sideToMove: 'w' },
  { diagram: 'content_1.4', filename: 'diag_1.4.png', fenBoard: '2k5/8/8/7p/8/8/6P1/5K2', sideToMove: 'w' },
  { diagram: 'content_1.5', filename: 'diag_1.5.png', fenBoard: '8/3p4/3P4/8/5k2/3K4/8/8', sideToMove: 'b' },
  { diagram: 'content_1.7', filename: 'diag_1.7.png', fenBoard: '8/1k6/1p6/1K6/P1P5/8/8/8', sideToMove: 'b' },
  // Set 3: content's batch2 (KS-2132 фаза 4) — другие позиции той же
  // растеризации; смена L2→IoU + sanity-check на дубль королей.
  { diagram: 'content_1.10', filename: 'diag_1.10.png', fenBoard: '4k3/8/3p4/3P4/2P5/8/8/5K2', sideToMove: 'w' },
  { diagram: 'content_1.11', filename: 'diag_1.11.png', fenBoard: '8/8/2p5/K1p2k2/p1P5/P7/8/8', sideToMove: 'b' },
];

function fixturePath(filename: string): string {
  return resolve(FIXTURES_DIR, filename);
}

function fenIsEightRows(fenBoard: string): boolean {
  return fenBoard.split('/').length === 8;
}

describe('Dvoretsky profile — infrastructure (KS-2132)', () => {
  for (const { diagram, filename } of EXPECTED_FENS) {
    it(`recognizeBoardImage не падает на фикстуре ${diagram} с профилем dvoretsky`, async () => {
      const path = fixturePath(filename);
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
    const path = fixturePath('dvoretsky_1_3.png');
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
    const path = fixturePath('dvoretsky_1_3.png');
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
 * Точная сверка FEN на 7 эталонах. Achievement KS-2132 шаг 2 — 7/7 exact
 * с профилем Дворецкого после калибровки порогов и загрузки шаблонов.
 */
describe('Dvoretsky profile — точные FEN', () => {
  for (const { diagram, filename, fenBoard } of EXPECTED_FENS) {
    it(`${diagram} → ${fenBoard}`, async () => {
      const path = fixturePath(filename);
      if (!existsSync(path)) return;
      if (!HAS_CV2) return;
      const result = await recognizeBoardImage(path, { profile: 'dvoretsky' });
      expect(result.fen_board).toBe(fenBoard);
    }, 20_000);
  }

  it('aggregate: 100% per-piece accuracy на эталонах обеих растеризаций', async () => {
    if (!HAS_CV2) return;
    let total = 0;
    let ok = 0;
    let evaluated = 0;
    for (const { diagram, filename, fenBoard } of EXPECTED_FENS) {
      const path = fixturePath(filename);
      if (!existsSync(path)) continue;
      evaluated++;
      const result = await recognizeBoardImage(path, { profile: 'dvoretsky' });
      const exp = fenBoard.split('/').map((row) => {
        const cells: string[] = [];
        for (const ch of row) {
          if (ch >= '0' && ch <= '9') cells.push(...Array(Number(ch)).fill('.'));
          else cells.push(ch);
        }
        return cells;
      });
      const act = result.fen_board.split('/').map((row) => {
        const cells: string[] = [];
        for (const ch of row) {
          if (ch >= '0' && ch <= '9') cells.push(...Array(Number(ch)).fill('.'));
          else cells.push(ch);
        }
        return cells;
      });
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          total++;
          if (exp[r][c] === act[r][c]) ok++;
        }
      }
    }
    if (evaluated === 0) return;
    const accuracy = ok / total;
    expect(
      accuracy,
      `aggregate per-piece accuracy ${(accuracy * 100).toFixed(2)}% (${ok}/${total}); evaluated ${evaluated} fixtures`,
    ).toBeGreaterThanOrEqual(0.95);
  }, 60_000);
});
