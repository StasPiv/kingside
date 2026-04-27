/**
 * KS-2028 — программный API распознавания диаграммы Майзелиса в FEN.
 *
 * Под капотом — Python-скрипт `src/python/recognizer.py`, использующий
 * OpenCV для детекции рамки доски, нарезки клеток и сопоставления с
 * заранее извлечёнными шаблонами фигур. JS-обёртка вызывает интерпретатор
 * через `child_process.spawn` и парсит JSON-вывод.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Путь к Python-скрипту. Решается относительно `dist/index.js` после tsc-сборки. */
const RECOGNIZER_PY = resolve(__dirname, '..', 'src', 'python', 'recognizer.py');

export type Orientation = 'white' | 'black';

export interface CellResult {
  /** 0 — верхний ряд изображения; для orientation=white это ранг 8. */
  row: number;
  /** 0 — самый левый столбец; для orientation=white это файл `a`. */
  col: number;
  /** Алгебраическая координата клетки с учётом ориентации (например, `e4`). */
  square: string;
  /** Цвет клетки: `l` — светлая, `d` — тёмная. */
  bg: 'l' | 'd';
  /** Распознанная фигура: `.` для пустой клетки, иначе FEN-символ. */
  piece: string;
  /** Confidence ∈ [-1, 1] (NCC); для пустой клетки — 1.0. */
  confidence: number;
}

export interface RecognizeResult {
  /** Полный FEN с фиксированным side-to-move/castling-частью `w - - 0 1`. */
  fen: string;
  /** Только board-часть FEN (`8/8/...`). */
  fen_board: string;
  /** Эффективная ориентация. */
  orientation: Orientation;
  /** Inner-bbox доски в исходных координатах изображения [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Клетки с подозрительно низким NCC — кандидаты на ручной просмотр. */
  low_confidence_cells: CellResult[];
  /** Полный список 64 клеток с предсказаниями и метаданными. */
  cells: CellResult[];
}

export interface RecognizeOptions {
  orientation?: Orientation;
  /** Путь к интерпретатору Python (по умолчанию `python3`). */
  pythonPath?: string;
  /** Альтернативная картинка-источник шаблонов вместо встроенных. */
  templatesImage?: string;
}

/**
 * Распознать шахматную диаграмму. Возвращает полный JSON-результат
 * Python-скрипта (см. RecognizeResult).
 */
export async function recognizeBoardImage(
  imagePath: string,
  options: RecognizeOptions = {},
): Promise<RecognizeResult> {
  const { orientation = 'white', pythonPath = 'python3', templatesImage } = options;
  const args = [RECOGNIZER_PY, imagePath, '--orientation', orientation, '--json'];
  if (templatesImage) {
    args.push('--templates', templatesImage);
  }

  return new Promise<RecognizeResult>((res, rej) => {
    const proc = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c) => stdoutChunks.push(c));
    proc.stderr.on('data', (c) => stderrChunks.push(c));
    proc.on('error', rej);
    proc.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        rej(new Error(
          `board-image-to-fen recognizer.py exited with code ${code}: ${stderr.trim()}`,
        ));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      try {
        const parsed = JSON.parse(stdout) as RecognizeResult;
        res(parsed);
      } catch (e) {
        rej(new Error(`board-image-to-fen: failed to parse Python output: ${(e as Error).message}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/** Удобный шорткат: вернуть только board-часть FEN. */
export async function recognizeBoardFen(
  imagePath: string,
  options: RecognizeOptions = {},
): Promise<string> {
  const result = await recognizeBoardImage(imagePath, options);
  return result.fen_board;
}
