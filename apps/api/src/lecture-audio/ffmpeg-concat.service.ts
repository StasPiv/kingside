import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

/**
 * KS-3832 / ADR-116 §5.1, §6.3. Тонкая обёртка над системным ffmpeg
 * для финализации записи лекции — склейка WebM-чанков клиента в
 * единый Ogg-контейнер через demuxer `concat` БЕЗ перекодирования
 * (`-c copy`). Стрим Opus в WebM и в Ogg один и тот же; ffmpeg
 * только переписывает контейнер, операция дисково-связанная и
 * стоит копейки CPU. На 1 час аудио (~24 МБ) укладывается в <10
 * секунд.
 *
 * Контроль ресурсов:
 *  - `nice -n 10` — даём приоритет ниже Node-процесса, чтобы
 *    параллельные финализации не задавили API.
 *  - Лимит параллельных задач — 2 через `p-queue`. p-queue v7
 *    распространяется как ESM-only, поэтому в CJS-сборке Nest
 *    подгружаем динамически через `Function('return import(...)')`
 *    (статический `import` TS вкомпилит в `require` и сломает
 *    рантайм).
 *  - Жёсткий timeout 60 секунд на одну задачу. По истечении —
 *    SIGKILL ffmpeg и `throw`.
 *
 * Tmp-директория: `os.tmpdir()/lecture-audio-<uuid>`. Удаляется
 * после успеха ИЛИ ошибки (`fsp.rm({ recursive, force })` в finally).
 * Возврат: `{ localPath, durationMs }`. `localPath` указывает на
 * `out.ogg` внутри tmp-директории; вызывающий код (cron-finalizer
 * KS-A05') обязан сразу же `putFinalTrack` и НЕ опираться на
 * долгое существование файла — после возврата tmp может быть
 * почищена параллельной задачей (`process.exit`/OOM).
 *
 * ВАЖНО: возвращаемый `localPath` — это путь в tmp, который этот
 * сервис **очистит** через `cleanup()` сразу после `await`. То есть
 * вызывающий код должен прочитать файл синхронно после возврата
 * (либо использовать `concatChunksToOggAnd(callback)`). Это
 * сделано осознанно: финалайзер сразу льёт файл в S3, держать tmp
 * после возврата нет смысла.
 *
 * Чтобы упростить контракт, фактический паттерн — `runWithOutput`,
 * который вызывает callback с готовым `localPath` и сам убирает
 * tmp. `concatChunksToOgg` оставлен как «низкоуровневый» под
 * Gherkin задачи; вызывающий код может опираться на него, если
 * сразу копирует файл. Реальный финалайзер будет пользоваться
 * `runWithOutput`.
 */
@Injectable()
export class FfmpegConcatService implements OnModuleInit {
  private readonly logger = new Logger(FfmpegConcatService.name);

  /** Жёсткий timeout одного запуска ffmpeg, мс. */
  static readonly FFMPEG_TIMEOUT_MS = 60_000;
  /** Параллелизм очереди. */
  static readonly QUEUE_CONCURRENCY = 2;

  // p-queue v7 — ESM-only. В CJS-сборке (Nest) подгружаем через
  // `Function('return import(...)')`, иначе TS вкомпилит `import` в
  // `require` и сломает рантайм.
  private queue!: import('p-queue').default;

  async onModuleInit(): Promise<void> {
    const importDynamic = new Function(
      'specifier',
      'return import(specifier)',
    ) as (s: string) => Promise<typeof import('p-queue')>;
    const mod = await importDynamic('p-queue');
    const PQueue = mod.default;
    this.queue = new PQueue({
      concurrency: FfmpegConcatService.QUEUE_CONCURRENCY,
    });
    this.logger.log(
      `FfmpegConcatService ready: concurrency=${FfmpegConcatService.QUEUE_CONCURRENCY} timeout=${FfmpegConcatService.FFMPEG_TIMEOUT_MS}ms`,
    );
  }

  /**
   * Внутренний размер очереди (выполняющиеся + ожидающие). Доступен
   * для тестов и мониторинга.
   */
  get queueSize(): number {
    return (this.queue?.size ?? 0) + (this.queue?.pending ?? 0);
  }

  /**
   * Запустить склейку чанков в Ogg. Возвращает `{ localPath,
   * durationMs }`. После возврата tmp-директория может быть удалена
   * в любой момент — вызывающий код обязан немедленно скопировать /
   * залить `localPath`.
   *
   * Альтернативно используйте `runWithOutput(paths, async (path) =>
   * ...)` — он гарантирует cleanup внутри одного await'а.
   */
  async concatChunksToOgg(
    localChunkPaths: string[],
  ): Promise<{ localPath: string; durationMs: number }> {
    return this.runWithOutput(localChunkPaths, async (out) => out);
  }

  /**
   * Безопасный паттерн использования: внутри callback'а файл доступен,
   * после выхода tmp удаляется. Callback должен либо
   * скопировать/залить файл, либо вернуть нужные метаданные.
   */
  async runWithOutput<T>(
    localChunkPaths: string[],
    use: (out: { localPath: string; durationMs: number }) => Promise<T>,
  ): Promise<T> {
    if (!this.queue) {
      throw new Error('FfmpegConcatService not initialized (onModuleInit)');
    }
    if (localChunkPaths.length === 0) {
      throw new Error('concatChunksToOgg: empty chunk list');
    }
    const task = async (): Promise<T> => {
      const tmpDir = await fsp.mkdtemp(
        join(os.tmpdir(), 'lecture-audio-'),
      );
      const mergedPath = join(tmpDir, 'merged.webm');
      const outPath = join(tmpDir, 'out.ogg');
      try {
        // KS-3877. MediaRecorder в режиме `timeslice` отдаёт первый
        // чанк с полным WebM-заголовком (EBML + Segment + Tracks +
        // Cluster1), а каждый последующий — только новый Cluster без
        // заголовков. Concat-demuxer ffmpeg (`-f concat`) считает
        // каждый файл из списка самостоятельным медиаконтейнером и
        // отбрасывает безголовочные чанки → итог получался длиной в
        // один таймслайс.
        //
        // Решение: байт-в-байт склеить чанки в `merged.webm`. Matroska
        // стрим валиден, если в нём header + произвольное число
        // Cluster'ов подряд — ffmpeg прочитает его как обычный WebM
        // и перепакует в Ogg одной операцией.
        await this.concatChunkBytes(localChunkPaths, mergedPath);
        const { stderr } = await this.runFfmpeg([
          '-i',
          mergedPath,
          '-c:a',
          'copy',
          '-f',
          'ogg',
          outPath,
        ]);
        const durationMs = this.parseDurationMs(stderr);
        return await use({ localPath: outPath, durationMs });
      } finally {
        await fsp
          .rm(tmpDir, { recursive: true, force: true })
          .catch((e) =>
            this.logger.warn(
              `cleanup ${tmpDir} failed: ${(e as Error).message}`,
            ),
          );
      }
    };
    // p-queue.add даёт Promise<T> в v7 при concurrency-mode.
    return (await this.queue.add(task)) as T;
  }

  /**
   * KS-3877. Байтовая конкатенация чанков (порядок гарантирует
   * вызывающий код — `LectureAudioS3Service.listChunks` сортирует по
   * `seq`). Используется вместо ffmpeg concat-demuxer'а, потому что
   * timeslice-чанки MediaRecorder корректно складываются только так
   * (см. подробности в комментарии task'а выше).
   */
  private async concatChunkBytes(
    chunks: string[],
    targetPath: string,
  ): Promise<void> {
    const out = createWriteStream(targetPath, { flags: 'w' });
    try {
      for (const chunk of chunks) {
        // pipeline(..., { end: false }) — иначе после первой записи
        // writer закроется и pipeline следующего файла упадёт.
        await pipeline(createReadStream(chunk), out, { end: false });
      }
    } finally {
      out.end();
      await new Promise<void>((resolve, reject) => {
        out.on('finish', () => resolve());
        out.on('error', reject);
      });
    }
  }

  /**
   * Запуск `nice -n 10 ffmpeg <args>` с жёстким timeout'ом. Возвращает
   * stderr (ffmpeg пишет туда длительность и сводку). stdout не
   * читаем — он пустой при `-f ogg <path>`.
   *
   * При timeout — SIGKILL и throw. exitCode != 0 → throw с куском
   * stderr (tail 4 KB).
   */
  private runFfmpeg(args: string[]): Promise<{ stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('nice', ['-n', '10', 'ffmpeg', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
        reject(
          new Error(
            `ffmpeg timeout after ${FfmpegConcatService.FFMPEG_TIMEOUT_MS}ms`,
          ),
        );
      }, FfmpegConcatService.FFMPEG_TIMEOUT_MS);

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(
          new Error(`ffmpeg spawn failed: ${(e as Error).message}`),
        );
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL') {
          // timeout-ветка уже отвергла обещание.
          return;
        }
        if (code === 0) {
          resolve({ stderr });
          return;
        }
        const tail = stderr.slice(-4 * 1024);
        reject(
          new Error(`ffmpeg exit code=${code} signal=${signal}: ${tail}`),
        );
      });
    });
  }

  /**
   * Извлечь длительность из stderr ffmpeg. ffmpeg на success пишет
   * строку `size=... time=HH:MM:SS.MS bitrate=...`. Берём последнее
   * вхождение `time=` (на длинных входах ffmpeg обновляет прогресс
   * многократно). Если не нашли — возвращаем 0; callers могут
   * упасть на этом значении явно (валидация в финалайзере).
   */
  private parseDurationMs(stderr: string): number {
    const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (matches.length === 0) {
      this.logger.warn('parseDurationMs: no time= in ffmpeg stderr');
      return 0;
    }
    const last = matches[matches.length - 1];
    const hours = Number(last[1]);
    const minutes = Number(last[2]);
    const seconds = Number(last[3]);
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  // ─── Тестовая инъекция ─────────────────────────────────────────────

  /**
   * Сброс/замена очереди — нужен для unit-тестов, чтобы можно было
   * прогнать концепцию без реального динамического импорта. В
   * рантайме не используется.
   */
  setQueueForTests(queue: import('p-queue').default): void {
    this.queue = queue;
  }
}

/**
 * Тип-хелпер: даёт удобный alias под `import('p-queue').default` в
 * местах, где не нужно тянуть весь модуль.
 */
export type PQueueCtor = typeof import('p-queue').default;

// Уникальный id запуска (для логов трассировки) — не используется
// сейчас, экспортируется на случай, если cron-finalizer'у понадобится
// корреляция между задачей и tmp-папкой.
export const FFMPEG_RUN_ID = (): string => randomUUID();
