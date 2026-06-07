/**
 * KS-3832 / ADR-116 §5.1, §6.3. Тесты обёртки ffmpeg.
 *
 * Гибридные:
 *  - integration на реальном ffmpeg (он стоит в Dockerfile API и
 *    локально доступен): генерируем 2 коротких WebM-Opus чанка
 *    через `ffmpeg -f lavfi sine`, склеиваем сервисом, проверяем
 *    `durationMs ≈ 2000`. Это и есть Gherkin.
 *  - unit: `parseDurationMs` (приватный, дёргаем через as any),
 *    `runWithOutput` cleanup при ошибке, очередь (`queueSize`).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { FfmpegConcatService } from './ffmpeg-concat.service';

/**
 * Минимальный CJS-stub p-queue для тестов. Реальный p-queue v7 — ESM,
 * jest без `--experimental-vm-modules` его не подхватывает; тестовая
 * очередь повторяет нужный нам интерфейс (`add`, `size`, `pending`)
 * и поведение concurrency.
 */
class TestQueue {
  concurrency: number;
  size = 0;
  pending = 0;
  private waiting: Array<() => void> = [];
  constructor(opts: { concurrency: number }) {
    this.concurrency = opts.concurrency;
  }
  async add<T>(task: () => Promise<T> | T): Promise<T> {
    this.size++;
    if (this.pending >= this.concurrency) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.size--;
    this.pending++;
    try {
      return await task();
    } finally {
      this.pending--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

function makeSvc(concurrency = 2): FfmpegConcatService {
  const s = new FfmpegConcatService();
  // Обходим onModuleInit (динамический import ESM не работает в jest
  // без --experimental-vm-modules); подсовываем CJS-stub очереди.
  s.setQueueForTests(
    new TestQueue({ concurrency }) as unknown as import('p-queue').default,
  );
  return s;
}

function genWebm(path: string, durationSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${durationSec}`,
        '-c:a',
        'libopus',
        '-f',
        'webm',
        path,
      ],
      { stdio: 'ignore' },
    );
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg gen exit ${code}`)),
    );
  });
}

function probeDurationMs(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (b) => (out += b.toString('utf-8')));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0
        ? resolve(Math.round(Number(out.trim()) * 1000))
        : reject(new Error(`ffprobe exit ${code}`)),
    );
  });
}

describe('FfmpegConcatService (KS-3832)', () => {
  let svc: FfmpegConcatService;

  beforeAll(() => {
    svc = makeSvc(2);
  });

  describe('runWithOutput / concatChunksToOgg (integration)', () => {
    it('склеивает два 1-сек WebM-Opus чанка в out.ogg ≈ 2000 мс', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const c0 = join(tmp, 'c0.webm');
      const c1 = join(tmp, 'c1.webm');
      try {
        await genWebm(c0, 1);
        await genWebm(c1, 1);
        let copied = '';
        let durationMs = 0;
        await svc.runWithOutput([c0, c1], async ({ localPath, durationMs: d }) => {
          // копируем перед cleanup
          copied = join(tmp, 'final.ogg');
          await fsp.copyFile(localPath, copied);
          durationMs = d;
        });
        const stat = await fsp.stat(copied);
        expect(stat.size).toBeGreaterThan(0);
        const probed = await probeDurationMs(copied);
        // ffmpeg возвращает чуть больше 2 с (накладные опуса), допуск ±400 мс.
        expect(probed).toBeGreaterThanOrEqual(1600);
        expect(probed).toBeLessThanOrEqual(2400);
        // Сам сервис рапортует через свой парсер stderr — допуск тот же.
        expect(durationMs).toBeGreaterThanOrEqual(1600);
        expect(durationMs).toBeLessThanOrEqual(2400);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 30_000);

    it('одиночный чанк — длительность ≈ 1000 мс', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const c0 = join(tmp, 'c0.webm');
      try {
        await genWebm(c0, 1);
        const { durationMs } = await svc.runWithOutput(
          [c0],
          async (out) => out,
        );
        expect(durationMs).toBeGreaterThanOrEqual(700);
        expect(durationMs).toBeLessThanOrEqual(1400);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 30_000);

    it('пустой список чанков → ошибка', async () => {
      await expect(svc.concatChunksToOgg([])).rejects.toThrow(/empty chunk/);
    });

    it('cleanup tmp-папки происходит даже при ошибке внутри callback', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const c0 = join(tmp, 'c0.webm');
      try {
        await genWebm(c0, 1);
        // Перехватываем имя tmp-папки сервиса через mkdtemp-spy
        const created: string[] = [];
        const origMkdtemp = fsp.mkdtemp;
        jest.spyOn(fsp, 'mkdtemp').mockImplementation(async (prefix) => {
          const d = await origMkdtemp(prefix);
          created.push(d);
          return d;
        });
        try {
          await expect(
            svc.runWithOutput([c0], async () => {
              throw new Error('boom');
            }),
          ).rejects.toThrow(/boom/);
        } finally {
          (fsp.mkdtemp as jest.Mock).mockRestore?.();
          jest.restoreAllMocks();
        }
        const svcTmp = created.find((d) => d.includes('lecture-audio-'));
        expect(svcTmp).toBeDefined();
        await expect(fsp.stat(svcTmp!)).rejects.toThrow(); // удалена
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe('очередь (concurrency)', () => {
    it('лимит concurrency=2: при 3 задачах одновременно работает не больше 2', async () => {
      const queue = new TestQueue({ concurrency: 2 });
      let running = 0;
      let maxRunning = 0;
      const task = async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
      };
      await Promise.all([queue.add(task), queue.add(task), queue.add(task)]);
      expect(maxRunning).toBe(2);
    });

    it('queueSize отражает в-работе + в-ожидании', async () => {
      const local = makeSvc(2);
      const resolvers: Array<() => void> = [];
      const slow = () =>
        new Promise<void>((r) => {
          resolvers.push(r);
        });
      const q = (local as unknown as { queue: import('p-queue').default })
        .queue;
      // 2 запустятся (pending=2), 3-я встанет в ожидание (size=1).
      const p1 = q.add(slow);
      const p2 = q.add(slow);
      const p3 = q.add(() => Promise.resolve());
      await new Promise((r) => setImmediate(r));
      expect(local.queueSize).toBeGreaterThanOrEqual(2);
      // Освобождаем обе медленные.
      resolvers.forEach((r) => r());
      await Promise.all([p1, p2, p3]);
    });
  });

  describe('parseDurationMs', () => {
    it('берёт последнее time=HH:MM:SS.MS', () => {
      const stderr =
        'frame=… time=00:00:00.50 bitrate=…\n' +
        'frame=… time=00:00:02.00 bitrate=…\n' +
        'frame=… time=01:02:03.456 bitrate=…\n';
      const v = (svc as unknown as {
        parseDurationMs(s: string): number;
      }).parseDurationMs(stderr);
      // 1h + 2m + 3.456s = 3723.456 → 3_723_456 ms
      expect(v).toBe(3_723_456);
    });

    it('нет time= → 0', () => {
      const v = (svc as unknown as {
        parseDurationMs(s: string): number;
      }).parseDurationMs('no progress here');
      expect(v).toBe(0);
    });
  });
});
