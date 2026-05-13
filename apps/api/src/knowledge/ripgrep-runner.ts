import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';

export type RipgrepResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/**
 * KS-2967 / ADR-063 — обёртка над spawn('rg', ...) с тайм-аутом и
 * cap на размер stdout. Вынесена в отдельный provider, чтобы
 * KnowledgeService можно было тестировать без реального ripgrep
 * (jest-окружение в нашем sandbox не имеет /usr/bin/rg).
 */
@Injectable()
export class RipgrepRunner {
  run(args: string[], cwd: string, timeoutMs: number): Promise<RipgrepResult> {
    return new Promise((resolve) => {
      const proc = spawn('rg', args, { cwd, env: { ...process.env, LANG: 'C' } });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 1024 * 1024) {
          timedOut = true;
          proc.kill('SIGKILL');
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 16 * 1024) {
          stderr = stderr.slice(0, 16 * 1024);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ kind: 'error', message: err.message });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return resolve({ kind: 'timeout' });
        if (code === 0 || code === 1) return resolve({ kind: 'ok', stdout });
        return resolve({
          kind: 'error',
          message: stderr.trim() || `rg exit ${code}`,
        });
      });
    });
  }
}
