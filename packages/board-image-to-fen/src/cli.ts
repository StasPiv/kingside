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
  };
}

async function runRecognizer(options: CliOptions): Promise<number> {
  const args: string[] = [];
  if (options.inputKind === 'image') {
    args.push(RECOGNIZER_PY, options.input, '--orientation', options.orientation);
    if (options.json) args.push('--json');
    if (options.templates) args.push('--templates', options.templates);
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
