#!/usr/bin/env node
/**
 * KS-2028 — Node CLI для распознавания диаграммы Майзелиса в FEN.
 *
 *   board-image-to-fen <image> [--orientation white|black] [--json] [--templates path]
 *
 * Без `--json` — печатает только FEN-board (одна строка), exit 0;
 * с `--json` — JSON-документ. Диагностика — в stderr.
 *
 * Под капотом — `src/python/recognizer.py` через child_process.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RECOGNIZER_PY = resolve(__dirname, '..', 'src', 'python', 'recognizer.py');

interface CliOptions {
  image: string;
  orientation: 'white' | 'black';
  json: boolean;
  templates?: string;
  pythonPath: string;
}

function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    [
      'Usage: board-image-to-fen <image> [options]',
      '',
      'Recognize a Maizelis-style chess diagram and emit its FEN-board.',
      '',
      'Options:',
      '  -o, --orientation <side>   white|black (default: white)',
      '      --json                 emit a detailed JSON document',
      '      --templates <path>     custom starting-position template image',
      '      --python <path>        Python interpreter (default: python3)',
      '  -h, --help                 print this help',
      '  -V, --version              print version',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const opts: Partial<CliOptions> = {
    orientation: 'white',
    json: false,
    pythonPath: 'python3',
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
    process.stderr.write('error: missing image path\n');
    printUsage(process.stderr);
    process.exit(2);
  }
  return {
    image: positional,
    orientation: opts.orientation!,
    json: opts.json!,
    templates: opts.templates,
    pythonPath: opts.pythonPath!,
  };
}

async function runRecognizer(options: CliOptions): Promise<number> {
  const args = [RECOGNIZER_PY, options.image, '--orientation', options.orientation];
  if (options.json) args.push('--json');
  if (options.templates) args.push('--templates', options.templates);

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
