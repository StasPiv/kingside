/**
 * Программный API распознавания шахматной диаграммы → FEN.
 *
 * Два кода-пути под одной обёрткой:
 *   - `recognizeBoardImage` (KS-2028) — растровое распознавание стиля
 *     Майзелиса через `src/python/recognizer.py` (OpenCV, template matching).
 *   - `recognizePdfBoards` (KS-2030) — детерминированный разбор PDF с
 *     диаграммами на шрифте Chess-Merida через
 *     `src/python/pdf_recognizer.py` (PyMuPDF, fitz).
 *
 * Обе функции вызывают Python через `child_process.spawn` и парсят
 * JSON-вывод. Ошибки Python-уровня поднимаются в JS как `Error`.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Пути к Python-скриптам. Решаются относительно `dist/index.js` после tsc-сборки. */
const RECOGNIZER_PY = resolve(__dirname, '..', 'src', 'python', 'recognizer.py');
const PDF_RECOGNIZER_PY = resolve(__dirname, '..', 'src', 'python', 'pdf_recognizer.py');

export type Orientation = 'white' | 'black';

/**
 * Профиль шрифта диаграмм (KS-2132).
 *
 *   - `maizelis` — учебник Майзелиса, KS-2028. Профиль по умолчанию.
 *   - `dvoretsky` — «Учебник эндшпиля» Дворецкого (Russian Chess House),
 *     KS-2132. Шаблоны и пороги отличаются от Майзелиса (другая плотность
 *     штриховки тёмных клеток, другой шрифт фигур).
 */
export type RecognizeProfile = 'maizelis' | 'dvoretsky';

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
  /** Имя профиля, по которому шёл матчинг (KS-2132). */
  profile?: RecognizeProfile;
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
  /** Профиль шрифта диаграмм. По умолчанию `'maizelis'`. */
  profile?: RecognizeProfile;
}

/** Одна доска, найденная на странице книги (KS-2132 мульти-диаграммный pre-step). */
export interface PageDiagram {
  /** Порядковый индекс на странице (0..N-1, в порядке чтения). */
  index: number;
  /** Bbox в исходных координатах изображения [x0, y0, x1, y1] с padding'ом. */
  bbox: [number, number, number, number];
}

export interface ScanPageResult {
  diagrams: PageDiagram[];
}

export interface ScanPageOptions {
  /** Путь к интерпретатору Python (по умолчанию `python3`). */
  pythonPath?: string;
}

/** Одна доска, найденная в PDF. */
export interface PdfBoardResult {
  /** Номер страницы (1-indexed). */
  page: number;
  /** Индекс доски на странице (0..N-1, в порядке чтения сверху-вниз/слева-направо). */
  diagram: number;
  /** Полный FEN с фиксированным side-to-move/castling-частью `w - - 0 1`. */
  fen: string;
  /** Только board-часть FEN. */
  fen_board: string;
  /** Эффективная ориентация. */
  orientation: Orientation;
  /** Bbox доски в координатах PDF-страницы [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
}

export interface RecognizePdfOptions {
  /** Распознать только указанную страницу (1-indexed). Взаимоисключаем с `allPages`. */
  page?: number;
  /** Обойти все страницы. По умолчанию `true`, если `page` не указан. */
  allPages?: boolean;
  /** Ориентация (по умолчанию `'white'`). */
  orientation?: Orientation;
  /** Путь к интерпретатору Python (по умолчанию `python3`). */
  pythonPath?: string;
}

/** Универсальный запуск Python-скрипта с возвратом распарсенного JSON. */
async function runJsonScript<T>(scriptPath: string, args: string[], pythonPath: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const proc = spawn(pythonPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c) => stdoutChunks.push(c));
    proc.stderr.on('data', (c) => stderrChunks.push(c));
    proc.on('error', rej);
    proc.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        rej(new Error(
          `board-image-to-fen ${scriptPath} exited with code ${code}: ${stderr.trim()}`,
        ));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      try {
        res(JSON.parse(stdout) as T);
      } catch (e) {
        rej(new Error(
          `board-image-to-fen: failed to parse Python output: ${(e as Error).message}\nstdout: ${stdout.slice(0, 500)}`,
        ));
      }
    });
  });
}

/**
 * Распознать шахматную диаграмму (растр). По умолчанию использует профиль
 * Майзелиса (KS-2028); для книги Дворецкого передавай `profile: 'dvoretsky'`
 * (KS-2132). Возвращает полный JSON-результат Python-скрипта
 * (см. `RecognizeResult`).
 */
export async function recognizeBoardImage(
  imagePath: string,
  options: RecognizeOptions = {},
): Promise<RecognizeResult> {
  const {
    orientation = 'white',
    pythonPath = 'python3',
    templatesImage,
    profile = 'maizelis',
  } = options;
  const args = [imagePath, '--orientation', orientation, '--json', '--profile', profile];
  if (templatesImage) {
    args.push('--templates', templatesImage);
  }
  return runJsonScript<RecognizeResult>(RECOGNIZER_PY, args, pythonPath);
}

/**
 * Найти все шахматные доски на странице книги (KS-2132).
 *
 * Полные страницы Дворецкого содержат 1–4 диаграммы вперемешку с текстом и
 * подписями (`1.7`, `?`, `1-6`); основной `recognizeBoardImage` рассчитан
 * на одну изолированную доску. Этот pre-step возвращает bbox-ы кандидатов
 * (с небольшим padding'ом), каждый из которых потом можно вырезать и
 * подать в `recognizeBoardImage`.
 *
 * Ограничение: диаграммы без внешней рамки (например, иллюстрация 1.1 в
 * Дворецком) могут быть пропущены — для них вырежи кроп вручную.
 */
export async function findDiagramsOnPage(
  imagePath: string,
  options: ScanPageOptions = {},
): Promise<ScanPageResult> {
  const { pythonPath = 'python3' } = options;
  const args = [imagePath, '--scan-page'];
  return runJsonScript<ScanPageResult>(RECOGNIZER_PY, args, pythonPath);
}

/** Удобный шорткат: вернуть только board-часть FEN растровой диаграммы. */
export async function recognizeBoardFen(
  imagePath: string,
  options: RecognizeOptions = {},
): Promise<string> {
  const result = await recognizeBoardImage(imagePath, options);
  return result.fen_board;
}

/**
 * Распознать диаграммы Chess-Merida в PDF (KS-2030). Возвращает массив
 * найденных досок (по странице/диаграмме), отсортированный в порядке чтения.
 *
 * Если `page` не указан и `allPages !== false` — обрабатываются все страницы.
 */
export async function recognizePdfBoards(
  pdfPath: string,
  options: RecognizePdfOptions = {},
): Promise<PdfBoardResult[]> {
  const { page, allPages, orientation = 'white', pythonPath = 'python3' } = options;
  if (page !== undefined && allPages === true) {
    throw new Error('recognizePdfBoards: page and allPages are mutually exclusive');
  }
  const useAllPages = page === undefined && allPages !== false;

  const args = [pdfPath, '--orientation', orientation, '--json'];
  if (page !== undefined) {
    args.push('--page', String(page));
  } else if (useAllPages) {
    args.push('--all-pages');
  }
  return runJsonScript<PdfBoardResult[]>(PDF_RECOGNIZER_PY, args, pythonPath);
}
