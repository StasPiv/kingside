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
const BOARD_RECOGNIZE_PY = resolve(__dirname, '..', 'src', 'python', 'board_recognize.py');

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

/* ───────────────────────────────────────────────────────────────────
 * Universal recognizer (KS-2362 / ADR-040 Stage 3).
 *
 * Под капотом — `src/python/board_recognize.py`: Stage 1 (board_detect.py)
 * → Stage 2 (ONNX MobileNetV3-Small из KS-2361) → Stage 3 (FEN + ориентация
 * + sanity). Универсальный: работает с любым piece-set'ом (lichess, chess.com,
 * наш default, фото с углом). Это *дополнение* к существующим
 * `recognizeBoardImage` (Майзелис) и `recognizePdfBoards` (Chess-Merida) —
 * не замена.
 *
 * `recognizeUniversal()` принимает поле `profile`:
 *
 *   - `'generic'` — только новый универсальный pipeline. Требует ONNX-модель
 *     (передаётся через `modelPath` или env `BOARD_RECOG_MODEL_PATH`).
 *   - `'maizelis'` / `'dvoretsky'` — старый растровый recognizer.py.
 *   - `'auto'` (по умолчанию) — пробуем generic; если detect/inference
 *     провалился, sanity-чек упал или > 20% клеток с низкой уверенностью,
 *     откатываемся на `maizelis`.
 *
 * Возвращает либо `UniversalRecognizeResult` (generic-путь, включает
 * `cells`/`low_confidence_cells`/`sanity`), либо `RecognizeResult` (старый
 * путь). Поле `usedProfile` всегда говорит, какой путь сработал.
 * ─────────────────────────────────────────────────────────────────── */

/** Профиль для `recognizeUniversal()`. */
export type UniversalProfile = 'auto' | 'generic' | 'maizelis' | 'dvoretsky';

/** Одна клетка из generic-пути (KS-2362). */
export interface UniversalCell {
  row: number;
  col: number;
  square: string;
  bg: 'l' | 'd';
  /** Метка из 13-классового набора (`empty`, `wK`, ..., `bP`). */
  predicted: string;
  /** Тот же набор в FEN-нотации (`.`, `K`, ..., `p`). */
  piece: string;
  /** Top-1 softmax probability ∈ [0, 1]. */
  confidence: number;
  /** Top-3 предсказаний с вероятностями (для UI/debug). */
  top3: Array<{ label: string; prob: number }>;
}

/** Результат sanity-проверки FEN (count'ы фигур, пешки на крайних рангах…). */
export interface UniversalSanity {
  valid: boolean;
  issues: string[];
  counts: Record<string, number>;
}

/** Результат `recognizeUniversal()` для generic-пути. */
export interface UniversalRecognizeResult {
  success: true;
  usedProfile: 'generic';
  fen: string;
  fen_board: string;
  orientation: Orientation;
  bbox: [number, number, number, number];
  detect: {
    method: string;
    confidence: number;
    corners: Array<[number, number]>;
    image_size: [number, number];
  };
  cells: UniversalCell[];
  low_confidence_cells: UniversalCell[];
  sanity: UniversalSanity;
  model_path: string;
}

/** Результат `recognizeUniversal()` для legacy-путей (Maizelis/Dvoretsky). */
export interface UniversalLegacyResult extends RecognizeResult {
  success: true;
  usedProfile: 'maizelis' | 'dvoretsky';
}

export type AnyUniversalResult = UniversalRecognizeResult | UniversalLegacyResult;

export interface RecognizeUniversalOptions {
  /** Профиль: `auto` (default) / `generic` / `maizelis` / `dvoretsky`. */
  profile?: UniversalProfile;
  /** Ориентация. Для generic-пути `'auto'` (default) определяется по королям. */
  orientation?: Orientation | 'auto';
  /**
   * Путь к ONNX-модели для generic-пути (KS-2361).
   * Если не задан — используется env `BOARD_RECOG_MODEL_PATH`.
   */
  modelPath?: string;
  /** Опциональная UNet-модель для board_detect fallback. */
  unetModelPath?: string;
  /** Cells с top-1 prob ниже этого порога попадают в `low_confidence_cells`. */
  lowConfidenceThreshold?: number;
  /** Путь к python (default `python3`). */
  pythonPath?: string;
  /** Альтернативная картинка-источник шаблонов для legacy-пути. */
  templatesImage?: string;
}

/** Поведение auto-fallback'а из generic в maizelis. */
interface AutoFallbackThresholds {
  /** Минимальная доля cells с conf ≥ low-threshold. Меньше → fallback. */
  minHighConfidenceFraction: number;
}

const AUTO_FALLBACK_DEFAULTS: AutoFallbackThresholds = {
  minHighConfidenceFraction: 0.8,
};

/**
 * Универсальное распознавание шахматной диаграммы (KS-2362).
 *
 * Возвращает либо результат generic-пути (с per-cell диагностикой), либо
 * legacy-результат (Maizelis/Dvoretsky). Поле `usedProfile` всегда указывает,
 * какой путь сработал. На полностью неуспешный результат бросает ошибку.
 */
export async function recognizeUniversal(
  imagePath: string,
  options: RecognizeUniversalOptions = {},
): Promise<AnyUniversalResult> {
  const {
    profile = 'auto',
    orientation = 'auto',
    modelPath,
    unetModelPath,
    lowConfidenceThreshold = 0.85,
    pythonPath = 'python3',
    templatesImage,
  } = options;

  // 1. Forced legacy paths — нет смысла трогать generic.
  if (profile === 'maizelis' || profile === 'dvoretsky') {
    const legacy = await recognizeBoardImage(imagePath, {
      orientation: orientation === 'auto' ? 'white' : orientation,
      pythonPath,
      templatesImage,
      profile,
    });
    return { ...legacy, success: true, usedProfile: profile };
  }

  // 2. Generic / auto — сначала пытаемся universal pipeline.
  let genericResult: UniversalRecognizeResult | null = null;
  let genericError: Error | null = null;
  try {
    genericResult = await runGeneric(imagePath, {
      orientation,
      modelPath,
      unetModelPath,
      lowConfidenceThreshold,
      pythonPath,
    });
  } catch (e) {
    genericError = e as Error;
  }

  if (profile === 'generic') {
    if (genericResult) return genericResult;
    throw genericError ?? new Error('recognizeUniversal: generic path failed');
  }

  // 3. profile === 'auto': принимаем generic-результат если он валиден и
  //    достаточно уверенный; иначе fallback на maizelis.
  if (genericResult && isGenericResultAcceptable(genericResult, AUTO_FALLBACK_DEFAULTS)) {
    return genericResult;
  }
  const legacy = await recognizeBoardImage(imagePath, {
    orientation: orientation === 'auto' ? 'white' : orientation,
    pythonPath,
    templatesImage,
    profile: 'maizelis',
  });
  return { ...legacy, success: true, usedProfile: 'maizelis' };
}

/** Сырой запуск generic Python-скрипта с обработкой "success: false". */
async function runGeneric(
  imagePath: string,
  opts: {
    orientation: Orientation | 'auto';
    modelPath?: string;
    unetModelPath?: string;
    lowConfidenceThreshold: number;
    pythonPath: string;
  },
): Promise<UniversalRecognizeResult> {
  const args: string[] = [
    imagePath,
    '--orientation', opts.orientation,
    '--low-confidence-threshold', String(opts.lowConfidenceThreshold),
    '--json',
  ];
  if (opts.modelPath) args.push('--model', opts.modelPath);
  if (opts.unetModelPath) args.push('--unet-model', opts.unetModelPath);

  type Raw = {
    success: boolean;
    error?: string;
    stage?: string | null;
  } & Partial<Omit<UniversalRecognizeResult, 'success' | 'usedProfile'>>;

  const raw = await runJsonScript<Raw>(BOARD_RECOGNIZE_PY, args, opts.pythonPath);
  if (!raw.success) {
    throw new Error(
      `board_recognize.py failed at stage=${raw.stage ?? 'unknown'}: ${raw.error ?? 'no error message'}`,
    );
  }
  return { ...(raw as UniversalRecognizeResult), success: true, usedProfile: 'generic' };
}

function isGenericResultAcceptable(
  result: UniversalRecognizeResult,
  thresholds: AutoFallbackThresholds,
): boolean {
  if (!result.sanity?.valid) return false;
  const total = result.cells.length;
  if (total === 0) return false;
  const highConf = total - result.low_confidence_cells.length;
  const fraction = highConf / total;
  return fraction >= thresholds.minHighConfidenceFraction;
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
