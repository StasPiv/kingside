/**
 * KS-2045 — TS-обёртка вокруг Python-extractor'а.
 * Запускает `extract_pdf.py` через child_process, возвращает распарсенный AST.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { PdfExtractResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTRACT_PY = resolve(__dirname, '..', 'src', 'python', 'extract_pdf.py');

export interface ExtractOptions {
  pageStart: number;
  pageEnd: number;
  pythonPath?: string;
}

/** Прогнать Python-extractor и вернуть AST. */
export async function extractPdf(
  pdfPath: string,
  options: ExtractOptions,
): Promise<PdfExtractResult> {
  const { pageStart, pageEnd, pythonPath = 'python3' } = options;
  const args = [
    EXTRACT_PY,
    pdfPath,
    '--page-start', String(pageStart),
    '--page-end', String(pageEnd),
  ];
  return new Promise<PdfExtractResult>((res, rej) => {
    const proc = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    proc.on('error', rej);
    proc.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        rej(new Error(
          `pdf-to-lesson-yaml extract_pdf.py exited with ${code}: ${stderr.trim()}`,
        ));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      try {
        res(JSON.parse(stdout) as PdfExtractResult);
      } catch (e) {
        rej(new Error(
          `pdf-to-lesson-yaml: failed to parse extractor output: ${(e as Error).message}\n` +
            `stdout (first 500 chars): ${stdout.slice(0, 500)}`,
        ));
      }
    });
  });
}
