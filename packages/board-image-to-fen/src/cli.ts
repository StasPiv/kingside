#!/usr/bin/env node
/**
 * Node CLI для распознавания шахматной диаграммы → FEN.
 *
 * Растровый режим (KS-2028, стиль Майзелиса):
 *
 *   board-image-to-fen <image> [--orientation white|black] [--json] [--templates path]
 *
 * PDF-режим (KS-2030, шрифт Chess-Merida — учебники Калиниченко):
 *
 *   board-image-to-fen <input.pdf> [--page N | --all-pages]
 *                      [--orientation white|black] [--json]
 *
 * Без `--json` — печатает FEN-board (одна строка на доску); с `--json` —
 * подробный документ. Диагностика — в stderr.
 *
 * Под капотом — `src/python/recognizer.py` (растр, OpenCV) или
 * `src/python/pdf_recognizer.py` (PDF, PyMuPDF) через child_process.
 * Маршрутизация — по расширению входного файла.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { realpathSync } from 'node:fs';

import { recognizeUniversal, type UniversalProfile } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RECOGNIZER_PY = resolve(__dirname, '..', 'src', 'python', 'recognizer.py');
const PDF_RECOGNIZER_PY = resolve(__dirname, '..', 'src', 'python', 'pdf_recognizer.py');

interface CliOptions {
  input: string;
  inputKind: 'image' | 'pdf';
  orientation: 'white' | 'black';
  json: boolean;
  templates?: string;
  pythonPath: string;
  page?: number;
  allPages: boolean;
  /**
   * Профиль для растрового пути:
   *   - `maizelis` (KS-2028, default) / `dvoretsky` (KS-2132) — legacy шаблонные.
   *   - `generic` (KS-2362) — универсальный ONNX-пайплайн, требует --model.
   *   - `auto` (KS-2362) — пробует generic, при failure/невалидном FEN
   *     откатывается на maizelis.
   */
  profile: UniversalProfile;
  /** KS-2132. Сканировать страницу на список диаграмм (bbox-ов), не распознавать. */
  scanPage: boolean;
  /** Путь к ONNX-модели для generic/auto (KS-2362). Иначе env BOARD_RECOG_MODEL_PATH. */
  modelPath?: string;
  /** Опциональная UNet-модель для board_detect fallback (KS-2362). */
  unetModelPath?: string;
  /** Порог low-confidence для generic-пути (KS-2362). */
  lowConfidenceThreshold: number;
}

function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    [
      'Usage: board-image-to-fen <input> [options]',
      '',
      '  <input> — image (jpg/png) for the Maizelis raster path,',
      '            or .pdf for the Chess-Merida text path.',
      '',
      'Common options:',
      '  -o, --orientation <side>   white|black (default: white)',
      '      --json                 emit a detailed JSON document',
      '      --python <path>        Python interpreter (default: python3)',
      '  -h, --help                 print this help',
      '  -V, --version              print version',
      '',
      'Image-only options:',
      '      --templates <path>     custom starting-position template image',
      '      --profile <name>       recognition profile (default: auto):',
      '                               auto      — generic, fallback to maizelis',
      '                               generic   — universal CNN (requires --model)',
      '                               maizelis  — KS-2028 raster template matcher',
      '                               dvoretsky — KS-2132 raster template matcher',
      '      --model <path>         ONNX model for generic/auto (KS-2362).',
      '                             Fallback: $BOARD_RECOG_MODEL_PATH.',
      '      --unet-model <path>    optional UNet for board_detect fallback',
      '      --low-confidence <p>   per-cell threshold for generic (default 0.85)',
      '      --scan-page            instead of recognizing the board, list',
      '                             chess-board bboxes detected on the page (JSON)',
      '',
      'PDF-only options:',
      '      --page <N>             recognize a single 1-indexed page',
      '      --all-pages            scan every page (default if neither given)',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = {
    orientation: 'white',
    json: false,
    pythonPath: 'python3',
    allPages: false,
    profile: 'auto',
    scanPage: false,
    lowConfidenceThreshold: 0.85,
  };
  let positional: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printUsage(process.stdout);
      process.exit(0);
    }
    if (a === '-V' || a === '--version') {
      process.stdout.write('0.0.1\n');
      process.exit(0);
    }
    if (a === '-o' || a === '--orientation') {
      const v = argv[++i];
      if (v !== 'white' && v !== 'black') {
        process.stderr.write(`error: invalid orientation: ${v}\n`);
        process.exit(2);
      }
      opts.orientation = v;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '--templates') {
      opts.templates = argv[++i];
      continue;
    }
    if (a === '--python') {
      opts.pythonPath = argv[++i];
      continue;
    }
    if (a === '--page') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(`error: --page must be a positive integer (got ${raw})\n`);
        process.exit(2);
      }
      opts.page = n;
      continue;
    }
    if (a === '--all-pages') {
      opts.allPages = true;
      continue;
    }
    if (a === '--profile') {
      const v = argv[++i];
      if (v !== 'auto' && v !== 'generic' && v !== 'maizelis' && v !== 'dvoretsky') {
        process.stderr.write(
          `error: invalid profile: ${v} (expected auto|generic|maizelis|dvoretsky)\n`,
        );
        process.exit(2);
      }
      opts.profile = v;
      continue;
    }
    if (a === '--model') {
      opts.modelPath = argv[++i];
      continue;
    }
    if (a === '--unet-model') {
      opts.unetModelPath = argv[++i];
      continue;
    }
    if (a === '--low-confidence') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        process.stderr.write(`error: --low-confidence must be in [0, 1] (got ${raw})\n`);
        process.exit(2);
      }
      opts.lowConfidenceThreshold = n;
      continue;
    }
    if (a === '--scan-page') {
      opts.scanPage = true;
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`error: unknown option: ${a}\n`);
      printUsage(process.stderr);
      process.exit(2);
    }
    if (positional !== null) {
      process.stderr.write(`error: too many positional arguments\n`);
      printUsage(process.stderr);
      process.exit(2);
    }
    positional = a;
  }
  if (positional === null) {
    process.stderr.write('error: missing input path\n');
    printUsage(process.stderr);
    process.exit(2);
  }
  const ext = extname(positional).toLowerCase();
  const inputKind: 'image' | 'pdf' = ext === '.pdf' ? 'pdf' : 'image';

  if (inputKind === 'image') {
    if (opts.page !== undefined || opts.allPages) {
      process.stderr.write('error: --page/--all-pages are valid only for PDF input\n');
      process.exit(2);
    }
  } else {
    if (opts.templates !== undefined) {
      process.stderr.write('error: --templates is valid only for image input\n');
      process.exit(2);
    }
    if (opts.profile !== 'auto' && opts.profile !== 'maizelis') {
      // For PDF the only sensible profiles are still legacy ones — the PDF
      // path uses the Chess-Merida font matcher unrelated to --profile.
      process.stderr.write('error: --profile is valid only for image input\n');
      process.exit(2);
    }
    if (opts.modelPath !== undefined) {
      process.stderr.write('error: --model is valid only for image input\n');
      process.exit(2);
    }
    if (opts.unetModelPath !== undefined) {
      process.stderr.write('error: --unet-model is valid only for image input\n');
      process.exit(2);
    }
    if (opts.scanPage) {
      process.stderr.write('error: --scan-page is valid only for image input\n');
      process.exit(2);
    }
    if (opts.page !== undefined && opts.allPages) {
      process.stderr.write('error: --page and --all-pages are mutually exclusive\n');
      process.exit(2);
    }
    // Если ни одного PDF-флага не задано — по умолчанию пробегаем все страницы.
    if (opts.page === undefined && !opts.allPages) {
      opts.allPages = true;
    }
  }

  return {
    input: positional,
    inputKind,
    orientation: opts.orientation!,
    json: opts.json!,
    templates: opts.templates,
    pythonPath: opts.pythonPath!,
    page: opts.page,
    allPages: opts.allPages!,
    profile: opts.profile!,
    scanPage: opts.scanPage!,
    modelPath: opts.modelPath,
    unetModelPath: opts.unetModelPath,
    lowConfidenceThreshold: opts.lowConfidenceThreshold!,
  };
}

async function runRecognizer(options: CliOptions): Promise<number> {
  // 1. Image + universal profiles (auto/generic) → recognizeUniversal().
  if (
    options.inputKind === 'image' &&
    !options.scanPage &&
    (options.profile === 'auto' || options.profile === 'generic')
  ) {
    return runUniversal(options);
  }

  // 2. Image legacy + PDF → fall through to the existing python spawn.
  const args: string[] = [];
  if (options.inputKind === 'image') {
    if (options.scanPage) {
      args.push(RECOGNIZER_PY, options.input, '--scan-page');
    } else {
      // profile is guaranteed to be 'maizelis' or 'dvoretsky' here.
      args.push(RECOGNIZER_PY, options.input, '--orientation', options.orientation);
      args.push('--profile', options.profile);
      if (options.json) args.push('--json');
      if (options.templates) args.push('--templates', options.templates);
    }
  } else {
    args.push(PDF_RECOGNIZER_PY, options.input, '--orientation', options.orientation);
    if (options.json) args.push('--json');
    if (options.page !== undefined) {
      args.push('--page', String(options.page));
    } else if (options.allPages) {
      args.push('--all-pages');
    }
  }

  return new Promise<number>((res) => {
    const proc = spawn(options.pythonPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('error', (err) => {
      process.stderr.write(`error: cannot launch python: ${err.message}\n`);
      res(1);
    });
    proc.on('close', (code) => {
      res(code ?? 1);
    });
  });
}

/**
 * Image + profile=auto|generic — universal pipeline через recognizeUniversal().
 * Печатает FEN-board в обычном режиме или весь JSON-документ при --json.
 */
async function runUniversal(options: CliOptions): Promise<number> {
  try {
    const result = await recognizeUniversal(options.input, {
      profile: options.profile,
      orientation: options.orientation,
      modelPath: options.modelPath,
      unetModelPath: options.unetModelPath,
      lowConfidenceThreshold: options.lowConfidenceThreshold,
      pythonPath: options.pythonPath,
      templatesImage: options.templates,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }

    if (result.usedProfile === 'generic') {
      process.stdout.write(`${result.fen_board}\n`);
      for (const issue of result.sanity.issues) {
        process.stderr.write(`warning: ${issue}\n`);
      }
      const low = result.low_confidence_cells;
      if (low.length > 0) {
        const joined = low
          .map((c) => `${c.square}=${c.predicted}(${c.confidence.toFixed(2)})`)
          .join(', ');
        process.stderr.write(`warning: low confidence cells: ${joined}\n`);
      }
      return 0;
    }

    // usedProfile === 'maizelis' (auto-fallback).
    process.stdout.write(`${result.fen_board}\n`);
    process.stderr.write(
      `info: auto profile fell back to maizelis (generic path unavailable or unreliable)\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  runRecognizer(opts).then((code) => process.exit(code));
}

export { parseArgs, runRecognizer };
